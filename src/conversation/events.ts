import {
  AI_RUNTIME_ATTACHMENT_ID_GRAMMAR,
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type DocumentMimeType,
  type ImageMimeType,
} from "../protocol.js";
import {
  normalizeCitationRecords,
  type Citation,
  type CitationRecordSet,
  type CitationSource,
} from "../citations.js";
import { jsonValuesEqual } from "../json-equality.js";

export const CONVERSATION_EVENT_VERSION = 1 as const;
export const CONVERSATION_CITATION_RECORDS_VERSION = 1 as const;

export const CONVERSATION_EVENT_TYPES = [
  "message.created",
  "message.text_appended",
  "message.attachment_referenced",
  "citation.records_linked",
  "turn.started",
  "turn.status_changed",
  "turn.attempt_started",
  "turn.retry_scheduled",
  "turn.retry_exhausted",
  "turn.cancellation_requested",
  "turn.cancellation_unsupported",
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
  "tool_call.requested",
  "tool_call.discovered",
  "tool_call.started",
  "tool_call.approval_required",
  "approval.proposal_created",
  "approval.proposal_status_changed",
  "tool_call.result_recorded",
  "tool_loop.budget_exhausted",
  "usage.receipt_linked",
  "conversation.metadata_updated",
  "conversation.title_updated",
] as const;

export const CONVERSATION_EVENT_ACTOR_TYPES = [
  "user",
  "assistant",
  "tool",
  "system",
] as const;

export const CONVERSATION_EVENT_SOURCE_TYPES = [
  "client",
  "runtime",
  "sync",
  "import",
] as const;

export const CONVERSATION_EVENT_LIMITS = {
  identifierLength: 256,
  textLength: 1_000_000,
  textChunkBytes: 1_000_000,
  titleLength: 4_096,
  filenameLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength,
  jsonDepth: 20,
  jsonNodes: 10_000,
  jsonArrayLength: 2_000,
  jsonObjectKeys: 2_000,
  jsonKeyLength: 256,
  jsonStringLength: 1_000_000,
  metadataDepth: 5,
  metadataNodes: 256,
  metadataArrayLength: 64,
  metadataObjectKeys: 64,
  metadataKeyLength: 128,
  metadataStringLength: 4_096,
  metadataSerializedBytes: 16_384,
  approvalReasonLength: 1_024,
  approvalArgumentReferenceLength: 512,
  approvalSnapshotDepth: 8,
  approvalSnapshotNodes: 512,
  approvalSnapshotArrayLength: 128,
  approvalSnapshotObjectKeys: 128,
  approvalSnapshotKeyLength: 128,
  approvalSnapshotStringLength: 4_096,
  approvalSnapshotSerializedBytes: 16_384,
} as const;

declare const opaqueConversationValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaqueConversationValue]: Name;
};

export type ConversationId = OpaqueString<"ConversationId">;
export type ConversationEventId = OpaqueString<"ConversationEventId">;
export type ConversationMessageId = OpaqueString<"ConversationMessageId">;
export type ConversationTurnId = OpaqueString<"ConversationTurnId">;
export type ConversationToolCallId = OpaqueString<"ConversationToolCallId">;
export type ConversationClientId = OpaqueString<"ConversationClientId">;
export type ConversationDeviceId = OpaqueString<"ConversationDeviceId">;
export type ConversationClientMutationId = OpaqueString<"ConversationClientMutationId">;
export type ConversationUsageReceiptId = OpaqueString<"ConversationUsageReceiptId">;
export type ConversationAttachmentId = OpaqueString<"ConversationAttachmentId">;
export type ConversationActorId = OpaqueString<"ConversationActorId">;
export type ConversationApprovalProposalId =
  OpaqueString<"ConversationApprovalProposalId">;
export type ConversationApprovalGroupId =
  OpaqueString<"ConversationApprovalGroupId">;
export type ConversationApprovalArgumentReference =
  OpaqueString<"ConversationApprovalArgumentReference">;
export type ConversationTimestamp = OpaqueString<"ConversationTimestamp">;
export type ConversationRevision = number & {
  readonly [opaqueConversationValue]: "ConversationRevision";
};

export type ConversationJsonPrimitive = string | number | boolean | null;
export type ConversationJsonValue =
  | ConversationJsonPrimitive
  | ConversationJsonObject
  | ConversationJsonValue[];
export type ConversationJsonObject = { [key: string]: ConversationJsonValue };
export type ConversationEventMetadata = ConversationJsonObject;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];
export type ConversationEventActorType =
  (typeof CONVERSATION_EVENT_ACTOR_TYPES)[number];
export type ConversationEventSourceType =
  (typeof CONVERSATION_EVENT_SOURCE_TYPES)[number];

export interface ConversationEventActor {
  type: ConversationEventActorType;
  id?: ConversationActorId;
}

export interface ConversationClientEventSource {
  type: "client";
  client_id: ConversationClientId;
  device_id?: ConversationDeviceId;
}

export interface ConversationRuntimeEventSource {
  type: "runtime";
}

export interface ConversationSyncEventSource {
  type: "sync";
}

export interface ConversationImportEventSource {
  type: "import";
}

export type ConversationEventSource =
  | ConversationClientEventSource
  | ConversationRuntimeEventSource
  | ConversationSyncEventSource
  | ConversationImportEventSource;

export interface ConversationMessageTextPart {
  type: "text";
  text: string;
}

export type ConversationMessageContentPart = ConversationMessageTextPart;
export type ConversationMessageRole = "user" | "assistant" | "system";

export interface MessageCreatedPayload {
  type: "message.created";
  message_id: ConversationMessageId;
  role: ConversationMessageRole;
  content: ConversationMessageContentPart[];
}

export interface MessageTextAppendedPayload {
  type: "message.text_appended";
  turn_id: ConversationTurnId;
  message_id: ConversationMessageId;
  text: string;
}

export type ConversationAttachmentKind = "image" | "document";

interface ConversationAttachmentReferenceBase {
  attachment_id: ConversationAttachmentId;
  filename?: string;
}

