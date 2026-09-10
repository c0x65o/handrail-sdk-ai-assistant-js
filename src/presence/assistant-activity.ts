import type { ConversationTransport, ResumeTurnInput, StartTurnInput, TurnHandle, TurnObservation } from "../transports/types.js";
import type { LivePresenceDelivery } from "./live-delivery.js";
import { parsePresenceRecord, type AssistantActivity, type PresenceRecord } from "./types.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

export interface AssistantActivityTransportOptions<TEvent, TRequest> {
  readonly delegate: ConversationTransport<TEvent, TRequest>;
  readonly delivery: LivePresenceDelivery;
  readonly participantId?: string;
  readonly sessionId: (conversationId: string, turnId: string) => string;
  readonly activityForEvent: (event: TEvent) => AssistantActivity | null;
  readonly ttlMilliseconds?: number;
  readonly now?: () => number;
  readonly diagnostics?: AiDiagnosticSink;
}

/** Adds automatic ephemeral assistant activity without changing durable event replay. */
export function createAssistantActivityTransport<TEvent, TRequest>(
  options: AssistantActivityTransportOptions<TEvent, TRequest>,
): ConversationTransport<TEvent, TRequest> {
  const ttl = options.ttlMilliseconds ?? 45_000, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 300_000) throw new TypeError("ttlMilliseconds is invalid");
  const publish = async (conversationId: string, turnId: string, activity: AssistantActivity | null, leave = false) => {
    const current = now(), record: PresenceRecord = parsePresenceRecord({ participant_id: options.participantId ?? "assistant",
      session_id: options.sessionId(conversationId, turnId), participant_kind: "assistant",
      state: leave ? "offline" : "active", ...(activity === null ? {} : { assistant_activity: activity }), typing: false,
      updated_at: new Date(current).toISOString(), expires_at: new Date(current + ttl).toISOString() });
    try { await options.delivery.publish(conversationId, leave ? "leave" : "upsert", record); }
    catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "presence", operation: "assistant_activity",
      phase: "failed", conversationId, turnId, code: "publish_failed", retryable: true, cause }); }
  };
  const wrap = (handle: TurnHandle<TEvent>): TurnHandle<TEvent> => {
    const original = handle.observation;
    let finishEvents!: () => void;
    const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
    const observation: TurnObservation<TEvent> = { events: (async function* () {
      await publish(handle.conversationId, handle.turnId, "thinking");
      try { for await (const event of original.events) {
          const activity = options.activityForEvent(event); if (activity) await publish(handle.conversationId, handle.turnId, activity);
          yield event;
        } } finally { finishEvents(); }
    })(), result: (async () => { const result = await original.result; await eventsFinished;
      await publish(handle.conversationId, handle.turnId, null, true); return result; })(),
    disconnect: () => original.disconnect() };
    return Object.freeze({ ...handle, observation });
  };
  return Object.freeze({ capabilities: options.delegate.capabilities,
    async startTurn(input: StartTurnInput<TRequest>, context?: Parameters<typeof options.delegate.startTurn>[1]) {
      const result = await options.delegate.startTurn(input, context);
      return result.ok ? { ok: true as const, value: wrap(result.value) } : result; },
    async resumeTurn(input: ResumeTurnInput) { const result = await options.delegate.resumeTurn(input);
      if (!result.ok) return result;
      const handle = wrap({ conversationId: input.conversationId, turnId: input.turnId, mutationId: "resume", observation: result.value });
      return { ok: true as const, value: handle.observation }; },
  });
}
