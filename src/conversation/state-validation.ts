import {
  isConversationApprovalReason,
  isConversationApprovalReviewedArguments,
  isConversationAttachmentReference,
  type ConversationId,
  type ConversationRevision,
} from "./events.js";
import { normalizeCitationRecords } from "../citations.js";
import { jsonValuesEqual } from "../json-equality.js";
import type { ConversationApprovalProposalRecord, ConversationState } from "./state.js";

export function isConversationState(
  value: unknown,
  conversationId: ConversationId | null,
  revision: ConversationRevision | null,
): value is ConversationState {
  if (!isPlainRecord(value)) return false;
  const requiredKeys = [
    "conversation_id", "revision", "last_event_id", "processed_event_ids",
    "processed_mutation_ids", "messages", "attachments", "citation_sources",
    "citations", "turns",
    "active_turn_id", "tool_calls", "approval_proposals",
    "tool_loop_budget_exhaustions",
    "usage_receipt_links", "metadata",
    "title", "replay_error",
  ];
  if (!hasExactKeys(value, requiredKeys)) return false;
  if (
    value.conversation_id !== conversationId ||
    value.revision !== revision ||
    !(revision === null ? value.last_event_id === null : isIdentifier(value.last_event_id)) ||
    value.replay_error !== null ||
    !(value.title === null || typeof value.title === "string") ||
    !isJsonObject(value.metadata)
  ) return false;

  const eventIds = identifierArray(value.processed_event_ids);
  const mutationIds = identifierArray(value.processed_mutation_ids);
  if (
    eventIds === null || mutationIds === null ||
    eventIds.length !== (revision ?? 0) ||
    new Set(eventIds).size !== eventIds.length ||
    new Set(mutationIds).size !== mutationIds.length ||
    (revision !== null && eventIds.at(-1) !== value.last_event_id)
  ) return false;

  if (!recordArray(value.messages, isMessage)) return false;
  if (!recordArray(value.attachments, isAttachmentRecord)) return false;
  if (!hasConsistentAttachmentProjection(
    value.messages as Record<string, unknown>[],
    value.attachments as Record<string, unknown>[],
  )) return false;
  if (!recordArray(value.turns, isTurn)) return false;
  if (!recordArray(value.tool_calls, isToolCall)) return false;
  if (!hasValidCitationProjection(
    value.citation_sources,
    value.citations,
    value.messages as Record<string, unknown>[],
    value.tool_calls as Record<string, unknown>[],
  )) return false;
  if (!recordArray(value.approval_proposals, isApprovalProposal)) return false;
  const proposalIds = (value.approval_proposals as Record<string, unknown>[])
    .map((proposal) => proposal.proposal_id);
  if (new Set(proposalIds).size !== proposalIds.length) return false;
  for (const proposal of value.approval_proposals as Record<string, unknown>[]) {
    if (!(value.tool_calls as Record<string, unknown>[]).some(
      (toolCall) => toolCall.tool_call_id === proposal.tool_call_id &&
        toolCall.turn_id === proposal.turn_id &&
        toolCall.name === proposal.tool_name &&
        toolCall.approval_required_at !== null,
    )) return false;
  }
  if (!recordArray(value.tool_loop_budget_exhaustions, isToolLoopBudgetExhaustion)) return false;
  if (!recordArray(value.usage_receipt_links, isUsageLink)) return false;
  if (!(value.active_turn_id === null || isIdentifier(value.active_turn_id))) return false;
  if (
    value.active_turn_id !== null &&
    !(value.turns as Record<string, unknown>[]).some(
      (turn) => turn.turn_id === value.active_turn_id &&
        ["queued", "running", "waiting_for_tool_result"].includes(String(turn.status)),
    )
  ) return false;
  return true;
}

