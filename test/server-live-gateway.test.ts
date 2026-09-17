import { expect, it, vi } from "vitest";
import { createHandrailAssistant } from "../src/server/assistant.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import { createApplicationTurnTransport, type ApplicationTurnExecutionContext } from "../src/transports/application-turn.js";
import { createApplicationGatewayTransport } from "../src/transports/application-gateway.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { replayConversation } from "../src/conversation/replay.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import type { PostgresAssistantPersistence } from "../src/postgres/index.js";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { PGlite } from "@electric-sql/pglite";
import { createHandrailAiClient } from "../src/client/bootstrap.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

it("runs the negotiated JS session through the protected gateway and PostgreSQL projection without client canonical hydration", async () => {
  const db = new PGlite();
  const adapt = (connection: Pick<PGlite, "query">): PostgresSqlClient => {
    const sql: PostgresSqlClient = { query: async <T extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) => {
      const result = await connection.query<T>(statement, [...values]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: work => work(sql) }; return sql;
  };
  const persistence = postgresFromClient({ query: adapt(db).query,
    transaction: work => db.transaction(tx => work(adapt(tx as unknown as Pick<PGlite, "query">))) });
  await persistence.persistence.migrate();
  const context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", attribution };
  const bundle = persistence.forScope<typeof context>(context, { createConversationId: () => "bounded-chat" as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
  const execute = vi.fn(async (_request: ChatRequest, turn: ApplicationTurnExecutionContext<StreamEvent>) => {
    const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "provider", trace_id: "trace" };
    await turn.emit({ ...envelope, type: "response.started", sequence: 0, attribution });
    await turn.emit({ ...envelope, type: "response.text.delta", sequence: 1, delta: "Live bounded reply" });
    await blocked;
    await turn.emit({ ...envelope, type: "response.completed", sequence: 2, outcome: "stop" });
    return { status: "completed" as const, checkpoint };
  });
  const assistant = await createHandrailAssistant({ id: "bounded", authorize: () => context, persistence, recoverPendingOnContext: false,
    automaticTitles: false, attachmentUpload: false, attachmentDownloads: false,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: () => createApplicationTurnTransport({ execute }) },
  });
  const reads: { path: string; operation: string | undefined; bytes: number }[] = [];
  const client = await createHandrailAiClient<StreamEvent, ChatRequest>({ baseUrl: "https://test.local", startActivityPolling: false,
    synchronizationPollingMilliseconds: 100, conversations: { mode: "single", conversationId: "bounded-chat" as never, clientId: "web" as never },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname, input = init?.body ? JSON.parse(String(init.body)) : {};
      const response = await assistant.handle(new Request(url, init));
      reads.push({ path, operation: input.operation, bytes: path.endsWith("/conversations/history") ? (await response.clone().arrayBuffer()).byteLength : 0 });
      return response;
    },
  });
  try {
    expect(client.conversation?.displaySession).toBeDefined();
    await client.conversation!.synchronize!();
    const accepted = vi.fn();
    const sending = client.conversation!.sendMessage({ content: "Question", onAccepted: accepted,
      request: { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, messages: [{ role: "user", content: [{ type: "text", text: "Question" }] }],
        continuation_of: null, tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} } });
    await vi.waitFor(() => expect(client.conversation!.getSnapshot().messages.at(-1)?.content).toEqual([{ type: "text", text: "Live bounded reply" }]), { timeout: 5000 });
    expect(client.conversation!.getSnapshot().active_turn_id).not.toBeNull(); expect(accepted).toHaveBeenCalledOnce();
    release(); expect((await sending).status).toBe("completed");
    const replay = await replayConversation({ conversationId: "bounded-chat" as never, eventStore: bundle.events });
    try { expect(replay.state.messages).toHaveLength(2); expect(replay.state.turns).toHaveLength(1); expect(replay.state.turns[0]!.status).toBe("completed"); }
    finally { replay.store.destroy(); }
    expect(execute).toHaveBeenCalledOnce();
    expect(reads.some(read => /snapshot|resume/u.test(read.path) || read.operation === "load_snapshot" || read.operation === "read_since")).toBe(false);
    expect(reads.filter(read => read.bytes > 0).length).toBeGreaterThan(0);
    expect(Math.max(...reads.map(read => read.bytes))).toBeLessThan(65536 + 1024);
    expect(client.conversation!.getSnapshot()).not.toHaveProperty("processed_event_ids");
  } finally { release(); await client.dispose(); await assistant.stopBackgroundWorkers(); await db.close(); }
}, 20_000);