/** Historical image metadata remains replayable without the newer kind field. */
export interface ConversationLegacyImageAttachmentReference
  extends ConversationAttachmentReferenceBase {
  kind?: never;
  /** Kept source-compatible with v1; durable parsing accepts image MIME values only. */
  media_type: string;
  size_bytes?: number;
}

export interface ConversationImageAttachmentReference
  extends ConversationAttachmentReferenceBase {
  kind: "image";
  media_type: ImageMimeType;
  size_bytes: number;
}

export interface ConversationDocumentAttachmentReference
  extends ConversationAttachmentReferenceBase {
  kind: "document";
  media_type: DocumentMimeType;
  size_bytes: number;
}

export type ConversationAttachmentReference =
  | ConversationLegacyImageAttachmentReference
  | ConversationImageAttachmentReference
  | ConversationDocumentAttachmentReference;

export interface MessageAttachmentReferencedPayload {
  type: "message.attachment_referenced";
  message_id: ConversationMessageId;
  attachment: ConversationAttachmentReference;
}

export interface TurnStartedPayload {
  type: "turn.started";
  turn_id: ConversationTurnId;
  input_message_ids: ConversationMessageId[];
  continuation_of_turn_id?: ConversationTurnId;
}

export type ConversationTurnStatus =
  | "queued"
  | "running"
  | "waiting_for_tool_result"
  | "waiting_for_approval";

export interface TurnStatusChangedPayload {
  type: "turn.status_changed";
  turn_id: ConversationTurnId;
  status: ConversationTurnStatus;
}

export type ConversationTurnAttemptOperation = "start" | "resume";

export type ConversationRetryReasonCategory =
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "internal"
  | "disconnected"
  | "interrupted";

export type ConversationRetryExhaustionReason =
  | "maximum_attempts"
  | "maximum_elapsed_time";

export interface TurnAttemptStartedPayload {
  type: "turn.attempt_started";
  turn_id: ConversationTurnId;
  attempt: number;
  operation: ConversationTurnAttemptOperation;
}

export interface TurnRetryScheduledPayload {
  type: "turn.retry_scheduled";
  turn_id: ConversationTurnId;
  attempt: number;
  reason_category: ConversationRetryReasonCategory;
  delay_ms: number;
}

export interface TurnRetryExhaustedPayload {
  type: "turn.retry_exhausted";
  turn_id: ConversationTurnId;
  attempt: number;
  reason_category: ConversationRetryReasonCategory;
  exhaustion_reason: ConversationRetryExhaustionReason;
}

export type ConversationTurnCompletionOutcome =
  | "stop"
  | "length"
  | "tool_calls";

export interface TurnCompletedPayload {
  type: "turn.completed";
  turn_id: ConversationTurnId;
  outcome: ConversationTurnCompletionOutcome;
  output_message_ids: ConversationMessageId[];
}

export type ConversationTurnCancellationReason =
  | "user"
  | "timeout"
  | "superseded"
  | "runtime_shutdown";