function isMessage(value: Record<string, unknown>): boolean {
  const expectedKeys = Object.hasOwn(value, "turn_id")
    ? ["message_id", "turn_id", "role", "content", "attachments", "created_at", "attribution"]
    : ["message_id", "role", "content", "attachments", "created_at", "attribution"];
  return hasExactKeys(value, expectedKeys) && isIdentifier(value.message_id) &&
    (!Object.hasOwn(value, "turn_id") || value.turn_id === null || isIdentifier(value.turn_id)) &&
    (value.role === null || ["user", "assistant", "system"].includes(String(value.role))) &&
    Array.isArray(value.content) && value.content.every(isTextPart) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isConversationAttachmentReference) &&
    new Set(value.attachments.map((attachment) => attachment.attachment_id)).size ===
      value.attachments.length &&
    (value.created_at === null || typeof value.created_at === "string") &&
    isNullableAttribution(value.attribution);
}

function isAttachmentRecord(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, [
    "message_id", "attachment_id", "reference", "referenced_at", "attribution",
  ]) && isIdentifier(value.message_id) &&
    isConversationAttachmentReference(value.reference) &&
    value.attachment_id === value.reference.attachment_id &&
    isConversationTimestamp(value.referenced_at) &&
    isAttribution(value.attribution);
}

function hasConsistentAttachmentProjection(
  messages: readonly Record<string, unknown>[],
  attachments: readonly Record<string, unknown>[],
): boolean {
  const messageIds = messages.map((message) => message.message_id);
  if (new Set(messageIds).size !== messageIds.length) return false;

  const recordKeys = attachments.map(
    (attachment) => `${String(attachment.message_id)}\0${String(attachment.attachment_id)}`,
  );
  if (new Set(recordKeys).size !== recordKeys.length) return false;

  for (const message of messages) {
    for (const reference of message.attachments as Record<string, unknown>[]) {
      const matching = attachments.find(
        (attachment) => attachment.message_id === message.message_id &&
          attachment.attachment_id === reference.attachment_id,
      );
      if (matching === undefined || !sameAttachmentReference(matching.reference, reference)) {
        return false;
      }
    }
  }
  for (const attachment of attachments) {
    const message = messages.find(
      (candidate) => candidate.message_id === attachment.message_id,
    );
    if (message === undefined || !(message.attachments as Record<string, unknown>[]).some(
      (reference) => sameAttachmentReference(attachment.reference, reference),
    )) return false;
  }
  return true;
}

function sameAttachmentReference(left: unknown, right: unknown): boolean {
  if (!isConversationAttachmentReference(left) ||
    !isConversationAttachmentReference(right)) return false;
  return left.attachment_id === right.attachment_id &&
    left.kind === right.kind &&
    left.media_type === right.media_type &&
    left.filename === right.filename &&
    left.size_bytes === right.size_bytes;
}

function hasValidCitationProjection(
  sources: unknown,
  citations: unknown,
  messages: readonly Record<string, unknown>[],
  toolCalls: readonly Record<string, unknown>[],
): boolean {
  let normalized;
  try {
    normalized = normalizeCitationRecords({ sources, citations });
  } catch {
    return false;
  }
  if (
    !jsonValuesEqual(normalized.sources, sources) ||
    !jsonValuesEqual(normalized.citations, citations)
  ) return false;

  for (const citation of normalized.citations) {
    if (citation.target.type === "assistant_message") {
      const messageId = citation.target.message_id;
      const message = messages.find(
        (candidate) => candidate.message_id === messageId,
      );
      if (
        message === undefined ||
        (message.role !== null && message.role !== "assistant")
      ) return false;
      continue;
    }
    const toolCallId = citation.target.tool_call_id;
    if (!toolCalls.some(
      (toolCall) => toolCall.tool_call_id === toolCallId,
    )) return false;
  }
  return true;
}

function isTurn(value: Record<string, unknown>): boolean {
  return isIdentifier(value.turn_id) &&
    (value.continuation_of_turn_id === null || isIdentifier(value.continuation_of_turn_id)) &&
    ["queued", "running", "waiting_for_tool_result", "waiting_for_approval", "completed", "cancelled", "failed"]
      .includes(String(value.status)) &&
    identifierArray(value.input_message_ids) !== null &&
    identifierArray(value.output_message_ids) !== null &&
    (value.outcome === null || ["stop", "length", "tool_calls"].includes(String(value.outcome))) &&
    (value.cancellation_reason === null || ["user", "timeout", "superseded", "runtime_shutdown"].includes(String(value.cancellation_reason))) &&
    (value.cancellation_status === null || isOneOf(
      value.cancellation_status,
      ["requested", "unsupported", "cancelled"],
    )) &&
    (value.cancellation_requested_reason === null || isOneOf(
      value.cancellation_requested_reason,
      ["user", "timeout", "superseded", "runtime_shutdown"],
    )) &&
    typeof value.remote_may_still_be_running === "boolean" &&
    (value.error === null || isTurnError(value.error)) &&
    Array.isArray(value.retry_history) && value.retry_history.every(isTurnRetryRecord) &&
    (value.started_at === null || typeof value.started_at === "string") &&
    (value.terminal_at === null || typeof value.terminal_at === "string") &&
    isNullableAttribution(value.attribution);
}