it.each([false, true])("publishes running text without a browser runtime and settles once; stop projection workers: %s", async stop => {
  const context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", attribution };
  const events = new InMemoryConversationEventStore();
  const turns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  const catalog = new InMemoryConversationCatalog<typeof context>({ authorize: () => "allow", createConversationId: () => "chat" as never });
  await catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  await events.append({ conversationId: "chat" as never, expectedRevision: null, events: [
    { type: "message.created", message_id: "input", role: "user", content: [{ type: "text", text: "Question" }] },
    { type: "turn.started", turn_id: "turn", input_message_ids: ["input"] },
  ].map((payload, index) => parseConversationEvent({ version: 1, conversation_id: "chat", event_id: `seed-${index}`,
    mutation_id: index === 0 ? "admission" : "admission-turn", revision: index + 1, occurred_at: "2026-09-16T00:00:00Z",
    actor: { type: "user" }, source: { type: "runtime" }, payload })) });
  const state = async () => {
    const replay = await replayConversation({ conversationId: "chat" as never, eventStore: events });
    replay.store.destroy(); return replay.state;
  };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
  const execute = vi.fn(async (_request: ChatRequest, turn: ApplicationTurnExecutionContext<StreamEvent>) => {
    const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "provider", trace_id: "trace" };
    await turn.emit({ ...envelope, type: "response.started", sequence: 0, attribution });
    await turn.emit({ ...envelope, type: "response.text.delta", sequence: 1, delta: "Before disconnect" });
    await blocked;
    await turn.emit({ ...envelope, type: "response.text.delta", sequence: 2, delta: " and after" });
    await turn.emit({ ...envelope, type: "response.completed", sequence: 3, outcome: "stop" });
    return { status: "completed" as const, checkpoint };
  });
  const diagnostics = vi.fn();
  const assistant = await createHandrailAssistant({ id: "test", authorize: () => context, diagnostics,
    recoverPendingOnContext: false,
    persistence: { persistence: {}, forScope: () => ({ events, durableTurns: turns, catalog,
      approvals: new InMemoryApprovalProposalStore({ authorize: () => "allow" }), toolLedger: new InMemoryToolExecutionLedger(),
      activity: { list: async () => [], upsert: async (record: unknown) => record }, usageReceiptSink: null, usageAdmissions: null }),
      attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60_000 },
    } as unknown as PostgresAssistantPersistence,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: () => createApplicationTurnTransport({ execute }) },
  });
  // Use the wire transport only. No client runtime writes canonical messages.
  const client = createApplicationGatewayTransport<StreamEvent, ChatRequest>({ baseUrl: "https://test.local",
    fetch: (url, init) => assistant.handle(new Request(url, init)) });
  try {
    const start = await client.startTurn({ conversationId: "chat", conversationTurnId: "turn" as never,
      mutationId: "admission", idempotencyKey: "start", request: { protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
        messages: [{ role: "user", content: [{ type: "text", text: "Question" }] }], continuation_of: null,
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} } });
    if (!start.ok) throw new Error(start.error.message);
    start.value.observation.disconnect();
    await vi.waitFor(async () => expect((await state()).messages.at(-1)?.content)
      .toEqual([{ type: "text", text: "Before disconnect" }]));
    expect((await state()).turns[0]?.status).toBe("running");
    expect((await turns.load("chat", "turn"))?.record.status).toBe("running");
    if (stop) await assistant.stopBackgroundWorkers();
    release();
    await vi.waitFor(async () => expect((await state()).turns[0]?.status).toBe("completed"));
    const completed = await state();
    expect(completed.messages.filter(message => message.role === "assistant")).toHaveLength(1);
    expect(completed.messages.at(-1)?.content).toEqual([{ type: "text", text: "Before disconnect and after" }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(diagnostics.mock.calls.filter(([event]) => event.code === "projection_failed")).toEqual([]);
  } finally { release(); await assistant.stopBackgroundWorkers(); }
});
