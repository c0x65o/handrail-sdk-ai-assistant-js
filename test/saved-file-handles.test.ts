import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore, parseConversationEvent } from "../src/index.js";
import { createSavedFileHandles, type SavedFileHandlesOptions } from "../src/server/saved-file-handles.js";
import type { AttachmentReference } from "../src/protocol.js";
import documentFixtures from "./fixtures/documents/manifest.json" with { type: "json" };

async function createFixture(count = 4) {
  const events = new InMemoryConversationEventStore();
  let revision = 0;
  const append = async (payload: Record<string, unknown>) => {
    await events.append({ conversationId: "conversation" as never, expectedRevision: (revision || null) as never,
      events: [parseConversationEvent({ version: 1, conversation_id: "conversation", event_id: `event-${++revision}`,
        revision, occurred_at: "2026-09-15T12:00:00Z", actor: { type: "user", id: "alice" }, source: { type: "runtime" }, payload })] });
  };
  for (let index = 0; index < count; index++) {
    const file = documentFixtures[index % documentFixtures.length]!;
    await append({ type: "message.created", message_id: `message-${index}`, role: "user", content: [{ type: "text", text: "Read this" }] });
    // Exercise the saved legacy image shape alongside Flutter's explicit kind.
    const saved: Record<string, unknown> = { ...file.saved };
    if (index === 0) delete saved.kind;
    await append({ type: "message.attachment_referenced", message_id: `message-${index}`, attachment: saved });
  }
  const authorize = vi.fn<SavedFileHandlesOptions["authorize"]>(async () => {});
  const resolveMetadata = vi.fn<SavedFileHandlesOptions["resolveMetadata"]>(async ({ attachment }) => {
    const file = documentFixtures.find(file => file.saved.attachment_id === attachment.attachment_id)!;
    return { reference: file.uploaded as AttachmentReference, sha256: file.sha256 };
  });
  const readBytes = vi.fn<SavedFileHandlesOptions["readBytes"]>(async ({ reference }) => ({ mediaType: reference.media_type,
    bytes: new Uint8Array(readFileSync(new URL(`./fixtures/documents/${reference.filename}`, import.meta.url))) }));
  const options: SavedFileHandlesOptions = { namespace: ["tenant", "account", "assistant"], eventStore: events, authorize, resolveMetadata, readBytes };
  const location = { conversationId: "conversation", signal: new AbortController().signal };
  return { options, files: createSavedFileHandles(options), location, authorize, resolveMetadata, readBytes, events, append };
}

it("lists bounded opaque handles without reading bytes or exposing storage keys, and pages after restart", async () => {
  const f = await createFixture(27);
  const first = await f.files.list({ ...f.location, limit: 10 });
  const reopened = createSavedFileHandles(f.options);
  const second = await reopened.list({ ...f.location, limit: 10, after: first.next! });
  const last = await reopened.list({ ...f.location, limit: 10, after: second.next! });
  expect([first.files.length, second.files.length, last.files.length, last.next]).toEqual([10, 10, 7, null]);
  expect(new Set([...first.files, ...second.files, ...last.files].map(file => file.handle)).size).toBe(27);
  expect((await reopened.list({ ...f.location, limit: 10 })).files).toEqual(first.files);
  expect(f.resolveMetadata).not.toHaveBeenCalled(); expect(f.readBytes).not.toHaveBeenCalled();
  expect(JSON.stringify(first)).not.toContain("content_ref");
  expect(first.files[0]).toMatchObject({ kind: "image", fileName: "invoice.png", handle: expect.stringMatching(/^file_[a-f0-9]{64}$/u) });
  await expect(f.files.list({ ...f.location, limit: 101 })).rejects.toThrow("page size");
});

it.each(documentFixtures)("opens original $filename by a saved handle after recreation", async fixture => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files.find(file => file.fileName === fixture.filename)!.handle;
  const reopened = createSavedFileHandles(f.options);
  const file = await reopened.read({ ...f.location, handle });
  expect(file.bytes).toEqual(new Uint8Array(readFileSync(new URL(`./fixtures/documents/${fixture.filename}`, import.meta.url))));
  expect(file.sha256).toBe(fixture.sha256);
  expect(createHash("sha256").update(file.bytes).digest("hex")).toBe(fixture.sha256);
  expect(file.entry).toMatchObject({ byteSize: fixture.uploaded.byte_size, fileName: fixture.filename });
  expect(f.resolveMetadata).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation", messageId: expect.any(String) }));
});

