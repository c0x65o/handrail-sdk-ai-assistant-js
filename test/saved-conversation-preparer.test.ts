import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore, parseConversationEvent, type ConversationId } from "../src/index.js";
import { createSavedConversationRequestPreparer, type SavedConversationPreparerOptions } from "../src/server/saved-conversation-request.js";
import type { ChatRequest } from "../src/protocol.js";

const conversationId = "saved-files" as ConversationId;
const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Client history must not win" }] }],
  tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
async function fixture(options: Partial<SavedConversationPreparerOptions> = {}) {
  const eventStore = new InMemoryConversationEventStore();
  let revision = 0;
  const append = async (payload: Record<string, unknown>) => {
    const event = parseConversationEvent({ version: 1, conversation_id: conversationId,
      event_id: `event-${revision + 1}`, revision: revision + 1, occurred_at: "2026-09-15T12:00:00Z",
      actor: { type: "user" }, source: { type: "runtime" }, payload });
    await eventStore.append({ conversationId, expectedRevision: (revision || null) as never, events: [event] });
    revision++;
  };
  await append({ type: "message.created", message_id: "saved-input", role: "user", content: [{ type: "text", text: "Read this image" }] });
  await append({ type: "message.attachment_referenced", message_id: "saved-input",
    attachment: { attachment_id: "att_image", media_type: "image/png", size_bytes: 4 } });
  await append({ type: "turn.started", turn_id: "saved-turn", input_message_ids: ["saved-input"] });
  const authorize = vi.fn<SavedConversationPreparerOptions["authorize"]>(async () => {});
  const resolveAttachment = vi.fn<SavedConversationPreparerOptions["resolveAttachment"]>(async () => ({
    attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4,
  }));
  const prepare = createSavedConversationRequestPreparer({ eventStore, authorize, resolveAttachment, ...options });
  const controller = new AbortController();
  const run = () => prepare({ request, conversationId, turnId: "saved-turn", mutationId: "mutation", signal: controller.signal });
  return { run, append, authorize, resolveAttachment, controller, eventStore };
}

it("replays admitted user events and resolves a legacy image using the saved message location", async () => {
  const h = await fixture();
  const read = vi.spyOn(h.eventStore, "read");
  const checkpoint = vi.spyOn(h.eventStore.checkpoints, "read");
  const result = await h.run();
  expect(result.request.messages).toEqual([{ role: "user", content: [
    { type: "text", text: "Read this image" },
    { type: "image", attachment: { attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4 } },
  ] }]);
  expect(h.resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({ conversationId,
    messageId: "saved-input", turnId: "saved-turn", attachment: expect.objectContaining({ attachment_id: "att_image" }) }));
  expect(h.authorize).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ limit: 128 }));
  expect(checkpoint).toHaveBeenCalledTimes(1);
});

it("does not read canonical history or source bytes after authorization is denied", async () => {
  const h = await fixture();
  h.authorize.mockRejectedValue(new Error("access revoked"));
  await expect(h.run()).rejects.toThrow("access revoked");
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});

it("rechecks access after a slow source read", async () => {
  const h = await fixture();
  h.authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error("access revoked"));
  await expect(h.run()).rejects.toThrow("access revoked");
  expect(h.resolveAttachment).toHaveBeenCalledTimes(1);
});

it("refuses changed message input while source metadata is loading", async () => {
  const h = await fixture();
  h.resolveAttachment.mockImplementation(async () => {
    await h.append({ type: "message.attachment_referenced", message_id: "saved-input",
      attachment: { attachment_id: "att_extra", media_type: "image/png", size_bytes: 4 } });
    return { attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4 };
  });
  await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
});

it("tolerates unrelated metadata changes during preparation", async () => {
  const h = await fixture();
  const read = vi.spyOn(h.eventStore, "read");
  h.resolveAttachment.mockImplementation(async () => {
    await h.append({ type: "conversation.metadata_updated", metadata: { title: "Renamed" } });
    return { attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4 };
  });
  expect((await h.run()).files[0]?.included).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it("refuses a clear saved while metadata was resolving", async () => {
  const h = await fixture();
  h.resolveAttachment.mockImplementation(async () => {
    await h.append({ type: "conversation.cleared" });
    return { attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4 };
  });
  await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
});

it("does not continue canonical replay after cancellation of an outstanding page", async () => {
  const h = await fixture();
  const original = h.eventStore.read.bind(h.eventStore);
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const read = vi.spyOn(h.eventStore, "read").mockImplementation(async input => {
    entered(); await held; return original({ ...input, limit: 1 });
  });
  const result = expect(h.run()).rejects.toThrow("stop replay");
  await started; h.controller.abort(new Error("stop replay")); await result;
  release(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(read).toHaveBeenCalledTimes(1);
  expect(h.resolveAttachment).not.toHaveBeenCalled();
});

it("refuses a canonical cancellation saved while a file read was running", async () => {
  const h = await fixture();
  h.resolveAttachment.mockImplementation(async () => {
    await h.append({ type: "turn.cancellation_requested", turn_id: "saved-turn", reason: "user" });
    return { attachment_id: "att_image", content_ref: "ref_image", media_type: "image/png", byte_size: 4 };
  });
  await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
});

it.each(["permission", "new-file", "cancellation"] as const)("rechecks %s after asynchronous business context", async change => {
  const h = await fixture({ applicationContext: async input => {
    expect(input).toMatchObject({ conversationId, turnId: "saved-turn", mutationId: "mutation" });
    expect(JSON.stringify(input.request)).toContain("Read this image");
    expect(JSON.stringify(input.request)).not.toContain("Client history must not win");
    if (change === "permission") h.authorize.mockRejectedValue(new Error("access revoked"));
    else if (change === "new-file") await h.append({ type: "message.attachment_referenced", message_id: "saved-input",
      attachment: { attachment_id: "att_extra", media_type: "image/png", size_bytes: 4 } });
    else await h.append({ type: "turn.cancellation_requested", turn_id: "saved-turn", reason: "user" });
    return { label: "fresh facts" };
  } });
  if (change === "permission") await expect(h.run()).rejects.toThrow("access revoked");
  else await expect(h.run()).rejects.toMatchObject({ code: "saved_input_unavailable" });
});
