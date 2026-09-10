import { parseStreamEvent, type ChatRequest, type StreamEvent } from "../protocol.js";
import { sha256Text } from "../provider-context.js";
import type { DurableApplicationTurnStore } from "../transports/durable.js";
import type { ConversationTransport } from "../transports/types.js";
import type { ConversationEvent, ConversationEventPayload, ConversationId } from "../conversation/events.js";
import type { ConversationSyncMutationEvent } from "./types.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { findConversationEvent } from "../conversation/find-event.js";
import { replayConversation } from "../conversation/replay.js";
import type { AiDiagnosticSink } from "../diagnostics.js";
import { createEventStoreConversationSyncAdapter, type CanonicalConversationSyncMutation } from "./event-store-adapter.js";

export interface DurableApplicationConversationSyncOptions<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly principalId: string;
  readonly eventStore: ConversationEventStore;
  readonly turnStore: DurableApplicationTurnStore<ChatRequest, StreamEvent>;
  readonly authorizeConversation: (conversationId: ConversationId) => boolean | Promise<boolean>;
  readonly diagnostics?: AiDiagnosticSink;
}

/**
 * Authoritative browser/runtime synchronization. User proposals are re-authored
 * from the principal; assistant proposals must exactly match a retained durable
 * provider frame before entering the canonical log.
 */
