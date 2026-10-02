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
import { AI_RUNTIME_PROTOCOL_VERSION, parseStreamEvent, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../src/protocol.js";

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
  it("rejects a forged clear through ordinary conversation synchronization", async () => {
    const { input } = await setup("completed");
    const sync = createDurableApplicationConversationSync({ authorizationContext: {}, principalId: "user",
      eventStore: input.events, turnStore: input.turns, authorizeConversation: () => true });
    const event = parseConversationEvent({ version: 1, conversation_id: "conversation", event_id: "forged-clear",
      mutation_id: "forged-clear", revision: 2, occurred_at: "2026-09-14T00:00:00.000Z",
      actor: { type: "assistant" }, source: { type: "runtime" }, payload: { type: "conversation.cleared" } });
    const result = await sync.appendMutations({ conversationId: "conversation" as never, expectedRevision: 1 as never,
      mutations: [{ mutationId: "forged-clear" as never, events: [{ ...event, mutation_id: "forged-clear" as never }] }] });
    expect(result.status).toBe("unauthorized");
    expect(await input.events.getLatestRevision("conversation" as never)).toBe(1);
  });
  it.each([false, true])("recovers repeated citations from reordered JSON checkpoints; conflicting source: %s", async (conflicting) => {
    const source = { source_id: "report", type: "tool" as const, label: "Report", locator: "app:/report" };
    const target = { type: "assistant_message" as const, message_id: "provider-output" };
    const output = [frames[0]!, frames[1]!,
      { ...envelope, type: "response.usage", sequence: 2, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      { ...envelope, type: "response.citation_batch", sequence: 3, target,
        sources: [{ ...source, label: conflicting ? "Different report" : source.label }],
        citations: [{ citation_id: "current-citation", source_id: source.source_id, order: 0, target }] },
      { ...envelope, type: "response.completed", sequence: 4, outcome: "stop" }].map(parseStreamEvent);
    const { input, state } = await setup("completed", output);
    const previousTarget = { type: "assistant_message", message_id: "previous-answer" };
    await input.events.append({ conversationId: "conversation" as never, expectedRevision: 1 as never,
      events: [
        { type: "message.created", message_id: "previous-answer", role: "assistant", content: [{ type: "text", text: "Previous answer" }] },
        { type: "citation.records_linked", citation_records_version: 1, target: previousTarget,
          sources: [source], citations: [{ citation_id: "previous-citation", source_id: source.source_id, order: 0, target: previousTarget }] },
      ].map((payload, index) => parseConversationEvent({ version: 1, conversation_id: "conversation",
        event_id: `previous-${index}`, revision: index + 2, occurred_at: "2026-09-04T00:00:00.000Z",
        actor: { type: "assistant" }, source: { type: "runtime" }, payload })) });
    const saved = await state();
    // JSONB does not preserve insertion order, including objects inside a checkpoint.
    const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
    await input.events.checkpoints.write({ conversationId: "conversation" as never, revision: saved.revision!,
      schemaVersion: 3, state: reorder(saved) as never });
    if (conflicting) {
      await expect(reconcileDurableConversationTurn(input)).rejects.toThrow();
      expect((await state()).active_turn_id).toBe("turn");
    } else {
      expect(await reconcileDurableConversationTurn(input)).toBe(true);
      const recovered = await state();
      expect(recovered.active_turn_id).toBeNull();
      expect(recovered.turns[0]?.status).toBe("completed");
      expect(recovered.citation_sources).toHaveLength(1);
      expect(recovered.citations.map((citation) => citation.citation_id)).toEqual(["previous-citation", "current-citation"]);
      expect(recovered.messages.map((message) => message.content)).toEqual([[{ type: "text", text: "Previous answer" }], [{ type: "text", text: "Stored answer" }]]);
      await reconcileDurableConversationTurn(input);
      expect((await state()).revision).toBe(recovered.revision);
    }
  });

  it.each([[true, 0], [false, 0], [true, 120], [false, 120]] as const)(
    "repairs legacy snapshot clients without rerunning work; completes before reload: %s, history events: %s", async (completeBeforeReload, historyEvents) => {
    const { input } = await setup("completed");
    if (historyEvents > 0) {
      await input.events.append({ conversationId: "conversation" as never, expectedRevision: 1 as never,
        events: Array.from({ length: historyEvents }, (_, index) => parseConversationEvent({
          version: 1, conversation_id: "conversation", event_id: `history-${index}`, revision: index + 2,
          occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" },
          payload: { type: "conversation.metadata_updated", metadata: { index } },
        })) });
    }
    const readEvents = vi.spyOn(input.events, "read");
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
    // Exercise supported old-server snapshot/resume behavior. This in-memory
    // fixture has no SQL display adapter; server-live-gateway covers the real
    // PostgreSQL bounded-session negotiation independently.
    const legacyFetch: typeof fetch = async (url, init) => {
      const response = await assistant.handle(new Request(url, init));
      if (!String(url).endsWith("/capabilities")) return response;
      const body = await response.json();
      return Response.json({ ...body, value: { ...body.value, displayHistory: false } });
    };
    const client = await createHandrailAiClient({ baseUrl: "https://test.local", startActivityPolling: false,
      fetch: legacyFetch,
      conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
    try {
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      // Listing no longer waits for repair. Its durable effects become visible
      // asynchronously without delaying the metadata response.
      await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "reconciliation_failed" })));
      activityOffline = true;
      const runtime = await client.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
      await runtime.synchronize!();
      activityOffline = false;
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      expect(runtime.getSnapshot().active_turn_id).toBeNull();
      expect(runtime.getSnapshot().messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
      await vi.waitFor(() => expect(activity.getSnapshot()[0]).toMatchObject({ turnStatus: "completed", unread: true, turnId: "turn" }));
      // Catalog reconciliation updates the server; this polling-disabled client
      // must observe that exact result before it can acknowledge it as read.
      await client.activity!.refresh();
      const observed = client.activity!.getSnapshot().find((record) => record.conversationId === "conversation");
      expect(observed?.unread).toBe(true);
      await client.markActivityRead("conversation", observed);
      readEvents.mockClear();
      await client.catalog.list({ authorizationContext: context, lifecycle: "active", pageSize: 20, order: { field: "updated_at", direction: "desc" } });
      if (historyEvents > 0) {
        expect(await input.events.checkpoints.read("conversation" as never)).not.toBeNull();
        await vi.waitFor(() => expect(readEvents.mock.calls.length).toBeGreaterThan(0));
        expect(readEvents.mock.calls.every(([read]) => read.after !== undefined)).toBe(true);
      }
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
            const response = await legacyFetch(url, init);
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
  it.each(["failed", "cancelled"] as const)("settles %s recovery after replaying only part of a retained prefix", async status => {
    const { input, state } = await setup(status, [frames[0]!, frames[1]!, frames[0]!]);
    expect(await reconcileDurableConversationTurn(input)).toBe(true);
    const recovered = await state();
    expect(recovered.turns[0]?.status).toBe(status);
    expect(recovered.active_turn_id).toBeNull();
    expect(recovered.messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
    await reconcileDurableConversationTurn(input);
    expect((await state()).revision).toBe(recovered.revision);
  });
  it("does not fabricate a successful completion when stored evidence is missing", async () => {
    const { input, state } = await setup("completed", []);
    await expect(reconcileDurableConversationTurn(input)).rejects.toThrow();
    expect((await state()).turns[0]?.status).not.toBe("completed");
  });

  const conflictingStart = { ...frames[0]!, attribution: { ...attribution,
    session: { ...attribution.session, id: "refreshed-session" } } } as StreamEvent;
  it.each(["valid", "wrong-turn", "changed-prefix", "changed-snapshot", "uncertain", "bad-sequence", "revoked"] as const)(
    "strictly validates independently retained completed output without rewriting the rejected stream (%s)", async mode => {
      const { input, state } = await setup("completed", [frames[0]!, conflictingStart, ...frames.slice(1)]);
      const original = await input.turns.load("conversation", "turn");
      const diagnostics = vi.fn();
      let revoked = false;
      const readCompletedOutput = vi.fn(async () => {
        if (mode === "uncertain") return null;
        if (mode === "revoked") revoked = true;
        if (mode === "changed-snapshot") await input.turns.compareAndSet({ conversationId: "conversation", turnId: "turn",
          expectedVersion: original!.version, record: { ...original!.record, updatedAt: "2026-09-04T00:00:02.000Z" } });
        return { conversationId: "conversation", turnId: mode === "wrong-turn" ? "other" : "turn", sourceRef: "checkpoint:verified:1",
          events: mode === "changed-prefix" ? [conflictingStart, ...frames.slice(1)]
            : mode === "bad-sequence" ? [frames[0]!, { ...frames[1]!, sequence: 3 }, frames[2]!] : frames,
          result: { status: "completed" as const, checkpoint } };
      });
      const run = () => reconcileDurableConversationTurn({ ...input, diagnostics, readCompletedOutput,
        authorize: async () => { if (revoked) throw Error("Revoked"); } });
      if (mode === "valid") {
        expect(await run()).toBe(true);
        const recovered = await state();
        expect(recovered.turns[0]?.status).toBe("completed");
        expect(recovered.active_turn_id).toBeNull();
        expect(recovered.messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
        const log = await input.events.read({conversationId:"conversation" as never});
        expect(log.entries.find(row=>row.event.payload.type==="turn.completed")?.event.metadata?.handrail_output_recovery)
          .toMatchObject({source_ref:"checkpoint:verified:1",durable_version:original!.version,source_sha256:expect.stringMatching(/^[a-f0-9]{64}$/)});
        await run();
        expect((await state()).revision).toBe(recovered.revision);
      } else {
        await expect(run()).rejects.toThrow();
        expect((await state()).turns[0]?.status).not.toBe("completed");
      }
      expect(readCompletedOutput).toHaveBeenCalledTimes(1);
      expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({code:"invalid_stored_output"}));
      if (mode !== "changed-snapshot") expect(await input.turns.load("conversation", "turn")).toEqual(original);
    });
  const acknowledgedConflict = async () => {
    const fixture = await setup("cancelled", [frames[0]!, frames[1]!, conflictingStart]);
    const saved = (await fixture.input.turns.load("conversation", "turn"))!;
    await fixture.input.turns.compareAndSet({ conversationId: "conversation", turnId: "turn", expectedVersion: saved.version,
      record: { ...saved.record, cancellation: { ...saved.record.cancellation!, acceptedAt: saved.record.updatedAt } } });
    return fixture;
  };
  it("settles acknowledged Stop independently of a rejected replay without rewriting retained evidence", async () => {
    const { input, state } = await acknowledgedConflict();
    const durable = await input.turns.load("conversation", "turn");
    const diagnostics = vi.fn();
    await Promise.all([reconcileDurableConversationTurn({ ...input, diagnostics }), reconcileDurableConversationTurn({ ...input, diagnostics })]);
    const settled = await state();
    expect(settled.turns[0]).toMatchObject({ status: "cancelled", remote_may_still_be_running: false, cancellation_reason: "user" });
    expect(settled.messages[0]?.content).toEqual([{ type: "text", text: "Stored answer" }]);
    expect(settled.active_turn_id).toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_stored_output", retryable: false }));
    expect(await input.turns.load("conversation", "turn")).toEqual(durable);
    const log = await input.events.read({ conversationId: "conversation" as never });
    expect(log.entries.filter(({ event }) => event.payload.type === "turn.cancelled")).toHaveLength(1);
    expect(log.entries.map(({ event }) => event.revision)).toEqual(log.entries.map((_, index) => index + 1));
    await reconcileDurableConversationTurn(input);
    expect((await state()).revision).toBe(settled.revision);
  });
  it("recovers an interrupted cancellation append, including a lost successful reply", async () => {
    const { input, state } = await acknowledgedConflict();
    const append = input.events.append.bind(input.events);
    let interruption: "before" | "after" | null = "before";
    vi.spyOn(input.events, "append").mockImplementation(async request => {
      if (!request.events.some(event => event.payload.type === "turn.cancelled")) return append(request);
      if (interruption === "before") { interruption = "after"; throw new Error("Projection unavailable"); }
      const saved = await append(request);
      if (interruption === "after") { interruption = null; throw new Error("Projection reply lost"); }
      return saved;
    });
    await expect(reconcileDurableConversationTurn(input)).rejects.toThrow("Projection unavailable");
    expect((await state()).turns[0]?.remote_may_still_be_running).toBe(true);
    await expect(reconcileDurableConversationTurn(input)).rejects.toThrow("Projection reply lost");
    await reconcileDurableConversationTurn(input);
    expect((await state()).turns[0]?.status).toBe("cancelled");
    const log = await input.events.read({ conversationId: "conversation" as never });
    expect(log.entries.filter(({ event }) => event.payload.type === "turn.cancelled")).toHaveLength(1);
  });
  it.each(["unacknowledged", "completed", "changed-document", "revoked"] as const)(
    "does not turn uncertain, successful, stale or unauthorized work into cancellation (%s)", async mode => {
      const { input, state } = mode === "completed"
        ? await setup("completed", [frames[0]!, frames[1]!, conflictingStart, frames[2]!])
        : mode === "unacknowledged" ? await setup("cancelled", [frames[0]!, conflictingStart]) : await acknowledgedConflict();
      let revoked = false;
      const authorize = async () => { if (revoked) throw new Error("Access revoked"); };
      // Change the durable generation just before the separate settlement read.
      const load = input.turns.load.bind(input.turns);
      let reads = 0;
      vi.spyOn(input.turns, "load").mockImplementation(async (...args) => {
        const saved = await load(...args);
        return mode === "changed-document" && ++reads > 1 && saved ? { ...saved, version: saved.version + 1 } : saved;
      });
      await expect(reconcileDurableConversationTurn({ ...input, authorize,
        diagnostics: () => { if (mode === "revoked") revoked = true; } })).rejects.toThrow();
      expect((await state()).turns[0]?.remote_may_still_be_running).toBe(true);
      expect((await input.events.read({ conversationId: "conversation" as never })).entries
        .some(({ event }) => event.payload.type === "turn.cancelled")).toBe(false);
    });
});

it.each(['before-replay', 'during-pause-append'] as const)("does not overwrite an approved turn admission with an old pause (%s)", async timing => {
  const { input, state } = await setup("completed", []);
  const original = (await input.turns.load("conversation", "turn"))!;
  const waiting = { ...original.record, status: "waiting_for_approval" as const,
    terminal: { status: "waiting_for_approval" as const, pendingToolCallIds: ["call"], checkpoint } };
  await input.turns.compareAndSet({ conversationId: "conversation", turnId: "turn", expectedVersion: original.version, record: waiting });
  const paused = (await input.turns.load("conversation", "turn"))!;
  const append = input.events.append.bind(input.events);
  const admit = async () => {
    const revision = await input.events.getLatestRevision("conversation" as never);
    await append({ conversationId: "conversation" as never, expectedRevision: revision, events: [parseConversationEvent({
      version: 1, conversation_id: "conversation", event_id: `approval-resume:turn:${paused.version}`,
      revision: (revision ?? 0) + 1, occurred_at: "2026-09-04T00:00:02.000Z",
      actor: { type: "system" }, source: { type: "runtime" },
      payload: { type: "turn.status_changed", turn_id: "turn", status: "running" },
    })] });
  };
  if (timing === 'before-replay') await admit();
  else {
    let admitted = false;
    vi.spyOn(input.events, 'append').mockImplementation(async value => {
      if (!admitted && value.events.some(event => event.payload.type === 'turn.status_changed' && event.payload.status === 'waiting_for_approval')) {
        admitted = true;
        await admit();
      }
      return append(value);
    });
  }
  expect(await reconcileDurableConversationTurn(input)).toBe(false);
  expect(await state()).toMatchObject({ active_turn_id: 'turn', turns: [{ status: 'running', remote_may_still_be_running: true }] });
  const all = await input.events.read({ conversationId: 'conversation' as never });
  expect(all.entries.some(({ event }) => event.payload.type === 'turn.failed')).toBe(false);
});

it('rejects a stale browser pause after approval admission while preserving a later real pause', async () => {
  const { input, state } = await setup('completed', []);
  const original = (await input.turns.load('conversation', 'turn'))!;
  const waiting = { ...original.record, status: 'waiting_for_approval' as const,
    terminal: { status: 'waiting_for_approval' as const, pendingToolCallIds: ['call'], checkpoint } };
  await input.turns.compareAndSet({ conversationId: 'conversation', turnId: 'turn', expectedVersion: original.version, record: waiting });
  const paused = (await input.turns.load('conversation', 'turn'))!;
  await input.events.append({ conversationId: 'conversation' as never, expectedRevision: 1 as never, events: [parseConversationEvent({
    version: 1, conversation_id: 'conversation', event_id: `approval-resume:turn:${paused.version}`, revision: 2,
    occurred_at: '2026-09-04T00:00:02.000Z', actor: { type: 'system' }, source: { type: 'runtime' },
    payload: { type: 'turn.status_changed', turn_id: 'turn', status: 'running' },
  })] });
  const sync = createDurableApplicationConversationSync({ authorizationContext: {}, principalId: 'user',
    eventStore: input.events, turnStore: input.turns, authorizeConversation: () => true });
  const event = parseConversationEvent({ version: 1, conversation_id: 'conversation', event_id: 'stale', mutation_id: 'stale',
    revision: 3, occurred_at: '2026-09-04T00:00:03.000Z', actor: { type: 'assistant' }, source: { type: 'runtime' },
    payload: { type: 'turn.status_changed', turn_id: 'turn', status: 'waiting_for_approval' } });
  const result = await sync.appendMutations({ conversationId: 'conversation' as never, expectedRevision: 2 as never,
    mutations: [{ mutationId: 'stale' as never, events: [{ ...event, mutation_id: 'stale' as never }] }] });
  expect(result.status).toBe('unauthorized');
  expect((await state()).active_turn_id).toBe('turn');
  await input.turns.compareAndSet({ conversationId: 'conversation', turnId: 'turn', expectedVersion: paused.version,
    record: { ...waiting, approvalResumes: 1, terminal: { ...waiting.terminal, pendingToolCallIds: ['second-call'] } } });
  expect(await reconcileDurableConversationTurn(input)).toBe(true);
  expect((await state()).turns[0]?.status).toBe('waiting_for_approval');
});

for (const [wire, canonical] of [["explicit_stop", "user"], ["deadline_exceeded", "timeout"],
  ["policy_revoked", "superseded"], ["runtime_shutdown", "runtime_shutdown"]] as const) {
  for (const supplied of [false, true]) it(`reconciles ${wire} with terminal supplied=${supplied} exactly once`, async () => {
    const { input, state } = await setup("cancelled", supplied
      ? [frames[0]!, { ...envelope, sequence: 1, type: "response.cancelled", reason: wire }] : []);
    const saved = (await input.turns.load("conversation", "turn"))!;
    await input.turns.compareAndSet({ conversationId: "conversation", turnId: "turn", expectedVersion: saved.version,
      record: { ...saved.record, cancellation: supplied ? null : { ...saved.record.cancellation!, reason: canonical } } });
    await reconcileDurableConversationTurn(input);
    const settled = await state();
    expect(settled.turns[0]).toMatchObject({ status: "cancelled", cancellation_reason: canonical, remote_may_still_be_running: false });
    await reconcileDurableConversationTurn(input);
    expect((await state()).revision).toBe(settled.revision);
  });
}

it("rejects a missing cancellation reason when no terminal frame was retained", async () => {
  const { input, state } = await setup("cancelled", []);
  const saved = (await input.turns.load("conversation", "turn"))!;
  await input.turns.compareAndSet({ conversationId: "conversation", turnId: "turn", expectedVersion: saved.version,
    record: { ...saved.record, cancellation: null } });
  await expect(reconcileDurableConversationTurn(input)).rejects.toThrow();
  expect((await state()).turns[0]?.status).not.toBe("cancelled");
});

it.each([["explicit_stop", "user"], ["deadline_exceeded", "timeout"], ["policy_revoked", "superseded"],
  ["runtime_shutdown", "runtime_shutdown"]] as const)("authorizes only the retained %s reason in client synchronization", async (wire, canonical) => {
  const { input, state } = await setup("cancelled", [frames[0]!, { ...envelope, sequence: 1, type: "response.cancelled", reason: wire }]);
  const sync = createDurableApplicationConversationSync({ authorizationContext: {}, principalId: "user",
    eventStore: input.events, turnStore: input.turns, authorizeConversation: () => true });
  const propose = (reason: string, mutationId: string) => {
    const event = parseConversationEvent({ version: 1, conversation_id: "conversation", event_id: mutationId, mutation_id: mutationId,
      revision: 2, occurred_at: "2026-09-04T00:00:01.000Z", actor: { type: "assistant" }, source: { type: "runtime" },
      metadata: { handrail_runtime: { sequence: 1, request_id: envelope.request_id, trace_id: envelope.trace_id, frame_type: "response.cancelled" } },
      payload: { type: "turn.cancelled", turn_id: "turn", reason } });
    return sync.appendMutations({ conversationId: "conversation" as never, expectedRevision: 1 as never,
      mutations: [{ mutationId: mutationId as never, events: [{ ...event, mutation_id: mutationId as never }] }] });
  };
  expect((await propose(canonical === "user" ? "superseded" : "user", "forged-reason")).status).toBe("unauthorized");
  await propose(canonical, "correct-reason");
  expect((await state()).turns[0]).toMatchObject({ status: "cancelled", cancellation_reason: canonical });
});
