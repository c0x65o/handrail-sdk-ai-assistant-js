import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseConversationEvent, type ConversationCatalogCursor, type ConversationCatalogDescriptor, type ConversationId } from "../src/index.js";
import { PostgresAiPersistence, PostgresConversationCatalog,
  type PostgresConversationCatalogOptions, type PostgresConversationCatalogTableOptions,
  type PostgresSqlClient } from "../src/postgres/index.js";

const database = new PGlite();
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const adapted: PostgresSqlClient = {
    async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    transaction: operation => operation(adapted),
  };
  return adapted;
};
const client: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = new PostgresAiPersistence(client);
const tenantId = "aaaaaaaa-0000-4000-8000-000000000001";
const userId = "bbbbbbbb-0000-4000-8000-000000000001";
const otherUserId = "bbbbbbbb-0000-4000-8000-000000000002";
type Actor = { userId: string; permitted: boolean };
const actor: Actor = { userId, permitted: true };
const table: PostgresConversationCatalogTableOptions = { name: "host_conversations",
  columns: { tenantId: "household_id", scopeId: "created_by_user_id", conversationId: "id" },
  deletedAtColumn: "deleted_at", identityFormat: "uuid" };
let sequence = 0;
const nextId = () => `cccccccc-0000-4000-8000-${String(++sequence).padStart(12, "0")}` as ConversationId;
const makeCatalog = (overrides: Partial<PostgresConversationCatalogOptions<Actor>> = {}) => new PostgresConversationCatalog<Actor>({
  persistence, tenantId, table, scopeId: context => context.userId,
  authorize: ({ authorizationContext }) => authorizationContext.permitted ? "allow" : "deny", createId: nextId,
  now: () => "2026-09-13T12:00:00.000Z" as never,
  prepareTitle: title => (title ?? "New conversation").replace(/\d{4}/g, "[redacted]"),
  onMutation: async input => { await input.client.query(`INSERT INTO host_audit(conversation_id,action,previous_version,version)
    VALUES ($1,$2,$3,$4)`, [input.conversationId, input.action, input.previousVersion, input.version]); }, ...overrides,
});
const create = (catalog: PostgresConversationCatalog<Actor>, conversationId = nextId()) => catalog.create({
  authorizationContext: actor, conversationId, idempotencyKey: conversationId as never,
});
const event = (conversationId: ConversationId) => parseConversationEvent({ version: 1,
  event_id: `${conversationId}-event`, conversation_id: conversationId, revision: 1, occurred_at: "2026-09-13T00:00:00.000Z",
  actor: { type: "system" }, source: { type: "runtime" },
  payload: { type: "conversation.metadata_updated", metadata: { note: "Private history" } } });
beforeAll(async () => {
  await persistence.migrate();
  await database.exec(`CREATE TABLE households(id uuid PRIMARY KEY);
    CREATE TABLE household_users(household_id uuid REFERENCES households(id), id uuid, PRIMARY KEY(household_id,id));
    CREATE TABLE host_audit(conversation_id uuid, action text, previous_version integer, version integer);
    CREATE TABLE host_conversations(household_id uuid NOT NULL, created_by_user_id uuid NOT NULL, id uuid PRIMARY KEY,
      lifecycle text NOT NULL CHECK(lifecycle IN ('active','archived')), title text NOT NULL,
      created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, archived_at timestamptz,
      version integer NOT NULL CHECK(version > 0), metadata jsonb NOT NULL, deleted_at timestamptz,
      FOREIGN KEY(household_id,created_by_user_id) REFERENCES household_users(household_id,id),
      CHECK((lifecycle='active' AND archived_at IS NULL) OR (lifecycle='archived' AND archived_at IS NOT NULL)));
    CREATE TABLE second_conversations(LIKE host_conversations INCLUDING ALL);`);
  await client.query("INSERT INTO households VALUES ($1)", [tenantId]);
  await client.query("INSERT INTO household_users VALUES ($1,$2),($1,$3)", [tenantId, userId, otherUserId]);
}, 20_000);
afterAll(async () => { await database.close(); });

