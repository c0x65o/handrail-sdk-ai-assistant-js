import { describe, expect, it } from "vitest";
import { assertConversationAttachmentMatches, conversationAttachmentKind,
  toConversationAttachmentReference } from "../src/attachments/references.js";
import { parseConversationEvent, type ConversationAttachmentReference } from "../src/conversation/events.js";
import type { AttachmentReference } from "../src/protocol.js";

const image: AttachmentReference = { attachment_id: "att_image", content_ref: "ref_private",
  media_type: "image/png", byte_size: 4, filename: "image.png" };
const legacy = { attachment_id: "att_image", media_type: "image/png", filename: "image.png" } as ConversationAttachmentReference;

describe("shared saved attachment references", () => {
  it.each([legacy, { ...legacy, size_bytes: 4 }, toConversationAttachmentReference(image)])(
    "accepts historical and explicit image metadata without changing stored input", saved => {
      const before = JSON.stringify(saved);
      expect(conversationAttachmentKind(saved)).toBe("image");
      expect(assertConversationAttachmentMatches(saved, image)).toEqual({ attachment_id: "att_image",
        kind: "image", media_type: "image/png", size_bytes: 4, filename: "image.png" });
      expect(JSON.stringify(saved)).toBe(before);
    });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/csv"] as const)(
    "emits replayable explicit metadata for %s without provider content references", media_type => {
      const attachment = toConversationAttachmentReference({ ...image, media_type });
      expect(attachment.kind).toBe(media_type.startsWith("image/") ? "image" : "document");
      expect(attachment).not.toHaveProperty("content_ref");
      expect(() => parseConversationEvent({ version: 1, event_id: "event", conversation_id: "conversation",
        revision: 1, occurred_at: "2026-09-15T12:00:00Z", actor: { type: "user" }, source: { type: "runtime" },
        payload: { type: "message.attachment_referenced", message_id: "message", attachment } })).not.toThrow();
    });

  it.each([
    { ...legacy, kind: "document" }, { ...legacy, media_type: "application/pdf" },
    { ...legacy, size_bytes: -1 }, { ...legacy, filename: "../secret" },
    { ...legacy, content_ref: "ref_injected" },
  ])("rejects malformed saved references instead of inferring a permissive kind", saved => {
    expect(() => conversationAttachmentKind(saved)).toThrow();
  });

  it.each([
    { ...image, attachment_id: "att_other" }, { ...image, media_type: "image/jpeg" as const },
    { ...image, byte_size: 5 },
  ])("rejects changed resolved identity, media type or known size", resolved => {
    expect(() => assertConversationAttachmentMatches({ ...legacy, size_bytes: 4 }, resolved)).toThrow();
  });
});
