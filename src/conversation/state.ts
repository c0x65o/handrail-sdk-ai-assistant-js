import type {
  ConversationAttachmentId,
  ConversationAttachmentReference,
  ConversationApprovalArgumentReference,
  ConversationApprovalGroupId,
  ConversationApprovalProposalId,
  ConversationApprovalProposalStatus,
  ConversationClientMutationId,
  ConversationEventActor,
  ConversationEventId,
  ConversationEventSource,
  ConversationId,
  ConversationMessageContentPart,
  ConversationMessageId,
  ConversationMessageRole,
  ConversationRevision,
  ConversationTimestamp,
  ConversationToolCallId,
  ConversationTurnCancellationReason,
  ConversationRetryExhaustionReason,
  ConversationRetryReasonCategory,
  ConversationTurnAttemptOperation,
  ConversationTurnCompletionOutcome,
  ConversationTurnError,
  ConversationTurnId,
  ConversationTurnStatus,
  ConversationUsageReceiptId,
  ToolLoopBudget,
} from "./events.js";
import type {
  Citation,
  CitationRecordSet,
  CitationSource,
} from "../citations.js";

export type ConversationStateJsonPrimitive = string | number | boolean | null;
export type ConversationStateJsonValue =
  | ConversationStateJsonPrimitive
  | ConversationStateJsonObject
  | readonly ConversationStateJsonValue[];
export interface ConversationStateJsonObject {
  readonly [key: string]: ConversationStateJsonValue;
}

export interface ConversationEventAttribution {
  readonly actor: Readonly<ConversationEventActor>;
  readonly source: Readonly<ConversationEventSource>;
}

export interface ConversationMessageRecord {
  readonly message_id: ConversationMessageId;
  /** The originating turn for incrementally appended assistant text. */
  readonly turn_id?: ConversationTurnId | null;
  /** Null only when an attachment or citation referenced it before creation. */
  readonly role: ConversationMessageRole | null;
  readonly content: readonly Readonly<ConversationMessageContentPart>[];
  readonly attachments: readonly Readonly<ConversationAttachmentReference>[];
  readonly created_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
}

