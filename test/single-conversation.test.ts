import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresAiPersistence, PostgresConversationCatalog, PostgresConversationEventStore,
  clearPostgresConversation, type PostgresSqlClient } from "../src/postgres/index.js";
import { PostgresRealtimeCallStore, PostgresRealtimeWorkspaceActivityStore } from "../src/postgres/index.js";
import { parseConversationEvent, type ConversationId } from "../src/conversation/events.js";
import { replayConversation } from "../src/conversation/replay.js";

const db = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const c: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, args?: readonly unknown[]) {
    const r = await db.query<T>(sql, args ? [...args] : []); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }, transaction: async f => f(c) }; return c;
}
const persistence = new PostgresAiPersistence({ query: adapt(db).query,
  transaction: f => db.transaction(tx => f(adapt(tx as unknown as Pick<PGlite, "query">))) });
beforeAll(() => persistence.migrate()); afterAll(() => db.close());
function fixture(single = true) {
  const tenantId = randomUUID(), context = { id: "owner", allowed: true };
  const options = { persistence, tenantId, scopeId: (c: typeof context) => c.id,
    authorize: ({ authorizationContext: c }: { authorizationContext: typeof context }) => c.allowed ? "allow" as const : "deny" as const,
    createId: () => randomUUID() as ConversationId, clearContents: clearPostgresConversation };
  const catalog = new PostgresConversationCatalog({ ...options, conversationMode: single ? "single" as const : "multiple" as const });
  const create = (key: string = randomUUID(), c = context) => catalog.create({ authorizationContext: c, idempotencyKey: key as never });
  return { catalog, create, context, tenantId, options };
}
async function append(tenant: string, id: ConversationId, payload: unknown) {
  const events = new PostgresConversationEventStore(persistence, tenant);
  const revision = await events.getLatestRevision(id);
  await events.append({ conversationId: id, expectedRevision: revision, events: [parseConversationEvent({ version: 1,
    event_id: randomUUID(), conversation_id: id, revision: (revision ?? 0) + 1, occurred_at: new Date().toISOString(),
    actor: { type: "system" }, source: { type: "runtime" }, payload })] });
}
it("concurrent devices and new sessions share one conversation; account scopes remain separate", async () => {
  const f = fixture(); const rows = await Promise.all([f.create(), f.create()]);
  expect(rows[0].descriptor.conversationId).toBe(rows[1].descriptor.conversationId);
  const restarted = new PostgresConversationCatalog({ ...f.options, conversationMode: "single" });
  expect((await restarted.create({ authorizationContext: f.context, idempotencyKey: "restart" as never })).descriptor.conversationId)
    .toBe(rows[0].descriptor.conversationId);
  expect((await f.create("other", { id: "other", allowed: true })).descriptor.conversationId).not.toBe(rows[0].descriptor.conversationId);
  const longScope = { id: "account".repeat(30), allowed: true };
  expect((await f.create("long-1", longScope)).descriptor.conversationId)
    .toBe((await f.create("long-2", longScope)).descriptor.conversationId);
  await expect(f.create("denied", { ...f.context, allowed: false })).rejects.toMatchObject({ code: "forbidden" });
});
it("adopts a legacy active conversation without deleting other saved rows and disables thread lifecycle", async () => {
  const f = fixture(false); await f.create(); await f.create();
  const single = new PostgresConversationCatalog({ ...f.options, conversationMode: "single" });
  const row = (await single.create({ authorizationContext: f.context, idempotencyKey: "adopt" as never })).descriptor;
  const page = await single.list({ authorizationContext: f.context, lifecycle: "active", pageSize: 20,
    order: { field: "updated_at", direction: "desc" } });
  expect(page.items).toHaveLength(1); expect(page.items[0]!.conversationId).toBe(row.conversationId);
  expect((await persistence.client.query("SELECT 1 FROM handrail_ai_conversations WHERE tenant_id=$1", [f.tenantId])).rows).toHaveLength(2);
  await expect(single.archive({ authorizationContext: f.context, conversationId: row.conversationId,
    expectedVersion: row.version, idempotencyKey: "archive" as never })).rejects.toMatchObject({ code: "unsupported" });
});
it("clear is idempotent, retains identity and audit events, and resets context at a monotonic revision", async () => {
  const f = fixture(); const row = (await f.create()).descriptor;
  await append(f.tenantId, row.conversationId, { type: "message.created", message_id: "old", role: "user", content: [{ type: "text", text: "Old context" }] });
  const input = { authorizationContext: f.context, conversationId: row.conversationId, expectedVersion: row.version, idempotencyKey: "clear" as never };
  const result = await f.catalog.clear(input); expect(result.descriptor.conversationId).toBe(row.conversationId);
  expect((await f.catalog.clear(input)).status).toBe("idempotent");
  let replay = await replayConversation({ eventStore: new PostgresConversationEventStore(persistence, f.tenantId), conversationId: row.conversationId });
  expect(replay.state.messages).toEqual([]); expect(replay.state.revision).toBe(2); replay.store.destroy();
  await append(f.tenantId, row.conversationId, { type: "message.created", message_id: "new", role: "user", content: [{ type: "text", text: "Fresh context" }] });
  replay = await replayConversation({ eventStore: new PostgresConversationEventStore(persistence, f.tenantId), conversationId: row.conversationId });
  expect(replay.state.messages.map(m => m.message_id)).toEqual(["new"]); expect(replay.state.revision).toBe(3); replay.store.destroy();
  expect((await persistence.client.query("SELECT 1 FROM handrail_ai_events WHERE tenant_id=$1", [f.tenantId])).rows).toHaveLength(3);
  expect((await f.create()).descriptor.conversationId).toBe(row.conversationId);
});
it("does not clear a running turn or advance its catalog version", async () => {
  const f = fixture(); const row = (await f.create()).descriptor;
  await append(f.tenantId, row.conversationId, { type: "turn.started", turn_id: "busy", input_message_ids: ["question"] });
  await expect(f.catalog.clear({ authorizationContext: f.context, conversationId: row.conversationId,
    expectedVersion: row.version, idempotencyKey: "clear" as never })).rejects.toBeDefined();
  expect((await f.catalog.get({ authorizationContext: f.context, conversationId: row.conversationId })).descriptor.version).toBe(row.version);
});

