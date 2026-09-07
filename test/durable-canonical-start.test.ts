import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { PGlite } from "@electric-sql/pglite";
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient,
  type PostgresAssistantPersistence, type PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { replayConversation } from "../src/conversation/replay.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore, type ConversationEventStore, type ReadConversationEventsInput } from "../src/conversation/event-store.js";
import { parseConversationEvent, type ConversationEventPayload, type ConversationId, type ConversationTurnId } from "../src/conversation/events.js";
import { qualifyDurableApplicationTurnStarts } from "../src/sync/durable-application-adapter.js";
import { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";
import type { ConversationTransport } from "../src/transports/types.js";

const conversationId = "conversation-1" as ConversationId;
const turnId = "turn-1" as ConversationTurnId;
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Update once" }] }], tools: [], tool_results: [],
  generation: { max_output_tokens: 1000, temperature: 0 }, correlation_hints: {} };
const input = { conversationId, conversationTurnId: turnId, mutationId: "admission-1", idempotencyKey: "start-1", request };

async function append(store: ConversationEventStore, payload: ConversationEventPayload, mutationId?: string) {
  const revision = await store.getLatestRevision(conversationId) ?? 0;
  await store.append({ conversationId, expectedRevision: revision || null, events: [parseConversationEvent({
    version: 1, event_id: `event-${revision + 1}`, conversation_id: conversationId, revision: revision + 1,
    occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "sync" },
    ...(mutationId ? { mutation_id: mutationId } : {}), payload,
  })] });
}
class PagedEventStore extends InMemoryConversationEventStore {
  override read(input: ReadConversationEventsInput) {
    return super.read({ ...input, limit: Math.min(input.limit ?? 1000, 1000) });
  }
}

async function fixture(historyEvents = 0, events: ConversationEventStore = new PagedEventStore()) {
  if (historyEvents > 0) {
    await events.append({ conversationId, expectedRevision: null,
      events: Array.from({ length: historyEvents }, (_, index) => parseConversationEvent({
        version: 1, event_id: `history-${index}`, conversation_id: conversationId, revision: index + 1,
        occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "system" }, source: { type: "import" },
        payload: index === 0 ? { type: "message.created", message_id: "old-message", role: "user",
          content: [{ type: "text", text: "Previous action request" }] }
          : index === 1 ? { type: "turn.started", turn_id: "old-turn", input_message_ids: ["old-message"] }
          : index === 2 ? { type: "turn.failed", turn_id: "old-turn",
            error: { code: "invalid_request", message: "The previous action failed.", retryable: false } }
          : { type: "conversation.metadata_updated", metadata: { index } },
      })) });
  }
  await append(events, { type: "message.created", message_id: "message-1" as never, role: "user",
    content: [{ type: "text", text: "Update once" }] }, input.mutationId);
  await append(events, { type: "turn.started", turn_id: turnId, input_message_ids: ["message-1" as never] });
  const start = vi.fn<ConversationTransport<StreamEvent, ChatRequest>["startTurn"]>(async (value) => ({ ok: true, value: {
    conversationId: value.conversationId, turnId: value.conversationTurnId, mutationId: value.mutationId,
    observation: { events: (async function* () {})(), result: Promise.resolve({ status: "completed", checkpoint }), disconnect() {} },
  } }));
  const delegate: ConversationTransport<StreamEvent, ChatRequest> = {
    capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
      attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
    startTurn: start,
    async resumeTurn() { return { ok: false, error: { code: "not_found", message: "No provider resume", retryable: false } }; },
  };
  const turns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  const durable = createDurableApplicationTransport({ store: turns,
    delegate: qualifyDurableApplicationTurnStarts(delegate, events), workerId: "worker", pollMilliseconds: 25,
    requestCodec: { encode: (value: ChatRequest) => value, decode: (value: ChatRequest) => value,
      fingerprint: (value: ChatRequest) => createHash("sha256").update(JSON.stringify(value)).digest("hex") }, checkpointForEvent: () => checkpoint });
  return { events, turns, durable, start, delegate };
}

it.each([999, 1000, 1166, 2001])("starts a follow-up after %s history events and never replays completed work", async (historyEvents) => {
  const { events, durable, start } = await fixture(historyEvents);
  expect((await events.read({ conversationId })).hasMore).toBe(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = await durable.startTurn(input);
    if (!handle.ok) throw new Error(handle.error.message);
    for await (const event of handle.value.observation.events) { void event; }
    expect(await handle.value.observation.result).toMatchObject({ status: "completed" });
  }
  expect(start).toHaveBeenCalledOnce();
});