export interface TurnCancellationRequestedPayload {
  type: "turn.cancellation_requested";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface TurnCancellationUnsupportedPayload {
  type: "turn.cancellation_unsupported";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface TurnCancelledPayload {
  type: "turn.cancelled";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface ConversationTurnError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TurnFailedPayload {
  type: "turn.failed";
  turn_id: ConversationTurnId;
  error: ConversationTurnError;
}

export interface ToolCallRequestedPayload {
  type: "tool_call.requested";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
  name: string;
  arguments: ConversationJsonObject;
}

export interface ToolCallDiscoveredPayload {
  type: "tool_call.discovered";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export interface ToolCallStartedPayload {
  type: "tool_call.started";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export interface ToolCallApprovalRequiredPayload {
  type: "tool_call.approval_required";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export const CONVERSATION_APPROVAL_PROPOSAL_STATUSES = [
  "pending",
  "confirmed",
  "rejected",
  "expired",
  "executing",
  "executed",
  "failed",
] as const;

export type ConversationApprovalProposalStatus =
  (typeof CONVERSATION_APPROVAL_PROPOSAL_STATUSES)[number];
export type ConversationApprovalProposalTransitionStatus = Exclude<
  ConversationApprovalProposalStatus,
  "pending"
>;

/**
 * Legal optimistic lifecycle edges. Terminal statuses have no successors;
 * failed execution may be retried through a new executing version.
 */
export const CONVERSATION_APPROVAL_PROPOSAL_TRANSITIONS: Readonly<
  Record<ConversationApprovalProposalStatus, readonly ConversationApprovalProposalStatus[]>
> = Object.freeze({
  pending: Object.freeze(["confirmed", "rejected", "expired"] as const),
  confirmed: Object.freeze(["executing"] as const),
  rejected: Object.freeze([] as const),
  expired: Object.freeze([] as const),
  executing: Object.freeze(["executed", "failed"] as const),
  executed: Object.freeze([] as const),
  failed: Object.freeze(["executing"] as const),
});

export function isLegalConversationApprovalProposalTransition(
  from: ConversationApprovalProposalStatus,
  to: ConversationApprovalProposalStatus,
): boolean {
  return CONVERSATION_APPROVAL_PROPOSAL_TRANSITIONS[from].includes(to);
}

/** A host-redacted, bounded JSON view suitable for a human review surface. */
export interface ConversationApprovalRedactedArguments {
  type: "redacted_json";
  value: ConversationJsonObject;
}

/** A host-owned lookup key. It never contains the referenced arguments. */
export interface ConversationApprovalOpaqueArguments {
  type: "opaque_reference";
  argument_ref: ConversationApprovalArgumentReference;
}

export type ConversationApprovalReviewedArguments =
  | ConversationApprovalRedactedArguments
  | ConversationApprovalOpaqueArguments;

export interface ApprovalProposalCreatedPayload {
  type: "approval.proposal_created";
  proposal_id: ConversationApprovalProposalId;
  group_id?: ConversationApprovalGroupId;
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
  tool_name: string;
  status: "pending";
  proposal_version: 1;
  expires_at: ConversationTimestamp | null;
  reviewed_arguments: ConversationApprovalReviewedArguments;
}

export interface ApprovalProposalDecisionPayload {
  type: "approval.proposal_status_changed";
  proposal_id: ConversationApprovalProposalId;
  proposal_version: number;
  status: "confirmed" | "rejected" | "expired";
  decision_reason?: string;
}

export interface ApprovalProposalExecutionPayload {
  type: "approval.proposal_status_changed";
  proposal_id: ConversationApprovalProposalId;
  proposal_version: number;
  status: "executing" | "executed";
}

export interface ApprovalProposalFailedPayload {
  type: "approval.proposal_status_changed";
  proposal_id: ConversationApprovalProposalId;
  proposal_version: number;
  status: "failed";
  failure_reason: string;
}

export type ApprovalProposalStatusChangedPayload =
  | ApprovalProposalDecisionPayload
  | ApprovalProposalExecutionPayload
  | ApprovalProposalFailedPayload;

export interface ConversationToolResultTextPart {
  type: "text";
  text: string;
}

export interface ConversationToolResultJsonPart {
  type: "json";
  value: ConversationJsonValue;
}

export type ConversationToolResultContentPart =
  | ConversationToolResultTextPart
  | ConversationToolResultJsonPart;

export interface ToolCallResultRecordedPayload {
  type: "tool_call.result_recorded";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
  content: ConversationToolResultContentPart[];
  is_error: boolean;
  /** Durable recovery state until the separate citation link event is accepted. */
  citation_records?: CitationRecordSet;
}

export interface ConversationAssistantMessageCitationTarget {
  type: "assistant_message";
  message_id: ConversationMessageId;
}

export interface ConversationToolResultCitationTarget {
  type: "tool_result";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export type ConversationCitationTarget =
  | ConversationAssistantMessageCitationTarget
  | ConversationToolResultCitationTarget;

/**
 * A bounded provider-neutral citation record set linked to one durable target.
 * The outer target supplies the turn identity needed for safe tool-call
 * placeholders; every nested citation target must identify the same fact.
 */
export interface CitationRecordsLinkedPayload {
  type: "citation.records_linked";
  citation_records_version: typeof CONVERSATION_CITATION_RECORDS_VERSION;
  target: ConversationCitationTarget;
  sources: CitationSource[];
  citations: Citation[];
}

export type ToolLoopBudget = "iterations" | "total_tool_calls" | "wall_clock";

export interface ToolLoopBudgetExhaustedPayload {
  type: "tool_loop.budget_exhausted";
  turn_id: ConversationTurnId;
  budget: ToolLoopBudget;
  limit: number;
}

export interface UsageReceiptLinkedPayload {
  type: "usage.receipt_linked";
  turn_id: ConversationTurnId;
  usage_receipt_id: ConversationUsageReceiptId;
}

export interface ConversationMetadataUpdatedPayload {
  type: "conversation.metadata_updated";
  metadata: ConversationEventMetadata;
}

export interface ConversationTitleUpdatedPayload {
  type: "conversation.title_updated";
  title: string | null;
}

export type ConversationEventPayload =
  | MessageCreatedPayload
  | MessageTextAppendedPayload
  | MessageAttachmentReferencedPayload
  | CitationRecordsLinkedPayload
  | TurnStartedPayload
  | TurnStatusChangedPayload
  | TurnAttemptStartedPayload
  | TurnRetryScheduledPayload
  | TurnRetryExhaustedPayload
  | TurnCancellationRequestedPayload
  | TurnCancellationUnsupportedPayload
  | TurnCompletedPayload
  | TurnCancelledPayload
  | TurnFailedPayload
  | ToolCallRequestedPayload
  | ToolCallDiscoveredPayload
  | ToolCallStartedPayload
  | ToolCallApprovalRequiredPayload
  | ApprovalProposalCreatedPayload
  | ApprovalProposalStatusChangedPayload
  | ToolCallResultRecordedPayload
  | ToolLoopBudgetExhaustedPayload
  | UsageReceiptLinkedPayload
  | ConversationMetadataUpdatedPayload
  | ConversationTitleUpdatedPayload;

/**
 * A provider-neutral durable conversation fact.
 *
 * Event revisions are assigned monotonically within one conversation. Repeated
 * observations of the same event_id are the same durable fact. When present,
 * repeated observations of the same mutation_id likewise represent the same
 * submitted mutation and must not be applied as a new mutation. Runtime and
 * sync sources may carry a client-assigned mutation identity after a remote
 * event-store admission; imported history must not.
 */
export interface ConversationEvent {
  version: typeof CONVERSATION_EVENT_VERSION;
  event_id: ConversationEventId;
  conversation_id: ConversationId;
  revision: ConversationRevision;
  occurred_at: ConversationTimestamp;
  actor: ConversationEventActor;
  source: ConversationEventSource;
  mutation_id?: ConversationClientMutationId;
  metadata?: ConversationEventMetadata;
  payload: ConversationEventPayload;
}

export class ConversationEventValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConversationEventValidationError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "secrets",
  "setcookie",
  "signingkey",
]);

const METADATA_FORBIDDEN_FIELD_NAMES = new Set([
  ...CREDENTIAL_FIELD_NAMES,
  "anthropic",
  "choices",
  "completiontokens",
  "contentblock",
  "finishreason",
  "functioncall",
  "gemini",
  "headers",
  "model",
  "modelid",
  "nativechunk",
  "nativepayload",
  "openai",
  "prompttokens",
  "provider",
  "providerchunk",
  "providererror",
  "providername",
  "providerpayload",
  "providerrequest",
  "providerresponse",
  "rawerror",
  "rawrequest",
  "rawresponse",
  "requestheaders",
  "systemfingerprint",
  "usagemetadata",
  "xai",
]);

const APPROVAL_SNAPSHOT_FORBIDDEN_FIELD_NAMES = new Set([
  ...METADATA_FORBIDDEN_FIELD_NAMES,
  "base64",
  "binary",
  "bytes",
  "hiddeninstruction",
  "hiddeninstructions",
  "prompt",
  "systeminstruction",
  "systeminstructions",
  "systemprompt",
]);

const METADATA_FORBIDDEN_STRING_VALUES = new Set([
  "anthropic",
  "chatcompletion",
  "chatcompletionchunk",
  "contentblockdelta",
  "gemini",
  "openai",
  "xai",
]);

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bsk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const APPROVAL_BINARY_VALUE_PATTERNS = [
  /^data:[^,]{1,256};base64,/i,
  /^(?:[a-z0-9+/]{256,}={0,2})$/i,
] as const;

const TURN_STATUSES = ["queued", "running", "waiting_for_tool_result", "waiting_for_approval"] as const;
const TURN_COMPLETION_OUTCOMES = ["stop", "length", "tool_calls"] as const;
const TURN_CANCELLATION_REASONS = [
  "user",
  "timeout",
  "superseded",
  "runtime_shutdown",
] as const;
const RETRY_REASON_CATEGORIES = [
  "rate_limit",
  "timeout",
  "unavailable",
  "internal",
  "disconnected",
  "interrupted",
] as const;
const RETRY_EXHAUSTION_REASONS = [
  "maximum_attempts",
  "maximum_elapsed_time",
] as const;

const ATTACHMENT_ID_PATTERN = new RegExp(AI_RUNTIME_ATTACHMENT_ID_GRAMMAR);

const normalizeFieldName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

function fail(path: string, message: string): never {
  throw new ConversationEventValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, "must be a JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must contain only string-named JSON fields");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable JSON data field");
    }
  }
  return value as UnknownRecord;
}

function allowedKeys(
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
}

function requiredKeys(
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function stringValue(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const {
    allowEmpty = false,
    maxLength = CONVERSATION_EVENT_LIMITS.identifierLength,
  } = options;
  if (typeof value !== "string") fail(path, "must be a string");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function identifier(value: unknown, path: string): string {
  return stringValue(value, path);
}

function identifierArray(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (!options.allowEmpty && value.length === 0) {
    fail(path, "must be a non-empty array");
  }
  const identifiers = value.map((item, index) =>
    identifier(item, `${path}[${index}]`),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    fail(path, "must contain unique identifiers");
  }
  return identifiers;
}

interface JsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxKeyLength: number;
  maxStringLength: number;
  forbiddenFields: ReadonlySet<string>;
  forbiddenStringValues?: ReadonlySet<string>;
  forbiddenStringPatterns?: readonly RegExp[];
}

const JSON_LIMITS: JsonLimits = {
  maxDepth: CONVERSATION_EVENT_LIMITS.jsonDepth,
  maxNodes: CONVERSATION_EVENT_LIMITS.jsonNodes,
  maxArrayLength: CONVERSATION_EVENT_LIMITS.jsonArrayLength,
  maxObjectKeys: CONVERSATION_EVENT_LIMITS.jsonObjectKeys,
  maxKeyLength: CONVERSATION_EVENT_LIMITS.jsonKeyLength,
  maxStringLength: CONVERSATION_EVENT_LIMITS.jsonStringLength,
  forbiddenFields: CREDENTIAL_FIELD_NAMES,
};

const METADATA_LIMITS: JsonLimits = {
  maxDepth: CONVERSATION_EVENT_LIMITS.metadataDepth,
  maxNodes: CONVERSATION_EVENT_LIMITS.metadataNodes,
  maxArrayLength: CONVERSATION_EVENT_LIMITS.metadataArrayLength,
  maxObjectKeys: CONVERSATION_EVENT_LIMITS.metadataObjectKeys,
  maxKeyLength: CONVERSATION_EVENT_LIMITS.metadataKeyLength,
  maxStringLength: CONVERSATION_EVENT_LIMITS.metadataStringLength,
  forbiddenFields: METADATA_FORBIDDEN_FIELD_NAMES,
  forbiddenStringValues: METADATA_FORBIDDEN_STRING_VALUES,
};

const APPROVAL_SNAPSHOT_LIMITS: JsonLimits = {
  maxDepth: CONVERSATION_EVENT_LIMITS.approvalSnapshotDepth,
  maxNodes: CONVERSATION_EVENT_LIMITS.approvalSnapshotNodes,
  maxArrayLength: CONVERSATION_EVENT_LIMITS.approvalSnapshotArrayLength,
  maxObjectKeys: CONVERSATION_EVENT_LIMITS.approvalSnapshotObjectKeys,
  maxKeyLength: CONVERSATION_EVENT_LIMITS.approvalSnapshotKeyLength,
  maxStringLength: CONVERSATION_EVENT_LIMITS.approvalSnapshotStringLength,
  forbiddenFields: APPROVAL_SNAPSHOT_FORBIDDEN_FIELD_NAMES,
  forbiddenStringValues: METADATA_FORBIDDEN_STRING_VALUES,
  forbiddenStringPatterns: APPROVAL_BINARY_VALUE_PATTERNS,
};

function validateJson(
  value: unknown,
  path: string,
  limits: JsonLimits,
): asserts value is ConversationJsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, currentPath: string, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      fail(path, `must contain at most ${limits.maxNodes} JSON values`);
    }
    if (depth > limits.maxDepth) {
      fail(currentPath, `exceeds maximum depth ${limits.maxDepth}`);
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail(currentPath, "must be a finite JSON number");
      }
      return;
    }
    if (typeof current === "string") {
      if (current.length > limits.maxStringLength) {
        fail(
          currentPath,
          `must be at most ${limits.maxStringLength} characters`,
        );
      }
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        fail(currentPath, "must not contain credential material");
      }
      if (limits.forbiddenStringValues?.has(normalizeFieldName(current))) {
        fail(currentPath, "must not identify provider-native data");
      }
      if (limits.forbiddenStringPatterns?.some((pattern) => pattern.test(current))) {
        fail(currentPath, "must not contain binary content");
      }
      return;
    }
    if (typeof current !== "object") {
      fail(currentPath, "must be a JSON value");
    }
    if (ancestors.has(current)) {
      fail(currentPath, "must not contain a circular reference");
    }
    ancestors.add(current);

    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        fail(currentPath, "must contain only JSON array entries");
      }
      if (current.length > limits.maxArrayLength) {
        fail(
          currentPath,
          `must contain at most ${limits.maxArrayLength} items`,
        );
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          fail(`${currentPath}[${index}]`, "must not be a sparse array entry");
        }
        visit(current[index], `${currentPath}[${index}]`, depth + 1);
      }
      const expectedKeys = new Set(
        Array.from({ length: current.length }, (_, index) => String(index)),
      );
      for (const key of Object.keys(current)) {
        if (!expectedKeys.has(key)) {
          fail(`${currentPath}.${key}`, "is not a JSON array index");
        }
      }
    } else {
      const object = record(current, currentPath);
      const entries = Object.entries(object);
      if (entries.length > limits.maxObjectKeys) {
        fail(
          currentPath,
          `must contain at most ${limits.maxObjectKeys} fields`,
        );
      }
      for (const [key, item] of entries) {
        if (key.length === 0 || key.length > limits.maxKeyLength) {
          fail(
            `${currentPath}.${key}`,
            `field names must be 1-${limits.maxKeyLength} characters`,
          );
        }
        if (limits.forbiddenFields.has(normalizeFieldName(key))) {
          fail(`${currentPath}.${key}`, "is forbidden in durable public data");
        }
        visit(item, `${currentPath}.${key}`, depth + 1);
      }
    }
    ancestors.delete(current);
  };

  visit(value, path, 0);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function validateMetadata(
  value: unknown,
  path: string,
): asserts value is ConversationEventMetadata {
  record(value, path);
  validateJson(value, path, METADATA_LIMITS);
  const serialized = JSON.stringify(value);
  if (
    utf8ByteLength(serialized) >
    CONVERSATION_EVENT_LIMITS.metadataSerializedBytes
  ) {
    fail(
      path,
      `must serialize to at most ${CONVERSATION_EVENT_LIMITS.metadataSerializedBytes} bytes`,
    );
  }
}

