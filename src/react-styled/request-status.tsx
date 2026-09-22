import type { ConversationActivityRecord } from "../conversation/activity.js";
import type { ConversationPresentationState } from "../conversation/presentation.js";
import type { ConversationApprovalProposalRecord } from "../conversation/state.js";
import { projectToolActivity } from "../conversation/tool-activity.js";

/** Current request status lives outside the scrolling transcript and action history. */
export function ConversationRequestStatus({ state, proposals, activity, hasPendingApprovals, savingDecision, onReview }: {
  readonly state: ConversationPresentationState;
  readonly proposals: readonly ConversationApprovalProposalRecord[];
  readonly activity: ConversationActivityRecord | undefined;
  readonly hasPendingApprovals: boolean;
  readonly savingDecision: boolean;
  readonly onReview?: (() => void) | undefined;
}) {
  const turn = state.turns.find(item => item.turn_id === state.active_turn_id) ?? state.turns.at(-1);
  const tools = projectToolActivity(state);
  const pending = proposals.filter(proposal => proposal.status === "pending");
  const decisions = proposals.filter(proposal => proposal.turn_id === turn?.turn_id);
  const decided = decisions.length > 0 && decisions.every(proposal => proposal.status !== "pending");
  const waiting = pending.length > 0 || hasPendingApprovals || turn?.status === "waiting_for_approval" && !decided;
  const executing = decisions.some(proposal => proposal.status === "confirmed" || proposal.status === "executing");
  const remoteRunning = activity?.turnStatus === "running" && (!turn || activity.turnId !== turn.turn_id);
  const terminal = turn?.status === "failed" || turn?.status === "cancelled" || turn?.status === "completed" && turn.outcome !== "tool_calls";
  let phase: "saving" | "waiting" | "working" | "complete" | "attention";
  let title: string, detail: string;
  if (savingDecision) {
    phase = "saving"; title = "Saving approval decision…"; detail = "Please wait for confirmation.";
  } else if (waiting) {
    phase = "waiting"; title = "Waiting for approval";
    detail = pending.length > 0 && !state.partial
      ? `${pending.length} ${pending.length === 1 ? "action needs" : "actions need"} your review.`
      : "There are actions that need your review.";
  } else if (turn?.remote_may_still_be_running && !state.active_turn_id) {
    phase = "working"; title = "Checking request status…"; detail = "The assistant may still be working.";
  } else if (remoteRunning || !terminal && (state.active_turn_id || executing || turn?.status === "waiting_for_approval" && decided
    || turn?.status === "completed" && turn.outcome === "tool_calls")) {
    phase = "working";
    title = executing ? "Running approved changes…" : turn?.status === "waiting_for_approval" || turn?.outcome === "tool_calls"
      ? "Continuing…" : "Working…";
    detail = "The request is still in progress.";
  } else if (turn?.status === "failed" || activity?.turnStatus === "error") {
    phase = "attention"; title = "Request failed"; detail = "Review the error in this conversation.";
  } else if (turn?.status === "cancelled") {
    phase = "attention"; title = "Request stopped"; detail = "Review any changes that already ran.";
  } else if (turn?.status === "completed" || activity?.turnStatus === "completed") {
    phase = tools.failed || tools.incomplete ? "attention" : "complete";
    title = phase === "attention" ? "Finished · some actions need attention" : "Request complete";
    detail = "The assistant has finished responding.";
  } else if (turn) {
    phase = "working"; title = "Working…"; detail = "The request is still in progress.";
  } else return null;
  return <section className="hr-chat__request-status" aria-label="Current request" data-phase={phase}>
    <div role="status" aria-live="polite" aria-atomic="true">
      <span className="hr-chat__request-icon" aria-hidden="true">{phase === "working" || phase === "saving" ? "•••"
        : phase === "complete" ? "✓" : "!"}</span>
      <span><strong>{title}</strong><span className="hr-chat__request-detail">{detail}</span></span>
    </div>
    {waiting && !savingDecision && onReview && <button type="button" onClick={onReview}>Review next</button>}
  </section>;
}

export const REQUEST_STATUS_CSS = `
.hr-chat__request-status{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;border-block-start:1px solid var(--hr-border);background:var(--hr-bg);font-size:12px;min-inline-size:0}
.hr-chat__request-status>[role=status]{display:flex;align-items:center;gap:10px;min-inline-size:0}.hr-chat__request-status strong{display:block}.hr-chat__request-detail{display:block;color:var(--hr-muted);overflow-wrap:anywhere}.hr-chat__request-icon{flex:none;color:var(--hr-accent)}.hr-chat__request-status>button{flex:none}
.hr-chat__request-status[data-phase=waiting]{background:var(--hr-panel)}.hr-chat__request-status[data-phase=working] .hr-chat__request-icon,.hr-chat__request-status[data-phase=saving] .hr-chat__request-icon{animation:hr-activity-pulse 1.2s ease-in-out infinite;letter-spacing:2px}@media(prefers-reduced-motion:reduce){.hr-chat__request-icon{animation:none!important}}
`;