it("admits a saved follow-up at PostgreSQL revision 1167 after a failed action", async () => {
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await db.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      transaction: (operation) => operation(client),
    };
    return client;
  };
  const persistence = new PostgresAiPersistence({ query: adapt(database).query,
    transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
  try {
    await persistence.migrate();
    const { events, durable, delegate, start } = await fixture(1166, new PostgresConversationEventStore(persistence, "tenant"));
    const firstPage = await events.read({ conversationId });
    expect(firstPage.entries).toHaveLength(1000);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entries.some(({ event }) => event.mutation_id === input.mutationId)).toBe(false);
    const tail = await events.read({ conversationId, after: { cursor: firstPage.nextCursor! } });
    expect(tail.entries.find(({ event }) => event.mutation_id === input.mutationId)?.event.revision).toBe(1167);
    const unauthorized = await qualifyDurableApplicationTurnStarts(delegate, events).startTurn({ ...input, mutationId: "wrong-admission" });
    expect(unauthorized).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false,
      message: "The turn identity does not match its saved user message." } });
    expect(start).not.toHaveBeenCalled();
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await durable.startTurn(input);
      if (!handle.ok) throw new Error(handle.error.message);
      for await (const event of handle.value.observation.events) { void event; }
      expect(await handle.value.observation.result).toMatchObject({ status: "completed" });
    }
    expect(start).toHaveBeenCalledExactlyOnceWith(input);
  } finally { await database.close(); }
}, 15000);