it("refuses foreign-scope, foreign-conversation and forged handles before reading bytes", async () => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files[0]!.handle;
  for (const namespace of [["other-tenant", "account", "assistant"], ["tenant", "other-account", "assistant"], ["tenant", "account", "other-assistant"]]) {
    await expect(createSavedFileHandles({ ...f.options, namespace }).read({ ...f.location, handle })).rejects.toMatchObject({ code: "attachment_unavailable" });
  }
  await expect(f.files.read({ ...f.location, conversationId: "other", handle })).rejects.toMatchObject({ code: "attachment_unavailable" });
  await expect(f.files.read({ ...f.location, handle: "blob-private" })).rejects.toMatchObject({ code: "attachment_unavailable" });
  await expect(f.files.list({ ...f.location, after: "forged" })).rejects.toMatchObject({ code: "attachment_unavailable" });
  expect(f.resolveMetadata).not.toHaveBeenCalled(); expect(f.readBytes).not.toHaveBeenCalled();
});

it("checks access before listing and after a byte read", async () => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files[0]!.handle;
  const read = vi.spyOn(f.events, "read");
  f.authorize.mockRejectedValue(new Error("denied"));
  await expect(f.files.list(f.location)).rejects.toThrow("denied");
  expect(read).not.toHaveBeenCalled();
  f.authorize.mockResolvedValue(undefined);
  const normalRead = f.options.readBytes;
  const files = createSavedFileHandles({ ...f.options, readBytes: async input => {
    const result = await normalRead(input);
    f.authorize.mockRejectedValue(new Error("revoked during read"));
    return result;
  } });
  await expect(files.read({ ...f.location, handle })).rejects.toThrow("revoked during read");
});

it("refuses saved provenance removed during an asynchronous file read", async () => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files[0]!.handle;
  const files = createSavedFileHandles({ ...f.options, readBytes: async input => {
    const result = await f.options.readBytes(input);
    await f.append({ type: "conversation.cleared" });
    return result;
  } });
  await expect(files.read({ ...f.location, handle })).rejects.toMatchObject({ code: "attachment_unavailable" });
});

it.each(["metadata", "size", "type", "checksum"])("refuses changed %s instead of attaching different bytes", async fault => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files[0]!.handle;
  const files = createSavedFileHandles({ ...f.options, resolveMetadata: async input => {
    const value = await f.options.resolveMetadata(input);
    return fault === "metadata" ? { ...value, reference: { ...value.reference, attachment_id: "att_other" } } : value;
  }, readBytes: async input => {
    const value = await f.options.readBytes(input);
    if (fault === "size") return { ...value, bytes: value.bytes.slice(1) };
    if (fault === "type") return { ...value, mediaType: "application/pdf" };
    if (fault === "checksum") value.bytes[0] = value.bytes[0]! ^ 1;
    return value;
  } });
  await expect(files.read({ ...f.location, handle })).rejects.toMatchObject({ code: "attachment_changed" });
});

it("enforces byte bounds before storage reads and cancellation while a host callback is pending", async () => {
  const f = await createFixture();
  const handle = (await f.files.list(f.location)).files[0]!.handle;
  await expect(createSavedFileHandles({ ...f.options, maximumBytes: 1 }).read({ ...f.location, handle }))
    .rejects.toMatchObject({ code: "attachment_limit" });
  expect(f.readBytes).not.toHaveBeenCalled();
  const started = vi.fn(), controller = new AbortController();
  const files = createSavedFileHandles({ ...f.options, readBytes: () => { started(); return new Promise(() => {}); } });
  const pending = files.read({ ...f.location, handle, signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("cancelled read");
  await vi.waitFor(() => expect(started).toHaveBeenCalled());
  controller.abort(new Error("cancelled read"));
  await rejected;
});