function validateApprovalReason(value: unknown, path: string): void {
  const reason = stringValue(value, path, {
    maxLength: CONVERSATION_EVENT_LIMITS.approvalReasonLength,
  });
  if (
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(reason)) ||
    APPROVAL_BINARY_VALUE_PATTERNS.some((pattern) => pattern.test(reason))
  ) {
    fail(path, "must not contain credential or binary material");
  }
}

export function isConversationApprovalReason(value: unknown): value is string {
  try {
    validateApprovalReason(value, "$reason");
    return true;
  } catch {
    return false;
  }
}

function validateApprovalReviewedArguments(
  value: unknown,
  path: string,
): asserts value is ConversationApprovalReviewedArguments {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  if (object.type === "redacted_json") {
    requiredKeys(object, ["value"], path);
    allowedKeys(object, ["type", "value"], path);
    record(object.value, `${path}.value`);
    validateJson(object.value, `${path}.value`, APPROVAL_SNAPSHOT_LIMITS);
    if (
      utf8ByteLength(JSON.stringify(object.value)) >
      CONVERSATION_EVENT_LIMITS.approvalSnapshotSerializedBytes
    ) {
      fail(
        `${path}.value`,
        `must serialize to at most ${CONVERSATION_EVENT_LIMITS.approvalSnapshotSerializedBytes} bytes`,
      );
    }
    return;
  }
  if (object.type === "opaque_reference") {
    requiredKeys(object, ["argument_ref"], path);
    allowedKeys(object, ["type", "argument_ref"], path);
    const reference = stringValue(object.argument_ref, `${path}.argument_ref`, {
      maxLength: CONVERSATION_EVENT_LIMITS.approvalArgumentReferenceLength,
    });
    if (
      !/^[a-z0-9][a-z0-9._:/-]*$/i.test(reference) ||
      reference.includes("://") ||
      CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(reference))
    ) {
      fail(
        `${path}.argument_ref`,
        "must be a safe host-owned opaque reference",
      );
    }
    return;
  }
  fail(`${path}.type`, 'must equal "redacted_json" or "opaque_reference"');
}

