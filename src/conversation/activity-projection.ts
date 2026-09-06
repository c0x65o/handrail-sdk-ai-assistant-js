import type { ConversationWorkspaceSnapshot } from "./workspace.js";
import type { ConversationState } from "./state.js";
import type { ConversationActivityRecord } from "./activity.js";

/** Resolve server activity against the latest locally synchronized turn. */
export function resolveConversationActivity(
  state: ConversationState,
  localRecord: ConversationActivityRecord,
  remote: ConversationActivityRecord | undefined,
): ConversationActivityRecord {
  if (!remote) return localRecord;
  const latest = state.turns.at(-1);
  const local: ConversationActivityRecord = {
    ...localRecord,
    ...(latest ? { turnId: String(latest.turn_id) } : {}),
  };
  if (!latest) return remote;
  if (remote.turnId !== undefined) {
    if (remote.turnId === latest.turn_id) {
      // A terminal canonical event can arrive before the activity index catches up.
      if (remote.turnStatus === "running" && (localRecord.turnStatus === "completed" || localRecord.turnStatus === "error")) return local;
      return remote;
    }
    // A record for an earlier turn cannot hide the user's newly admitted request.
    if (state.turns.some((turn) => turn.turn_id === remote.turnId)) return local;
    // The server knows a turn that this runtime has not synchronized yet.
    return remote;
  }
  // Older/custom gateways have no turn identity. Keep their read markers visible;
  // use timestamps when present, otherwise preserve an admitted local run.
  const localAt = latest.terminal_at ?? latest.started_at;
  if (remote.updatedAt && localAt && remote.updatedAt > localAt) return remote;
  if (localRecord.turnStatus === "running") return local;
  return { ...local, unread: remote.unread || local.unread };
}

/** Shared launcher/list projection for open and unopened conversations. */
export function projectConversationActivity(
  workspace: ConversationWorkspaceSnapshot,
  remote: readonly ConversationActivityRecord[],
): readonly ConversationActivityRecord[] {
  const records = new Map(remote.map((record) => [String(record.conversationId), record]));
  for (const thread of workspace.threads) {
    const remoteRecord = records.get(String(thread.conversationId));
    const local = { conversationId: thread.conversationId, turnStatus: thread.turnStatus, unread: thread.unread };
    records.set(String(thread.conversationId), remoteRecord
      ? resolveConversationActivity(thread.runtime.getSnapshot(), local, remoteRecord) : local);
  }
  return Object.freeze([...records.values()].map((record) => Object.freeze(record)));
}

/** Execution failure stays in the transcript; attention depends only on running/unread. */
export function conversationAttentionStatus(record: Pick<ConversationActivityRecord, "turnStatus" | "unread"> | undefined): "running" | "unread" | "idle" {
  return record?.turnStatus === "running" ? "running" : record?.unread ? "unread" : "idle";
}

export function summarizeConversationActivity(records: readonly ConversationActivityRecord[]): {
  readonly runningCount: number; readonly unreadCount: number;
} {
  return Object.freeze({
    runningCount: records.filter((record) => record.turnStatus === "running").length,
    unreadCount: records.filter((record) => record.unread).length,
  });
}
