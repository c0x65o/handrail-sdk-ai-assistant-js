import { useState } from "react";
import type { ConversationComposerAttachment } from "../react/use-conversation-composer.js";
import { AttachmentRemove } from "../react/primitives.js";
import { AttachmentImage } from "./attachment-image.js";

export function ComposerAttachment({ attachment }: { readonly attachment: ConversationComposerAttachment }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = attachment.filename ?? (attachment.kind === "image" ? "Pasted image" : "Document");
  const busy = attachment.status === "queued" || attachment.status === "uploading";
  const size = attachment.byteSize < 1024 * 1024
    ? `${Math.max(1, Math.ceil(attachment.byteSize / 1024))} KB`
    : `${Number((attachment.byteSize / (1024 * 1024)).toFixed(1))} MB`;
  return <div className="hr-composer__attachment">
    {attachment.previewUrl && failedUrl !== attachment.previewUrl
      ? <AttachmentImage url={attachment.previewUrl} name={name} onError={() => setFailedUrl(attachment.previewUrl ?? null)}/>
      : <span className="hr-composer__file-icon" aria-hidden="true">{attachment.kind === "image" ? "Image" : "File"}</span>}
    <span className="hr-composer__attachment-copy"><strong title={name}>{name}</strong><small>{size}</small>
      {busy && <><small role="status">Uploading…</small><progress aria-label={`${name} upload progress`}
        max={Math.max(attachment.progress.totalBytes, 1)} value={Math.min(attachment.progress.uploadedBytes, attachment.progress.totalBytes)}/></>}
      {attachment.error ? <small role="alert">{attachment.error.message}</small> : null}
      {attachment.status === "cancelled" || attachment.status === "missing" ? <small role="status">Upload stopped. Remove and attach again.</small> : null}
      {failedUrl && failedUrl === attachment.previewUrl ? <small role="status">Preview unavailable</small> : null}
    </span>
    <AttachmentRemove className="hr-composer__attachment-remove" title={`Remove ${name}`}><span aria-hidden="true">×</span></AttachmentRemove>
  </div>;
}