export function isConversationApprovalReviewedArguments(
  value: unknown,
): value is ConversationApprovalReviewedArguments {
  try {
    validateApprovalReviewedArguments(value, "$reviewed_arguments");
    return true;
  } catch {
    return false;
  }
}

function validateActor(
  value: unknown,
  path: string,
): asserts value is ConversationEventActor {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  allowedKeys(object, ["type", "id"], path);
  enumValue(object.type, CONVERSATION_EVENT_ACTOR_TYPES, `${path}.type`);
  if (Object.hasOwn(object, "id")) identifier(object.id, `${path}.id`);
}

function validateSource(
  value: unknown,
  path: string,
): asserts value is ConversationEventSource {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  const sourceType = enumValue(
    object.type,
    CONVERSATION_EVENT_SOURCE_TYPES,
    `${path}.type`,
  );
  if (sourceType === "client") {
    requiredKeys(object, ["client_id"], path);
    allowedKeys(object, ["type", "client_id", "device_id"], path);
    identifier(object.client_id, `${path}.client_id`);
    if (Object.hasOwn(object, "device_id")) {
      identifier(object.device_id, `${path}.device_id`);
    }
    return;
  }
  allowedKeys(object, ["type"], path);
}

function validateTimestamp(value: unknown, path: string): void {
  const timestamp = stringValue(value, path, { maxLength: 64 });
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      timestamp,
    );
  if (match === null) {
    fail(path, "must be a valid RFC 3339 UTC timestamp");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    year === 0 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    fail(path, "must be a valid RFC 3339 UTC timestamp");
  }
}

function validateRevision(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(path, "must be a positive safe integer monotonic revision");
  }
}

function positiveSafeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, "must be a positive safe integer");
  }
}

function nonnegativeSafeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
}

function validateTextPart(
  value: unknown,
  path: string,
): asserts value is ConversationMessageTextPart {
  const object = record(value, path);
  requiredKeys(object, ["type", "text"], path);
  allowedKeys(object, ["type", "text"], path);
  if (object.type !== "text") fail(`${path}.type`, 'must equal "text"');
  stringValue(object.text, `${path}.text`, {
    allowEmpty: true,
    maxLength: CONVERSATION_EVENT_LIMITS.textLength,
  });
}

