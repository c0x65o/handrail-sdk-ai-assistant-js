import { createHash } from "node:crypto";
import { createConversationRuntime, type ConversationRuntimeTurnResult } from "../runtime.js";
import { createRetryPolicy } from "../retry.js";
import { parseConversationEvent, type ConversationId } from "../conversation/events.js";
import { ConversationEventStoreConflictError, type ConversationEventStore } from "../conversation/event-store.js";
import type { StreamEvent } from "../protocol.js";
import type { ConversationTransport, TurnObservation, TurnObservationResult } from "../transports/types.js";
import type { NormalizedUsageReceipt } from "../usage.js";

const emptyCheckpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
export interface LiveConversationProjection {
  /** Backpressured: resolves after this frame's canonical writes/validation.
   * Terminal settlement still waits for finish and its authoritative outcome.
   * Call sequentially and only after the durable writer has saved the frame. */
  push(frame: StreamEvent): Promise<void>;
  finish(result: TurnObservationResult): Promise<ConversationRuntimeTurnResult>;
  disconnect(): Promise<void>;
}

/** One canonical runtime per active durable writer, independent of browser views.
 * Reuses the protocol/CAS/deduplication machinery used by legacy clients. The
 * input channel retains at most one frame. No display page seeds this runtime.
 * Runtime hydration is still canonical; this is not a bounded display read. */
export async function createLiveConversationProjection(input: {
  readonly conversationId: string;
  readonly turnId: string;
  readonly events: ConversationEventStore;
  readonly authorize: () => Promise<void>;
  readonly usageReceiptSink?: { capture(receipt: NormalizedUsageReceipt): Promise<void> };
}): Promise<LiveConversationProjection | null> {
  await input.authorize();
  type FrameSlot = { frame: StreamEvent; accept: () => void; reject: (cause: unknown) => void };
  let slot: FrameSlot | null = null, inFlight: FrameSlot | null = null;
  let wake: (() => void) | null = null, closed = false, writing = false;
  let resolveResult!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>(resolve => { resolveResult = resolve; });
  const close = (outcome: TurnObservationResult) => {
    if (closed) return;
    closed = true; resolveResult(outcome);
    slot?.reject(new Error("Live projection was closed")); slot = null;
    inFlight?.reject(new Error("Live projection stopped before applying the frame")); inFlight = null;
    wake?.(); wake = null;
  };
  const observation: TurnObservation<StreamEvent> = {
    events: (async function* () {
      while (!closed) {
        if (!slot) await new Promise<void>(resolve => { wake = resolve; });
        if (closed) return;
        const current = slot!; slot = null; inFlight = current;
        yield current.frame;
      }
    })(), result,
    disconnect: () => close({ status: "disconnected", checkpoint: emptyCheckpoint }),
  };
  const transport: ConversationTransport<StreamEvent, unknown> = {
    capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
      attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
    startTurn: async () => { throw new Error("Live projection cannot execute a provider"); },
    resumeTurn: async () => ({ ok: true, value: observation }),
  };
  const events: ConversationEventStore = {
    ...(input.events.checkpoints ? { checkpoints: input.events.checkpoints } : {}),
    read: request => input.events.read(request), getLatestRevision: id => input.events.getLatestRevision(id),
    append: async request => { await input.authorize(); return input.events.append(request); },
  };
  const conversationId = input.conversationId as ConversationId;
  const runtime = await createConversationRuntime({ conversationId, clientId: "server-live-projection" as never,
    eventStore: events, transport, retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
    onFrameApplied: () => { inFlight?.accept(); inFlight = null; },
    ...(input.usageReceiptSink ? { usageReceiptSink: input.usageReceiptSink } : {}) });
  const bindingId = `live-binding:${createHash("sha256").update(JSON.stringify([input.conversationId, input.turnId])).digest("hex")}`;
  try {
    let bound = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = runtime.getSnapshot(), turn = state.turns.find(turn => turn.turn_id === input.turnId);
      if (!turn || !turn.remote_may_still_be_running) { runtime.destroy(); return null; }
      if (state.processed_event_ids.includes(bindingId as never)) { bound = true; break; }
      try {
        await events.append({ conversationId, expectedRevision: state.revision, events: [parseConversationEvent({
          version: 1, event_id: bindingId, conversation_id: conversationId, revision: (state.revision ?? 0) + 1,
          occurred_at: new Date().toISOString(), actor: { type: "system" }, source: { type: "runtime" },
          metadata: { handrail_runtime: { transport_turn_id: input.turnId } },
          payload: { type: "turn.status_changed", turn_id: input.turnId, status: turn.status },
        })] });
        await runtime.synchronize!(); bound = true; break;
      } catch (cause) {
        if (!(cause instanceof ConversationEventStoreConflictError)) throw cause;
        await runtime.synchronize!();
      }
    }
    if (!bound) throw new Error("Live projection could not bind the admitted turn");
  } catch (cause) { runtime.destroy(); throw cause; }
  let failure: unknown;
  const completion = Promise.resolve().then(() => runtime.resumeTurn(input.turnId as never)).then(outcome => {
    if (outcome.status === "interrupted") failure = outcome.error ?? new Error("Live projection interrupted");
    return outcome;
  }).catch(cause => { failure = cause; throw cause; }).finally(() => {
    observation.disconnect(); runtime.destroy();
  });
  void completion.catch(() => {});
  return {
    async push(frame) {
      if (closed) throw failure ?? new Error("Live projection is closed");
      if (writing) throw new Error("Live projection accepts one frame at a time");
      writing = true;
      try {
        await input.authorize();
        if (closed) throw failure ?? new Error("Live projection is closed");
        await new Promise<void>((accept, reject) => { slot = { frame, accept, reject }; wake?.(); wake = null; });
        if (closed) throw failure ?? new Error("Live projection stopped before applying the frame");
      } finally { writing = false; }
    },
    async finish(outcome) { close(outcome); return completion; },
    async disconnect() { observation.disconnect(); runtime.destroy(); await completion.catch(() => {}); },
  };
}
