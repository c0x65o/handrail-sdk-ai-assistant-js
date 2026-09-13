import type { ConversationApprovalProposalRecord, ConversationMessageRecord, ConversationState, ConversationToolCallRecord } from "./state.js";

export type ConversationTimelineEntry =
  | { readonly type: "message"; readonly message: ConversationMessageRecord }
  | { readonly type: "approval"; readonly proposal: ConversationApprovalProposalRecord }
  | { readonly type: "tool_result"; readonly call: ConversationToolCallRecord }
  | { readonly type: "failure"; readonly turn: ConversationState["turns"][number] };

export interface ConversationTimelineOptions {
  readonly proposals?: readonly ConversationApprovalProposalRecord[];
  /** Show domain result cards; unselected tool results remain in activity. */
  readonly includeToolResult?: (call: ConversationToolCallRecord) => boolean;
  /** Migration adapter for a host's legacy turn/message identities. */
  readonly resolveLegacyTurnMessageId?: (turnId: string) => string | null;
}

/** Preserve canonical message order and bind actions/failures to their original question. */
export function conversationTimeline(state: ConversationState, options: ConversationTimelineOptions = {}): readonly ConversationTimelineEntry[] {
  const messages = state.messages;
  // Inputs are already scoped by the conversation store or authenticated resource.
  // A proposal group is an independent identity, not necessarily a conversation ID.
  const proposals = options.proposals ?? state.approval_proposals;
  const slots = new Map<number, ConversationTimelineEntry[]>();
  const add = (slot: number, entry: ConversationTimelineEntry) => slots.set(slot, [...(slots.get(slot) ?? []), entry]);
  const actions = proposals.map((proposal) => ({ entry: { type: "approval" as const, proposal },
    id: String(proposal.proposal_id), turnId: proposal.turn_id, createdAt: String(proposal.created_at) }));
  const results = state.tool_calls.flatMap((call) => {
    if (!call.result || !options.includeToolResult?.(call) || call.approval_required_at !== null || proposals.some((proposal) =>
      proposal.turn_id === call.turn_id && proposal.tool_call_id === call.tool_call_id && proposal.tool_name === call.name)) return [];
    return [{ entry: { type: "tool_result" as const, call }, id: `${call.turn_id}:${call.tool_call_id}`,
      turnId: call.turn_id, createdAt: call.requested_at ?? call.result.recorded_at }];
  });
  for (const item of [...actions, ...results].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))) {
    const turn = state.turns.find((candidate) => candidate.turn_id === item.turnId);
    const legacyMessageId = options.resolveLegacyTurnMessageId?.(String(item.turnId));
    const relatedIndex = messages.findIndex((message) => message.message_id === legacyMessageId ||
      message.turn_id === item.turnId || turn?.input_message_ids.includes(message.message_id) || turn?.output_message_ids.includes(message.message_id));
    let start = 0, end = messages.length;
    if (relatedIndex >= 0) {
      for (let index = relatedIndex; index >= 0; index--) if (messages[index]!.role === "user") { start = index + 1; break; }
      for (let index = Math.max(start, relatedIndex + 1); index < messages.length; index++) if (messages[index]!.role === "user") { end = index; break; }
    }
    let slot = end;
    for (let index = start; index < end; index++) {
      const message = messages[index]!;
      if (message.created_at === null) continue;
      const createdAt = Date.parse(message.created_at), requestedAt = Date.parse(item.createdAt);
      if (createdAt > requestedAt || createdAt === requestedAt && message.role !== "user") { slot = index; break; }
    }
    add(slot, item.entry);
  }
  const failures = new Map<number, ConversationTimelineEntry[]>();
  for (const turn of state.turns) {
    if (turn.status !== "failed") continue;
    const message = [...messages].reverse().find((candidate) => candidate.turn_id === turn.turn_id ||
      turn.output_message_ids.includes(candidate.message_id) || turn.input_message_ids.includes(candidate.message_id));
    const index = message ? messages.indexOf(message) : messages.length;
    failures.set(index, [...(failures.get(index) ?? []), { type: "failure", turn }]);
  }
  const entries: ConversationTimelineEntry[] = [];
  for (let index = 0; index <= messages.length; index++) {
    entries.push(...(slots.get(index) ?? []));
    if (index < messages.length) entries.push({ type: "message", message: messages[index]! });
    entries.push(...(failures.get(index) ?? []));
  }
  return entries;
}
