import {
  isConversationAttachmentReference,
  type ConversationAttachmentKind,
  type ConversationAttachmentReference,
  type ConversationDocumentAttachmentReference,
  type ConversationImageAttachmentReference,
} from "../conversation/events.js";
import type { AttachmentReference } from "../protocol.js";

/** Classifies validated saved metadata, including the v1 image representation.
 * This is not an ownership check or permission to read the attachment's bytes. */
export function conversationAttachmentKind(value: unknown): ConversationAttachmentKind {
  if (!isConversationAttachmentReference(value)) throw new TypeError("Invalid saved attachment reference");
  return value.kind ?? "image";
}

/** Converts an upload/resolution result to durable presentation metadata. Content
 * references remain server input and are never copied into transcript events. */
export function toConversationAttachmentReference(reference: AttachmentReference):
  ConversationImageAttachmentReference | ConversationDocumentAttachmentReference {
  const saved = {
    attachment_id: reference.attachment_id,
    kind: reference.media_type.startsWith("image/") ? "image" : "document",
    media_type: reference.media_type,
    size_bytes: reference.byte_size,
    ...(reference.filename === undefined ? {} : { filename: reference.filename }),
  };
  if (!isConversationAttachmentReference(saved)) throw new TypeError("Invalid resolved attachment reference");
  return saved as ConversationImageAttachmentReference | ConversationDocumentAttachmentReference;
}

/** Checks a saved reference against host-authorized storage metadata. The host
 * must authorize the account, conversation, source message and file first.
 * Legacy images may omit kind/size; known sizes may never be changed. */
export function assertConversationAttachmentMatches(
  saved: ConversationAttachmentReference,
  resolved: AttachmentReference,
): ConversationImageAttachmentReference | ConversationDocumentAttachmentReference {
  const kind = conversationAttachmentKind(saved);
  const canonical = toConversationAttachmentReference(resolved);
  if (saved.attachment_id !== canonical.attachment_id || saved.media_type !== canonical.media_type ||
      kind !== canonical.kind || (saved.size_bytes !== undefined && saved.size_bytes !== canonical.size_bytes)) {
    throw new TypeError("The resolved attachment does not match its saved reference");
  }
  return canonical;
}
