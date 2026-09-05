import { describe, expect, it, vi } from "vitest";
import { createDurableApplicationConversationSync } from "../src/sync/durable-application-adapter.js";
import { createHandrailAssistant } from "../src/server/assistant.js";
import { createHandrailAiClient } from "../src/client/bootstrap.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryConversationActivityStore } from "../src/conversation/activity.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { createApplicationTurnTransport, type ApplicationTurnExecutionContext } from "../src/transports/application-turn.js";
import type { PostgresAssistantPersistence } from "../src/postgres/index.js";
import { reconcileDurableConversationTurn } from "../src/server/reconcile-conversation.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryDurableApplicationTurnStore, type DurableApplicationTurnRecord } from "../src/transports/durable.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { replayConversation } from "../src/conversation/replay.js";
import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from "../src/usage.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../src/protocol.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "request", trace_id: "trace" };
const frames: StreamEvent[] = [{ ...envelope, type: "response.started", sequence: 0, attribution },
  { ...envelope, type: "response.text.delta", sequence: 1, delta: "Stored answer" },
  { ...envelope, type: "response.completed", sequence: 2, outcome: "stop" }];
async function setup(status: "completed" | "cancelled" | "failed", output = frames, usageReceipt?: NormalizedUsageReceipt) {
  const events = new InMemoryConversationEventStore();
  const turns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  await events.append({ conversationId: "conversation" as never, expectedRevision: null, events: [parseConversationEvent({
    version: 1, conversation_id: "conversation", event_id: "admission", revision: 1,
    occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "user" }, source: { type: "runtime" },
    payload: { type: "turn.started", turn_id: "turn", input_message_ids: ["input"] },
  })] });
  const record: DurableApplicationTurnRecord<ChatRequest, StreamEvent> = {
    schemaVersion: 1, conversationId: "conversation", turnId: "turn", mutationId: "mutation", idempotencyKey: "key",
    requestFingerprint: "fingerprint", request: {} as ChatRequest, delegateTurnId: "turn", status, attempt: 1,
    events: output.map((event, index) => ({ event, checkpoint: { lastAppliedEventId: `${event.request_id}:${event.sequence}`,
      lastAppliedCursor: `${event.request_id}:${event.sequence}`, lastAppliedRevision: event.sequence }, sequence: index + 1 })), cancellation: status === "cancelled" ? { mutationId: "cancel", idempotencyKey: "cancel",
      fingerprint: "cancel", reason: "user", requestedAt: "2026-09-04T00:00:00.500Z" } : null, lease: null,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:01.000Z",
    terminal: status === "failed" ? { status, checkpoint, error: { code: "unavailable", message: "Worker stopped", retryable: true } }
      : { status, checkpoint, ...(usageReceipt ? { usageReceipt } : {}) },
  };
  await turns.create(record);
  const input = { conversationId: "conversation", turnId: "turn", events, turns, attribution };
  const state = async () => {
    const replay = await replayConversation({ conversationId: "conversation" as never, eventStore: events, checkpointPolicy: false });
    replay.store.destroy(); return replay.state;
  };
  return { input, state };
}