it.each(["identity", "message", "attachments", "conversation"] as const)(
  "still rejects mismatched %s after the first history page", async (mismatch) => {
    const { events, delegate, start } = await fixture(1166);
    if (mismatch === "attachments") {
      await append(events, { type: "message.attachment_referenced", message_id: "message-1" as never,
        attachment: { attachment_id: "att_saved-image" as never, media_type: "image/png", filename: "saved.png", size_bytes: 10 } });
    }
    const changed = { ...input,
      ...(mismatch === "identity" ? { mutationId: "someone-elses-admission" } : {}),
      ...(mismatch === "conversation" ? { conversationId: "another-conversation" } : {}),
      ...(mismatch === "message" ? { request: { ...request,
        messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Different instructions" }] }] } } : {}),
    };
    const result = await qualifyDurableApplicationTurnStarts(delegate, events).startTurn(changed);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", retryable: false } });
    expect(start).not.toHaveBeenCalled();
  });

it.each(["cancelled", "completed", "failed", "cancellation_requested"] as const)("does not execute a delayed start after canonical %s", async (status) => {
  const { events, durable, start } = await fixture();
  await append(events, status === "completed"
    ? { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] }
    : status === "failed"
    ? { type: "turn.failed", turn_id: turnId, error: { code: "unavailable", message: "Stopped", retryable: false } }
    : { type: status === "cancelled" ? "turn.cancelled" : "turn.cancellation_requested", turn_id: turnId, reason: "user" });
  const handle = await durable.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  for await (const event of handle.value.observation.events) { void event; }
  expect(start).not.toHaveBeenCalled();
  expect(await handle.value.observation.result).toMatchObject({ status: "failed", error: { retryable: false } });
});

it("still replays retained completed work without executing again", async () => {
  const { events, durable, start } = await fixture();
  const first = await durable.startTurn(input);
  if (!first.ok) throw new Error(first.error.message);
  for await (const event of first.value.observation.events) { void event; }
  expect((await first.value.observation.result).status).toBe("completed");
  await append(events, { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] });
  const replay = await durable.startTurn(input);
  if (!replay.ok) throw new Error(replay.error.message);
  for await (const event of replay.value.observation.events) { void event; }
  expect((await replay.value.observation.result).status).toBe("completed");
  expect(start).toHaveBeenCalledOnce();
});


it("atomically reserves cancellation before a delayed start without decoding input", async () => {
  const { durable, start, turns } = await fixture();
  const cancel = { conversationId, turnId, mutationId: "cancel-1", idempotencyKey: "cancel-1", reason: "user" as const };
  expect(await durable.cancelTurnBeforeStart(cancel)).toMatchObject({ ok: true, value: { status: "already_terminal" } });
  const handle = await durable.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  for await (const event of handle.value.observation.events) { void event; }
  expect(await handle.value.observation.result).toMatchObject({ status: "cancelled" });
  expect(start).not.toHaveBeenCalled();
  expect((await turns.load(conversationId, turnId))?.record).toMatchObject({ status: "cancelled", request: null, cancelledBeforeStart: true });
});

it("uses ordinary cancellation when a start wins creation", async () => {
  const { durable, start, turns } = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const decode = vi.fn(async (value: ChatRequest) => { await barrier; return value; });
  const racing = createDurableApplicationTransport({ store: turns, delegate: {
    capabilities: durable.capabilities, startTurn: start, resumeTurn: durable.resumeTurn,
  }, workerId: "racing", pollMilliseconds: 25,
    requestCodec: { encode: (value: ChatRequest) => value, decode, fingerprint: () => "request" }, checkpointForEvent: () => checkpoint });
  const handle = await racing.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  await vi.waitFor(() => expect(decode).toHaveBeenCalled());
  expect(await racing.cancelTurnBeforeStart({ conversationId, turnId, mutationId: "cancel-race", idempotencyKey: "cancel-race", reason: "user" }))
    .toMatchObject({ ok: true, value: { status: "cancellation_requested" } });
  try {
    for await (const event of handle.value.observation.events) { void event; }
  expect(await handle.value.observation.result).toMatchObject({ status: "cancelled" });
    expect(start).not.toHaveBeenCalled();
    expect((await turns.load(conversationId, turnId))?.record.cancelledBeforeStart).toBeUndefined();
  } finally { release(); }
});


it("cancels an admitted turn through the high-level HTTP gateway before start exists", async () => {
  const { events, turns, start, delegate } = await fixture();
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", tenantId: "tenant", scopeId: "alice",
    attribution: {
      organization: { id: "org", source: "server_derived", trust: "authoritative" },
      project: { id: "project", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
      known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    } };
  const records: import("../src/conversation/activity.js").ConversationActivityRecord[] = [];
  const bundle = { events, durableTurns: turns, toolLedger: new InMemoryToolExecutionLedger(),
    approvals: new InMemoryApprovalProposalStore({ authorize: () => "allow" }),
    catalog: new InMemoryConversationCatalog({ authorize: () => "allow" }),
    activity: { async list() { return records; }, async upsert(record: typeof records[number]) { records.push(record); return record; } },
    usageReceiptSink: null, usageAdmissions: null,
  } as unknown as PostgresAssistantPersistenceBundle<HandrailAssistantAuthorizationContext>;
  const assistant = await createHandrailAssistant({ id: "cancel-before-start", authorize: () => context,
    persistence: { attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60000 },
      forScope: () => bundle } as unknown as PostgresAssistantPersistence,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: () => delegate } });
  const post = (path: string, body: unknown) => assistant.handle(new Request(`https://example.test/ai/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const cancel = { conversationId, turnId, mutationId: "cancel-http", idempotencyKey: "cancel-http", reason: "user" };
  expect(await turns.load(conversationId, turnId)).toBeNull();
  const unknown = await post("turns/cancel", { ...cancel, turnId: "unknown" });
  expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await turns.load(conversationId, "unknown")).toBeNull();
  const response = await post("turns/cancel", cancel);
  expect(await response.json()).toMatchObject({ ok: true, value: { status: "already_terminal" } });
  const replay = await replayConversation({ conversationId, eventStore: events, checkpointPolicy: false });
  try {
    expect(replay.state.replay_error).toBeNull();
    expect(replay.state.turns.at(-1)).toMatchObject({ status: "cancelled", remote_may_still_be_running: false,
      cancellation_reason: "user", cancellation_requested_reason: "user" });
  } finally { replay.store.destroy(); }
  const late = await post("turns/start", input);
  expect(late.status).toBe(200);
  expect(await late.text()).toContain('"status":"cancelled"');
  expect(start).not.toHaveBeenCalled();
  expect(records.at(-1)).toMatchObject({ turnStatus: "completed", unread: true });
  const revision = await events.getLatestRevision(conversationId);
  expect(await (await post("turns/cancel", cancel)).json()).toMatchObject({ ok: true });
  expect(await events.getLatestRevision(conversationId)).toBe(revision);
});
