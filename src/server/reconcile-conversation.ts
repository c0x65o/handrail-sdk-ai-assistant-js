import { createHash } from "node:crypto";
import { createConversationRuntime } from "../runtime.js";
import { createRetryPolicy } from "../retry.js";
import { replayConversation } from "../conversation/replay.js";
import { parseConversationEvent, type ConversationId, type ConversationEventPayload } from "../conversation/events.js";
import { ConversationEventStoreConflictError, type ConversationEventStore } from "../conversation/event-store.js";
import { AI_RUNTIME_PROTOCOL_VERSION, parseStreamEvent, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../protocol.js";
import type { DurableApplicationTurnStore, DurableApplicationTurnRecord } from "../transports/durable.js";
import type { ConversationTransport, TurnObservationResult } from "../transports/types.js";
import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from "../usage.js";

const emptyCheckpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const terminalFrame = (frame: StreamEvent) => ["response.completed", "response.cancelled", "response.error"].includes(frame.type);

function storedObservation(record: DurableApplicationTurnRecord<ChatRequest, StreamEvent>, attribution: AuthoritativeAttribution) {
  if (!record.terminal || record.terminal.status === "disconnected" || record.terminal.status !== record.status) throw new TypeError("The durable turn has no terminal outcome");
  const frames = record.events.map(({ event }) => parseStreamEvent(event));
  const last = frames.at(-1);
  const expected = record.status === "completed" ? "response.completed" : record.status === "cancelled" ? "response.cancelled" : "response.error";
  if (last?.type !== expected) {
    if (record.status === "completed") throw new TypeError("A completed durable turn is missing its completion frame");
    if (last && terminalFrame(last)) frames.pop();
    // Worker failure or authoritative cancellation can finish before a provider terminal frame.
    // These are runtime facts; no provider usage is synthesized.
    if (frames.length === 0) frames.push(parseStreamEvent({ type: "response.started", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: `recovery-${createHash("sha256").update(`${record.conversationId}:${record.turnId}`).digest("hex")}`,
      trace_id: `recovery-${createHash("sha256").update(record.turnId).digest("hex")}`, sequence: 0, attribution }));
    const preceding = frames.at(-1)!;
    frames.push(parseStreamEvent({ protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: preceding.request_id, trace_id: preceding.trace_id, sequence: preceding.sequence + 1,
      ...(record.status === "cancelled" ? { type: "response.cancelled", reason: record.cancellation?.reason === "timeout"
        ? "deadline_exceeded" : "runtime_shutdown" } : { type: "response.error", error: { category: "internal", code: "internal_error",
        message: "The assistant could not complete this request. Your message and attachments are saved.", retryable: record.terminal.status === "failed" && record.terminal.error.retryable } }) }));
  }
  const result: TurnObservationResult = { ...record.terminal, checkpoint: emptyCheckpoint };
  return { events: (async function* () { yield* frames; })(), result: Promise.resolve(result), disconnect() {} };
}

/** Replays trusted stored output through the shared runtime; never starts a provider or domain tool. */
export async function reconcileDurableConversationTurn(input: {
  readonly conversationId: string;
  readonly turnId: string;
  readonly events: ConversationEventStore;
  readonly turns: DurableApplicationTurnStore<ChatRequest, StreamEvent>;
  readonly attribution: AuthoritativeAttribution;
  readonly usageReceiptSink?: { capture(receipt: NormalizedUsageReceipt): Promise<void> };
}): Promise<boolean> {
  const document = await input.turns.load(input.conversationId, input.turnId);
  if (!document || document.record.status === "pending" || document.record.status === "running") return false;
  const record = document.record;
  const receipt = record.terminal && record.terminal.status !== "disconnected" && record.terminal.usageReceipt
    ? parseNormalizedUsageReceipt(record.terminal.usageReceipt) : null;
  if (receipt && (receipt.conversation_id !== input.conversationId || receipt.turn_id !== input.turnId)) {
    throw new TypeError("The stored usage receipt belongs to a different turn");
  }
  // Capture even if another projector already completed the transcript. The sink
  // durably deduplicates receipt identity before its best-effort delivery.
  if (receipt) await input.usageReceiptSink?.capture(receipt);
  const conversationId = input.conversationId as ConversationId;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const replay = await replayConversation({ conversationId, eventStore: input.events, checkpointPolicy: false });
    const state = replay.state;
    replay.store.destroy();
    const turn = state.turns.find((candidate) => candidate.turn_id === input.turnId);
    if (!turn || turn.started_at === null) return false;
    if (receipt && !state.usage_receipt_links.some((link) => link.usage_receipt_id === receipt.usage_receipt_id)) {
      try {
        await input.events.append({ conversationId, expectedRevision: state.revision, events: [parseConversationEvent({
          version: 1, event_id: `reconciled-usage:${createHash("sha256").update(JSON.stringify([conversationId, input.turnId, receipt.usage_receipt_id])).digest("hex")}`,
          conversation_id: conversationId, revision: (state.revision ?? 0) + 1, occurred_at: record.updatedAt,
          actor: { type: "system" }, source: { type: "runtime" },
          payload: { type: "usage.receipt_linked", turn_id: input.turnId, usage_receipt_id: receipt.usage_receipt_id },
        })] });
        continue;
      } catch (cause) {
        if (cause instanceof ConversationEventStoreConflictError) continue;
        throw cause;
      }
    }
    if (turn.status === "completed" || turn.status === "cancelled" || turn.status === "failed") {
      if (turn.status !== record.status) throw new TypeError("Canonical and durable terminal outcomes disagree");
      return true;
    }
    // Bind the canonical identity even if the browser disconnected before receiving its start handle.
    const bindingId = `reconcile-binding:${createHash("sha256").update(JSON.stringify([conversationId, input.turnId])).digest("hex")}`;
    const history = await input.events.read({ conversationId, limit: 500 });
    let bound = history.entries.some(({ event }) => event.event_id === bindingId ||
      "turn_id" in event.payload && event.payload.turn_id === input.turnId &&
      (event.metadata?.handrail_runtime as { transport_turn_id?: unknown } | undefined)?.transport_turn_id === input.turnId);
    let page = history;
    while (!bound && page.hasMore) {
      if (!page.nextCursor) throw new TypeError("Reconciliation history did not advance");
      const previous = page.nextCursor;
      page = await input.events.read({ conversationId, after: { cursor: previous }, limit: 500 });
      bound = page.entries.some(({ event }) => event.event_id === bindingId ||
        "turn_id" in event.payload && event.payload.turn_id === input.turnId &&
        (event.metadata?.handrail_runtime as { transport_turn_id?: unknown } | undefined)?.transport_turn_id === input.turnId);
      if (page.hasMore && previous === page.nextCursor) throw new TypeError("Reconciliation history did not advance");
    }
    const bindings: { id: string; payload: ConversationEventPayload }[] = [];
    if (record.status === "cancelled" && record.cancellation && turn.cancellation_requested_reason === null) {
      bindings.push({ id: `${bindingId}:cancellation`, payload: { type: "turn.cancellation_requested",
        turn_id: input.turnId as never, reason: record.cancellation.reason } });
    }
    if (!bound) bindings.push({ id: bindingId, payload: { type: "turn.status_changed", turn_id: input.turnId as never, status: turn.status } });
    if (record.cancellation && turn.cancellation_requested_reason === null) bindings.push({ id: `${bindingId}-cancel`,
      payload: { type: "turn.cancellation_requested", turn_id: input.turnId as never, reason: record.cancellation.reason } });
    if (bindings.length > 0) {
      try {
        await input.events.append({ conversationId, expectedRevision: state.revision, events: bindings.map((binding, index) => parseConversationEvent({
          version: 1, event_id: binding.id, conversation_id: conversationId, revision: (state.revision ?? 0) + index + 1,
          occurred_at: record.updatedAt, actor: { type: "system" }, source: { type: "runtime" },
          metadata: { handrail_runtime: { transport_turn_id: input.turnId } }, payload: binding.payload,
        })) });
      } catch (cause) {
        if (cause instanceof ConversationEventStoreConflictError) continue;
        throw cause;
      }
    }
    const transport: ConversationTransport<StreamEvent, ChatRequest> = {
      capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
      async startTurn() { throw new Error("Reconciliation cannot start work"); },
      async resumeTurn() { return { ok: true, value: storedObservation(record, input.attribution) }; },
    };
    const runtime = await createConversationRuntime({ conversationId, clientId: "server-reconciliation" as never,
      eventStore: input.events, transport, retryPolicy: createRetryPolicy({ maximumAttempts: 1 }) });
    try {
      const current = runtime.getSnapshot().turns.find((candidate) => candidate.turn_id === input.turnId);
      if (current && ["completed", "cancelled", "failed"].includes(current.status)) continue;
      const outcome = await runtime.resumeTurn(input.turnId as never);
      if (outcome.status === record.status) return true;
      if (outcome.status !== "interrupted") throw new Error("Stored turn output did not reach its durable outcome");
    } catch (cause) {
      // A browser or another reconciler may have finalized during our CAS rebase.
      if (runtime.getSnapshot().turns.some((candidate) => candidate.turn_id === input.turnId && candidate.status === record.status)) return true;
      throw cause;
    } finally { runtime.destroy(); }
  }
  throw new Error("Stored turn output could not be reconciled after concurrent writes");
}
