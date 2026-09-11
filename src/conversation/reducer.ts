import { jsonValuesEqual } from "../json-equality.js";
import {
  isLegalConversationApprovalProposalTransition,
  type ConversationApprovalReviewedArguments,
  type ConversationAttachmentReference,
  type ConversationEvent,
  type ConversationEventActor,
  type ConversationEventSource,
  type ConversationJsonObject,
  type ConversationJsonValue,
  type ConversationMessageContentPart,
  type ConversationToolResultContentPart,
} from "./events.js";
import {
  normalizeCitationRecords,
  type Citation,
  type CitationRecordSet,
  type CitationSource,
} from "../citations.js";
import type {
  ConversationApprovalProposalRecord,
  ConversationAttachmentRecord,
  ConversationEventAttribution,
  ConversationMessageRecord,
  ConversationReplayError,
  ConversationState,
  ConversationStateApprovalReviewedArguments,
  ConversationStateJsonObject,
  ConversationStateJsonValue,
  ConversationStateToolResultContentPart,
  ConversationToolCallRecord,
  ConversationToolLoopBudgetExhaustion,
  ConversationToolResultRecord,
  ConversationTurnRecord,
  ConversationTurnRetryRecord,
  ConversationUsageReceiptLink,
} from "./state.js";

/** Fold one validated durable event into an immutable conversation projection. */
export function reduceConversationEvent(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (
    state.processed_event_ids.includes(event.event_id) ||
    (event.mutation_id !== undefined &&
      state.processed_mutation_ids.includes(event.mutation_id))
  ) {
    return state;
  }

  if (
    state.conversation_id !== null &&
    state.conversation_id !== event.conversation_id
  ) {
    return withReplayError(state, {
      type: "conversation_mismatch",
      conversation_id: event.conversation_id,
      event_id: event.event_id,
      expected_conversation_id: state.conversation_id,
    });
  }

  const expectedRevision = (state.revision ?? 0) + 1;
  if (event.revision !== expectedRevision) {
    return withReplayError(state, {
      type:
        event.revision > expectedRevision
          ? "revision_gap"
          : "stale_revision",
      conversation_id: event.conversation_id,
      event_id: event.event_id,
      expected_revision: expectedRevision,
      received_revision: event.revision,
    });
  }

  const accepted = acceptEnvelope(state, event);
  const attribution = cloneAttribution(event.actor, event.source);
  const payload = event.payload;

  switch (payload.type) {
    case "message.created": {
      const index = accepted.messages.findIndex(
        (message) => message.message_id === payload.message_id,
      );
      if (index >= 0) {
        const current = accepted.messages[index]!;
        if (current.role !== null) return accepted;
        const replacement = freeze({
          ...current,
          role: payload.role,
          content: cloneMessageContent(payload.content),
          created_at: event.occurred_at,
          attribution,
        });
        const updated = event.source.type === "import"
          ? freeze({ ...accepted, messages: insertImportedMessage(
            accepted.messages.filter((_, position) => position !== index), replacement) })
          : updateMessages(accepted, index, replacement);
        return payload.role === "assistant"
          ? updated
          : removeCitationsForAssistantMessage(updated, payload.message_id);
      }

      const message: ConversationMessageRecord = freeze({
        message_id: payload.message_id,
        role: payload.role,
        content: cloneMessageContent(payload.content),
        attachments: freeze([]),
        created_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        messages: event.source.type === "import"
          ? insertImportedMessage(accepted.messages, message)
          : freeze([...accepted.messages, message]),
      });
    }

    case "message.text_appended": {
      const index = accepted.messages.findIndex(
        (message) => message.message_id === payload.message_id,
      );
      if (index >= 0) {
        const current = accepted.messages[index]!;
        if (
          (current.role !== null && current.role !== "assistant") ||
          (current.role === "assistant" && current.turn_id !== payload.turn_id)
        ) {
          return accepted;
        }
        return updateMessages(accepted, index, freeze({
          ...current,
          turn_id: payload.turn_id,
          role: "assistant",
          content: appendMessageText(current.content, payload.text),
          created_at: current.created_at ?? event.occurred_at,
          attribution: current.attribution ?? attribution,
        }));
      }

      const message: ConversationMessageRecord = freeze({
        message_id: payload.message_id,
        turn_id: payload.turn_id,
        role: "assistant",
        content: freeze([freeze({ type: "text", text: payload.text })]),
        attachments: freeze([]),
        created_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        messages: freeze([...accepted.messages, message]),
      });
    }

    case "message.attachment_referenced": {
      const reference = cloneAttachment(payload.attachment);
      const alreadyLinked = accepted.attachments.some(
        (attachment) =>
          attachment.message_id === payload.message_id &&
          attachment.attachment_id === reference.attachment_id,
      );
      const attachments = alreadyLinked
        ? accepted.attachments
        : freeze([
            ...accepted.attachments,
            freeze({
              message_id: payload.message_id,
              attachment_id: reference.attachment_id,
              reference,
              referenced_at: event.occurred_at,
              attribution,
            } satisfies ConversationAttachmentRecord),
          ]);

      const messageIndex = accepted.messages.findIndex(
        (message) => message.message_id === payload.message_id,
      );
      if (messageIndex >= 0) {
        const message = accepted.messages[messageIndex]!;
        if (
          message.attachments.some(
            (attachment) => attachment.attachment_id === reference.attachment_id,
          )
        ) {
          return attachments === accepted.attachments
            ? accepted
            : freeze({ ...accepted, attachments });
        }
        return freeze({
          ...updateMessages(accepted, messageIndex, freeze({
            ...message,
            attachments: freeze([...message.attachments, reference]),
          })),
          attachments,
        });
      }

      const placeholder: ConversationMessageRecord = freeze({
        message_id: payload.message_id,
        role: null,
        content: freeze([]),
        attachments: freeze([reference]),
        created_at: null,
        attribution: null,
      });
      return freeze({
        ...accepted,
        attachments,
        messages: freeze([...accepted.messages, placeholder]),
      });
    }

    case "citation.records_linked": {
      const records = normalizeCitationRecords({
        sources: payload.sources,
        citations: payload.citations,
      });
      const merged = mergeCitationRecords(accepted, records);
      if (merged === null) return accepted;

      if (payload.target.type === "assistant_message") {
        const messageId = payload.target.message_id;
        const message = accepted.messages.find(
          (candidate) => candidate.message_id === messageId,
        );
        if (message !== undefined && message.role !== null && message.role !== "assistant") {
          return accepted;
        }
        if (message !== undefined) return merged;
        const placeholder: ConversationMessageRecord = freeze({
          message_id: messageId,
          role: null,
          content: freeze([]),
          attachments: freeze([]),
          created_at: null,
          attribution: null,
        });
        return freeze({
          ...merged,
          messages: freeze([...merged.messages, placeholder]),
        });
      }

      const toolTarget = payload.target;
      const toolCall = accepted.tool_calls.find(
        (candidate) => candidate.tool_call_id === toolTarget.tool_call_id,
      );
      if (toolCall !== undefined && toolCall.turn_id !== toolTarget.turn_id) {
        return accepted;
      }
      if (toolCall !== undefined) return merged;
      const placeholder: ConversationToolCallRecord = freeze({
        tool_call_id: toolTarget.tool_call_id,
        turn_id: toolTarget.turn_id,
        name: null,
        arguments: null,
        requested_at: null,
        discovered_at: null,
        started_at: null,
        approval_required_at: null,
        attribution: null,
        result: null,
      });
      return freeze({
        ...merged,
        tool_calls: freeze([...merged.tool_calls, placeholder]),
      });
    }

    case "turn.started": {
      const index = findTurn(accepted, payload.turn_id);
      if (index >= 0) {
        const turn = accepted.turns[index]!;
        if (isTerminal(turn) || turn.started_at !== null) return accepted;
        return updateTurn(accepted, index, freeze({
          ...turn,
          input_message_ids: freeze([...payload.input_message_ids]),
          continuation_of_turn_id: payload.continuation_of_turn_id ?? null,
          started_at: event.occurred_at,
          attribution,
        }), payload.turn_id);
      }
      return appendTurn(accepted, freeze({
        turn_id: payload.turn_id,
        continuation_of_turn_id: payload.continuation_of_turn_id ?? null,
        status: "queued",
        input_message_ids: freeze([...payload.input_message_ids]),
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: null,
        cancellation_status: null,
        cancellation_requested_reason: null,
        remote_may_still_be_running: true,
        error: null,
        retry_history: freeze([]),
        started_at: event.occurred_at,
        terminal_at: null,
        attribution,
      }), payload.turn_id);
    }

    case "turn.status_changed": {
      const index = findTurn(accepted, payload.turn_id);
      if (index >= 0) {
        const turn = accepted.turns[index]!;
        if (isTerminal(turn)) return accepted;
        return updateTurn(accepted, index, freeze({
          ...turn,
          status: payload.status,
        }), payload.turn_id);
      }
      return appendTurn(accepted, emptyTurn({
        turn_id: payload.turn_id,
        status: payload.status,
        attribution,
      }), payload.turn_id);
    }

    case "turn.attempt_started":
      return appendTurnRetryRecord(accepted, payload.turn_id, freeze({
        type: payload.type,
        attempt: payload.attempt,
        operation: payload.operation,
        occurred_at: event.occurred_at,
        attribution,
      }));

    case "turn.retry_scheduled":
      return appendTurnRetryRecord(accepted, payload.turn_id, freeze({
        type: payload.type,
        attempt: payload.attempt,
        reason_category: payload.reason_category,
        delay_ms: payload.delay_ms,
        occurred_at: event.occurred_at,
        attribution,
      }));

    case "turn.retry_exhausted":
      return appendTurnRetryRecord(accepted, payload.turn_id, freeze({
        type: payload.type,
        attempt: payload.attempt,
        reason_category: payload.reason_category,
        exhaustion_reason: payload.exhaustion_reason,
        occurred_at: event.occurred_at,
        attribution,
      }));

    case "turn.cancellation_requested":
      return updateTurnCancellation(
        accepted,
        payload.turn_id,
        "requested",
        payload.reason,
        attribution,
      );

    case "turn.cancellation_unsupported":
      return updateTurnCancellation(
        accepted,
        payload.turn_id,
        "unsupported",
        payload.reason,
        attribution,
      );

    case "turn.completed":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "completed",
        output_message_ids: freeze([...payload.output_message_ids]),
        outcome: payload.outcome,
        cancellation_reason: null,
        remote_may_still_be_running: false,
        error: null,
      });

    case "turn.cancelled":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "cancelled",
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: payload.reason,
        cancellation_status: "cancelled",
        cancellation_requested_reason: payload.reason,
        remote_may_still_be_running: false,
        error: null,
      });

    case "turn.failed":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "failed",
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: null,
        remote_may_still_be_running: false,
        error: freeze({ ...payload.error }),
      });

    case "tool_call.requested": {
      if (isTerminalTurn(accepted, payload.turn_id)) return accepted;
      const index = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      if (index >= 0) {
        const current = accepted.tool_calls[index]!;
        if (current.name !== null || current.turn_id !== payload.turn_id) {
          return accepted;
        }
        return updateToolCall(accepted, index, freeze({
          ...current,
          name: payload.name,
          arguments: cloneJsonObject(payload.arguments),
          requested_at: event.occurred_at,
          attribution,
        }));
      }
      const toolCall: ConversationToolCallRecord = freeze({
        tool_call_id: payload.tool_call_id,
        turn_id: payload.turn_id,
        name: payload.name,
        arguments: cloneJsonObject(payload.arguments),
        requested_at: event.occurred_at,
        discovered_at: null,
        started_at: null,
        approval_required_at: null,
        attribution,
        result: null,
      });
      return freeze({
        ...accepted,
        tool_calls: freeze([...accepted.tool_calls, toolCall]),
      });
    }

    case "tool_call.discovered":
    case "tool_call.started":
    case "tool_call.approval_required": {
      const index = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      const field = payload.type === "tool_call.discovered"
        ? "discovered_at"
        : payload.type === "tool_call.started"
          ? "started_at"
          : "approval_required_at";
      if (index >= 0) {
        const current = accepted.tool_calls[index]!;
        if (current.turn_id !== payload.turn_id || current[field] !== null) return accepted;
        return updateToolCall(accepted, index, freeze({
          ...current,
          [field]: event.occurred_at,
        }));
      }
      const toolCall: ConversationToolCallRecord = freeze({
        tool_call_id: payload.tool_call_id,
        turn_id: payload.turn_id,
        name: null,
        arguments: null,
        requested_at: null,
        discovered_at: field === "discovered_at" ? event.occurred_at : null,
        started_at: field === "started_at" ? event.occurred_at : null,
        approval_required_at: field === "approval_required_at" ? event.occurred_at : null,
        attribution: null,
        result: null,
      });
      return freeze({
        ...accepted,
        tool_calls: freeze([...accepted.tool_calls, toolCall]),
      });
    }

    case "approval.proposal_created": {
      if (
        isTerminalTurn(accepted, payload.turn_id) ||
        accepted.approval_proposals.some(
          (proposal) => proposal.proposal_id === payload.proposal_id,
        )
      ) {
        return accepted;
      }
      const toolCallIndex = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      const toolCall = accepted.tool_calls[toolCallIndex];
      if (
        toolCall === undefined ||
        toolCall.turn_id !== payload.turn_id ||
        toolCall.name !== payload.tool_name
      ) {
        return accepted;
      }
      const proposal: ConversationApprovalProposalRecord = freeze({
        proposal_id: payload.proposal_id,
        group_id: payload.group_id ?? null,
        turn_id: payload.turn_id,
        tool_call_id: payload.tool_call_id,
        tool_name: payload.tool_name,
        reviewed_arguments: cloneApprovalReviewedArguments(
          payload.reviewed_arguments,
        ),
        status: payload.status,
        proposal_version: payload.proposal_version,
        expires_at: payload.expires_at,
        created_at: event.occurred_at,
        updated_at: event.occurred_at,
        created_attribution: attribution,
        latest_attribution: attribution,
        decision_at: null,
        decision_attribution: null,
        decision_reason: null,
        failure_reason: null,
      });
      const toolCalls = toolCall.approval_required_at === null
        ? replaceAt(accepted.tool_calls, toolCallIndex, freeze({
            ...toolCall,
            approval_required_at: event.occurred_at,
          }))
        : accepted.tool_calls;
      return freeze({
        ...accepted,
        tool_calls: toolCalls,
        approval_proposals: freeze([
          ...accepted.approval_proposals,
          proposal,
        ]),
      });
    }

    case "approval.proposal_status_changed": {
      const index = accepted.approval_proposals.findIndex(
        (proposal) => proposal.proposal_id === payload.proposal_id,
      );
      if (index < 0) return accepted;
      const current = accepted.approval_proposals[index]!;
      if (
        payload.proposal_version !== current.proposal_version + 1 ||
        !isLegalConversationApprovalProposalTransition(
          current.status,
          payload.status,
        )
      ) {
        return accepted;
      }
      const occurredAt = Date.parse(event.occurred_at);
      const expiresAt = Date.parse(current.expires_at);
      if (
        (payload.status === "expired" && occurredAt < expiresAt) ||
        (["confirmed", "executing"].includes(payload.status) &&
          occurredAt >= expiresAt)
      ) {
        return accepted;
      }
      const isDecision = ["confirmed", "rejected", "expired"].includes(
        payload.status,
      );
      const proposal: ConversationApprovalProposalRecord = freeze({
        ...current,
        status: payload.status,
        proposal_version: payload.proposal_version,
        updated_at: event.occurred_at,
        latest_attribution: attribution,
        decision_at: isDecision ? event.occurred_at : current.decision_at,
        decision_attribution: isDecision
          ? attribution
          : current.decision_attribution,
        decision_reason:
          isDecision && "decision_reason" in payload
            ? payload.decision_reason ?? null
            : current.decision_reason,
        failure_reason:
          payload.status === "failed"
            ? payload.failure_reason
            : payload.status === "executing"
              ? null
              : current.failure_reason,
      });
      return updateApprovalProposal(accepted, index, proposal);
    }

    case "tool_call.result_recorded": {
      const result: ConversationToolResultRecord = freeze({
        content: cloneToolResultContent(payload.content),
        is_error: payload.is_error,
        ...(payload.citation_records === undefined
          ? {}
          : { citation_records: normalizeCitationRecords(payload.citation_records) }),
        recorded_at: event.occurred_at,
        attribution,
      });
      const index = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      if (index >= 0) {
        const current = accepted.tool_calls[index]!;
        if (current.result !== null || current.turn_id !== payload.turn_id) {
          return accepted;
        }
        return updateToolCall(accepted, index, freeze({ ...current, result }));
      }
      const toolCall: ConversationToolCallRecord = freeze({
        tool_call_id: payload.tool_call_id,
        turn_id: payload.turn_id,
        name: null,
        arguments: null,
        requested_at: null,
        discovered_at: null,
        started_at: null,
        approval_required_at: null,
        attribution: null,
        result,
      });
      return freeze({
        ...accepted,
        tool_calls: freeze([...accepted.tool_calls, toolCall]),
      });
    }

    case "tool_loop.budget_exhausted": {
      if (accepted.tool_loop_budget_exhaustions.some(
        (item) => item.turn_id === payload.turn_id && item.budget === payload.budget,
      )) return accepted;
      const exhaustion: ConversationToolLoopBudgetExhaustion = freeze({
        turn_id: payload.turn_id,
        budget: payload.budget,
        limit: payload.limit,
        exhausted_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        tool_loop_budget_exhaustions: freeze([
          ...accepted.tool_loop_budget_exhaustions,
          exhaustion,
        ]),
      });
    }

    case "usage.receipt_linked": {
      if (
        accepted.usage_receipt_links.some(
          (link) => link.usage_receipt_id === payload.usage_receipt_id,
        )
      ) {
        return accepted;
      }
      const link: ConversationUsageReceiptLink = freeze({
        usage_receipt_id: payload.usage_receipt_id,
        turn_id: payload.turn_id,
        linked_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        usage_receipt_links: freeze([...accepted.usage_receipt_links, link]),
      });
    }

    case "conversation.metadata_updated":
      return freeze({
        ...accepted,
        metadata: cloneJsonObject(payload.metadata),
      });

    case "conversation.title_updated":
      return freeze({ ...accepted, title: payload.title });
  }
}

