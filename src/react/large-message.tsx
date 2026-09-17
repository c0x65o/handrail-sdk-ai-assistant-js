import { useEffect, useState } from "react";
import type { ConversationDisplayContentInput, ConversationDisplayContentChunk, ConversationDisplayRecord } from "../conversation/display-history.js";

export type ConversationMessageTextReader = (input: ConversationDisplayContentInput, signal: AbortSignal) => Promise<ConversationDisplayContentChunk>;

/** One explicit, revision-pinned text section. Never assembles record JSON or
 * grows the transcript cache. The parent permits only one expanded reader. */
export function ConversationLargeMessage({ conversationId, generation, record, read, expanded, onOpen, onClose, onRefresh }:
  { readonly conversationId: string; readonly generation: number; readonly record: ConversationDisplayRecord;
    readonly read: ConversationMessageTextReader; readonly expanded: boolean;
    readonly onOpen: () => void; readonly onClose: () => void; readonly onRefresh: () => void }) {
  const key = JSON.stringify([conversationId, generation, record.id, record.revision]);
  const [navigation, setNavigation] = useState({ key, owner: read, offset: 0, retry: 0 });
  const current = navigation.key === key && navigation.owner === read ? navigation : { key, owner: read, offset: 0, retry: 0 };
  const [page, setPage] = useState<{ key: string; owner: ConversationMessageTextReader; offset: number;
    text: string; next: number | null; error: "changed" | "denied" | "unavailable" | null; loading: boolean } | null>(null);
  useEffect(() => {
    if (!expanded) { setPage(null); setNavigation({ key, owner: read, offset: 0, retry: 0 }); return; }
    const abort = new AbortController();
    setPage({ key, owner: read, offset: current.offset, text: "", next: null, error: null, loading: true });
    void read({ conversationId, generation, kind: "message", id: record.id, revision: record.revision,
      format: "message-text", offset: current.offset }, abort.signal).then(chunk => {
      if (abort.signal.aborted) return;
      const length = Array.from(chunk.text).length;
      if (chunk.encoding !== "plain-text" || chunk.revision !== record.revision || length > 8192 ||
          chunk.nextOffset !== null && (length !== 8192 || chunk.nextOffset !== current.offset + length)) throw new Error("Invalid message section");
      setPage({ key, owner: read, offset: current.offset, text: chunk.text, next: chunk.nextOffset, error: null, loading: false });
    }).catch((cause: unknown) => {
      if (abort.signal.aborted) return;
      const code = cause && typeof cause === "object" ? (cause as { resourceCode?: string; code?: string }).resourceCode ?? (cause as { code?: string }).code : undefined;
      setPage({ key, owner: read, offset: current.offset, text: "", next: null, loading: false,
        error: code === "content_changed" || code === "stale_cursor" ? "changed"
          : ["forbidden", "permission_denied", "unauthenticated", "not_found"].includes(code ?? "") ? "denied" : "unavailable" });
    });
    return () => { abort.abort(); };
  }, [conversationId, generation, key, read, record.id, record.revision, expanded, current.offset, current.retry]);
  if (!expanded) return <p>Large message. <button type="button" onClick={onOpen}>Read message</button></p>;
  const visible = page?.key === key && page.owner === read && page.offset === current.offset ? page : null;
  return <section aria-label="Large message text" aria-busy={visible?.loading ?? true}>
    <div><strong>Message text — part {Math.floor(current.offset / 8192) + 1}</strong>{" "}
      <button type="button" onClick={onClose}>Close message</button></div>
    {!visible || visible.loading ? <p role="status">Loading message…</p> : visible.error ? <div role="alert">
      <p>{visible.error === "changed" ? "This message changed. Reload it to read the latest version."
        : visible.error === "denied" ? "This message is no longer available." : "This part could not be loaded."}</p>
      {visible.error === "unavailable" && <button type="button" onClick={() => setNavigation({ ...current, retry: current.retry + 1 })}>Retry reading</button>}
      {visible.error === "changed" && <button type="button" onClick={() => { onClose(); onRefresh(); }}>Reload message</button>}
    </div> : <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "50vh", overflowY: "auto" }} tabIndex={0} aria-label="Message text part">
      {visible.text || "This message has no text."}</div>}
    <div aria-label="Message text navigation">
      <button type="button" disabled={!visible || visible.loading || current.offset === 0 || visible.error === "denied"}
        onClick={() => setNavigation({ key, owner: read, offset: Math.max(0, current.offset - 8192), retry: 0 })}>Previous part</button>{" "}
      <button type="button" disabled={!visible || visible.loading || visible.error !== null || visible.next === null}
        onClick={() => { if (visible?.next !== null && visible?.next !== undefined) setNavigation({ key, owner: read, offset: visible.next, retry: 0 }); }}>Next part</button>
    </div>
  </section>;
}