it("blocks pending approvals, checks fresh permission, and preserves voice receipts across clear", async () => {
  const f = fixture();
  const voiceTenant = `${f.tenantId}-voice`;
  const catalog = new PostgresConversationCatalog({ ...f.options, conversationMode: "single",
    clearContents: (input) => clearPostgresConversation({ ...input, relatedTenantIds: [voiceTenant] }) });
  const row = (await catalog.create({ authorizationContext: f.context, idempotencyKey: "create" as never })).descriptor;
  const input = { authorizationContext: f.context, conversationId: row.conversationId,
    expectedVersion: row.version, idempotencyKey: "clear" as never };
  await persistence.client.query(`INSERT INTO handrail_ai_approvals VALUES ($1,'owner','review',$2,1,'{"status":"pending"}',now())`, [f.tenantId, row.conversationId]);
  await expect(catalog.clear(input)).rejects.toBeDefined();
  await persistence.client.query(`UPDATE handrail_ai_approvals SET payload='{"status":"rejected"}' WHERE tenant_id=$1`, [f.tenantId]);
  const calls = new PostgresRealtimeCallStore(persistence, voiceTenant, "owner");
  const call = { callId: "old-call", conversationId: row.conversationId, workerId: "worker", fingerprint: "settings" };
  await calls.admit(call);
  await expect(catalog.clear(input)).rejects.toBeDefined();
  await calls.requestEnd(call.callId);
  await catalog.clear(input);
  const feed = new PostgresRealtimeWorkspaceActivityStore([{ conversationId: row.conversationId, calls }]);
  expect((await feed.list()).calls).toEqual([]);
  expect((await calls.list()).calls).toEqual([]);
  expect((await calls.list({ includeCleared: true })).calls.map(call => call.callId)).toEqual(["old-call"]);
  expect((await calls.admit(call)).created).toBe(false);
  expect((await calls.get(call.callId))?.status).toBe("ended");
  await calls.admit({ ...call, callId: "new-call" });
  expect((await feed.list()).calls.map(call => call.callId)).toEqual(["new-call"]);
  await expect(catalog.clear({ ...input, authorizationContext: { ...f.context, allowed: false } }))
    .rejects.toMatchObject({ code: "forbidden" });
});
