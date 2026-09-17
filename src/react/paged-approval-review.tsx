import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ConversationApprovalReview, type ConversationApprovalReviewReader } from "../client/approval-review.js";
import type { ConversationApprovalDisplayDecisionInput } from "../conversation/approval-display-review.js";

export interface ConversationPagedApprovalReviewProps {
  readonly conversationId: string;
  readonly generation: number;
  readonly proposalId: string;
  /** Stable, account-owned reader. A different reader erases the old review. */
  readonly read: ConversationApprovalReviewReader;
  readonly decide: (input: ConversationApprovalDisplayDecisionInput, signal: AbortSignal) => Promise<unknown>;
  readonly readOnly?: boolean;
  readonly onRefresh: () => void;
}

/** Explicit, bounded review; generic record inspection cannot enable approval. */
export function ConversationPagedApprovalReview(props: ConversationPagedApprovalReviewProps) {
  const { conversationId, generation, proposalId, read } = props;
  const identity = useMemo(() => ({}), [conversationId, generation, proposalId, read]);
  const [saved, setSaved] = useState<{ identity: object; controller: ConversationApprovalReview }>();
  useEffect(() => {
    const controller = new ConversationApprovalReview({ conversationId, generation, proposalId }, read);
    setSaved({ identity, controller }); void controller.load();
    return () => controller.dispose();
  }, [identity, conversationId, generation, proposalId, read]);
  return saved?.identity === identity ? <ReviewView {...props} controller={saved.controller}/>
    : <p role="status">Loading action review…</p>;
}

function ReviewView(props: ConversationPagedApprovalReviewProps & { readonly controller: ConversationApprovalReview }) {
  const { controller } = props;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const latest = useRef(props); latest.current = props;
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => { if (region.current) region.current.scrollTop = 0; }, [state.offset]);
  const decide = (status: "confirmed" | "rejected") => {
    if (latest.current.readOnly) return;
    void controller.decide(status, (input, signal) => {
      signal.throwIfAborted();
      if (latest.current.readOnly) throw new Error("Approval is read-only");
      return latest.current.decide(input, signal);
    });
  };
  const busy = state.status === "loading" || state.status === "deciding";
  return <section className="hr-chat__approval" aria-label="Action review" aria-busy={busy}>
    <strong>{state.section?.toolName ?? "Action review"}</strong>
    {state.status === "decided" ? <p role="status">{state.decision === "confirmed" ? "Approval saved." : "Rejection saved."}</p>
      : state.status === "preparing" ? <p role="status">Action details are being prepared. <button type="button" onClick={() => { void controller.load(); }}>Retry review</button></p>
      : state.status === "error" ? <div role="alert">
        <p>{state.error === "changed" ? "This action changed. Reload its details and review again."
          : state.error === "denied" ? "This action is no longer available."
            : state.error === "decision" ? "The decision could not be verified. Retry to check the saved result."
              : "Action details could not be loaded."}</p>
        {state.error === "changed" && <button type="button" onClick={props.onRefresh}>Reload action</button>}
        {state.error === "unavailable" && <button type="button" onClick={() => { void controller.load(); }}>Retry review</button>}
        {state.error === "decision" && state.decision && <button type="button" disabled={props.readOnly} onClick={() => decide(state.decision!)}>Retry decision</button>}
      </div> : <>
        {state.status === "loading" || state.status === "idle" ? <p role="status">Loading action review…</p>
          : state.status === "deciding" ? <p role="status">Saving decision…</p> : null}
        {state.section && <>
          <p>Action arguments — part {Math.floor(state.offset / 8192) + 1}</p>
          <div ref={region} tabIndex={0} aria-label="Action arguments part"
            style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "50vh", overflowY: "auto" }}>{state.section.text}</div>
          <div>
            <button type="button" disabled={busy || state.offset === 0} onClick={() => { void controller.previous(); }}>Previous part</button>{" "}
            <button type="button" disabled={busy || state.section.nextOffset === null} onClick={() => { void controller.next(); }}>Next part</button>
          </div>
          <label><input type="checkbox" checked={state.acknowledged} disabled={busy || !state.complete || props.readOnly}
            onChange={event => controller.acknowledge(event.target.checked)}/> I have reviewed every part of this action</label>
          <div className="hr-chat__approval-actions">
            <button type="button" disabled={busy || props.readOnly || !state.complete || !state.acknowledged} onClick={() => decide("confirmed")}>Confirm</button>
            <button type="button" disabled={busy || props.readOnly} onClick={() => decide("rejected")}>Reject</button>
          </div>
        </>}
      </>}
  </section>;
}