/** Historical imports retain their original time without reordering live event arrivals. */
function insertImportedMessage(
  messages: readonly ConversationMessageRecord[],
  message: ConversationMessageRecord,
): readonly ConversationMessageRecord[] {
  const timestamp = Date.parse(message.created_at!);
  const index = messages.findIndex((existing) =>
    existing.created_at !== null && Date.parse(existing.created_at) > timestamp);
  return freeze(index < 0 ? [...messages, message]
    : [...messages.slice(0, index), message, ...messages.slice(index)]);
}

function acceptEnvelope(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  return freeze({
    ...state,
    conversation_id: state.conversation_id ?? event.conversation_id,
    revision: event.revision,
    last_event_id: event.event_id,
    processed_event_ids: freeze([
      ...state.processed_event_ids,
      event.event_id,
    ]),
    processed_mutation_ids:
      event.mutation_id === undefined
        ? state.processed_mutation_ids
        : freeze([...state.processed_mutation_ids, event.mutation_id]),
    replay_error: null,
  });
}

function withReplayError(
  state: ConversationState,
  error: ConversationReplayError,
): ConversationState {
  if (sameReplayError(state.replay_error, error)) return state;
  return freeze({ ...state, replay_error: freeze(error) });
}

function sameReplayError(
  left: ConversationReplayError | null,
  right: ConversationReplayError,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function cloneAttribution(
  actor: ConversationEventActor,
  source: ConversationEventSource,
): ConversationEventAttribution {
  const clonedActor = freeze(
    actor.id === undefined ? { type: actor.type } : { type: actor.type, id: actor.id },
  );
  let clonedSource: Readonly<ConversationEventSource>;
  if (source.type === "client") {
    clonedSource = freeze(
      source.device_id === undefined
        ? { type: source.type, client_id: source.client_id }
        : {
            type: source.type,
            client_id: source.client_id,
            device_id: source.device_id,
          },
    );
  } else {
    clonedSource = freeze({ type: source.type });
  }
  return freeze({ actor: clonedActor, source: clonedSource });
}

function cloneAttachment(
  attachment: ConversationAttachmentReference,
): Readonly<ConversationAttachmentReference> {
  if (attachment.kind !== undefined) {
    return freeze({
      attachment_id: attachment.attachment_id,
      kind: attachment.kind,
      media_type: attachment.media_type,
      ...(attachment.filename === undefined
        ? {}
        : { filename: attachment.filename }),
      size_bytes: attachment.size_bytes,
    } as ConversationAttachmentReference);
  }
  return freeze({
    attachment_id: attachment.attachment_id,
    media_type: attachment.media_type,
    ...(attachment.filename === undefined
      ? {}
      : { filename: attachment.filename }),
    ...(attachment.size_bytes === undefined
      ? {}
      : { size_bytes: attachment.size_bytes }),
  });
}

function mergeCitationRecords(
  state: ConversationState,
  records: CitationRecordSet,
): ConversationState | null {
  const sources = [...state.citation_sources];
  const citations = [...state.citations];

  for (const source of records.sources) {
    const existing = sources.find((candidate) => candidate.source_id === source.source_id);
    if (existing !== undefined) {
      if (!jsonValuesEqual(existing, source)) return null;
      continue;
    }
    sources.push(cloneCitationSource(source));
  }
  for (const citation of records.citations) {
    const existing = citations.find(
      (candidate) => candidate.citation_id === citation.citation_id,
    );
    if (existing !== undefined) {
      if (!jsonValuesEqual(existing, citation)) return null;
      continue;
    }
    citations.push(cloneCitation(citation));
  }

  return freeze({
    ...state,
    citation_sources: freeze(sources),
    citations: freeze(citations),
  });
}

function cloneCitationSource(source: CitationSource): CitationSource {
  return freeze({
    source_id: source.source_id,
    type: source.type,
    label: source.label,
    ...(source.locator === undefined ? {} : { locator: source.locator }),
  });
}

function cloneCitation(citation: Citation): Citation {
  return freeze({
    citation_id: citation.citation_id,
    source_id: citation.source_id,
    order: citation.order,
    target: citation.target.type === "assistant_message"
      ? freeze({
          type: citation.target.type,
          message_id: citation.target.message_id,
        })
      : freeze({
          type: citation.target.type,
          tool_call_id: citation.target.tool_call_id,
        }),
  });
}

function removeCitationsForAssistantMessage(
  state: ConversationState,
  messageId: string,
): ConversationState {
  const citations = state.citations.filter(
    (citation) => citation.target.type !== "assistant_message" ||
      citation.target.message_id !== messageId,
  );
  return citations.length === state.citations.length
    ? state
    : freeze({ ...state, citations: freeze(citations) });
}

function cloneMessageContent(
  content: readonly ConversationMessageContentPart[],
): readonly Readonly<ConversationMessageContentPart>[] {
  return freeze(content.map((part) => freeze({ type: part.type, text: part.text })));
}

function appendMessageText(
  content: readonly Readonly<ConversationMessageContentPart>[],
  text: string,
): readonly Readonly<ConversationMessageContentPart>[] {
  if (content.length === 0) {
    return freeze([freeze({ type: "text", text })]);
  }
  const next = [...content];
  const index = next.length - 1;
  const current = next[index]!;
  next[index] = freeze({ type: "text", text: current.text + text });
  return freeze(next);
}

function cloneToolResultContent(
  content: readonly ConversationToolResultContentPart[],
): readonly ConversationStateToolResultContentPart[] {
  return freeze(content.map((part) =>
    part.type === "text"
      ? freeze({ type: part.type, text: part.text })
      : freeze({ type: part.type, value: cloneJson(part.value) }),
  ));
}

function cloneJsonObject(value: ConversationJsonObject): ConversationStateJsonObject {
  return cloneJson(value) as ConversationStateJsonObject;
}

function cloneApprovalReviewedArguments(
  value: ConversationApprovalReviewedArguments,
): ConversationStateApprovalReviewedArguments {
  return value.type === "opaque_reference"
    ? freeze({ type: value.type, argument_ref: value.argument_ref })
    : freeze({ type: value.type, value: cloneJsonObject(value.value) });
}

function cloneJson(value: ConversationJsonValue): ConversationStateJsonValue {
  if (Array.isArray(value)) {
    return freeze(value.map((item) => cloneJson(item)));
  }
  if (value !== null && typeof value === "object") {
    return freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ));
  }
  return value;
}

