import type { ConversationPresentationState as ConversationState } from "../conversation/presentation.js";
import { Fragment, useContext, useMemo, useSyncExternalStore, type HTMLAttributes, type ReactNode } from "react";
import type { ApplicationConversationSession } from "../client/application-session.js";
import { ConversationContext } from "./context.js";
import { ConversationDisplayTranscript } from "./display-transcript.js";
import { conversationTimeline, type ConversationActivityGroup, type ConversationTimelineOptions } from "../conversation/timeline.js";
import type { ConversationApprovalProposalRecord, ConversationMessageRecord,  ConversationToolCallRecord } from "../conversation/state.js";
import { useSmartTranscriptFollow } from "./transcript-follow.js";
import { Message } from "./primitives.js";
import { ConversationDeferredRecords } from "./deferred-records.js";

export interface ConversationTranscriptProps extends Omit<HTMLAttributes<HTMLDivElement>, "children">, ConversationTimelineOptions {
  readonly state: ConversationState;
  readonly renderActivity?: (group: ConversationActivityGroup) => ReactNode;
  readonly renderMessage?: (message: ConversationMessageRecord) => ReactNode;
  readonly renderApproval?: (proposal: ConversationApprovalProposalRecord) => ReactNode;
  readonly renderToolResult?: (call: ConversationToolCallRecord) => ReactNode;
  readonly renderFailure?: (turn: ConversationState["turns"][number]) => ReactNode;
  readonly emptyState?: ReactNode;
  readonly children?: ReactNode;
}

/** Shared chronology, saved failures and scroll following; hosts supply domain card formatting. */
export function ConversationTranscript(props: ConversationTranscriptProps) {
  const session = useContext(ConversationContext)?.runtime?.displaySession;
  return session && props.state.partial ? <PagedConversationTranscript {...props} session={session}/>
    : <FullConversationTranscript {...props}/>;
}

function PagedConversationTranscript({ session, state, proposals, includeToolResult, includeActivity, renderActivity,
  renderMessage, renderApproval, renderToolResult, renderFailure, emptyState, children, ...props }:
  ConversationTranscriptProps & { readonly session: ApplicationConversationSession }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const positions = useMemo(() => ({ get: () => session.getPosition(), set: (_id: string, value: Parameters<typeof session.savePosition>[0]) => session.savePosition(value) }), [session]);
  const entries = conversationTimeline(state, { ...(proposals ? { proposals } : {}),
    ...(includeToolResult ? { includeToolResult } : {}), ...(includeActivity ? { includeActivity } : {}) });
  const before = new Map<string, ReactNode[]>(); let pending: ReactNode[] = [];
  for (const entry of entries) {
    if (entry.type === "message") { before.set(entry.message.message_id, pending); pending = []; continue; }
    const key = entry.type === "activity" ? `activity:${entry.group.id}` : entry.type === "approval" ? `approval:${entry.proposal.proposal_id}`
      : entry.type === "tool_result" ? `tool:${entry.call.turn_id}:${entry.call.tool_call_id}` : `failure:${entry.turn.turn_id}`;
    const node = entry.type === "activity" ? renderActivity?.(entry.group) : entry.type === "approval" ? renderApproval?.(entry.proposal)
      : entry.type === "tool_result" ? renderToolResult?.(entry.call) : renderFailure?.(entry.turn) ?? <article role="listitem" aria-label="Failed request">
        <strong>Request failed</strong><p>{entry.turn.error?.message ?? "The assistant could not complete this request."}</p></article>;
    pending.push(<Fragment key={key}>{node}</Fragment>);
  }
  return <ConversationDisplayTranscript {...props} controller={session.window} conversationId={snapshot.conversationId}
    manageSelection={false} positions={positions} pollingMilliseconds={0} onFollowingLatestChange={value => session.setFollowingLatest(value)}
    {...(session.supportsMessageText ? { readMessageText: session.readMessageText } : {})}
    emptyState={emptyState} renderMessage={record => {
      const message = state.messages.find(message => message.message_id === record.id) ?? record.value;
      return <>{before.get(record.id)}{message ? renderMessage?.(message) ?? <Message message={message}/> : null}</>;
    }}>
    {pending}{snapshot.loading && snapshot.window.status === "empty" && <p role="status">Loading conversation…</p>}
    {snapshot.error && <div role="alert"><p>{snapshot.error.message}</p>
      {snapshot.error.retryable && <button type="button" onClick={() => { void session.refresh().catch(() => undefined); }}>Retry conversation</button>}</div>}
    {(state.unresolvedCitationCount ?? 0) > 0 && <p role="status">Some citation sources are not loaded in this activity window.</p>}
    {session.supportsRecordText && <ConversationDeferredRecords conversationId={snapshot.conversationId}
      generation={snapshot.window.generation} records={snapshot.related} read={session.readRecordText}
      onRefresh={() => { void session.showLatestRelated().catch(() => undefined); }}/>}
    {snapshot.hasMoreRelated && <button type="button" onClick={() => { void session.loadMoreRelated().catch(() => undefined); }}>Load more activity</button>}
    {snapshot.relatedTruncated && <p>Showing part of this chat’s activity. <button type="button"
      onClick={() => { void session.showLatestRelated().catch(() => undefined); }}>Show latest activity</button></p>}
    {snapshot.hasPendingSubmission && <button type="button" disabled={snapshot.submitting}
      onClick={() => { void session.retryPending().catch(() => undefined); }}>Retry saved message</button>}
    {children}
  </ConversationDisplayTranscript>;
}

function FullConversationTranscript({ state, proposals, includeToolResult, includeActivity, renderActivity,
  renderMessage, renderApproval, renderToolResult, renderFailure, emptyState, children, onScroll, ...props }: ConversationTranscriptProps) {
  const contentVersion = useMemo(() => ({ state, proposals }), [state, proposals]);
  const follow = useSmartTranscriptFollow({ conversationId: state.conversation_id, contentVersion });
  const entries = conversationTimeline(state, {
    ...(includeActivity ? { includeActivity } : {}), ...(proposals ? { proposals } : {}), ...(includeToolResult ? { includeToolResult } : {}),
  });
  return <div className="hr-chat__transcript-wrap">
    <div {...props} ref={follow.transcriptRef} tabIndex={props.tabIndex ?? 0} role={props.role ?? "list"}
      aria-label={props["aria-label"] ?? "Conversation transcript"} onScroll={(event) => {
        onScroll?.(event); if (!event.defaultPrevented) follow.onScroll(event);
      }}>
      {entries.map((entry) => entry.type === "activity" ? <Fragment key={`activity:${entry.group.id}`}>{renderActivity?.(entry.group)}</Fragment>
        : entry.type === "message" ? <Fragment key={`message:${entry.message.message_id}`}>
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
