import { useEffect, useRef, useState } from "react";
import type { AttachmentDownloadInput } from "../attachments/downloader.js";
import type { ConversationAttachmentReference } from "../conversation/events.js";
import { AttachmentImage } from "./attachment-image.js";

export type MessageAttachmentLoader = (input: AttachmentDownloadInput) => Promise<Uint8Array>;

/** Protected preview and download lifecycle shared by the optional workspace UI. */
export function ProtectedMessageAttachmentPreview({ attachment, conversationId, loadAttachment }: {
  readonly attachment: ConversationAttachmentReference;
  readonly conversationId: string;
  readonly loadAttachment: MessageAttachmentLoader;
}) {
  const { attachment_id: attachmentId, media_type: mediaType, size_bytes: byteSize } = attachment;
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType);
  const name = attachment.filename ?? (image ? "Image" : "Document");
  const active = useRef<{ abort: AbortController; previewUrl?: string; downloadUrl?: string; opening: boolean;
    loader: MessageAttachmentLoader; conversation: string; attachment: string; mediaType: string; byteSize: number | undefined } | null>(null);
  const [state, setState] = useState<{ owner: typeof active.current; url?: string; error?: string; opening?: boolean }>({ owner: null });
  const [attempt, setAttempt] = useState(0);
  // A changed loader represents a changed authenticated client/account, even for identical file IDs.
  useEffect(() => {
    const owner: NonNullable<typeof active.current> = { abort: new AbortController(), opening: false,
      loader: loadAttachment, conversation: conversationId, attachment: attachmentId, mediaType, byteSize };
    active.current = owner;
    setState({ owner });
    if (image) {
      void loadAttachment({ conversationId, attachmentId, mediaType, ...(byteSize === undefined ? {} : { byteSize }), signal: owner.abort.signal })
        .then((bytes) => {
          if (owner.abort.signal.aborted) return;
          owner.previewUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
          setState({ owner, url: owner.previewUrl, opening: owner.opening });
        }).catch(() => { if (!owner.abort.signal.aborted) setState({ owner, error: "Preview unavailable. Try again." }); });
    }
    return () => {
      owner.abort.abort();
      if (owner.previewUrl) URL.revokeObjectURL(owner.previewUrl);
      if (owner.downloadUrl) URL.revokeObjectURL(owner.downloadUrl);
      if (active.current === owner) active.current = null;
    };
  }, [loadAttachment, conversationId, attachmentId, mediaType, byteSize, image, attempt]);
  const download = async () => {
    const owner = active.current;
    if (!owner || owner.opening || owner.abort.signal.aborted) return;
    owner.opening = true;
    setState((previous) => ({ owner, ...(previous.url ? { url: previous.url } : {}), opening: true }));
    try {
      // Reauthorize on activation, including when an image preview is already cached.
      const bytes = await loadAttachment({ conversationId, attachmentId, mediaType,
        ...(byteSize === undefined ? {} : { byteSize }), signal: owner.abort.signal });
      if (owner.abort.signal.aborted || active.current !== owner) return;
      if (owner.downloadUrl) URL.revokeObjectURL(owner.downloadUrl);
      owner.downloadUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }));
      const link = document.createElement("a");
      link.href = owner.downloadUrl;
      link.download = name.replace(/[/\\\p{Cc}]/gu, "_");
      document.body.append(link);
      try { link.click(); } finally { link.remove(); }
      setState((previous) => ({ owner, ...(previous.url ? { url: previous.url } : {}) }));
    } catch {
      if (!owner.abort.signal.aborted) setState((previous) => ({ owner, ...(previous.url ? { url: previous.url } : {}),
        error: "Attachment unavailable. Try again." }));
    } finally { owner.opening = false; }
  };
  const current = state.owner === active.current && state.owner?.loader === loadAttachment &&
    state.owner.conversation === conversationId && state.owner.attachment === attachmentId && state.owner.mediaType === mediaType &&
    state.owner.byteSize === byteSize ? state : null;
  const downloadButton = <button type="button" disabled={current?.opening === true} onClick={() => { void download(); }}>
    {current?.opening ? "Loading attachment…" : `Download ${name}`}
  </button>;
  const errorMessage = current?.error ? <small role="status">{current.error}</small> : null;
  return <span className="hr-chat__attachment-card">
    {current?.url ? <AttachmentImage key={current.url} name={name} url={current.url}
      footer={<>{downloadButton}{errorMessage}</>} onError={() => setState((previous) => ({
      owner: previous.owner, error: "Preview unavailable. Try again.",
    }))}/> : <strong aria-hidden="true">{mediaType === "application/pdf" ? "PDF" : "FILE"}</strong>}
    <span className="hr-chat__attachment-copy"><strong>{name}</strong><small>{mediaType}</small>
      {(!image || (!current?.url && current?.error)) ? downloadButton : null}
      {!current?.url && current?.error ? <>{errorMessage}
        {image && !current.url ? <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry preview</button> : null}</> : null}
    </span>
  </span>;
}
