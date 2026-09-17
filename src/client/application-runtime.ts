import type { ConversationId, ConversationRevision, ConversationTurnId } from "../conversation/events.js";
import type { ConversationDisplayTurnControl } from "../conversation/display-control.js";
import type { ConversationPresentationRuntime, ConversationPresentationSelector, ConversationPresentationState,
  ConversationPresentationStore, ConversationPresentationTurn, ConversationPresentationTurnResult } from "../conversation/presentation.js";
import type { ConversationStoreEquality, ConversationStoreSelectorListener } from "../conversation/store.js";
import { ApplicationConversationSession, type ApplicationConversationSessionOptions,
  type ApplicationConversationSessionSnapshot } from "./application-session.js";

/** Derive only loaded presentation facts; no fake checkpoint or replay markers. */
export function applicationConversationPresentation(snapshot: ApplicationConversationSessionSnapshot): ConversationPresentationState {
  const messages = snapshot.window.records.flatMap(record => record.kind === "message" && record.value
    ? [{ ...record.value, turn_id: record.turnId as ConversationTurnId | null }] : []);
  const related = snapshot.related.filter(record => record.value && !record.deleted);
  const turns = new Map<string, ConversationPresentationTurn>();
  for (const record of related) if (record.kind === "turn" && record.value) turns.set(record.id, record.value);
  for (const control of [snapshot.control?.latestTurn, snapshot.control?.activeTurn]) {
    if (!control) continue;
    const previous = turns.get(control.turnId);
    const ids = (role: "user" | "assistant") => messages.filter(message => message.turn_id === control.turnId && message.role === role).map(message => message.message_id);
    turns.set(control.turnId, { turn_id: control.turnId as ConversationTurnId, status: control.status,
      error: control.error, remote_may_still_be_running: control.remoteMayStillBeRunning,
      input_message_ids: previous?.input_message_ids ?? ids("user"), output_message_ids: previous?.output_message_ids ?? ids("assistant"),
      outcome: previous?.outcome ?? null, continuation_of_turn_id: previous?.continuation_of_turn_id ?? null });
  }
  return Object.freeze({ partial: true, conversation_id: snapshot.conversationId as ConversationId,
    revision: snapshot.control?.canonicalRevision ? snapshot.control.canonicalRevision as ConversationRevision : null,
    active_turn_id: snapshot.control?.activeTurnId as ConversationTurnId | null ?? null,
    messages: Object.freeze(messages), attachments: Object.freeze([]), turns: Object.freeze([...turns.values()]),
    tool_calls: Object.freeze(related.flatMap(record => record.kind === "tool" && record.value ? [record.value] : [])),
    approval_proposals: Object.freeze(related.flatMap(record => record.kind === "approval" && record.value ? [record.value] : [])),
    tool_loop_budget_exhaustions: Object.freeze(related.flatMap(record => record.kind === "budget" && record.value ? [record.value] : [])),
    citations: Object.freeze(related.flatMap(record => record.kind === "citation" && record.value ? [record.value] : [])),
    citation_sources: Object.freeze(related.flatMap(record => record.kind === "source" && record.value ? [record.value] : [])),
    usage_receipt_links: Object.freeze([]), metadata: Object.freeze({}), title: null, replay_error: null });
}
function result(control: ConversationDisplayTurnControl): ConversationPresentationTurnResult {
  if (!["completed", "cancelled", "failed", "waiting_for_approval"].includes(control.status)) throw new Error("Turn has not settled");
  return { turnId: control.turnId as ConversationTurnId, status: control.status as ConversationPresentationTurnResult["status"],
    ...(control.error ? { error: control.error } : {}) };
}

/** UI-compatible read-only runtime backed by a bounded, server-owned session. */
export function createApplicationConversationRuntime<TRequest>(options: ApplicationConversationSessionOptions<TRequest>): ConversationPresentationRuntime<TRequest> {
  const session = new ApplicationConversationSession(options);
  let snapshot = applicationConversationPresentation(session.getSnapshot());
  const listeners = new Set<() => void>();
  session.subscribe(() => {
    snapshot = applicationConversationPresentation(session.getSnapshot());
    for (const listener of listeners) { try { listener(); } catch { /* Observers cannot interrupt durable admission. */ } }
  });
  function select<T>(selector: ConversationPresentationSelector<T>): T;
  function select<T>(selector: ConversationPresentationSelector<T>, listener: ConversationStoreSelectorListener<T>, isEqual?: ConversationStoreEquality<T>): () => void;
  function select<T>(selector: ConversationPresentationSelector<T>, listener?: ConversationStoreSelectorListener<T>, isEqual: ConversationStoreEquality<T> = Object.is): T | (() => void) {
    let previous = selector(snapshot);
    if (!listener) return previous;
    return store.subscribe(() => { const next = selector(snapshot); if (!isEqual(previous, next)) { const old = previous; previous = next; listener(next, old); } });
  }
  const store: ConversationPresentationStore = { getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, select };
  const runtime: ConversationPresentationRuntime<TRequest> = {
    store, displaySession: session, getSnapshot: store.getSnapshot, observe: observer => store.subscribe(() => observer(snapshot)),
    synchronize: () => session.refresh(), setSynchronizationActive: active => { void session.setActive(active).catch(() => undefined); },
    sendMessage: async input => result(await session.sendMessage(input)),
    resumeTurn: async turnId => result(await session.waitForTurn(turnId)),
    stopObserving: turnId => session.stopObserving(turnId),
    restoreActiveTurn: async () => { await session.refresh(); const active = session.getSnapshot().control?.activeTurnId;
      return active ? result(await session.waitForTurn(active)) : null; },
    cancelTurn: async (turnId, reason) => ({ turnId, reason, status: await session.cancelTurn(turnId, reason),
      remoteMayStillBeRunning: session.getSnapshot().control?.requestedTurn?.remoteMayStillBeRunning ?? Boolean(session.getSnapshot().control?.activeTurnId === turnId) }),
    destroy: () => { session.dispose(); snapshot = applicationConversationPresentation(session.getSnapshot()); listeners.clear(); },
  };
  // Return immediately: loading/error state is renderable and switching can abort it.
  void session.initialize().catch(() => undefined);
  return runtime;
}