function updateMessages(
  state: ConversationState,
  index: number,
  message: ConversationMessageRecord,
): ConversationState {
  const messages = [...state.messages];
  messages[index] = message;
  return freeze({ ...state, messages: freeze(messages) });
}

function findTurn(state: ConversationState, turnId: string): number {
  return state.turns.findIndex((turn) => turn.turn_id === turnId);
}

function isTerminal(turn: ConversationTurnRecord): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "cancelled" ||
    turn.status === "failed"
  );
}

function isTerminalTurn(state: ConversationState, turnId: string): boolean {
  const index = findTurn(state, turnId);
  return index >= 0 && isTerminal(state.turns[index]!);
}

function emptyTurn(
  values: Pick<ConversationTurnRecord, "turn_id" | "status" | "attribution">,
): ConversationTurnRecord {
  return freeze({
    ...values,
    continuation_of_turn_id: null,
    input_message_ids: freeze([]),
    output_message_ids: freeze([]),
    outcome: null,
    cancellation_reason: null,
    cancellation_status: null,
    cancellation_requested_reason: null,
    remote_may_still_be_running: true,
    error: null,
    retry_history: freeze([]),
    started_at: null,
    terminal_at: null,
  });
}

function appendTurn(
  state: ConversationState,
  turn: ConversationTurnRecord,
  activeTurnId: ConversationTurnRecord["turn_id"] | null,
): ConversationState {
  return freeze({
    ...state,
    turns: freeze([...state.turns, turn]),
    active_turn_id: activeTurnId,
  });
}