export function createDurableApplicationConversationSync<TAuthorizationContext>(
  options: DurableApplicationConversationSyncOptions<TAuthorizationContext>,
) {
  return createEventStoreConversationSyncAdapter({
    authorizationContext: options.authorizationContext,
    eventStore: options.eventStore,
    authorize: ({ conversationId }) => options.authorizeConversation(conversationId),
    allowRuntimeMutationProposals: true,
    canonicalizeMutation: ({ conversationId, proposedEvent }) => canonicalize(
      proposedEvent, conversationId, options.principalId, options.turnStore, options.eventStore,
    ),
    validateCanonicalBatch: async ({ conversationId, events }) => {
      const replay = await replayConversation({ conversationId, eventStore: options.eventStore, checkpointPolicy: false });
      const state = await replay.store.applyEvents(events);
      if (state.replay_error !== null) throw new TypeError("The proposed history is not a valid canonical transition");
    },
    createEventId: ({ conversationId, mutationId }) =>
      `assistant-sync:${digest(`${conversationId}\0${mutationId}`)}` as never,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
}

/** Reject provider starts that do not match the already-admitted canonical user turn. */
export function qualifyDurableApplicationTurnStarts(
  transport: ConversationTransport<StreamEvent, ChatRequest>,
  eventStore: ConversationEventStore,
): ConversationTransport<StreamEvent, ChatRequest> {
  const qualified: ConversationTransport<StreamEvent, ChatRequest> = {
    capabilities: transport.capabilities,
    async startTurn(input, context) {
      try {
        const replay = await replayConversation({ conversationId: input.conversationId as ConversationId,
          eventStore, checkpointPolicy: false });
        const state = replay.state;
        replay.store.destroy();
        const turn = state.turns.find((candidate) => candidate.turn_id === input.conversationTurnId);
        const message = turn?.input_message_ids.length === 1
          ? state.messages.find((candidate) => candidate.message_id === turn.input_message_ids[0]) : undefined;
        const proposed = input.request.messages.filter((candidate) => candidate.role === "user").at(-1);
        const proposedText = proposed?.content.filter((part) => part.type === "text") ?? [];
        if (!turn || !message || message.role !== "user" || !proposed || json(message.content) !== json(proposedText)) {
          throw new TypeError("The turn does not match its saved user message.");
        }
        const admission = await findConversationEvent(eventStore, input.conversationId as ConversationId,
          (event) => event.payload.type === "message.created" && event.payload.message_id === message.message_id);
        if (!admission) throw new TypeError("The saved user message for this turn could not be found.");
        if (admission.mutation_id !== input.mutationId) {
          throw new TypeError("The turn identity does not match its saved user message.");
        }
        const retainedAttachments = message.attachments.map((attachment) => ({ attachment_id: attachment.attachment_id,
          media_type: attachment.media_type, byte_size: attachment.size_bytes ?? null,
          filename: attachment.filename ?? null })).sort(byAttachmentId);
        const requestedAttachments = proposed.content.filter((part) => part.type !== "text").map((part) => ({
          attachment_id: part.attachment.attachment_id, media_type: part.attachment.media_type,
          byte_size: part.attachment.byte_size, filename: part.attachment.filename ?? null,
        })).sort(byAttachmentId);
        if (json(retainedAttachments) !== json(requestedAttachments)) {
          throw new TypeError("The turn attachments do not match its saved user message.");
        }
        return guardCanonicalTurnExecution(transport, eventStore).startTurn(input, context);
      } catch (error) {
        return { ok: false as const, error: { code: "invalid_request" as const, retryable: false,
          message: error instanceof Error ? error.message : "Canonical turn admission is invalid." } };
      }
    },
    resumeTurn: (input) => transport.resumeTurn(input),
  };
  return Object.freeze(qualified);
}

/**
 * Install inside the durable worker, immediately around the provider delegate.
 * Retained durable results can still replay; new execution requires an active
 * canonical turn, including after recovery or a delayed start request.
 */
export function guardCanonicalTurnExecution<TEvent, TRequest>(
  transport: ConversationTransport<TEvent, TRequest>,
  eventStore: ConversationEventStore,
): ConversationTransport<TEvent, TRequest> {
  return Object.freeze({
    capabilities: transport.capabilities,
    async startTurn(input: Parameters<typeof transport.startTurn>[0], context?: Parameters<typeof transport.startTurn>[1]) {
      try {
        const replay = await replayConversation({ conversationId: input.conversationId as ConversationId,
          eventStore, checkpointPolicy: false });
        try {
          const turn = replay.state.turns.find((candidate) => candidate.turn_id === input.conversationTurnId);
          if (replay.state.replay_error !== null || !turn ||
            replay.state.active_turn_id !== input.conversationTurnId ||
            !turn.remote_may_still_be_running || turn.cancellation_status === "requested" ||
            !["queued", "running", "waiting_for_tool_result"].includes(turn.status)) {
            return { ok: false as const, error: { code: "invalid_request" as const, retryable: false,
              message: "The saved turn is no longer active and cannot execute." } };
          }
        } finally { replay.store.destroy(); }
      } catch {
        return { ok: false as const, error: { code: "unavailable" as const, retryable: true,
          message: "The saved turn could not be verified before execution." } };
      }
      return transport.startTurn(input, context);
    },
    resumeTurn: (input: Parameters<typeof transport.resumeTurn>[0]) => transport.resumeTurn(input),
  });
}

async function canonicalize(
  proposed: ConversationSyncMutationEvent,
  conversationId: ConversationId,
  principalId: string,
  turnStore: DurableApplicationTurnStore<ChatRequest, StreamEvent>,
  eventStore: ConversationEventStore,
): Promise<CanonicalConversationSyncMutation> {
  const payload = proposed.payload;
  if (payload.type === "message.created") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user" || payload.role !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  if (payload.type === "message.attachment_referenced") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  if (payload.type === "turn.started") {
    if (proposed.source.type !== "runtime" || proposed.actor.type !== "assistant" ||
      payload.input_message_ids.length !== 1 || payload.continuation_of_turn_id !== undefined) deny();
    return canonical(proposed, { type: "assistant" });
  }
  if (payload.type === "turn.attempt_started" || payload.type === "turn.retry_scheduled" ||
    payload.type === "turn.retry_exhausted") {
    if (proposed.source.type !== "runtime" || proposed.actor.type !== "assistant") deny();
    return canonical(proposed, { type: "assistant" });
  }
  if (payload.type === "turn.cancellation_requested" || payload.type === "turn.cancellation_unsupported") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  const metadata = runtimeMetadata(proposed);
  const turnId = payloadTurnId(payload) ?? (typeof metadata.turn_id === "string" ? metadata.turn_id : null);
  if (!turnId || proposed.source.type !== "runtime" || proposed.actor.type !== "assistant") deny();
  const durable = await turnStore.load(conversationId, turnId);
  if (!durable) deny();
  if (payload.type === "turn.status_changed" && metadata.checkpoint !== undefined && metadata.frame_type === undefined) {
    const checkpoint = metadata.checkpoint;
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) deny();
    const point = checkpoint as Record<string, unknown>;
    if (Object.keys(point).length !== 3 || typeof point.last_applied_event_id !== "string" ||
      typeof point.last_applied_cursor !== "string" || !Number.isSafeInteger(point.last_applied_revision)) deny();
    const retained = durable.record.events.find((entry) => entry.checkpoint.lastAppliedEventId === point.last_applied_event_id &&
      entry.checkpoint.lastAppliedCursor === point.last_applied_cursor);
    if (!retained) throw new TypeError("Checkpoint is not retained in durable output");
    const replay = await replayConversation({ conversationId, eventStore, checkpointPolicy: false });
    const state = replay.state;
    replay.store.destroy();
    const turn = state.turns.find((candidate) => candidate.turn_id === turnId);
    if (turn?.status !== payload.status || Number(point.last_applied_revision) > (state.revision ?? 0)) throw new TypeError("Checkpoint status or revision is invalid");
    let page = await eventStore.read({ conversationId, limit: 500 });
    for (;;) {
      if (page.entries.some(({ event }) => {
        const evidence = runtimeMetadata(event);
        return event.revision <= Number(point.last_applied_revision) && evidence.resume_safe === true &&
          evidence.request_id === retained.event.request_id && evidence.sequence === retained.event.sequence;
      })) return canonical(proposed, { type: "assistant" });
      if (!page.hasMore || !page.nextCursor) throw new TypeError("Checkpoint has no canonical frame evidence");
      const cursor = page.nextCursor;
      page = await eventStore.read({ conversationId, after: { cursor }, limit: 500 });
      if (page.hasMore && page.nextCursor === cursor) deny();
    }
  }
  if (payload.type === "turn.status_changed" && payload.status === "queued") {
    if (runtimeMetadata(proposed).transport_turn_id !== turnId) deny();
    return canonical(proposed, { type: "assistant" });
  }
  const frame = retainedFrame(proposed, durable.record.events.map((entry) => entry.event));
  if (!frame || !payloadMatchesFrame(payload, frame, turnId)) deny();
  return canonical(proposed, { type: "assistant" });
}

