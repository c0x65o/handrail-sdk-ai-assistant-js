import { expect, it, vi } from "vitest";
import { prepareSavedConversationRequest, type SavedConversationRequestOptions } from "../src/server/saved-conversation-request.js";
import type { ConversationMessageRecord } from "../src/conversation/state.js";
import type { AttachmentMimeType, ChatRequest } from "../src/protocol.js";

const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Untrusted browser history" }] }],
  tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
function message(id: string, mediaType?: AttachmentMimeType): ConversationMessageRecord {
  return { message_id: id as never, role: "user", content: [{ type: "text", text: `Saved ${id}` }],
    created_at: null, attribution: null, attachments: mediaType === undefined ? [] : [{
      attachment_id: `att_${id}` as never, media_type: mediaType, size_bytes: 4,
      // Exercise actual legacy React image metadata; Flutter's explicit kind is covered separately.
      ...(mediaType.startsWith("image/") ? {} : { kind: "document" as const }),
    } as ConversationMessageRecord["attachments"][number]] };
}
function fixture(history: readonly ConversationMessageRecord[], overrides: Partial<SavedConversationRequestOptions> = {}) {
  const resolveAttachment = vi.fn<SavedConversationRequestOptions["resolveAttachment"]>(async (file) => ({
    attachment_id: file.attachment_id, content_ref: `ref_${file.attachment_id}`,
    media_type: file.media_type as AttachmentMimeType, byte_size: 4,
  }));
  const controller = new AbortController();
  const options: SavedConversationRequestOptions = { request, messages: [...history, message("current")],
    inputMessageIds: ["current"], turnId: "current-turn", signal: controller.signal, resolveAttachment, ...overrides };
  return { options, resolveAttachment, controller, run: () => prepareSavedConversationRequest(options) };
}
it.each([["application/pdf", 5, 4], ["image/png", 9, 8]] as const)(
  "bounds historical %s files from %i to %i on a text follow-up", async (media, count, bound) => {
    const h = fixture(Array.from({ length: count }, (_, index) => message(`old${index}`, media)));
    const result = await h.run();
    expect(result.request.messages.at(-1)?.content).toEqual([{ type: "text", text: "Saved current" }]);
    expect(result.files).toHaveLength(count);
    expect(result.files.filter(file => file.included)).toHaveLength(bound);
    expect(h.resolveAttachment).toHaveBeenCalledTimes(bound);
    expect(result.files[0]?.included).toBe(false);
    expect(JSON.stringify(result.request)).not.toContain("Untrusted browser history");
  });
it("includes original file references on a follow-up rather than only the prior textual answer", async () => {
  const h = fixture([message("image", "image/png")]);
  const result = await h.run();
  expect(result.request.messages[0]?.content[1]).toMatchObject({ type: "image",
    attachment: { attachment_id: "att_image", content_ref: "ref_att_image" } });
  expect(h.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({ attachment_id: "att_image" }), "image", h.controller.signal);
});
it("prioritizes current files and bounds historical files without resolving omitted bytes", async () => {
  const history = Array.from({ length: 7 }, (_, index) => message(`old${index}`, "application/pdf"));
  const h = fixture(history, { messages: [...history, message("current", "application/pdf")] });
  const result = await h.run();
  expect(result.files.filter(file => file.included).map(file => file.messageId)).toEqual(["old4", "old5", "old6", "current"]);
  expect(h.resolveAttachment).toHaveBeenCalledTimes(4);
});
it("can select an exact old file beyond the text history window", async () => {
  const history = Array.from({ length: 30 }, (_, index) => message(`old${index}`, "application/pdf"));
  const h = fixture(history, { maximumHistoricalMessages: 2, historicalAttachmentIds: ["att_old0"] });
  const result = await h.run();
  expect(result.files.filter(file => file.included).map(file => file.messageId)).toEqual(["old0"]);
  expect(result.request.messages[0]?.content).toEqual([expect.objectContaining({ type: "document" })]);
  expect(h.resolveAttachment).toHaveBeenCalledTimes(1);
});
it("refuses an unknown selected identity instead of trusting client history", async () => {
  const h = fixture([], { historicalAttachmentIds: ["att_foreign"] });
  await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});
it("reports explicit over-selection before any file resolution", async () => {
  const history = Array.from({ length: 5 }, (_, index) => message(`old${index}`, "application/pdf"));
  const h = fixture(history, { historicalAttachmentIds: history.map(row => row.attachments[0]!.attachment_id) });
  await expect(h.run()).rejects.toMatchObject({ code: "attachment_limit" });
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});
it("honors the provider's per-message document bound", async () => {
  const earlier = message("old", "application/pdf");
  const h = fixture([{ ...earlier, attachments: [...earlier.attachments, ...message("other", "application/pdf").attachments] }],
    { maximumDocumentsPerMessage: 1 });
  expect((await h.run()).files.filter(file => file.included)).toHaveLength(1);
});
it("rejects changed storage identity and observes cancellation after resolution", async () => {
  const h = fixture([message("old", "image/png")]);
  h.resolveAttachment.mockResolvedValue({ attachment_id: "att_other", content_ref: "ref_other", media_type: "image/png", byte_size: 4 });
  await expect(h.run()).rejects.toMatchObject({ code: "attachment_changed" });
  h.resolveAttachment.mockImplementation(async file => {
    h.controller.abort(new Error("cancelled"));
    return { attachment_id: file.attachment_id, content_ref: "ref_old", media_type: "image/png", byte_size: 4 };
  });
  await expect(h.run()).rejects.toThrow("cancelled");
});
it("rejects missing current input and excludes later messages and partial current-turn output", async () => {
  const h = fixture([], { inputMessageIds: ["missing"] });
  await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
  const valid = fixture([], { messages: [{ ...message("partial"), role: "assistant", turn_id: "current-turn" as never },
    message("current"), message("later", "image/png")] });
  const result = await valid.run();
  expect(result.request.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Saved current" }] }]);
  expect(valid.resolveAttachment).not.toHaveBeenCalled();
});

it("stops waiting for a host resolver that ignores cancellation", async () => {
  const h = fixture([message("old", "image/png")]);
  h.resolveAttachment.mockImplementation(() => new Promise(() => {}));
  const pending = h.run();
  const assertion = expect(pending).rejects.toThrow("stop preparing");
  h.controller.abort(new Error("stop preparing"));
  await assertion;
});

it("never silently drops an over-limit current upload", async () => {
  const h = fixture([], { messages: [message("current", "application/pdf")], maximumDocuments: 0 });
  await expect(h.run()).rejects.toMatchObject({ code: "attachment_limit" });
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});

it("does not treat assistant-supplied file metadata as uploaded user evidence", async () => {
  const h = fixture([{ ...message("assistant", "image/png"), role: "assistant" }]);
  expect((await h.run()).files).toEqual([]);
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});