function updateTurn(
  state: ConversationState,
  index: number,
  turn: ConversationTurnRecord,
  activeTurnId: ConversationTurnRecord["turn_id"] | null,
): ConversationState {
  const turns = [...state.turns];
  turns[index] = turn;
  return freeze({ ...state, turns: freeze(turns), active_turn_id: activeTurnId });
}

function terminateTurn(
  state: ConversationState,
  turnId: ConversationTurnRecord["turn_id"],
  terminalAt: ConversationTurnRecord["terminal_at"],
  attribution: ConversationEventAttribution,
  terminal: Pick<
    ConversationTurnRecord,
    | "status"
    | "output_message_ids"
    | "outcome"
    | "cancellation_reason"
    | "remote_may_still_be_running"
    | "error"
  > & Partial<Pick<
    ConversationTurnRecord,
    "cancellation_status" | "cancellation_requested_reason"
  >>,
): ConversationState {
  const index = findTurn(state, turnId);
  if (index >= 0) {
    const current = state.turns[index]!;
    if (isTerminal(current)) return state;
    return updateTurn(state, index, freeze({
      ...current,
      ...terminal,
      terminal_at: terminalAt,
    }), state.active_turn_id === turnId ? null : state.active_turn_id);
  }
  return appendTurn(state, freeze({
    turn_id: turnId,
    continuation_of_turn_id: null,
    input_message_ids: freeze([]),
    started_at: null,
    terminal_at: terminalAt,
    attribution,
    retry_history: freeze([]),
    cancellation_status: terminal.cancellation_status ?? null,
    cancellation_requested_reason: terminal.cancellation_requested_reason ?? null,
    ...terminal,
  }), state.active_turn_id);
}