function isTurnRetryRecord(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPositiveSafeInteger(value.attempt) ||
    !isConversationTimestamp(value.occurred_at) || !isAttribution(value.attribution)) {
    return false;
  }
  switch (value.type) {
    case "turn.attempt_started":
      return hasExactKeys(value, [
        "type", "attempt", "operation", "occurred_at", "attribution",
      ]) && isOneOf(value.operation, ["start", "resume"]);
    case "turn.retry_scheduled":
      return hasExactKeys(value, [
        "type", "attempt", "reason_category", "delay_ms", "occurred_at", "attribution",
      ]) && isRetryReasonCategory(value.reason_category) &&
        isNonnegativeSafeInteger(value.delay_ms);
    case "turn.retry_exhausted":
      return hasExactKeys(value, [
        "type", "attempt", "reason_category", "exhaustion_reason", "occurred_at",
        "attribution",
      ]) && isRetryReasonCategory(value.reason_category) &&
        isOneOf(value.exhaustion_reason, ["maximum_attempts", "maximum_elapsed_time"]);
    default:
      return false;
  }
}

function isRetryReasonCategory(value: unknown): boolean {
  return isOneOf(value, [
    "rate_limit", "timeout", "unavailable", "internal", "disconnected", "interrupted",
  ]);
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonnegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isConversationTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ][month - 1];
  return year !== 0 && daysInMonth !== undefined && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 && Number.isFinite(Date.parse(value));
}

function isToolCall(value: Record<string, unknown>): boolean {
  return isIdentifier(value.tool_call_id) && isIdentifier(value.turn_id) &&
    (value.name === null || typeof value.name === "string") &&
    (value.arguments === null || isJsonObject(value.arguments)) &&
    (value.requested_at === null || typeof value.requested_at === "string") &&
    (value.discovered_at === null || typeof value.discovered_at === "string") &&
    (value.started_at === null || typeof value.started_at === "string") &&
    (value.approval_required_at === null || typeof value.approval_required_at === "string") &&
    isNullableAttribution(value.attribution) &&
    (value.result === null || isToolResult(value.result, value.tool_call_id as string));
}

export function isConversationApprovalProposalRecord(
  value: unknown,
): value is ConversationApprovalProposalRecord {
  return isPlainRecord(value) && isApprovalProposal(value);
}

function isApprovalProposal(value: Record<string, unknown>): boolean {
  const expectedKeys = [
    "proposal_id", "group_id", "turn_id", "tool_call_id", "tool_name",
    "reviewed_arguments", "status", "proposal_version", "expires_at",
    "created_at", "updated_at", "created_attribution", "latest_attribution",
    "decision_at", "decision_attribution", "decision_reason", "failure_reason",
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !isIdentifier(value.proposal_id) ||
    !(value.group_id === null || isIdentifier(value.group_id)) ||
    !isIdentifier(value.turn_id) ||
    !isIdentifier(value.tool_call_id) ||
    !isIdentifier(value.tool_name) ||
    !isConversationApprovalReviewedArguments(value.reviewed_arguments) ||
    !isOneOf(value.status, [
      "pending", "confirmed", "rejected", "expired", "executing", "executed",
      "failed",
    ]) ||
    !isPositiveSafeInteger(value.proposal_version) ||
    !(value.expires_at === null || isConversationTimestamp(value.expires_at)) ||
    !isConversationTimestamp(value.created_at) ||
    !isConversationTimestamp(value.updated_at) ||
    Date.parse(value.updated_at) < Date.parse(value.created_at) ||
    !isAttribution(value.created_attribution) ||
    value.created_attribution.actor.type !== "system" ||
    !isAttribution(value.latest_attribution) ||
    !(value.decision_at === null || isConversationTimestamp(value.decision_at)) ||
    !isNullableAttribution(value.decision_attribution) ||
    !(value.decision_reason === null || isConversationApprovalReason(value.decision_reason)) ||
    !(value.failure_reason === null || isConversationApprovalReason(value.failure_reason))
  ) return false;

  if (value.status === "pending") {
    return value.proposal_version === 1 && value.decision_at === null &&
      value.decision_attribution === null && value.decision_reason === null &&
      value.failure_reason === null;
  }
  if (
    value.proposal_version < 2 || value.decision_at === null ||
    value.decision_attribution === null ||
    !["user", "system"].includes(String(value.decision_attribution.actor.type))
  ) return false;
  if (["confirmed", "rejected", "expired", "executing", "executed"].includes(
    value.status,
  ) && value.failure_reason !== null) return false;
  return value.status !== "failed" || value.failure_reason !== null;
}

