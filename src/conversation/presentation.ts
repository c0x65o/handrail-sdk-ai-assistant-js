import type { ConversationState, ConversationTurnRecord } from "./state.js";
import type { ConversationStoreEquality, ConversationStoreListener, ConversationStoreSelectorListener } from "./store.js";
import type { ConversationRuntimeCancellationResult, ConversationRuntimeSendMessageInput, ConversationRuntimeTurnResult } from "../runtime.js";
import type { ConversationTurnCancellationReason, ConversationTurnId } from "./events.js";
import type { ApplicationConversationSession } from "../client/application-session.js";

/** Facts needed by presentation. A loaded window does not claim complete audit,
 * retry, transport-resume, or provider-context state. Canonical stores also fit. */
export type ConversationPresentationTurn = Pick<ConversationTurnRecord, "turn_id" | "status" | "error" |
  "remote_may_still_be_running" | "input_message_ids" | "output_message_ids" | "outcome" | "continuation_of_turn_id"> &
  Partial<Pick<ConversationTurnRecord, "terminal_at" | "started_at">>;
export interface ConversationPresentationState extends Omit<ConversationState,
  "processed_event_ids" | "processed_mutation_ids" | "last_event_id" | "turns"> {
  readonly turns: readonly ConversationPresentationTurn[];
  /** True means arrays contain only the loaded display window. */
  readonly partial?: true;
}
export type ConversationPresentationSelector<T> = (snapshot: ConversationPresentationState) => T;
export interface ConversationPresentationStore {
  getSnapshot(): ConversationPresentationState;
  subscribe(listener: ConversationStoreListener): () => void;
  select<T>(selector: ConversationPresentationSelector<T>): T;
  select<T>(selector: ConversationPresentationSelector<T>, listener: ConversationStoreSelectorListener<T>,
    isEqual?: ConversationStoreEquality<T>): () => void;
}
/** Sending through a server-owned session cannot manufacture a checkpoint. */
export type ConversationPresentationTurnResult = Pick<ConversationRuntimeTurnResult, "turnId" | "status" | "error">;
export interface ConversationPresentationRuntime<TRequest = unknown> {
  readonly store: ConversationPresentationStore;
  readonly displaySession?: ApplicationConversationSession<TRequest>;
  getSnapshot(): ConversationPresentationState;
  observe(observer: (snapshot: ConversationPresentationState) => void): () => void;
  synchronize?(): Promise<void>;
  setSynchronizationActive?(active: boolean): void;
  sendMessage(input: ConversationRuntimeSendMessageInput<TRequest>): Promise<ConversationPresentationTurnResult>;
  resumeTurn(turnId: ConversationTurnId): Promise<ConversationPresentationTurnResult>;
  restoreActiveTurn(): Promise<ConversationPresentationTurnResult | null>;
  stopObserving(turnId: ConversationTurnId): boolean;
  cancelTurn(turnId: ConversationTurnId, reason: ConversationTurnCancellationReason): Promise<ConversationRuntimeCancellationResult>;
  destroy(): void;
}