function updateTurnCancellation(
  state: ConversationState,
  turnId: ConversationTurnRecord["turn_id"],
  status: Exclude<ConversationTurnRecord["cancellation_status"], null | "cancelled">,
  reason: Exclude<ConversationTurnRecord["cancellation_requested_reason"], null>,
  attribution: ConversationEventAttribution,
): ConversationState {
  const index = findTurn(state, turnId);
  if (index >= 0) {
    const turn = state.turns[index]!;
    if (isTerminal(turn)) return state;
    return updateTurn(state, index, freeze({
      ...turn,
      cancellation_status: status,
      cancellation_requested_reason: reason,
      remote_may_still_be_running: true,
    }), state.active_turn_id);
  }
  return appendTurn(state, freeze({
    ...emptyTurn({ turn_id: turnId, status: "queued", attribution }),
    cancellation_status: status,
    cancellation_requested_reason: reason,
  }), turnId);
}

function appendTurnRetryRecord(
  state: ConversationState,
  turnId: ConversationTurnRecord["turn_id"],
  record: ConversationTurnRetryRecord,
): ConversationState {
  const index = findTurn(state, turnId);
  if (index >= 0) {
    const turn = state.turns[index]!;
    return updateTurn(state, index, freeze({
      ...turn,
      retry_history: freeze([...turn.retry_history, record]),
    }), state.active_turn_id);
  }
  return appendTurn(state, freeze({
    ...emptyTurn({
      turn_id: turnId,
      status: "queued",
      attribution: record.attribution,
    }),
    retry_history: freeze([record]),
  }), turnId);
}

function updateToolCall(
  state: ConversationState,
  index: number,
  toolCall: ConversationToolCallRecord,
): ConversationState {
  const toolCalls = [...state.tool_calls];
  toolCalls[index] = toolCall;
  return freeze({ ...state, tool_calls: freeze(toolCalls) });
}

function updateApprovalProposal(
  state: ConversationState,
  index: number,
  proposal: ConversationApprovalProposalRecord,
): ConversationState {
  return freeze({
    ...state,
    approval_proposals: replaceAt(state.approval_proposals, index, proposal),
  });
}

function replaceAt<T>(
  values: readonly T[],
  index: number,
  value: T,
): readonly T[] {
  const next = [...values];
  next[index] = value;
  return freeze(next);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
