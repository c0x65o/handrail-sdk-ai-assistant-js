import type { AttachmentUploadAdapter } from "../attachments/types.js";
import type {
  ConversationTurnCancellationReason,
  ConversationTurnId,
} from "../conversation/events.js";
import type { DocumentInputCapabilityDescriptor } from "../providers/index.js";
import type { NormalizedUsageReceipt } from "../usage.js";

/**
 * A capability is usable only after its negotiated value has been narrowed to
 * `supported: true`. Unsupported capabilities intentionally expose no
 * operation or adapter reference.
 */
export interface UnsupportedTransportCapability {
  readonly supported: false;
}

export interface SupportedTransportCapability<TCapability> {
  readonly supported: true;
  readonly capability: TCapability;
}

export type NegotiatedTransportCapability<TCapability> =
  | UnsupportedTransportCapability
  | SupportedTransportCapability<TCapability>;

export type TransportErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "internal_error";

export interface TransportError {
  readonly code: TransportErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Optional provider-neutral delay hint normalized and bounded by the runtime. */
  readonly retryAfterMs?: number;
}

export interface TransportSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface TransportFailure {
  readonly ok: false;
  readonly error: TransportError;
}

/** A normalized operation result which never exposes implementation errors. */
export type TransportResult<TValue> =
  | TransportSuccess<TValue>
  | TransportFailure;

export interface TurnResumePoint {
  /** The durable event identifier most recently applied by the caller. */
  readonly lastAppliedEventId: string | null;
  /** The opaque transport cursor associated with the last applied event. */
  readonly lastAppliedCursor: string | null;
  /** The conversation revision most recently applied by the caller. */
  readonly lastAppliedRevision: number | null;
}

export interface StartTurnInput<TRequest = unknown> {
  readonly conversationId: string;
  /** Caller-owned durable turn identifier used by conversation state. */
  readonly conversationTurnId: ConversationTurnId;
  /** Caller-generated mutation identifier used by conversation state. */
  readonly mutationId: string;
  /** Caller-generated key used to make retries of this start operation safe. */
  readonly idempotencyKey: string;
  /** Provider-neutral request data understood by the transport implementation. */
  readonly request: TRequest;
}

/** Identity of one successfully claimed durable execution, scoped to its turn store. */
export interface DurableTurnExecutionIdentity {
  readonly conversationId: string;
  readonly turnId: string;
  /** One-based persisted claim ordinal; recovery claims a new attempt. */
  readonly attempt: number;
}

/** Trusted in-process context. Never serialized as part of StartTurnInput or HTTP. */
export interface TurnExecutionContext {
  readonly durableExecution?: DurableTurnExecutionIdentity;
}

export interface ResumeTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly resumeFrom: TurnResumePoint;
}

export interface TurnObservationCompleted {
  readonly status: "completed";
  readonly checkpoint: TurnResumePoint;
  readonly usageReceipt?: NormalizedUsageReceipt | null;
}

export interface TurnObservationCancelled {
  readonly status: "cancelled";
  readonly checkpoint: TurnResumePoint;
  readonly usageReceipt?: NormalizedUsageReceipt | null;
}

export interface TurnObservationDisconnected {
  readonly status: "disconnected";
  readonly checkpoint: TurnResumePoint;
}

export interface TurnObservationFailed {
  readonly status: "failed";
  readonly checkpoint: TurnResumePoint;
  readonly error: TransportError;
  readonly usageReceipt?: NormalizedUsageReceipt | null;
}

export type TurnObservationResult =
  | TurnObservationCompleted
  | TurnObservationCancelled
  | TurnObservationDisconnected
  | TurnObservationFailed;

/**
 * A runtime-neutral pull stream for one connection to a turn.
 *
 * `disconnect` interrupts only this local observation. It must not request or
 * imply authoritative cancellation of the underlying turn. Callers that need
 * cancellation must separately negotiate and invoke that capability.
 */
export interface TurnObservation<TEvent = unknown> {
  readonly events: AsyncIterable<TEvent>;
  readonly result: Promise<TurnObservationResult>;
  disconnect(): void;
}

export interface TurnHandle<TEvent = unknown> {
  readonly conversationId: string;
  readonly turnId: string;
  readonly mutationId: string;
  readonly observation: TurnObservation<TEvent>;
}

export interface CancelTurnInput {
  readonly conversationId: string;
  readonly turnId: string;
  /** Caller-generated mutation identifier for this cancellation request. */
  readonly mutationId: string;
  /** Caller-generated key used to make retries of cancellation safe. */
  readonly idempotencyKey: string;
  /** Provider-neutral, SDK-owned reason for the authoritative request. */
  readonly reason: ConversationTurnCancellationReason;
}

export interface AuthoritativeCancelTurnResult {
  readonly status: "cancellation_requested" | "already_terminal";
}

export interface AuthoritativeTurnCancellation {
  cancelTurn(
    input: CancelTurnInput,
  ): Promise<TransportResult<AuthoritativeCancelTurnResult>>;
}

/**
 * Attachment upload, presence, and synchronization remain opaque adapter
 * references here. Their operations are available only when a transport both
 * negotiates support and supplies the corresponding capability contract.
 */
export interface ConversationTransportCapabilities<
  TAttachmentUpload = AttachmentUploadAdapter,
  TPresence = unknown,
  TSynchronization = unknown,
> {
  readonly authoritativeCancellation: NegotiatedTransportCapability<AuthoritativeTurnCancellation>;
  /** Provider-neutral document limits negotiated before a turn is started. */
  readonly documentInput: NegotiatedTransportCapability<DocumentInputCapabilityDescriptor>;
  readonly attachmentUpload: NegotiatedTransportCapability<TAttachmentUpload>;
  readonly presence: NegotiatedTransportCapability<TPresence>;
  readonly synchronization: NegotiatedTransportCapability<TSynchronization>;
}

/**
 * Provider- and runtime-neutral boundary used by a headless conversation
 * runtime. TEvent deliberately defaults to unknown until an application binds
 * its canonical durable conversation-event envelope.
 */
export interface ConversationTransport<
  TEvent = unknown,
  TStartRequest = unknown,
  TAttachmentUpload = AttachmentUploadAdapter,
  TPresence = unknown,
  TSynchronization = unknown,
> {
  readonly capabilities: ConversationTransportCapabilities<
    TAttachmentUpload,
    TPresence,
    TSynchronization
  >;

  startTurn(
    input: StartTurnInput<TStartRequest>,
    context?: TurnExecutionContext,
  ): Promise<TransportResult<TurnHandle<TEvent>>>;

  resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<TEvent>>>;
}
