import type { ReactNode } from "react";
import { projectToolActivity, type ToolActivitySnapshot, type ToolActivityStatus } from "../conversation/tool-activity.js";
import type { ConversationState } from "../conversation/state.js";
import { useResolvedState } from "./primitive-context.js";

export interface ToolActivityProps {
  readonly state?: ConversationState;
  readonly turnId?: string;
  readonly display?: "collapsed" | "expanded" | "hidden";
  readonly className?: string;
  /** Replace presentation while keeping the same canonical projection. */
  readonly children?: (activity: ToolActivitySnapshot) => ReactNode;
}
const labels: Record<ToolActivityStatus, string> = { pending: "Pending", running: "Running",
  awaiting_approval: "Waiting for approval", completed: "Completed", failed: "Failed",
  cancelled: "Cancelled", incomplete: "No result recorded" };

/** Optional unstyled details panel backed by canonical tool lifecycle evidence. */
export function ToolActivity(props: ToolActivityProps): ReactNode {
  const state = useResolvedState(props.state);
  if (!state || props.display === "hidden") return null;
  const activity = projectToolActivity(state, props.turnId);
  if (activity.total === 0) return null;
  if (props.children) return props.children(activity);
  const counts = [`${activity.completed} completed`,
    ...(activity.recovered ? [`${activity.recovered} recovered after retry`] : []),
    ...(activity.running ? [`${activity.running} running`] : []),
    ...(activity.pending ? [`${activity.pending} pending`] : []),
    ...(activity.awaitingApproval ? [`${activity.awaitingApproval} waiting for approval`] : []),
    ...(activity.failed ? [`${activity.failed} failed`] : []),
    ...(activity.cancelled ? [`${activity.cancelled} cancelled`] : []),
    ...(activity.incomplete ? [`${activity.incomplete} without a recorded result`] : [])].join(", ");
  return <details key={`${activity.turnId}:${props.display ?? "collapsed"}`} className={props.className}
    {...(props.display === "expanded" ? { open: true } : {})}>
    <summary><span role="status">{activity.total} tool {activity.total === 1 ? "call" : "calls"}: {counts}</span></summary>
    <ol aria-label="Tool activity">{activity.items.map((item) => <li key={item.toolCallId} data-tool-status={item.status}>
      <span>{item.name}</span>{" — "}<span>{item.recovery?.status === "recovered"
        ? `Recovered after ${item.recovery.failedAttempts} failed ${item.recovery.failedAttempts === 1 ? "attempt" : "attempts"}` : labels[item.status]}</span>
    </li>)}</ol>
  </details>;
}
