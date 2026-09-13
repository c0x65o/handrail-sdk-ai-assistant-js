import { Fragment, useMemo, type HTMLAttributes, type ReactNode } from "react";
import { conversationTimeline, type ConversationTimelineOptions } from "../conversation/timeline.js";
import type { ConversationApprovalProposalRecord, ConversationMessageRecord, ConversationState, ConversationToolCallRecord } from "../conversation/state.js";
import { useSmartTranscriptFollow } from "./transcript-follow.js";
import { Message } from "./primitives.js";

export interface ConversationTranscriptProps extends Omit<HTMLAttributes<HTMLDivElement>, "children">, ConversationTimelineOptions {
  readonly state: ConversationState;
  readonly renderMessage?: (message: ConversationMessageRecord) => ReactNode;
  readonly renderApproval?: (proposal: ConversationApprovalProposalRecord) => ReactNode;
  readonly renderToolResult?: (call: ConversationToolCallRecord) => ReactNode;
  readonly renderFailure?: (turn: ConversationState["turns"][number]) => ReactNode;
  readonly emptyState?: ReactNode;
  readonly children?: ReactNode;
}

/** Shared chronology, saved failures and scroll following; hosts supply domain card formatting. */
export function ConversationTranscript({ state, proposals, includeToolResult, resolveLegacyTurnMessageId,
  renderMessage, renderApproval, renderToolResult, renderFailure, emptyState, children, onScroll, ...props }: ConversationTranscriptProps) {
  const contentVersion = useMemo(() => ({ state, proposals }), [state, proposals]);
  const follow = useSmartTranscriptFollow({ conversationId: state.conversation_id, contentVersion });
  const entries = conversationTimeline(state, {
    ...(proposals ? { proposals } : {}), ...(includeToolResult ? { includeToolResult } : {}),
    ...(resolveLegacyTurnMessageId ? { resolveLegacyTurnMessageId } : {}),
  });
  return <div className="hr-chat__transcript-wrap">
    <div {...props} ref={follow.transcriptRef} tabIndex={props.tabIndex ?? 0} role={props.role ?? "list"}
      aria-label={props["aria-label"] ?? "Conversation transcript"} onScroll={(event) => {
        onScroll?.(event); if (!event.defaultPrevented) follow.onScroll(event);
      }}>
      {entries.map((entry) => entry.type === "message" ? <Fragment key={`message:${entry.message.message_id}`}>
        {renderMessage ? renderMessage(entry.message) : <Message message={entry.message}/>}</Fragment>
        : entry.type === "approval" ? <Fragment key={`approval:${entry.proposal.proposal_id}`}>{renderApproval?.(entry.proposal)}</Fragment>
          : entry.type === "tool_result" ? <Fragment key={`tool:${entry.call.turn_id}:${entry.call.tool_call_id}`}>{renderToolResult?.(entry.call)}</Fragment>
            : <Fragment key={`failure:${entry.turn.turn_id}`}>{renderFailure ? renderFailure(entry.turn) : <article className="hr-timeline__failure" role="listitem" aria-label="Failed request">
              <strong>Request failed</strong><p>{entry.turn.error?.message ?? "The assistant could not complete this request."}</p>
            </article>}</Fragment>)}
      {state.messages.length === 0 ? emptyState : null}{children}
    </div>
    {!follow.following && <button className="hr-chat__jump" type="button" aria-label="Jump to latest message" onClick={() => follow.scrollToLatest()}>
      {follow.hasNewContent ? "New messages" : "Jump to latest"}</button>}
  </div>;
}