function isToolLoopBudgetExhaustion(value: Record<string, unknown>): boolean {
  return isIdentifier(value.turn_id) &&
    ["iterations", "total_tool_calls", "wall_clock"].includes(String(value.budget)) &&
    Number.isSafeInteger(value.limit) && (value.limit as number) > 0 &&
    typeof value.exhausted_at === "string" && isAttribution(value.attribution);
}

function isToolResult(value: unknown, toolCallId: string): boolean {
  if (!isPlainRecord(value)) return false;
  const expectedKeys = Object.hasOwn(value, "citation_records")
    ? ["content", "is_error", "citation_records", "recorded_at", "attribution"]
    : ["content", "is_error", "recorded_at", "attribution"];
  if (
    !hasExactKeys(value, expectedKeys) ||
    !Array.isArray(value.content) ||
    !value.content.every((part) => isTextPart(part) || isJsonPart(part)) ||
    typeof value.is_error !== "boolean" ||
    typeof value.recorded_at !== "string" ||
    !isAttribution(value.attribution)
  ) return false;
  if (!Object.hasOwn(value, "citation_records")) return true;
  try {
    const records = normalizeCitationRecords(value.citation_records);
    return records.citations.length > 0 &&
      jsonValuesEqual(records, value.citation_records) &&
      records.citations.every((citation) =>
        citation.target.type === "tool_result" &&
        citation.target.tool_call_id === toolCallId);
  } catch {
    return false;
  }
}

function isUsageLink(value: Record<string, unknown>): boolean {
  return isIdentifier(value.usage_receipt_id) && isIdentifier(value.turn_id) &&
    typeof value.linked_at === "string" && isAttribution(value.attribution);
}

function isTextPart(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ["type", "text"]) &&
    value.type === "text" && typeof value.text === "string";
}

function isJsonPart(value: unknown): boolean {
  return isPlainRecord(value) && value.type === "json" && isJsonValue(value.value);
}

function isTurnError(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.code === "string" &&
    typeof value.message === "string" && typeof value.retryable === "boolean";
}

type AttributionRecord = {
  actor: Record<string, unknown>;
  source: Record<string, unknown>;
};

function isNullableAttribution(
  value: unknown,
): value is AttributionRecord | null {
  return value === null || isAttribution(value);
}

function isAttribution(value: unknown): value is AttributionRecord {
  if (!isPlainRecord(value) || !isPlainRecord(value.actor) || !isPlainRecord(value.source)) {
    return false;
  }
  if (!["user", "assistant", "tool", "system"].includes(String(value.actor.type))) return false;
  if (value.actor.id !== undefined && !isIdentifier(value.actor.id)) return false;
  if (!["client", "runtime", "sync", "import"].includes(String(value.source.type))) return false;
  return value.source.type !== "client" || isIdentifier(value.source.client_id);
}

function recordArray(
  value: unknown,
  predicate: (item: Record<string, unknown>) => boolean,
): boolean {
  return Array.isArray(value) &&
    value.every((item) => isPlainRecord(item) && predicate(item));
}

function identifierArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(isIdentifier) ? value : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isJsonObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
