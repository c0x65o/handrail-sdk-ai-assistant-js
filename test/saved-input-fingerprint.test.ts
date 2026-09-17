import { expect, it } from "vitest";
import { savedInputFingerprint } from "../src/server/saved-input-fingerprint.js";
import type { ConversationMessageRecord } from "../src/conversation/state.js";

const message = (text: string): ConversationMessageRecord => ({ message_id: "one" as never, role: "user",
  content: [{ type: "text", text }], attachments: [], created_at: null, attribution: null });
const fingerprint = (messages: readonly ConversationMessageRecord[], inputMessageIds = ["one"]) =>
  savedInputFingerprint({ messages, inputMessageIds });

it("retains exact Unicode and framing identity across chunk boundaries", () => {
  const text = "x".repeat(8191) + "😀" + "z".repeat(8191) + "\ud800";
  const original = message(text);
  const equal = structuredClone(original);
  expect(fingerprint([original])).toBe(fingerprint([equal]));
  expect(fingerprint([original])).not.toBe(fingerprint([message(text.slice(0, -1) + "\ud801")]));
  expect(fingerprint([message("ab"), message("c")])).not.toBe(fingerprint([message("a"), message("bc")]));
  expect(fingerprint([original])).not.toBe(fingerprint([original], ["other"]));
});

it("checks every saved message field and ignores object-key insertion order", () => {
  const original = message("input");
  expect(fingerprint([original])).toBe(fingerprint([{ ...Object.fromEntries(Object.entries(original).reverse()) } as unknown as ConversationMessageRecord]));
  for (const changed of [
    { ...original, turn_id: "new-turn" as never }, { ...original, role: "assistant" as const },
    { ...original, created_at: "2026-09-17T00:00:00Z" as never },
    { ...original, attachments: [{ attachment_id: "file" as never, media_type: "image/png", size_bytes: 4 }] },
  ]) expect(fingerprint([changed])).not.toBe(fingerprint([original]));
});
