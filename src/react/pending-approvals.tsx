import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ApplicationConversationSession } from "../client/application-session.js";
import type { ConversationDisplayPage } from "../conversation/display-history.js";
import type { ConversationApprovalProposalRecord, ConversationToolCallRecord } from "../conversation/state.js";
import { ConversationDeferredRecords } from "./deferred-records.js";

/** At most one inbox page and one review pair are mounted/retained. Opening an
 * older pending action never changes the message window or model context. */
export function ConversationPendingApprovals({ session, renderApproval, renderPagedReview }: {
  readonly session: ApplicationConversationSession;
  readonly renderPagedReview?: (proposalId: string, generation: number, refresh: () => void) => ReactNode;
  readonly renderApproval: (proposal: ConversationApprovalProposalRecord, tools: readonly ConversationToolCallRecord[]) => ReactNode;
}) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [owner, setOwner] = useState(session);
  const [open, setOpen] = useState(false), [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<string>(), [attempt, retry] = useState(0);
  const usePagedReview = Boolean(renderPagedReview && session.supportsApprovalReview);
  const key = JSON.stringify([snapshot.control?.generation, snapshot.control?.revision, cursor, attempt]);
  const [inbox, setInbox] = useState<{ key: string; page?: ConversationDisplayPage; error?: boolean }>();
  const reviewKey = `${key}/${selected ?? ""}`;
  const [review, setReview] = useState<{ key: string; page?: ConversationDisplayPage; error?: boolean }>();
  // A new account can reuse the same chat ID, generation and revision. Reset
  // during render so no previous account's cached review can reach the DOM.
  if (owner !== session) {
    setOwner(session); setOpen(false); setCursor(undefined); setSelected(undefined);
    setInbox(undefined); setReview(undefined);
  }
  useEffect(() => {
    if (!open) { setInbox(undefined); return; }
    const request = new AbortController();
    void session.readApprovals(cursor ? { cursor } : {}, request.signal)
      .then(page => { if (!request.signal.aborted) setInbox({ key, page }); })
      .catch(() => { if (!request.signal.aborted) setInbox({ key, error: true }); });
    return () => request.abort();
  }, [session, open, cursor, key]);
  useEffect(() => {
    if (!open || !selected || usePagedReview) { setReview(undefined); return; }
    const request = new AbortController();
    void session.readApprovals({ proposalId: selected }, request.signal)
      .then(page => { if (!request.signal.aborted) setReview({ key: reviewKey, page }); })
      .catch(() => { if (!request.signal.aborted) setReview({ key: reviewKey, error: true }); });
    return () => request.abort();
  }, [session, open, selected, reviewKey, usePagedReview]);
  if (!session.supportsPendingApprovals || !snapshot.control?.hasPendingApprovals && !open) return null;
  const visible = inbox?.key === key ? inbox : undefined;
  const details = review?.key === reviewKey ? review : undefined;
  const proposal = details?.page?.records.find(record => record.kind === "approval" && record.id === selected);
  const tools = details?.page?.records.flatMap(record => record.kind === "tool" && record.value ? [record.value] : []) ?? [];
  const close = () => { setOpen(false); setCursor(undefined); setSelected(undefined); setInbox(undefined); setReview(undefined); };
  return <section aria-label="Pending approvals" className="hr-chat__pending-approvals">
    <button type="button" aria-expanded={open} onClick={() => open ? close() : setOpen(true)}>
      {open ? "Close pending approvals" : "Review pending approvals"}
    </button>
    {open && <div>
      {!visible ? <p role="status">Loading pending approvals…</p> : visible.error ? <p role="alert">Pending approvals could not be loaded.
        <button type="button" onClick={() => { setCursor(undefined); retry(value => value + 1); }}>Retry pending approvals</button></p> : <>
        {!visible.page?.records.length && <p>No pending approvals on this page.</p>}
        <ul>{visible.page?.records.map(record => <li key={record.id}>
          <button type="button" aria-pressed={selected === record.id} onClick={() => setSelected(record.id)}>
            Review {record.kind === "approval" && record.value ? record.value.tool_name : "action"}
          </button>
        </li>)}</ul>
        {visible.page?.nextCursor && <button type="button" onClick={() => { setCursor(visible.page!.nextCursor!); setSelected(undefined); }}>Older pending approvals</button>}
        {cursor && <button type="button" onClick={() => { setCursor(undefined); setSelected(undefined); }}>Newest pending approvals</button>}
      </>}
      {selected && <div aria-label="Selected approval">
        {!usePagedReview && details?.page && session.supportsRecordText && <ConversationDeferredRecords conversationId={snapshot.conversationId}
          generation={details.page.generation} records={details.page.records} read={session.readRecordText}
          onRefresh={() => retry(value => value + 1)}/>}
        {usePagedReview ? snapshot.control?.status === "ready" ? <div key={JSON.stringify([selected, snapshot.control.generation, attempt])}>
          {renderPagedReview!(selected, snapshot.control.generation, () => retry(value => value + 1))}</div> : <p role="status">Loading current approval…</p>
          : !details ? <p role="status">Loading approval details…</p> : details.error ? <p role="alert">Approval details could not be loaded.
          <button type="button" onClick={() => retry(value => value + 1)}>Retry approval details</button></p>
          : proposal?.kind === "approval" && proposal.value ? renderApproval(proposal.value, tools)
            : <p>{proposal?.deferred ? "This approval is too large for inline review. Confirmation is unavailable until its full details can be reviewed."
              : "This approval is no longer available."}</p>}
      </div>}
    </div>}
  </section>;
}