function validateAttachmentReference(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["attachment_id", "media_type"], path);
  allowedKeys(
    object,
    ["attachment_id", "kind", "media_type", "filename", "size_bytes"],
    path,
  );
  const attachmentId = stringValue(object.attachment_id, `${path}.attachment_id`, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentIdLength,
  });
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    fail(
      `${path}.attachment_id`,
      `must be an opaque identifier matching ${AI_RUNTIME_ATTACHMENT_ID_GRAMMAR}`,
    );
  }

  const kind = Object.hasOwn(object, "kind")
    ? enumValue(object.kind, ["image", "document"], `${path}.kind`)
    : undefined;
  const mediaTypes = kind === "document"
    ? AI_RUNTIME_DOCUMENT_MIME_TYPES
    : AI_RUNTIME_IMAGE_MIME_TYPES;
  enumValue(object.media_type, mediaTypes, `${path}.media_type`);

  if (Object.hasOwn(object, "filename")) {
    const filename = stringValue(object.filename, `${path}.filename`, {
      maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength,
    });
    const hasUnsafeCharacter = [...filename].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127 || '<>:"/\\|?*'.includes(character);
    });
    if (
      filename === "." ||
      filename === ".." ||
      hasUnsafeCharacter ||
      CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(filename))
    ) {
      fail(
        `${path}.filename`,
        "must be a safe filename without path separators or control characters",
      );
    }
  }

  if (kind !== undefined && !Object.hasOwn(object, "size_bytes")) {
    fail(`${path}.size_bytes`, "is required when kind is present");
  }
  if (!Object.hasOwn(object, "size_bytes")) return;

  const minBytes = kind === "document"
    ? AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes
    : AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes;
  const maxBytes = kind === "document"
    ? AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes
    : AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes;
  if (
    !Number.isSafeInteger(object.size_bytes) ||
    (object.size_bytes as number) < minBytes ||
    (object.size_bytes as number) > maxBytes
  ) {
    fail(
      `${path}.size_bytes`,
      `must be a safe integer from ${minBytes} through ${maxBytes}`,
    );
  }
}

/** Validate durable, provider-neutral attachment metadata without cloning it. */
export function isConversationAttachmentReference(
  value: unknown,
): value is ConversationAttachmentReference {
  try {
    validateAttachmentReference(value, "$attachment");
    return true;
  } catch {
    return false;
  }
}

function validateTurnError(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["code", "message", "retryable"], path);
  allowedKeys(object, ["code", "message", "retryable"], path);
  identifier(object.code, `${path}.code`);
  stringValue(object.message, `${path}.message`, {
    allowEmpty: true,
    maxLength: CONVERSATION_EVENT_LIMITS.titleLength,
  });
  booleanValue(object.retryable, `${path}.retryable`);
}

function validateToolResultPart(value: unknown, path: string): void {
  const object = record(value, path);
  if (object.type === "text") {
    validateTextPart(value, path);
    return;
  }
  if (object.type === "json") {
    requiredKeys(object, ["type", "value"], path);
    allowedKeys(object, ["type", "value"], path);
    validateJson(object.value, `${path}.value`, JSON_LIMITS);
    return;
  }
  fail(`${path}.type`, 'must equal "text" or "json"');
}