it("owns catalog lifecycle on the host ownership table with durable, exactly-once audit and new history deletion", async () => {
  const catalog = makeCatalog(); const conversationId = nextId();
  const request = { authorizationContext: actor, conversationId, idempotencyKey: conversationId as never,
    title: "Account 1234", metadata: { source: "host" } };
  let current: ConversationCatalogDescriptor = (await catalog.create(request)).descriptor;
  expect(current).toMatchObject({ title: "Account [redacted]", metadata: { source: "host" }, version: 1, lifecycle: "active" });
  expect((await catalog.create(request)).status).toBe("idempotent");
  await expect(catalog.create({ ...request, title: "Different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(catalog.get({ authorizationContext: { ...actor, userId: otherUserId }, conversationId }))
    .rejects.toMatchObject({ code: "not_found" });
  await persistence.appendEvents({ tenantId, conversationId, expectedRevision: null, events: [event(conversationId)] });
  for (const operation of ["rename", "archive", "restore"] as const) {
    const input: Parameters<typeof catalog.archive>[0] = { authorizationContext: actor, conversationId, idempotencyKey: `${conversationId}-${operation}` as never,
      expectedVersion: current.version };
    const apply = () => operation === "rename" ? catalog.rename({ ...input, title: "Updated 5678" }) : catalog[operation](input);
    current = (await apply()).descriptor;
    expect((await apply()).status).toBe("idempotent");
    expect(current.lifecycle).toBe(operation === "archive" ? "archived" : "active");
    expect(current.title).toBe("Updated [redacted]");
  }
  const deletion = { authorizationContext: actor, conversationId, expectedVersion: current.version,
    idempotencyKey: `${conversationId}-delete` as never };
  expect((await catalog.permanentlyDelete(deletion)).status).toBe("deleted");
  expect((await catalog.permanentlyDelete(deletion)).status).toBe("idempotent");
  expect(await persistence.readEvents(tenantId, conversationId)).toEqual([]);
  expect((await client.query("SELECT 1 FROM host_conversations WHERE id=$1", [conversationId])).rows).toEqual([]);
  expect((await client.query("SELECT 1 FROM handrail_ai_conversations WHERE conversation_id=$1", [conversationId])).rows).toEqual([]);
  expect((await client.query("SELECT action,previous_version,version FROM host_audit WHERE conversation_id=$1 ORDER BY version NULLS LAST",
    [conversationId])).rows).toEqual([
    { action: "create", previous_version: null, version: 1 }, { action: "rename", previous_version: 1, version: 2 },
    { action: "archive", previous_version: 2, version: 3 }, { action: "restore", previous_version: 3, version: 4 },
    { action: "permanent_delete", previous_version: 4, version: null },
  ]);
  await expect(catalog.create({ ...request, idempotencyKey: `${conversationId}-reuse` as never }))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(await persistence.getDocument(tenantId, "catalog_identity", conversationId, "owner"))
    .toMatchObject({ value: { schemaVersion: 1, ownerScopeId: userId } });
});

it("uses stable keyset pages with ties, lifecycle filters and soft-deleted ownership rows", async () => {
  const catalog = makeCatalog();
  const ids = [nextId(), nextId(), nextId(), nextId()];
  for (const id of ids) await create(catalog, id);
  await client.query("UPDATE host_conversations SET deleted_at=now() WHERE id=$1", [ids[1]]);
  const archived = (await catalog.get({ authorizationContext: actor, conversationId: ids[2]! })).descriptor;
  await catalog.archive({ authorizationContext: actor, conversationId: archived.conversationId,
    expectedVersion: archived.version, idempotencyKey: `${ids[2]}-archive` as never });
  const list = { authorizationContext: actor, lifecycle: "all" as const, pageSize: 1, order: { field: "updated_at" as const, direction: "desc" as const } };
  const found: string[] = []; let cursor: string | null = null;
  do {
    const page = await catalog.list({ ...list, ...(cursor ? { cursor: cursor as never } : {}) });
    found.push(...page.items.map(item => item.conversationId)); cursor = page.nextCursor;
  } while (cursor);
  expect(found).toEqual([ids[0], ids[2], ids[3]]);
  expect((await catalog.list({ ...list, lifecycle: "archived", pageSize: 20 })).items.map(item => item.conversationId)).toEqual([ids[2]]);
  await expect(catalog.get({ authorizationContext: actor, conversationId: ids[1]! })).rejects.toMatchObject({ code: "not_found" });
  await expect(catalog.create({ authorizationContext: actor, conversationId: ids[1]!, idempotencyKey: `${ids[1]}-reuse` as never }))
    .rejects.toMatchObject({ code: "idempotency_conflict" });
});

it.each([
  { field: "created_at", direction: "asc" }, { field: "created_at", direction: "desc" },
  { field: "updated_at", direction: "asc" }, { field: "updated_at", direction: "desc" },
] as const)("pages submillisecond ties with native event activity in $field $direction order", async order => {
  const owner = nextId(), context = { ...actor, userId: owner };
  await client.query("INSERT INTO household_users VALUES ($1,$2)", [tenantId, owner]);
  const catalog = makeCatalog({ table: { ...table, includeEventActivity: true } });
  await client.query(`INSERT INTO host_conversations(household_id,created_by_user_id,id,lifecycle,title,created_at,updated_at,version,metadata)
    SELECT $1,$2,gen_random_uuid(),'active','Fixture','2026-09-01'::timestamptz + (n%7)*interval '1 day' + n*interval '1 microsecond',
      '2026-09-01'::timestamptz + (7+n%11)*interval '1 day' + n*interval '1 microsecond',1,'{}'
    FROM generate_series(1,105) n`, [tenantId, owner]);
  const conversationId = (await client.query<{ id: ConversationId }>("SELECT id FROM host_conversations WHERE created_by_user_id=$1 ORDER BY id LIMIT 1", [owner])).rows[0]!.id;
  const saved = { ...event(conversationId), occurred_at: "2099-01-01T00:00:00.000Z" };
  await persistence.appendEvents({ tenantId, conversationId, expectedRevision: null, events: [parseConversationEvent(saved)] });
  await client.query("UPDATE handrail_ai_events SET created_at='2026-09-25T01:00:00.000999Z' WHERE tenant_id=$1 AND conversation_id=$2", [tenantId, conversationId]);
  await persistence.appendEvents({ tenantId: 'other-tenant', conversationId, expectedRevision: null, events: [parseConversationEvent(saved)] });
  await client.query("UPDATE handrail_ai_events SET created_at='2099-01-01' WHERE tenant_id='other-tenant' AND conversation_id=$1", [conversationId]);
  expect((await catalog.get({ authorizationContext: context, conversationId })).descriptor)
    .toMatchObject({ updatedAt: "2026-09-25T01:00:00.000Z", version: 1 });
  let cursor: ConversationCatalogCursor | null = null; const seen: string[] = [];
  for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
    const page = await catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map(item => item.conversationId)); cursor = page.nextCursor;
    if (!cursor) break;
  }
  expect(cursor).toBeNull(); expect(new Set(seen).size).toBe(105);
  const primary = order.field === 'created_at' ? 'c.created_at' : `greatest(c.updated_at,(SELECT max(e.created_at)
    FROM handrail_ai_events e WHERE e.tenant_id=c.household_id::text AND e.conversation_id=c.id::text))`;
  const expected = await client.query<{ id: string }>(`SELECT c.id FROM host_conversations c WHERE c.household_id=$1 AND c.created_by_user_id=$2
    ORDER BY date_trunc('milliseconds',${primary}) ${order.direction},c.id`, [tenantId, owner]);
  expect(seen).toEqual(expected.rows.map(row => row.id));
  // Mutation locking must still lock the ownership row despite the aggregate
  // subquery in its activity projection, without changing catalog CAS semantics.
  const renamed = await catalog.rename({ authorizationContext: context, conversationId,
    expectedVersion: 1 as never, title: 'Renamed', idempotencyKey: `rename-${owner}` as never });
  expect(renamed.descriptor.version).toBe(2);
  expect((await catalog.get({ authorizationContext: context, conversationId })).descriptor.updatedAt).toBe("2026-09-25T01:00:00.000Z");
});

it("rolls back the ownership row, claim, receipt and audit when a host hook fails or access is revoked before commit", async () => {
  for (const reason of ["hook", "revocation"] as const) {
    const context = { ...actor }; const conversationId = nextId();
    const catalog = makeCatalog({ onMutation: async input => {
      await input.client.query("INSERT INTO host_audit(conversation_id,action) VALUES ($1,'create')", [input.conversationId]);
      if (reason === "hook") throw new Error("Audit storage failed");
      context.permitted = false;
    } });
    await expect(catalog.create({ authorizationContext: context, conversationId, idempotencyKey: conversationId as never }))
      .rejects.toMatchObject({ code: reason === "hook" ? "unavailable" : "forbidden" });
    expect((await client.query("SELECT 1 FROM host_conversations WHERE id=$1", [conversationId])).rows).toEqual([]);
    expect((await client.query("SELECT 1 FROM host_audit WHERE conversation_id=$1", [conversationId])).rows).toEqual([]);
    expect(await persistence.getDocument(tenantId, "catalog_identity", conversationId, "owner")).toBeNull();
    expect((await client.query("SELECT 1 FROM handrail_ai_idempotency WHERE idempotency_key=$1", [conversationId])).rows).toEqual([]);
    expect((await create(makeCatalog(), conversationId)).status).toBe("created");
  }
});

it("preserves foreign keys and authorizes before any lookup or domain title hook", async () => {
  const query = vi.fn(client.query); const prepareTitle = vi.fn(() => "New conversation");
  const catalog = makeCatalog({ persistence: new PostgresAiPersistence({ ...client, query: query as PostgresSqlClient["query"] }), prepareTitle });
  await expect(catalog.create({ authorizationContext: { ...actor, permitted: false }, idempotencyKey: "denied" as never }))
    .rejects.toMatchObject({ code: "forbidden" });
  expect(query).not.toHaveBeenCalled(); expect(prepareTitle).not.toHaveBeenCalled();
  const conversationId = nextId();
  await expect(catalog.create({ authorizationContext: { ...actor, userId: nextId() }, conversationId,
    idempotencyKey: conversationId as never })).rejects.toMatchObject({ code: "unavailable" });
  expect(await persistence.getDocument(tenantId, "catalog_identity", conversationId, "owner")).toBeNull();
});

it("rolls back updated and deleted catalog/history state when the transactional audit cannot commit", async () => {
  const ordinary = makeCatalog(); const conversationId = nextId(); const current = (await create(ordinary, conversationId)).descriptor;
  await persistence.appendEvents({ tenantId, conversationId, expectedRevision: null, events: [event(conversationId)] });
  const failing = makeCatalog({ onMutation: async input => {
    await input.client.query("INSERT INTO host_audit(conversation_id,action) VALUES ($1,$2)", [input.conversationId, input.action]);
    throw new Error("Audit rejected");
  } });
  const input = { authorizationContext: actor, conversationId, expectedVersion: current.version,
    idempotencyKey: `${conversationId}-failed` as never };
  await expect(failing.rename({ ...input, title: "Changed" })).rejects.toMatchObject({ code: "unavailable" });
  await expect(failing.permanentlyDelete(input)).rejects.toMatchObject({ code: "unavailable" });
  expect((await ordinary.get({ authorizationContext: actor, conversationId })).descriptor).toEqual(current);
  expect(await persistence.readEvents(tenantId, conversationId)).toHaveLength(1);
  expect(await persistence.getDocument(tenantId, "conversation_deleted", conversationId, "deleted")).toBeNull();
  expect((await client.query("SELECT action FROM host_audit WHERE conversation_id=$1", [conversationId])).rows).toEqual([{ action: "create" }]);
  expect((await ordinary.permanentlyDelete(input)).status).toBe("deleted");
});

it("prevents identity and idempotency reuse across custom tables, native storage and owners", async () => {
  const conversationId = nextId(); const catalog = makeCatalog(); await create(catalog, conversationId);
  const native = new PostgresConversationCatalog<Actor>({ persistence, tenantId, scopeId: context => context.userId,
    authorize: () => "allow", createId: nextId, prepareTitle: () => "New conversation" });
  for (const other of [makeCatalog({ table: { ...table, name: "second_conversations" } }), native]) {
    await expect(create(other, conversationId)).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(other.create({ authorizationContext: actor, conversationId, idempotencyKey: `${conversationId}-new` as never }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(other.create({ authorizationContext: { ...actor, userId: otherUserId }, conversationId,
      idempotencyKey: `${conversationId}-other-owner` as never })).rejects.toMatchObject({ code: "idempotency_conflict" });
  }
  const oldNativeId = nextId();
  await client.query(`INSERT INTO handrail_ai_conversations(tenant_id,scope_id,conversation_id,lifecycle,title,created_at,updated_at,version,metadata)
    VALUES ($1,$2,$3,'active','Existing',now(),now(),1,'{}')`, [tenantId, userId, oldNativeId]);
  await expect(create(catalog, oldNativeId)).rejects.toMatchObject({ code: "idempotency_conflict" });
});

it("hides conflicting ownership claims from reads and keyset pages", async () => {
  const catalog = makeCatalog({ table: { ...table, name: "second_conversations" } });
  const conversationId = nextId(); await create(makeCatalog(), conversationId);
  await client.query("INSERT INTO second_conversations SELECT * FROM host_conversations WHERE id=$1", [conversationId]);
  const validId = nextId(); await create(catalog, validId);
  await expect(catalog.get({ authorizationContext: actor, conversationId })).rejects.toMatchObject({ code: "not_found" });
  const page = await catalog.list({ authorizationContext: actor, pageSize: 1, lifecycle: "active",
    order: { field: "updated_at", direction: "desc" } });
  expect(page.items.map(item => item.conversationId)).toEqual([validId]); expect(page.hasMore).toBe(false);
});

it("rejects noncanonical UUID aliases and unsafe or colliding SQL identifiers", async () => {
  const catalog = makeCatalog(); const conversationId = nextId(); await create(catalog, conversationId);
  for (const alias of [conversationId.toUpperCase(), "not-a-uuid"]) {
    await expect(catalog.get({ authorizationContext: actor, conversationId: alias as ConversationId }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(create(catalog, alias as ConversationId)).rejects.toMatchObject({ code: "invalid_input" });
  }
  await expect(catalog.list({ authorizationContext: { ...actor, userId: userId.toUpperCase() }, pageSize: 20, lifecycle: "active",
    order: { field: "updated_at", direction: "desc" } }))
    .rejects.toMatchObject({ code: "invalid_input" });
  expect(() => makeCatalog({ table: { ...table, name: "host_conversations; DROP TABLE households" } })).toThrow(TypeError);
  expect(() => makeCatalog({ table: { ...table, columns: { tenantId: "id", conversationId: "id" } } })).toThrow(TypeError);
  expect(() => makeCatalog({ table: { ...table, deletedAtColumn: "title" } })).toThrow(TypeError);
});

it("audits successful reads without leaking missing identities and rechecks access before returning a page", async () => {
  const onRead = vi.fn(async () => undefined);
  const catalog = makeCatalog({ onRead }); const conversationId = nextId(); await create(catalog, conversationId);
  await expect(catalog.get({ authorizationContext: actor, conversationId: nextId() })).rejects.toMatchObject({ code: "not_found" });
  expect(onRead).not.toHaveBeenCalled();
  await catalog.get({ authorizationContext: actor, conversationId });
  expect(onRead).toHaveBeenCalledWith(expect.objectContaining({ action: "get", tenantId, scopeId: userId, conversationId }));
  const revoked = { ...actor };
  const restricted = makeCatalog({ onRead: async () => { revoked.permitted = false; } });
  await expect(restricted.list({ authorizationContext: revoked, lifecycle: "active", pageSize: 20,
    order: { field: "updated_at", direction: "desc" } })).rejects.toMatchObject({ code: "forbidden" });
  const unavailable = makeCatalog({ onRead: async () => { throw new Error("Audit store unavailable"); } });
  await expect(unavailable.get({ authorizationContext: actor, conversationId })).rejects.toMatchObject({ code: "unavailable" });
});
