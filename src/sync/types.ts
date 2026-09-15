import type {
  ConversationClientMutationId,
  ConversationEvent,
  ConversationEventPayload,
  ConversationEventSource,
  ConversationId,
  ConversationJsonValue,
  ConversationRevision,
} from "../conversation/events.js";
import type { PresenceRecord } from "../presence/types.js";

/** The host denied access to the requested conversation. */
export interface ConversationSyncUnauthorized {
  readonly status: "unauthorized";
  readonly message?: string;
}

/** The host could not complete the operation, but a later retry may succeed. */
export interface ConversationSyncTemporarilyUnavailable {
  readonly status: "temporarily_unavailable";
  readonly message?: string;
  readonly retryAfterMilliseconds?: number;
}

/** The mutation was not admitted and cannot succeed unchanged. Keep the draft
 * for user correction, but do not reconnect or automatically retry this batch. */
export interface ConversationSyncMutationRejected {
  readonly status: "rejected";
  readonly code: "invalid_mutation" | "attachment_expired" | "attachment_unavailable" | "attachment_changed" | "attachment_invalid";
  readonly message: string;
}

/**
 * The requested revision can no longer be resumed incrementally.
 *
 * Callers must discard their incremental cursor and call `pullSnapshot`.
 */
export interface ConversationSyncSnapshotRequired {
  readonly status: "snapshot_required";
  readonly reason: "revision_gap" | "compacted";
  readonly latestRevision: ConversationRevision | null;
}

export type ConversationSyncOperationFailure =
  | ConversationSyncUnauthorized
  | ConversationSyncMutationRejected
  | ConversationSyncTemporarilyUnavailable;

export interface PullSnapshotInput {
  readonly conversationId: ConversationId;
}

/** A JSON-safe application snapshot after applying `revision`. */
export interface ConversationSyncSnapshot<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
> {
  readonly conversationId: ConversationId;
  readonly revision: ConversationRevision | null;
  readonly state: TSnapshot;
}

export interface PullSnapshotSuccess<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
> {
  readonly status: "snapshot";
  readonly snapshot: ConversationSyncSnapshot<TSnapshot>;
}

export type PullSnapshotResult<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
> = PullSnapshotSuccess<TSnapshot> | ConversationSyncOperationFailure;

export interface ReadSinceInput {
  readonly conversationId: ConversationId;
  /** `null` reads from the start of durable history. */
  readonly afterRevision: ConversationRevision | null;
  /** Optional positive host-defined page size hint. */
  readonly limit?: number;
}

/** A contiguous batch of durable events after the requested revision. */
export interface ConversationSyncEvents {
  readonly status: "events";
  readonly events: readonly ConversationEvent[];
  /** The final event revision in this batch, or the requested revision if empty. */
  readonly revision: ConversationRevision | null;
  /** The authoritative conversation head observed with this batch. */
  readonly latestRevision: ConversationRevision | null;
  readonly hasMore: boolean;
}

export type ReadSinceResult =
  | ConversationSyncEvents
  | ConversationSyncSnapshotRequired
  | ConversationSyncOperationFailure;

/**
 * One idempotent client-authored mutation.
 *
 * One mutation ID identifies exactly one event/fact, whose `mutation_id` must
 * match this `mutationId`.
 * Proposed envelopes are untrusted input: an application-hosted adapter must
 * authenticate the caller, validate authorization and client event semantics,
 * and return the authoritative stored envelopes in its acknowledgement.
 */
export interface ConversationSyncMutation {
  readonly mutationId: ConversationClientMutationId;
  readonly events: readonly [ConversationSyncMutationEvent];
}

/**
 * A client event proposal accepted by `appendMutations`.
 *
 * Client-provided actor, source, metadata, payload, timestamps, identifiers,
 * and revisions remain untrusted. In particular, a proposed runtime-source or
 * usage-receipt event must never establish assistant output, metering, billing,
 * or trust claims. The server adapter rejects those proposals by default and a
 * host may opt in only when it independently verifies them against its durable
 * turn/provider authority.
 */
export type ConversationSyncMutationEvent = Omit<
  ConversationEvent,
  "mutation_id" | "source"
> & {
  readonly mutation_id: ConversationClientMutationId;
  readonly payload: ConversationEventPayload;
  readonly source: ConversationEventSource;
};

