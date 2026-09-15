import { useState, type ReactNode } from "react";
import type { ConversationState } from "../conversation/state.js";
import type { ConversationActivityRecord } from "../conversation/activity.js";
import type { ConversationActivityGroup } from "../conversation/timeline.js";
import { projectToolActivity, type ToolActivitySnapshot } from "../conversation/tool-activity.js";
import { structuredDetailLabel } from "../react/structured-details.js";

const labels = { pending: "Queued", running: "Running", awaiting_approval: "Waiting for approval",
  completed: "Completed", failed: "Failed", cancelled: "Stopped", incomplete: "No result recorded" };

/** One inline request group; raw tool arguments/results never enter the activity summary. */
export function ConversationActivityCard({ state, group, display = "collapsed", activity: remote, renderDetails }: {
  readonly state: ConversationState;
  readonly group: ConversationActivityGroup;
  readonly display?: "collapsed" | "expanded" | "hidden";
  readonly activity?: ConversationActivityRecord | undefined;
  readonly renderDetails?: ((activity: ToolActivitySnapshot) => ReactNode) | undefined;
}) {
  const [open, setOpen] = useState(display === "expanded");
  const activity = projectToolActivity(state, group.turnId);
  const turn = state.turns.find(turn => turn.turn_id === group.turnId);
  const waiting = turn?.status === "waiting_for_approval" || activity.awaitingApproval > 0;
  const stopped = turn?.status === "cancelled";
  const failed = turn?.status === "failed";
  const terminal = stopped || failed || turn?.status === "completed" && turn.outcome !== "tool_calls";
  const active = !waiting && !terminal && (state.active_turn_id === group.turnId ||
    !!activity.running || !!activity.pending || turn?.outcome === "tool_calls" || remote?.turnStatus === "running");
  const streaming = active && state.messages.some(message => message.role === "assistant" &&
    group.turnIds.includes(message.turn_id ?? "") && message.content.some(part => part.type === "text" && part.text.length > 0));
  // Quiet text-only completed turns don't need a permanent activity card.
  if (!activity.total && !active && !waiting) return null;
  const title = waiting ? "Waiting for approval" : failed ? "Activity failed" : stopped ? "Activity stopped"
    : active ? activity.running || activity.pending ? "Working…" : streaming ? "Writing response…" : "Thinking…"
      : activity.failed || activity.incomplete ? "Activity needs attention" : "Activity complete";
  const latest = [...activity.items].reverse().find(item => item.status === "running" || item.status === "awaiting_approval") ?? activity.items.at(-1);
  const progress = remote?.progress;
  const subtitle = active && remote?.summary ? `${remote.summary}${progress ? ` (${progress.completed}/${progress.total}${progress.unit ? ` ${progress.unit}` : ""})` : ""}`
    : latest ? `${structuredDetailLabel(latest.name)} · ${labels[latest.status]}` : "The assistant is working on your request.";
  const expandable = activity.total > 0 && display !== "hidden";
  const summary = <>
    <span className="hr-activity__icon" aria-hidden="true">{active ? <span className="hr-activity__dots">•••</span> : waiting ? "!" : failed || activity.failed || activity.incomplete ? "!" : stopped ? "■" : "✓"}</span>
    <span className="hr-activity__copy"><span className="hr-activity__heading"><strong>{title}</strong>
      {expandable && <span className="hr-activity__count">{activity.total} {activity.total === 1 ? "action" : "actions"}</span>}</span>
      {display !== "hidden" && <span className="hr-activity__latest">{subtitle}</span>}</span>
    {expandable && <span className="hr-activity__chevron" aria-hidden="true">{open ? "⌄" : "›"}</span>}
  </>;
  if (!expandable) return active || waiting ? <div className="hr-activity" data-active={active} role="status"><div className="hr-activity__summary">{summary}</div></div> : null;
  return <details className="hr-activity" data-active={active} data-waiting={waiting} open={open}
    onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="hr-activity__summary"><span className="hr-activity__announcement" role="status" aria-live="polite">{summary}</span></summary>
    <div className="hr-activity__details">{renderDetails ? renderDetails(activity) : <ol aria-label="Request actions">{activity.items.map(item =>
      <li key={item.toolCallId} data-tool-status={item.status}><span>{structuredDetailLabel(item.name)}</span><span>{item.recovery?.status === "recovered"
        ? `Completed after ${item.recovery.failedAttempts} ${item.recovery.failedAttempts === 1 ? "retry" : "retries"}` : labels[item.status]}</span></li>)}</ol>}</div>
  </details>;
}

export const HANDRAIL_ACTIVITY_CSS = `
.hr-activity{border:1px solid var(--hr-border);border-radius:var(--hr-radius-message);background:var(--hr-panel);margin:12px 0;min-inline-size:0;max-inline-size:100%;color:var(--hr-text)}
.hr-activity__summary{display:flex;align-items:center;gap:12px;padding:14px 16px;list-style:none}.hr-activity summary{cursor:pointer}.hr-activity summary::-webkit-details-marker{display:none}
.hr-activity__announcement{display:flex;align-items:center;gap:12px;min-inline-size:0;inline-size:100%}.hr-activity__icon{display:grid;place-items:center;flex:0 0 28px;block-size:28px;border-radius:50%;color:var(--hr-accent);background:color-mix(in srgb,var(--hr-accent),transparent 88%)}
.hr-activity__copy{display:grid;gap:5px;flex:1;min-inline-size:0}.hr-activity__heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}.hr-activity__count{background:color-mix(in srgb,var(--hr-accent),transparent 90%);color:var(--hr-accent);border-radius:999px;padding:2px 8px;font-size:11px;white-space:nowrap}.hr-activity__latest{font-size:12px;color:var(--hr-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hr-activity__chevron{color:var(--hr-muted);font-size:22px;flex:none}
.hr-activity__details{border-block-start:1px solid var(--hr-border);max-block-size:16rem;overflow:auto;padding:8px 16px;font-size:12px;overflow-wrap:anywhere}.hr-activity__details ol{list-style:none;margin:0;padding:0}.hr-activity__details li{display:flex;justify-content:space-between;gap:12px;padding:8px 0}.hr-activity__details li>span:last-child{color:var(--hr-muted);text-align:end}.hr-activity__details [data-tool-status=failed]>span:last-child{color:var(--hr-danger)}
.hr-activity[data-active=true] .hr-activity__dots{animation:hr-activity-pulse 1.2s ease-in-out infinite;letter-spacing:2px}@keyframes hr-activity-pulse{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){.hr-activity__dots{animation:none!important}}
`;
