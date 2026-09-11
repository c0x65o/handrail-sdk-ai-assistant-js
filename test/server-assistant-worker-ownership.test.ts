import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";
import { InMemoryDurableApplicationTurnStore, DURABLE_APPLICATION_TURN_SCHEMA_VERSION } from "../src/transports/durable.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { parseConversationEvent, type ConversationId } from "../src/conversation/events.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";

type Context = HandrailAssistantAuthorizationContext & { role: "admin" | "user" };
const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };

it.each(["role", "session"] as const)("cancels the original worker after a trusted %s change without claiming its live lease", async change => {
  let context: Context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", role: "admin",
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("alice"), session: fact("original-session"), automation: fact(null) } };
  const conversationId = "conversation" as ConversationId, turnId = "turn", mutationId = "admission";
  const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Wait for approval" }] }], tools: [], tool_results: [],
    generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
  const events = new InMemoryConversationEventStore();
  await events.append({ conversationId, expectedRevision: null, events: [
    { type: "message.created", message_id: "message", role: "user", content: [{ type: "text", text: "Wait for approval" }] },
    { type: "turn.started", turn_id: turnId, input_message_ids: ["message"] },
  ].map((payload, index) => parseConversationEvent({ version: 1, event_id: `event-${index}`, conversation_id: conversationId,
    revision: index + 1, occurred_at: new Date().toISOString(), actor: { type: "user" }, source: { type: "sync" },
    ...(index === 0 ? { mutation_id: mutationId } : {}), payload })) });
  const durableTurns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  await durableTurns.create({ schemaVersion: DURABLE_APPLICATION_TURN_SCHEMA_VERSION, conversationId, turnId, mutationId,
    idempotencyKey: "start", requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"), request,
    delegateTurnId: null, status: "pending", attempt: 0, events: [], terminal: null, cancellation: null, lease: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const bundle = { events, durableTurns,
    approvals: new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" }),
    catalog: new InMemoryConversationCatalog<Context>({ authorize: () => "allow" }),
    toolLedger: new InMemoryToolExecutionLedger(), activity: {}, usageReceiptSink: null, usageAdmissions: null,
  } as unknown as PostgresAssistantPersistenceBundle<Context>;
  await bundle.catalog.create({ authorizationContext: context, conversationId,
    title: "Owned conversation", idempotencyKey: "owned-create" as never });
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const executions: Array<{ context: Context; signal: AbortSignal; finished: boolean }> = [];
  const assistant = await createHandrailAssistant<Context>({ id: "worker-ownership", workerId: "host-worker",
    authorize: () => context, persistence: { attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"],
      ttlMilliseconds: 60000 }, persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport(input) {
      return createApplicationTurnTransport<StreamEvent, ChatRequest>({ async execute(_request, turn) {
        const execution = { context: input.context, signal: turn.signal, finished: false };
        executions.push(execution);
        await Promise.race([cleanup, new Promise<void>(resolve => {
          if (turn.signal.aborted) resolve();
          else turn.signal.addEventListener("abort", () => resolve(), { once: true });
        })]);
        execution.finished = true;
        return { status: turn.signal.aborted ? "cancelled" : "completed", checkpoint };
      } });
    } },
  });
  try {
    expect((await assistant.handle(new Request("https://assistant.test/capabilities"))).status).toBe(200);
    await vi.waitFor(() => expect(executions).toHaveLength(1));
    const originalLease = (await durableTurns.load(conversationId, turnId))!.record.lease;
    context = change === "role" ? { ...context, role: "user" }
      : { ...context, attribution: { ...context.attribution, session: fact("refreshed-session") } };
    const response = await assistant.handle(new Request("https://assistant.test/turns/cancel", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, turnId,
        mutationId: "cancel", idempotencyKey: "cancel", reason: "user" }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(executions[0]!.finished).toBe(true), { timeout: 3000 });
    expect(executions[0]!.signal.aborted).toBe(true);
    expect(executions).toHaveLength(1);
    await vi.waitFor(async () => expect((await durableTurns.load(conversationId, turnId))!.record)
      .toMatchObject({ status: "cancelled", attempt: 1, lease: null }));
    expect(originalLease?.ownerId).toEqual(expect.any(String));
  } finally {
    release();
    await vi.waitFor(() => expect(executions.every(execution => execution.finished)).toBe(true));
    assistant.stopUsageWorker();
  }
});
