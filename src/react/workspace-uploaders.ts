import { useEffect, useMemo } from "react";
import { createAttachmentUploader, type AttachmentUploader } from "../attachments/uploader.js";
import type { AttachmentUploadAdapter } from "../attachments/types.js";
import type { ConversationId } from "../conversation/events.js";
import { useConversationWorkspaceSnapshot, type ConversationWorkspaceReadable } from "./workspace.js";

/** One upload queue per retained conversation; no cross-thread attachment reuse. */
export function useWorkspaceUploaders<TSource>(workspace: ConversationWorkspaceReadable,
  adapter: AttachmentUploadAdapter<TSource> | null,
  factory?: (conversationId: ConversationId) => AttachmentUploader<TSource>) {
  const pool = useMemo(() => ({ revision: 0, items: new Map<ConversationId, AttachmentUploader<TSource>>() }),
    [workspace, adapter, factory]);
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  useEffect(() => {
    const ids = new Set(snapshot.threads.map((thread) => thread.conversationId));
    for (const [id, uploader] of pool.items) {
      if (!ids.has(id)) { uploader.dispose(); pool.items.delete(id); }
    }
  }, [pool, snapshot]);
  useEffect(() => {
    const revision = ++pool.revision;
    return () => {
      // React strict effects immediately reconnect the same pool. Actual
      // unmount/account changes release everything after that reconnect window.
      queueMicrotask(() => {
        if (pool.revision !== revision) return;
        for (const uploader of pool.items.values()) uploader.dispose();
        pool.items.clear();
      });
    };
  }, [pool]);
  return (conversationId: ConversationId): AttachmentUploader<TSource> => {
    let uploader = pool.items.get(conversationId);
    if (!uploader) {
      uploader = factory?.(conversationId) ?? createAttachmentUploader(adapter ?? {
        upload: async () => { throw new TypeError("This assistant does not accept attachments."); },
      });
      pool.items.set(conversationId, uploader);
    }
    return uploader;
  };
}
