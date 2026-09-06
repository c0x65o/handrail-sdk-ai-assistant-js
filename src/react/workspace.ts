import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { projectConversationActivity, summarizeConversationActivity } from "../conversation/activity-projection.js";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationWorkspaceSnapshot } from "../conversation/workspace.js";
import type { ConversationActivityReadable, ConversationActivityRecord } from "../conversation/activity.js";
export type { ConversationActivityReadable, ConversationActivityRecord } from "../conversation/activity.js";
import type {
  ChatLauncherConnectionStatus,
  ChatLauncherRootProps,
} from "./launcher.js";

const EMPTY_WORKSPACE_SNAPSHOT: ConversationWorkspaceSnapshot = Object.freeze({
  selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 0,
  threads: Object.freeze([]),
});
const EMPTY_ACTIVITY_SNAPSHOT: readonly ConversationActivityRecord[] = Object.freeze([]);

export interface ConversationWorkspaceReadable {
  getSnapshot(): ConversationWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
}

/** Subscribe React to all open threads without coupling runtime ownership to rendering. */
export function useConversationWorkspaceSnapshot(
  workspace?: ConversationWorkspaceReadable,
): ConversationWorkspaceSnapshot {
  const subscribe = useCallback((notify: () => void) =>
    workspace?.subscribe(notify) ?? (() => undefined), [workspace]);
  const snapshot = useCallback(() => workspace?.getSnapshot() ?? EMPTY_WORKSPACE_SNAPSHOT, [workspace]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type ConversationLauncherBinding = Pick<ChatLauncherRootProps,
  "activityProgress" | "activitySummary" | "connectionStatus" | "turnStatus" | "unreadCount" | "runningCount">;

/** Observe server activity and resolve it against currently open runtimes. */
export function useConversationActivitySnapshot(
  workspace?: ConversationWorkspaceReadable,
  activity?: ConversationActivityReadable,
): readonly ConversationActivityRecord[] {
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  const subscribeActivity = useCallback((notify: () => void) =>
    activity?.subscribe(notify) ?? (() => undefined), [activity]);
  const activitySnapshot = useCallback(() => activity?.getSnapshot() ?? EMPTY_ACTIVITY_SNAPSHOT, [activity]);
  const remote = useSyncExternalStore(subscribeActivity, activitySnapshot, activitySnapshot);
  return useMemo(() => projectConversationActivity(snapshot, remote), [snapshot, remote]);
}

/** Derive launcher button/badge state from every concurrent conversation. */
export function useConversationLauncherBinding(
  workspace?: ConversationWorkspaceReadable,
  connectionStatus?: ChatLauncherConnectionStatus,
  activity?: ConversationActivityReadable,
): ConversationLauncherBinding {
  const combined = useConversationActivitySnapshot(workspace, activity);
  const { runningCount, unreadCount } = summarizeConversationActivity(combined);
  const currentActivity = combined.filter((record) => record.turnStatus === "running" && record.summary)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
  return Object.freeze({
    ...(currentActivity?.progress === undefined ? {} : { activityProgress: currentActivity.progress }),
    ...(currentActivity?.summary === undefined ? {} : { activitySummary: currentActivity.summary }),
    ...(connectionStatus === undefined ? {} : { connectionStatus }),
    turnStatus: runningCount > 0 ? "busy" as const :
        unreadCount > 0 ? "completed" as const : "idle" as const,
    unreadCount, runningCount,
  });
}


/** Acknowledge only a visible, synchronized terminal reply, including a failed reply.
 * Minimized panels and hidden browser tabs retain unread updates. */
export function useConversationReadState(
  workspace: (ConversationWorkspaceReadable & {
    setVisible?(visible: boolean): void;
    markRead?(conversationId: ConversationId): void;
  }) | undefined,
  activity: ConversationActivityReadable | undefined,
  visible: boolean,
  onConversationRead?: (conversationId: ConversationId, observed?: ConversationActivityRecord) => void | Promise<void>,
): void {
  const [documentVisible, setDocumentVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const isVisible = visible && documentVisible;
  useEffect(() => {
    workspace?.setVisible?.(isVisible);
    return () => workspace?.setVisible?.(false);
  }, [workspace, isVisible]);
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  const records = useConversationActivitySnapshot(workspace, activity);
  const selected = snapshot.threads.find((thread) => thread.conversationId === snapshot.selectedConversationId);
  const record = records.find((candidate) => candidate.conversationId === selected?.conversationId);
  const latest = selected?.runtime.getSnapshot().turns.at(-1);
  // A server index may announce completion before the transcript arrives.
  const synchronized = latest && (latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled") &&
    (record?.turnId === undefined || record.turnId === latest.turn_id);
  const readId = isVisible && selected && record?.unread && synchronized ? selected.conversationId : null;
  const readKey = readId === null ? "" : JSON.stringify([readId, latest?.turn_id, record?.turnRevision, record?.updatedAt]);
  const acknowledge = useRef(onConversationRead);
  acknowledge.current = onConversationRead;
  useEffect(() => {
    if (readId === null) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const mark = async () => {
      try {
        await acknowledge.current?.(readId, record);
        if (!cancelled) workspace?.markRead?.(readId);
      } catch {
        if (!cancelled) retry = setTimeout(() => void mark(), 5_000);
      }
    };
    void mark();
    return () => { cancelled = true; clearTimeout(retry); };
  }, [workspace, readId, readKey, record]);
}