describe("server stored-output reconciliation", () => {
  it.each([true, false])("repairs gateway state without rerunning work; completes before reload: %s", async (completeBeforeReload) => {
    const { input } = await setup("completed");
    const context = { principalId: "user", tenantId: "tenant", scopeId: "scope", attribution };
    const catalog = new InMemoryConversationCatalog({ authorize: () => "allow", createConversationId: () => "conversation" as never });
    await catalog.create({ authorizationContext: context, idempotencyKey: "create" as never, title: "Saved" });
    const activity = new InMemoryConversationActivityStore();
    let failActivity = true;
    let activityOffline = false;
    const bundle = { events: input.events, durableTurns: input.turns, catalog,
      approvals: new InMemoryApprovalProposalStore({ authorize: () => "allow" }), toolLedger: new InMemoryToolExecutionLedger(),
      activity: { list: async () => activity.getSnapshot(), upsert: async (record: Parameters<typeof activity.upsert>[0]) => {
        if (activityOffline) throw new Error("Activity storage is offline");
        if (failActivity) { failActivity = false; throw new Error("Activity storage temporarily unavailable"); }
        activity.upsert(record); return activity.getSnapshot()[0]!;
      }, markRead: async (id: string) => { activity.markRead(id); return activity.getSnapshot()[0] ?? null; } },
      usageReceiptSink: null, usageAdmissions: null };
    let holdExecution: Promise<void> | undefined;
    const execute = vi.fn(async (_request: ChatRequest, turn: ApplicationTurnExecutionContext<StreamEvent>) => {
      for (const frame of frames) {
        if (frame.type === "response.completed") await holdExecution;
        await turn.emit({ ...frame, request_id: `next-${turn.turnId}` });
      }
      return { status: "completed" as const, checkpoint };
    });
    const diagnostics = vi.fn();
    const assistant = await createHandrailAssistant({ id: "test", authorize: () => context, diagnostics,
      persistence: { attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60000 },
        persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence,
      provider: { metadata: { provider_id: "test", model_id: "test", capabilities: { streaming: true, text: true,
        tool_calls: true, parallel_tool_calls: false, reasoning: false, document_input: { supported: false },
        provider_context: { supported: false, reason: "provider_not_supported" }, context_window_tokens: null, max_output_tokens: null } },
        createTransport: () => createApplicationTurnTransport({ execute }) } });
    const client = await createHandrailAiClient({ baseUrl: "https://test.local", startActivityPolling: false,
      fetch: async (url, init) => assistant.handle(new Request(url, init)),
      conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
    try {
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "reconciliation_failed" }));
      activityOffline = true;
      const runtime = await client.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
      await runtime.synchronize!();
      activityOffline = false;
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      expect(runtime.getSnapshot().active_turn_id).toBeNull();
      expect(runtime.getSnapshot().messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
      expect(activity.getSnapshot()[0]).toMatchObject({ turnStatus: "completed", unread: true, turnId: "turn" });
      await client.markActivityRead("conversation");
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      expect(activity.getSnapshot()[0]?.unread).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      const nextRequest: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
        continuation_of: null, messages: [{ role: "user", content: [{ type: "text", text: "Next" }] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
      const outcome = await runtime.sendMessage({ content: "Next", request: nextRequest });
      expect(outcome.status, JSON.stringify({ outcome, turns: runtime.getSnapshot().turns, diagnostics: diagnostics.mock.calls })).toBe("completed");
      expect(execute).toHaveBeenCalledOnce();
      expect(runtime.getSnapshot().messages.filter((message) => message.role === "assistant")).toHaveLength(2);
      expect(runtime.getSnapshot().active_turn_id).toBeNull();
      let release!: () => void;
      holdExecution = new Promise<void>((resolve) => { release = resolve; });
      const pending = runtime.sendMessage({ content: "Next", request: nextRequest });
      try {
        await vi.waitFor(() => expect(runtime.getSnapshot().messages.filter((message) => message.role === "assistant")).toHaveLength(3));
        const turnId = runtime.getSnapshot().active_turn_id!;
        expect(runtime.stopObserving(turnId)).toBe(true);
        await expect(pending).resolves.toMatchObject({ status: "disconnected" });
        await client.dispose();
        if (completeBeforeReload) release();
        if (completeBeforeReload) await vi.waitFor(async () => {
          const saved = await replayConversation({ conversationId: "conversation" as never, eventStore: input.events, checkpointPolicy: false });
          saved.store.destroy();
          expect(saved.state.active_turn_id).toBeNull();
          expect(saved.state.turns.at(-1)?.status).toBe("completed");
        });
        if (completeBeforeReload) expect(activity.getSnapshot()[0]).toMatchObject({ turnId, turnStatus: "completed", unread: true });
        expect(execute).toHaveBeenCalledTimes(2);
        const resumeStatuses: number[] = [];
        const reloaded = await createHandrailAiClient({ baseUrl: "https://test.local", startActivityPolling: false,
          fetch: async (url, init) => {
            const response = await assistant.handle(new Request(url, init));
            if (String(url).endsWith("/turns/resume")) resumeStatuses.push(response.status);
            return response;
          },
          conversations: { mode: "multiple", clientId: "reloaded-browser" as never, authorize: () => "allow" } });
        try {
          const restored = await reloaded.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
          if (!completeBeforeReload) {
            expect(restored.getSnapshot().active_turn_id).toBe(turnId);
            await vi.waitFor(() => expect(resumeStatuses).toEqual([200]));
            release();
          }
          await vi.waitFor(() => expect(restored.getSnapshot().active_turn_id).toBeNull());
          expect(restored.getSnapshot().messages.filter((message) => message.role === "assistant")).toHaveLength(3);
          expect(execute).toHaveBeenCalledTimes(2);
        } finally { release(); await reloaded.dispose(); }
      } finally { release(); await pending.catch(() => undefined); }
    } finally { await client.dispose(); assistant.stopUsageWorker(); }
  });

  it.each(["valid", "unknown-frame", "future-revision", "unapplied-frame", "wrong-status"])(
    "checks canonical evidence for a disconnect checkpoint: %s", async (variant) => {
      const { input } = await setup("completed");
      const conversationId = "conversation" as never;
      await input.events.append({ conversationId, expectedRevision: 1 as never, events: [parseConversationEvent({
        version: 1, conversation_id: conversationId, event_id: "started-frame", revision: 2,
        occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" },
        payload: { type: "turn.status_changed", turn_id: "turn", status: "running" },
        metadata: { handrail_runtime: { request_id: "request", trace_id: "trace", sequence: 0,
          frame_type: "response.started", resume_safe: true } },
      })] });
      const frameId = variant === "unknown-frame" ? "unknown" : variant === "unapplied-frame" ? "request:1" : "request:0";
      const event = parseConversationEvent({ version: 1, conversation_id: conversationId, event_id: "checkpoint", revision: 3,
        occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" },
        mutation_id: "checkpoint", payload: { type: "turn.status_changed", turn_id: "turn", status: variant === "wrong-status" ? "queued" : "running" },
        metadata: { handrail_runtime: { checkpoint: { last_applied_event_id: frameId, last_applied_cursor: frameId,
          last_applied_revision: variant === "future-revision" ? 200 : 2 } } },
      });
      const sync = createDurableApplicationConversationSync({ authorizationContext: {}, principalId: "user",
        eventStore: input.events, turnStore: input.turns, authorizeConversation: () => true });
      const result = await sync.appendMutations({ conversationId, expectedRevision: 2 as never,
        mutations: [{ mutationId: "checkpoint" as never, events: [{ ...event, mutation_id: "checkpoint" as never }] }] });
      expect(result.status).toBe(variant === "valid" ? "mutations" : "unauthorized");
      expect(await input.events.getLatestRevision(conversationId)).toBe(variant === "valid" ? 3 : 2);
    });

  it("recaptures retained usage after a sink failure and links it once even after transcript completion", async () => {
    const receipt = parseNormalizedUsageReceipt({ version: 1, usage_receipt_id: "receipt", conversation_id: "conversation",
      turn_id: "turn", logical_request_id: "request", trace_id: "trace", attempt: { id: "attempt", index: 0 },
      continuation: { id: "continuation", index: 0 }, provider_id: "test", model_id: "test", attribution,
      source: "provider", terminal_status: "completed", tokens: { input_tokens: { status: "reported", value: 10 },
        cached_input_tokens: { status: "unavailable" }, output_tokens: { status: "reported", value: 5 },
        reasoning_tokens: { status: "unavailable" }, total_tokens: { status: "reported", value: 15 } },
      provider_cost: { status: "unavailable" } });
    const { input, state } = await setup("completed", frames, receipt);
    const capture = vi.fn().mockRejectedValueOnce(new Error("Outbox unavailable")).mockResolvedValue(undefined);
    await expect(reconcileDurableConversationTurn({ ...input, usageReceiptSink: { capture } })).rejects.toThrow("Outbox unavailable");
    expect((await state()).turns[0]?.status).not.toBe("completed");
    await reconcileDurableConversationTurn({ ...input, usageReceiptSink: { capture } });
    await reconcileDurableConversationTurn({ ...input, usageReceiptSink: { capture } });
    expect(capture).toHaveBeenCalledTimes(3);
    for (const [captured] of capture.mock.calls) expect(captured).toEqual(receipt);
    expect((await state()).usage_receipt_links).toHaveLength(1);
    expect((await state()).messages).toHaveLength(1);
    expect((await state()).turns[0]?.status).toBe("completed");
  });

  it("finishes the saved transcript after the browser disconnected before receiving its handle", async () => {
    const { input, state } = await setup("completed");
    expect(await reconcileDurableConversationTurn(input)).toBe(true);
    const saved = await state();
    expect(saved.active_turn_id).toBeNull();
    expect(saved.turns[0]?.status).toBe("completed");
    expect(saved.messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
    const revision = saved.revision;
    await reconcileDurableConversationTurn(input);
    expect((await state()).revision).toBe(revision);
    expect((await input.turns.load("conversation", "turn"))?.version).toBe(1);
  });
  it("deduplicates concurrent reconcilers without duplicating answer text", async () => {
    const { input, state } = await setup("completed");
    await Promise.all([reconcileDurableConversationTurn(input), reconcileDurableConversationTurn(input)]);
    expect((await state()).messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
  });
  it.each(["cancelled", "failed"] as const)("settles %s when the worker never supplied a terminal frame", async (status) => {
    const { input, state } = await setup(status, []);
    await reconcileDurableConversationTurn(input);
    expect((await state()).turns[0]?.status).toBe(status);
    expect((await state()).active_turn_id).toBeNull();
    expect((await state()).messages).toHaveLength(0);
  });
  it("retains partial output when authoritative cancellation wins over provider completion", async () => {
    const { input, state } = await setup("cancelled");
    await reconcileDurableConversationTurn(input);
    expect((await state()).turns[0]).toMatchObject({ status: "cancelled", cancellation_reason: "user" });
    expect((await state()).messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
  });
  it("does not fabricate a successful completion when stored evidence is missing", async () => {
    const { input, state } = await setup("completed", []);
    await expect(reconcileDurableConversationTurn(input)).rejects.toThrow();
    expect((await state()).turns[0]?.status).not.toBe("completed");
  });
});