export interface AppendMutationsInput {
  readonly conversationId: ConversationId;
  /** `null` means the caller expects an empty durable history. */
  readonly expectedRevision: ConversationRevision | null;
  /** A non-empty batch in caller order. */
  readonly mutations: readonly ConversationSyncMutation[];
}

export interface ConversationSyncMutationAccepted {
  readonly status: "accepted";
  readonly mutationId: ConversationClientMutationId;
  readonly events: readonly ConversationEvent[];
}

/** A retry acknowledgement for a mutation already represented durably. */
export interface ConversationSyncMutationDuplicate {
  readonly status: "duplicate";
  readonly mutationId: ConversationClientMutationId;
  readonly events: readonly ConversationEvent[];
}

export type ConversationSyncMutationAcknowledgement =
  | ConversationSyncMutationAccepted
  | ConversationSyncMutationDuplicate;

export interface AppendMutationsSuccess {
  readonly status: "mutations";
  readonly acknowledgements: readonly ConversationSyncMutationAcknowledgement[];
  readonly latestRevision: ConversationRevision;
}

/** No mutation was appended because the optimistic revision was stale. */
export interface ConversationSyncConflict {
  readonly status: "conflict";
  readonly expectedRevision: ConversationRevision | null;
  readonly actualRevision: ConversationRevision | null;
}

export type AppendMutationsResult =
  | AppendMutationsSuccess
  | ConversationSyncConflict
  | ConversationSyncSnapshotRequired
  | ConversationSyncOperationFailure;

export interface SubscribeSinceInput {
  readonly conversationId: ConversationId;
  /** `null` subscribes from the start of retained durable history. */
  readonly afterRevision: ConversationRevision | null;
}

/** JSON-serializable messages emitted by a durable sync subscription. */
export type ConversationSyncUpdate =
  | ConversationSyncEvents
  | ConversationSyncSnapshotRequired
  | ConversationSyncOperationFailure;

/** Runtime handle only; implementations may use any underlying transport. */
export interface ConversationSyncSubscription {
  readonly updates: AsyncIterable<ConversationSyncUpdate>;
  close(): void;
}

export interface SubscribeSinceSuccess {
  readonly status: "subscribed";
  readonly subscription: ConversationSyncSubscription;
}

export type SubscribeSinceResult =
  | SubscribeSinceSuccess
  | ConversationSyncSnapshotRequired
  | ConversationSyncOperationFailure;

export interface PublishPresenceInput {
  readonly conversationId: ConversationId;
  readonly record: PresenceRecord;
}

export interface PublishPresenceSuccess {
  readonly status: "published";
  readonly record: PresenceRecord;
}

export type PublishPresenceResult =
  | PublishPresenceSuccess
  | ConversationSyncOperationFailure;

export interface SubscribePresenceInput {
  readonly conversationId: ConversationId;
}

/** An ephemeral presence message which must never enter durable event history. */
export interface ConversationPresenceUpdate {
  readonly status: "presence";
  readonly record: PresenceRecord;
}

export type ConversationPresenceStreamUpdate =
  | ConversationPresenceUpdate
  | ConversationSyncOperationFailure;

export interface ConversationPresenceSubscription {
  readonly updates: AsyncIterable<ConversationPresenceStreamUpdate>;
  close(): void;
}

export interface SubscribePresenceSuccess {
  readonly status: "subscribed";
  readonly subscription: ConversationPresenceSubscription;
}

export type SubscribePresenceResult =
  | SubscribePresenceSuccess
  | ConversationSyncOperationFailure;

/**
 * Application-hosted, provider- and transport-independent multi-device sync.
 *
 * Durable conversation events and ephemeral presence intentionally use
 * separate channels. Implementations must not append presence or typing data to
 * `ConversationEvent` history. Request and result DTOs contain only JSON data;
 * the two subscription handles are local runtime capabilities whose emitted
 * messages are JSON-serializable.
 */
export interface ConversationSyncAdapter<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
> {
  pullSnapshot(input: PullSnapshotInput): Promise<PullSnapshotResult<TSnapshot>>;
  readSince(input: ReadSinceInput): Promise<ReadSinceResult>;
  appendMutations(input: AppendMutationsInput): Promise<AppendMutationsResult>;
  subscribeSince(input: SubscribeSinceInput): Promise<SubscribeSinceResult>;
  publishPresence(input: PublishPresenceInput): Promise<PublishPresenceResult>;
  subscribePresence(input: SubscribePresenceInput): Promise<SubscribePresenceResult>;
}