function validatePayload(
  value: unknown,
  path: string,
): asserts value is ConversationEventPayload {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  if (
    typeof object.type !== "string" ||
    !CONVERSATION_EVENT_TYPES.includes(object.type as ConversationEventType)
  ) {
    fail(`${path}.type`, "is not a supported durable event discriminator");
  }

  switch (object.type as ConversationEventType) {
    case "message.created": {
      requiredKeys(object, ["message_id", "role", "content"], path);
      allowedKeys(object, ["type", "message_id", "role", "content"], path);
      identifier(object.message_id, `${path}.message_id`);
      enumValue(object.role, ["user", "assistant", "system"], `${path}.role`);
      if (!Array.isArray(object.content) || object.content.length === 0) {
        fail(`${path}.content`, "must be a non-empty array");
      }
      object.content.forEach((part, index) =>
        validateTextPart(part, `${path}.content[${index}]`),
      );
      return;
    }
    case "message.text_appended": {
      requiredKeys(object, ["turn_id", "message_id", "text"], path);
      allowedKeys(object, ["type", "turn_id", "message_id", "text"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.message_id, `${path}.message_id`);
      const text = stringValue(object.text, `${path}.text`, {
        maxLength: CONVERSATION_EVENT_LIMITS.textLength,
      });
      if (utf8ByteLength(text) > CONVERSATION_EVENT_LIMITS.textChunkBytes) {
        fail(
          `${path}.text`,
          `must be at most ${CONVERSATION_EVENT_LIMITS.textChunkBytes} UTF-8 bytes`,
        );
      }
      return;
    }
    case "message.attachment_referenced":
      requiredKeys(object, ["message_id", "attachment"], path);
      allowedKeys(object, ["type", "message_id", "attachment"], path);
      identifier(object.message_id, `${path}.message_id`);
      validateAttachmentReference(object.attachment, `${path}.attachment`);
      return;
    case "citation.records_linked": {
      requiredKeys(
        object,
        ["citation_records_version", "target", "sources", "citations"],
        path,
      );
      allowedKeys(
        object,
        ["type", "citation_records_version", "target", "sources", "citations"],
        path,
      );
      if (
        object.citation_records_version !==
        CONVERSATION_CITATION_RECORDS_VERSION
      ) {
        fail(
          `${path}.citation_records_version`,
          `must equal ${CONVERSATION_CITATION_RECORDS_VERSION}`,
        );
      }
      const target = record(object.target, `${path}.target`);
      requiredKeys(target, ["type"], `${path}.target`);
      if (target.type === "assistant_message") {
        requiredKeys(target, ["message_id"], `${path}.target`);
        allowedKeys(target, ["type", "message_id"], `${path}.target`);
        identifier(target.message_id, `${path}.target.message_id`);
      } else if (target.type === "tool_result") {
        requiredKeys(target, ["turn_id", "tool_call_id"], `${path}.target`);
        allowedKeys(
          target,
          ["type", "turn_id", "tool_call_id"],
          `${path}.target`,
        );
        identifier(target.turn_id, `${path}.target.turn_id`);
        identifier(target.tool_call_id, `${path}.target.tool_call_id`);
      } else {
        fail(
          `${path}.target.type`,
          'must equal "assistant_message" or "tool_result"',
        );
      }

      let records;
      try {
        records = normalizeCitationRecords({
          sources: object.sources,
          citations: object.citations,
        });
      } catch (error) {
        fail(
          path,
          error instanceof Error ? error.message : "contains invalid citation records",
        );
      }
      if (records.citations.length === 0) {
        fail(`${path}.citations`, "must contain at least one citation link");
      }
      if (
        !jsonValuesEqual(records.sources, object.sources) ||
        !jsonValuesEqual(records.citations, object.citations)
      ) {
        fail(
          path,
          "citation records must already be normalized and identity-deduplicated",
        );
      }
      for (const citation of records.citations) {
        if (
          citation.target.type !== target.type ||
          (target.type === "assistant_message"
            ? citation.target.type !== "assistant_message" ||
              citation.target.message_id !== target.message_id
            : citation.target.type !== "tool_result" ||
              citation.target.tool_call_id !== target.tool_call_id)
        ) {
          fail(
            `${path}.citations`,
            "must contain only links to the payload target",
          );
        }
      }
      return;
    }
    case "turn.started":
      requiredKeys(object, ["turn_id", "input_message_ids"], path);
      allowedKeys(
        object,
        ["type", "turn_id", "input_message_ids", "continuation_of_turn_id"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifierArray(object.input_message_ids, `${path}.input_message_ids`);
      if (Object.hasOwn(object, "continuation_of_turn_id")) {
        identifier(object.continuation_of_turn_id, `${path}.continuation_of_turn_id`);
      }
      return;
    case "turn.status_changed":
      requiredKeys(object, ["turn_id", "status"], path);
      allowedKeys(object, ["type", "turn_id", "status"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.status, TURN_STATUSES, `${path}.status`);
      return;
    case "turn.attempt_started":
      requiredKeys(object, ["turn_id", "attempt", "operation"], path);
      allowedKeys(object, ["type", "turn_id", "attempt", "operation"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.operation, ["start", "resume"], `${path}.operation`);
      return;
    case "turn.retry_scheduled":
      requiredKeys(
        object,
        ["turn_id", "attempt", "reason_category", "delay_ms"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "attempt", "reason_category", "delay_ms"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.reason_category, RETRY_REASON_CATEGORIES, `${path}.reason_category`);
      nonnegativeSafeInteger(object.delay_ms, `${path}.delay_ms`);
      return;
    case "turn.retry_exhausted":
      requiredKeys(
        object,
        ["turn_id", "attempt", "reason_category", "exhaustion_reason"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "attempt", "reason_category", "exhaustion_reason"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.reason_category, RETRY_REASON_CATEGORIES, `${path}.reason_category`);
      enumValue(
        object.exhaustion_reason,
        RETRY_EXHAUSTION_REASONS,
        `${path}.exhaustion_reason`,
      );
      return;
    case "turn.cancellation_requested":
    case "turn.cancellation_unsupported":
      requiredKeys(object, ["turn_id", "reason"], path);
      allowedKeys(object, ["type", "turn_id", "reason"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.reason, TURN_CANCELLATION_REASONS, `${path}.reason`);
      return;
    case "turn.completed":
      requiredKeys(
        object,
        ["turn_id", "outcome", "output_message_ids"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "outcome", "output_message_ids"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.outcome, TURN_COMPLETION_OUTCOMES, `${path}.outcome`);
      identifierArray(object.output_message_ids, `${path}.output_message_ids`, {
        allowEmpty: true,
      });
      return;
    case "turn.cancelled":
      requiredKeys(object, ["turn_id", "reason"], path);
      allowedKeys(object, ["type", "turn_id", "reason"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.reason, TURN_CANCELLATION_REASONS, `${path}.reason`);
      return;
    case "turn.failed":
      requiredKeys(object, ["turn_id", "error"], path);
      allowedKeys(object, ["type", "turn_id", "error"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      validateTurnError(object.error, `${path}.error`);
      return;
    case "tool_call.requested":
      requiredKeys(
        object,
        ["turn_id", "tool_call_id", "name", "arguments"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "tool_call_id", "name", "arguments"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      identifier(object.name, `${path}.name`);
      record(object.arguments, `${path}.arguments`);
      validateJson(object.arguments, `${path}.arguments`, JSON_LIMITS);
      return;
    case "tool_call.discovered":
    case "tool_call.started":
    case "tool_call.approval_required":
      requiredKeys(object, ["turn_id", "tool_call_id"], path);
      allowedKeys(object, ["type", "turn_id", "tool_call_id"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      return;
    case "approval.proposal_created":
      requiredKeys(
        object,
        [
          "proposal_id",
          "turn_id",
          "tool_call_id",
          "tool_name",
          "status",
          "proposal_version",
          "expires_at",
          "reviewed_arguments",
        ],
        path,
      );
      allowedKeys(
        object,
        [
          "type",
          "proposal_id",
          "group_id",
          "turn_id",
          "tool_call_id",
          "tool_name",
          "status",
          "proposal_version",
          "expires_at",
          "reviewed_arguments",
        ],
        path,
      );
      identifier(object.proposal_id, `${path}.proposal_id`);
      if (Object.hasOwn(object, "group_id")) {
        identifier(object.group_id, `${path}.group_id`);
      }
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      identifier(object.tool_name, `${path}.tool_name`);
      if (object.status !== "pending") {
        fail(`${path}.status`, 'must equal "pending"');
      }
      if (object.proposal_version !== 1) {
        fail(`${path}.proposal_version`, "must equal the initial version 1");
      }
      if (object.expires_at !== null) validateTimestamp(object.expires_at, `${path}.expires_at`);
      validateApprovalReviewedArguments(
        object.reviewed_arguments,
        `${path}.reviewed_arguments`,
      );
      return;
    case "approval.proposal_status_changed": {
      requiredKeys(
        object,
        ["proposal_id", "proposal_version", "status"],
        path,
      );
      identifier(object.proposal_id, `${path}.proposal_id`);
      positiveSafeInteger(object.proposal_version, `${path}.proposal_version`);
      const status = enumValue(
        object.status,
        CONVERSATION_APPROVAL_PROPOSAL_STATUSES.filter(
          (candidate) => candidate !== "pending",
        ) as ConversationApprovalProposalTransitionStatus[],
        `${path}.status`,
      );
      if (["confirmed", "rejected", "expired"].includes(status)) {
        allowedKeys(
          object,
          ["type", "proposal_id", "proposal_version", "status", "decision_reason"],
          path,
        );
        if (Object.hasOwn(object, "decision_reason")) {
          validateApprovalReason(object.decision_reason, `${path}.decision_reason`);
        }
        return;
      }
      if (status === "failed") {
        requiredKeys(object, ["failure_reason"], path);
        allowedKeys(
          object,
          ["type", "proposal_id", "proposal_version", "status", "failure_reason"],
          path,
        );
        validateApprovalReason(object.failure_reason, `${path}.failure_reason`);
        return;
      }
      allowedKeys(
        object,
        ["type", "proposal_id", "proposal_version", "status"],
        path,
      );
      return;
    }
    case "tool_call.result_recorded":
      requiredKeys(
        object,
        ["turn_id", "tool_call_id", "content", "is_error"],
        path,
      );
      allowedKeys(
        object,
        [
          "type",
          "turn_id",
          "tool_call_id",
          "content",
          "is_error",
          "citation_records",
        ],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      if (!Array.isArray(object.content) || object.content.length === 0) {
        fail(`${path}.content`, "must be a non-empty array");
      }
      object.content.forEach((part, index) =>
        validateToolResultPart(part, `${path}.content[${index}]`),
      );
      booleanValue(object.is_error, `${path}.is_error`);
      if (Object.hasOwn(object, "citation_records")) {
        let records: CitationRecordSet;
        try {
          records = normalizeCitationRecords(object.citation_records);
        } catch (error) {
          fail(
            `${path}.citation_records`,
            error instanceof Error ? error.message : "contains invalid citation records",
          );
        }
        if (records.citations.length === 0) {
          fail(`${path}.citation_records.citations`, "must contain at least one citation link");
        }
        if (!jsonValuesEqual(records, object.citation_records)) {
          fail(
            `${path}.citation_records`,
            "must already be normalized and identity-deduplicated",
          );
        }
        for (const citation of records.citations) {
          if (
            citation.target.type !== "tool_result" ||
            citation.target.tool_call_id !== object.tool_call_id
          ) {
            fail(
              `${path}.citation_records.citations`,
              "must contain only links to this tool result",
            );
          }
        }
      }
      return;
    case "tool_loop.budget_exhausted":
      requiredKeys(object, ["turn_id", "budget", "limit"], path);
      allowedKeys(object, ["type", "turn_id", "budget", "limit"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(
        object.budget,
        ["iterations", "total_tool_calls", "wall_clock"],
        `${path}.budget`,
      );
      positiveSafeInteger(object.limit, `${path}.limit`);
      return;
    case "usage.receipt_linked":
      requiredKeys(object, ["turn_id", "usage_receipt_id"], path);
      allowedKeys(object, ["type", "turn_id", "usage_receipt_id"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.usage_receipt_id, `${path}.usage_receipt_id`);
      return;
    case "conversation.metadata_updated":
      requiredKeys(object, ["metadata"], path);
      allowedKeys(object, ["type", "metadata"], path);
      validateMetadata(object.metadata, `${path}.metadata`);
      return;
    case "conversation.title_updated":
      requiredKeys(object, ["title"], path);
      allowedKeys(object, ["type", "title"], path);
      if (object.title !== null) {
        stringValue(object.title, `${path}.title`, {
          allowEmpty: true,
          maxLength: CONVERSATION_EVENT_LIMITS.titleLength,
        });
      }
      return;
  }
}

/** Validates a durable event without cloning or mutating it. */
export function parseConversationEvent(value: unknown): ConversationEvent {
  const object = record(value, "$event");
  requiredKeys(
    object,
    [
      "version",
      "event_id",
      "conversation_id",
      "revision",
      "occurred_at",
      "actor",
      "source",
      "payload",
    ],
    "$event",
  );
  allowedKeys(
    object,
    [
      "version",
      "event_id",
      "conversation_id",
      "revision",
      "occurred_at",
      "actor",
      "source",
      "mutation_id",
      "metadata",
      "payload",
    ],
    "$event",
  );
  if (object.version !== CONVERSATION_EVENT_VERSION) {
    fail(
      "$event.version",
      `must equal ${CONVERSATION_EVENT_VERSION}`,
    );
  }
  identifier(object.event_id, "$event.event_id");
  identifier(object.conversation_id, "$event.conversation_id");
  validateRevision(object.revision, "$event.revision");
  validateTimestamp(object.occurred_at, "$event.occurred_at");
  validateActor(object.actor, "$event.actor");
  validateSource(object.source, "$event.source");
  if (Object.hasOwn(object, "mutation_id")) {
    identifier(object.mutation_id, "$event.mutation_id");
    if (object.source.type === "import") {
      fail(
        "$event.mutation_id",
        "is not supported for imported events",
      );
    }
  }
  if (Object.hasOwn(object, "metadata")) {
    validateMetadata(object.metadata, "$event.metadata");
  }
  validatePayload(object.payload, "$event.payload");
  const payload = object.payload as ConversationEventPayload;
  const actor = object.actor as ConversationEventActor;
  if (payload.type === "approval.proposal_created") {
    if (actor.type !== "system") {
      fail(
        "$event.actor.type",
        "approval proposals must be created by an explicit host system actor",
      );
    }

  } else if (payload.type === "approval.proposal_status_changed") {
    if (actor.type !== "user" && actor.type !== "system") {
      fail(
        "$event.actor.type",
        "approval lifecycle changes require an explicit user or host system actor",
      );
    }
    if (
      ["expired", "executing", "executed", "failed"].includes(payload.status) &&
      actor.type !== "system"
    ) {
      fail(
        "$event.actor.type",
        `${payload.status} lifecycle changes require a host system actor`,
      );
    }
  }
  return value as ConversationEvent;
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  try {
    parseConversationEvent(value);
    return true;
  } catch {
    return false;
  }
}
