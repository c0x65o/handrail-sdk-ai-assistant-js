import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationCatalogError, parseConversationEvent, type ConversationId } from "../src/index.js";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { openaiResponses } from "../src/server/openai-responses.js";

// Use the repository's embedded PostgreSQL harness and the actual scoped catalog,
// event stores and migrations. Only request authentication and the provider are fixtures.
const database = new PGlite();
const statements: string[] = [];
let catalogUnavailable = false;
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = {
    async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      statements.push(sql);
      if (catalogUnavailable && sql.includes("FROM handrail_ai_conversations")) {
        throw new Error("private database connection failure");
      }
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    transaction: operation => operation(client),
  };
  return client;
};
const sql: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = postgresFromClient(sql);
const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const contextFor = (household: string, user: string): HandrailAssistantAuthorizationContext => ({
  tenantId: household, scopeId: user, principalId: user,
  attribution: { organization: fact(household), project: fact("sync-test"), service_environment: fact("test"),
    known_user: fact(user), session: fact(`${user}-session`), automation: fact(null) },
});
const owner = contextFor("household-a", "alice");
const actors = {
  owner,
  "foreign-user": contextFor("household-a", "bob"),
  "foreign-household": contextFor("household-b", "alice"),
};
const conversationId = "private-conversation" as ConversationId;
const savedEvent = parseConversationEvent({ version: 1, event_id: "private-event", conversation_id: conversationId,
  revision: 1, occurred_at: "2026-10-05T00:00:00.000Z", actor: { type: "user", id: owner.principalId },
  source: { type: "client", client_id: "owner-browser" }, mutation_id: "saved-message",
  payload: { type: "message.created", message_id: "private-message", role: "user",
    content: [{ type: "text", text: "Private household message" }] } });
let accessDenied = false;
let authorizationFailure: Error | undefined;
const provider = vi.fn(async function* () {
  throw new Error("Synchronization must not call a provider");
  yield {};
});
let assistant: Awaited<ReturnType<typeof createHandrailAssistant>>;

beforeAll(async () => {
  await persistence.persistence.migrate();
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(owner, { createConversationId: () => conversationId });
  await bundle.catalog.create({ authorizationContext: owner, idempotencyKey: "create" as never, title: "Private title" });
  await bundle.events.append({ conversationId, expectedRevision: null, events: [savedEvent] });
  assistant = await createHandrailAssistant({ id: "sync-authorization", persistence,
    automaticTitles: false, attachmentCleanup: false, recoverPendingOnContext: false,
    authorize: request => {
      const actor = request.headers.get("x-test-actor") as keyof typeof actors;
      const context = actors[actor];
      if (!context) throw new Error("Unauthenticated fixture request");
      return context;
    },
    authorizeConversation: () => {
      if (authorizationFailure) throw authorizationFailure;
      return accessDenied ? "deny" : "allow";
    },
    provider: openaiResponses({ model: "fixture", request: provider }),
  });
}, 20_000);
afterAll(async () => { await assistant?.stopBackgroundWorkers(); await database.close(); });
beforeEach(() => {
  statements.length = 0;
  catalogUnavailable = false;
  accessDenied = false;
  authorizationFailure = undefined;
  provider.mockClear();
});

const operations = ["pull_snapshot", "read_since", "append_mutations"] as const;
const request = (path: string, actor: keyof typeof actors, body: unknown) => assistant.handle(
  new Request(`https://assistant.test/${path}`, { method: "POST", headers: {
    "content-type": "application/json", "x-test-actor": actor,
  }, body: JSON.stringify(body) }));
const sync = (operation: typeof operations[number], actor: keyof typeof actors = "owner", id = conversationId) =>
  request("synchronization", actor, { operation, input: { conversationId: id,
    ...(operation === "read_since" ? { afterRevision: null } : {}),
    ...(operation === "append_mutations" ? { expectedRevision: 1, mutations: [{ mutationId: "new-message",
      events: [{ ...savedEvent, conversation_id: id, event_id: "new-event", revision: 2, mutation_id: "new-message",
        payload: { ...savedEvent.payload, message_id: "new-message" } }] }] } : {}),
  } });
const denied = { ok: true, value: { status: "unauthorized", message: "Conversation synchronization was denied." } };
const unavailable = { ok: false, error: { code: "unavailable",
  message: "Conversation synchronization is unavailable.", retryable: true } };
function expectNoHistoryOrEffects() {
  // Denial must stop before repair/approval continuation, canonical reads/writes,
  // durable execution, provider accounting, or any other persistence effect.
  for (const statement of statements) {
    expect(statement).toMatch(/^SELECT /u);
    expect(statement).toContain("FROM handrail_ai_conversations");
  }
  expect(provider).not.toHaveBeenCalled();
}

describe.each(operations)("assistant synchronization %s", operation => {
  it.each(["foreign-user", "foreign-household", "missing", "revoked"] as const)(
    "returns the same terminal denial for %s without records or effects", async scenario => {
      const actor = scenario === "foreign-user" || scenario === "foreign-household" ? scenario : "owner";
      const id = scenario === "missing" ? "nonexistent-conversation" as ConversationId : conversationId;
      accessDenied = scenario === "revoked";
      // Exercise actual SQL scope isolation (not_found) and the catalog's native
      // authorizer (forbidden), rather than stubbing catalog.get to throw.
      const catalog = await request("conversations/get", actor, { conversationId: id });
      expect(await catalog.json()).toMatchObject({ ok: false, error: {
        code: scenario === "revoked" ? "forbidden" : "not_found",
      } });
      statements.length = 0;
      const response = await sync(operation, actor, id);
      expectNoHistoryOrEffects();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(denied);
    });

  it("keeps actual catalog storage failures retryable and succeeds after recovery", async () => {
    catalogUnavailable = true;
    const response = await sync(operation);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
    expectNoHistoryOrEffects();
    catalogUnavailable = false;
    const recovered = await sync("read_since");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ ok: true, value: { status: "events", events: [savedEvent] } });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    new Error("private authorization service failure"),
    Object.assign(new Error("untyped failure with a denial-like code"), { code: "forbidden" }),
    new ConversationCatalogError("unavailable", "get"),
    new ConversationCatalogError("invalid_input", "get"),
  ])("preserves exceptions other than known catalog denials (%s)", async failure => {
    authorizationFailure = failure;
    const response = await sync(operation);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
    expectNoHistoryOrEffects();
  });
});

it("returns the owner's saved snapshot and incremental events through the public HTTP boundary", async () => {
  const snapshot = await sync("pull_snapshot");
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toMatchObject({ ok: true, value: { status: "snapshot", snapshot: {
    conversationId, revision: 1, state: { messages: [{ message_id: "private-message", content: savedEvent.payload.type === "message.created"
      ? savedEvent.payload.content : [] }] },
  } } });
  const incremental = await sync("read_since");
  expect(incremental.status).toBe(200);
  expect(await incremental.json()).toEqual({ ok: true, value: { status: "events", events: [savedEvent],
    revision: 1, latestRevision: 1, hasMore: false } });
  expect(provider).not.toHaveBeenCalled();
});