function canonical(proposed: ConversationSyncMutationEvent, actor: ConversationEvent["actor"]): CanonicalConversationSyncMutation {
  return Object.freeze({ actor, source: { type: "sync" as const }, payload: proposed.payload,
    ...(proposed.metadata === undefined ? {} : { metadata: proposed.metadata }) });
}

function retainedFrame(proposed: ConversationSyncMutationEvent, events: readonly StreamEvent[]): StreamEvent | null {
  const metadata = runtimeMetadata(proposed);
  if (typeof metadata.sequence !== "number" || typeof metadata.request_id !== "string" ||
    typeof metadata.trace_id !== "string" || typeof metadata.frame_type !== "string") return null;
  const frame = events.map(parseStreamEvent).find((candidate) => candidate.sequence === metadata.sequence);
  return frame && frame.request_id === metadata.request_id && frame.trace_id === metadata.trace_id &&
    frame.type === metadata.frame_type ? frame : null;
}

function payloadMatchesFrame(payload: ConversationEventPayload, frame: StreamEvent, turnId: string): boolean {
  switch (frame.type) {
    case "response.started": return payload.type === "turn.status_changed" && payload.status === "running" && payload.turn_id === turnId;
    case "response.text.delta": return payload.type === "message.text_appended" && payload.turn_id === turnId && payload.text === frame.delta;
    case "response.tool_call": return payload.type === "tool_call.requested" && payload.turn_id === turnId &&
      payload.tool_call_id === frame.tool_call_id && payload.name === frame.name && json(payload.arguments) === json(frame.arguments);
    case "response.citation_batch": return payload.type === "citation.records_linked" && json(payload.sources) === json(frame.sources) &&
      json(payload.citations.map(withoutTarget)) === json(frame.citations.map(withoutTarget));
    case "response.completed": return payload.type === "turn.completed" && payload.turn_id === turnId && payload.outcome === frame.outcome;
    case "response.cancelled": return payload.type === "turn.cancelled" && payload.turn_id === turnId && payload.reason === cancellationReason(frame.reason);
    case "response.error": return payload.type === "turn.failed" && payload.turn_id === turnId &&
      json(payload.error) === json({ code: frame.error.code, message: frame.error.message, retryable: frame.error.retryable });
    case "response.usage": return false;
  }
}

function payloadTurnId(payload: ConversationEventPayload): string | null {
  return "turn_id" in payload && typeof payload.turn_id === "string" ? payload.turn_id : null;
}
function runtimeMetadata(event: Pick<ConversationEvent, "metadata">): Record<string, unknown> {
  const value = event.metadata?.handrail_runtime;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function cancellationReason(reason: string): "user" | "timeout" | "superseded" | "runtime_shutdown" {
  if (reason === "deadline_exceeded") return "timeout";
  if (reason === "policy_revoked") return "superseded";
  return "runtime_shutdown";
}
function withoutTarget(value: { readonly citation_id: string; readonly source_id: string; readonly order: number }) {
  return { citation_id: value.citation_id, source_id: value.source_id, order: value.order };
}
function byAttachmentId(left: { readonly attachment_id: string }, right: { readonly attachment_id: string }): number {
  return left.attachment_id.localeCompare(right.attachment_id);
}
function digest(value: string): string { return sha256Text(value).slice(0, 32); }
function json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${json(record[key])}`).join(",")}}`;
}
function deny(): never { throw new TypeError("The proposed runtime event is not backed by server authority"); }