export interface ConversationAttachmentRecord {
  readonly message_id: ConversationMessageId;
  readonly attachment_id: ConversationAttachmentId;
  readonly reference: Readonly<ConversationAttachmentReference>;
  readonly referenced_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export type ConversationTurnStateStatus =
  | ConversationTurnStatus
  | "completed"
  | "cancelled"
  | "failed";

export type ConversationTurnCancellationStatus =
  | "requested"
  | "unsupported"
  | "cancelled";

export type ConversationTurnRetryRecord =
  | {
      readonly type: "turn.attempt_started";
      readonly attempt: number;
      readonly operation: ConversationTurnAttemptOperation;
      readonly occurred_at: ConversationTimestamp;
      readonly attribution: ConversationEventAttribution;
    }
  | {
      readonly type: "turn.retry_scheduled";
      readonly attempt: number;
      readonly reason_category: ConversationRetryReasonCategory;
      readonly delay_ms: number;
      readonly occurred_at: ConversationTimestamp;
      readonly attribution: ConversationEventAttribution;
    }
  | {
      readonly type: "turn.retry_exhausted";
      readonly attempt: number;
      readonly reason_category: ConversationRetryReasonCategory;
      readonly exhaustion_reason: ConversationRetryExhaustionReason;
      readonly occurred_at: ConversationTimestamp;
      readonly attribution: ConversationEventAttribution;
    };

export interface ConversationTurnRecord {
  readonly turn_id: ConversationTurnId;
  readonly continuation_of_turn_id: ConversationTurnId | null;
  readonly status: ConversationTurnStateStatus;
  readonly input_message_ids: readonly ConversationMessageId[];
  readonly output_message_ids: readonly ConversationMessageId[];
  readonly outcome: ConversationTurnCompletionOutcome | null;
  readonly cancellation_reason: ConversationTurnCancellationReason | null;
  /** The latest durable cancellation request/outcome, independent of execution status. */
  readonly cancellation_status: ConversationTurnCancellationStatus | null;
  readonly cancellation_requested_reason: ConversationTurnCancellationReason | null;
  /** False only after an authoritative terminal event has won the turn. */
  readonly remote_may_still_be_running: boolean;
  readonly error: Readonly<ConversationTurnError> | null;
  readonly retry_history: readonly ConversationTurnRetryRecord[];
  readonly started_at: ConversationTimestamp | null;
  readonly terminal_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
}

export interface ConversationToolResultRecord {
  readonly content: readonly ConversationStateToolResultContentPart[];
  readonly is_error: boolean;
  /** Normalized recovery state retained even after citation linkage succeeds. */
  readonly citation_records?: CitationRecordSet;
  readonly recorded_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export interface ConversationStateToolResultTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ConversationStateToolResultJsonPart {
  readonly type: "json";
  readonly value: ConversationStateJsonValue;
}

export type ConversationStateToolResultContentPart =
  | ConversationStateToolResultTextPart
  | ConversationStateToolResultJsonPart;

export type ConversationStateApprovalReviewedArguments =
  | {
      readonly type: "redacted_json";
      readonly value: ConversationStateJsonObject;
    }
  | {
      readonly type: "opaque_reference";
      readonly argument_ref: ConversationApprovalArgumentReference;
    };

export interface ConversationToolCallRecord {
  readonly tool_call_id: ConversationToolCallId;
  readonly turn_id: ConversationTurnId;
  /** Null only when a result was observed before its request. */
  readonly name: string | null;
  readonly arguments: ConversationStateJsonObject | null;
  readonly requested_at: ConversationTimestamp | null;
  readonly discovered_at: ConversationTimestamp | null;
  readonly started_at: ConversationTimestamp | null;
  readonly approval_required_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
  readonly result: ConversationToolResultRecord | null;
}

/** Current durable projection; the event log remains the authoritative audit history. */
export interface ConversationApprovalProposalRecord {
  readonly proposal_id: ConversationApprovalProposalId;
  readonly group_id: ConversationApprovalGroupId | null;
  readonly turn_id: ConversationTurnId;
  readonly tool_call_id: ConversationToolCallId;
  readonly tool_name: string;
  readonly reviewed_arguments: ConversationStateApprovalReviewedArguments;
  readonly status: ConversationApprovalProposalStatus;
  readonly proposal_version: number;
  readonly expires_at: ConversationTimestamp | null;
  readonly created_at: ConversationTimestamp;
  readonly updated_at: ConversationTimestamp;
  readonly created_attribution: ConversationEventAttribution;
  readonly latest_attribution: ConversationEventAttribution;
  readonly decision_at: ConversationTimestamp | null;
  readonly decision_attribution: ConversationEventAttribution | null;
  readonly decision_reason: string | null;
  readonly failure_reason: string | null;
}

export interface ConversationToolLoopBudgetExhaustion {
  readonly turn_id: ConversationTurnId;
  readonly budget: ToolLoopBudget;
  readonly limit: number;
  readonly exhausted_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export interface ConversationUsageReceiptLink {
  readonly usage_receipt_id: ConversationUsageReceiptId;
  readonly turn_id: ConversationTurnId;
  readonly linked_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export interface ConversationRevisionGapError {
  readonly type: "revision_gap";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_revision: number;
  readonly received_revision: ConversationRevision;
}

export interface ConversationStaleRevisionError {
  readonly type: "stale_revision";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_revision: number;
  readonly received_revision: ConversationRevision;
}

export interface ConversationIdentityMismatchError {
  readonly type: "conversation_mismatch";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_conversation_id: ConversationId;
}

export type ConversationReplayError =
  | ConversationRevisionGapError
  | ConversationStaleRevisionError
  | ConversationIdentityMismatchError;

/**
 * Immutable, JSON-serializable projection of a durable conversation event log.
 * Arrays retain first-seen order so serialization is deterministic.
 */
export interface ConversationState {
  readonly conversation_id: ConversationId | null;
  readonly revision: ConversationRevision | null;
  readonly last_event_id: ConversationEventId | null;
  readonly processed_event_ids: readonly ConversationEventId[];
  readonly processed_mutation_ids: readonly ConversationClientMutationId[];
  readonly messages: readonly ConversationMessageRecord[];
  readonly attachments: readonly ConversationAttachmentRecord[];
  /** First-seen normalized source identities, including sources for pending links. */
  readonly citation_sources: readonly CitationSource[];
  /** Normalized links; targets may be placeholders until their facts arrive. */
  readonly citations: readonly Citation[];
  readonly turns: readonly ConversationTurnRecord[];
  readonly active_turn_id: ConversationTurnId | null;
  readonly tool_calls: readonly ConversationToolCallRecord[];
  readonly approval_proposals: readonly ConversationApprovalProposalRecord[];
  readonly tool_loop_budget_exhaustions: readonly ConversationToolLoopBudgetExhaustion[];
  /** References only; receipt bodies live behind the usage contract/store. */
  readonly usage_receipt_links: readonly ConversationUsageReceiptLink[];
  readonly metadata: ConversationStateJsonObject;
  readonly title: string | null;
  readonly replay_error: ConversationReplayError | null;
}

export function createInitialConversationState(
  conversationId: ConversationId | null = null,
): ConversationState {
  return Object.freeze({
    conversation_id: conversationId,
    revision: null,
    last_event_id: null,
    processed_event_ids: Object.freeze([]),
    processed_mutation_ids: Object.freeze([]),
    messages: Object.freeze([]),
    attachments: Object.freeze([]),
    citation_sources: Object.freeze([]),
    citations: Object.freeze([]),
    turns: Object.freeze([]),
    active_turn_id: null,
    tool_calls: Object.freeze([]),
    approval_proposals: Object.freeze([]),
    tool_loop_budget_exhaustions: Object.freeze([]),
    usage_receipt_links: Object.freeze([]),
    metadata: Object.freeze({}),
    title: null,
    replay_error: null,
  });
}
