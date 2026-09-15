import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore, parseConversationEvent } from "../src/index.js";
import { createAiApplication } from "../src/server/application.js";
import { createSavedFileHandles } from "../src/server/saved-file-handles.js";
import { createSavedFileTools, openedSavedFileSelection, SAVED_FILE_LIST_TOOL, SAVED_FILE_OPEN_TOOL,
  type SavedFileToolOptions } from "../src/server/saved-file-tools.js";
import { SavedConversationFileUnavailableError } from "../src/server/saved-conversation-request.js";
import type { AttachmentReference, JsonObject } from "../src/protocol.js";
import manifest from "./fixtures/documents/manifest.json" with { type: "json" };

const context = { actor: "alice" };
async function fixture(limits: Partial<Omit<SavedFileToolOptions<typeof context>, "filesFor">> = {}) {
  let allowed = true, expired = false;
  const events = new InMemoryConversationEventStore();
  await events.append({ conversationId: "conversation" as never, expectedRevision: null, events: manifest.flatMap((file, index) => [
    { type: "message.created", message_id: `m${index}`, role: "user", content: [{ type: "text", text: "Read this file" }] },
    { type: "message.attachment_referenced", message_id: `m${index}`, attachment: file.saved },
  ]).map((payload, index) => parseConversationEvent({ version: 1, conversation_id: "conversation", event_id: `event-${index}`,
    revision: index + 1, occurred_at: "2026-09-15T12:00:00Z", actor: { type: "user", id: "alice" }, source: { type: "runtime" }, payload })) });
  const readBytes = vi.fn(async ({ reference }: { reference: Readonly<AttachmentReference> }) => ({ mediaType: reference.media_type,
    bytes: new Uint8Array(readFileSync(new URL(`./fixtures/documents/${reference.filename}`, import.meta.url))) }));
  const files = createSavedFileHandles({ namespace: ["tenant", "alice", "assistant"], eventStore: events,
    authorize: () => { if (!allowed) throw new Error("private credential detail"); },
    resolveMetadata: async ({ attachment }) => {
      if (expired) throw new SavedConversationFileUnavailableError("expired");
      const file = manifest.find(file => file.saved.attachment_id === attachment.attachment_id)!;
      return { reference: file.uploaded as AttachmentReference, sha256: file.sha256 };
    }, readBytes });
  const tools = createSavedFileTools<typeof context>({ filesFor: () => files, supportedDocumentMediaTypes: ["application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], maximumDocuments: 2, ...limits });
  const application = await createAiApplication({ installContext: context, plugins: [tools.plugin], toolAdmission: tools.admission,
    policy: () => ({ outcome: "allow" }) });
  let call = 0;
  const execute = async (name: string, arguments_: JsonObject, id = `call-${++call}`) => {
    const value = await application.executeTool({ discovery: { context }, applicationContext: context,
      call: { tool_call_id: id, name, arguments: arguments_ }, location: { conversationId: "conversation", turnId: "turn" },
      executionKey: id, signal: new AbortController().signal });
    if (value.status !== "completed") throw new Error(`Unexpected ${value.status}`);
    return value.result;
  };
  const handles = (await files.list({ conversationId: "conversation", signal: new AbortController().signal })).files.map(file => file.handle);
  return { execute, readBytes, handles, revoke: () => { allowed = false; }, expire: () => { expired = true; } };
}

it("lists canonical files without bytes, and opens verified originals through the normal tool runtime", async () => {
  const f = await fixture();
  const listed = await f.execute(SAVED_FILE_LIST_TOOL, { after: null, limit: 2 });
  expect(listed.is_error).toBe(false);
  expect(listed.content).toMatchObject([{ type: "json", value: { status: "listed", files: [{ fileName: "invoice.png" }, { fileName: "invoice.pdf" }], next: f.handles[1] } }]);
  expect(f.readBytes).not.toHaveBeenCalled();
  const opened = await f.execute(SAVED_FILE_OPEN_TOOL, { handles: [f.handles[0]!, f.handles[3]!] });
  expect(opened.is_error).toBe(false);
  const selection = openedSavedFileSelection([opened]);
  expect(selection).toMatchObject([{ fileName: "invoice.png", sha256: manifest[0]!.sha256 }, { fileName: "invoice.docx", sha256: manifest[3]!.sha256 }]);
  const json = JSON.stringify(opened);
  expect(json).not.toContain("content_ref"); expect(json).not.toContain("base64");
  expect(json).not.toContain("ref_att_");
});

it("reopens selection from a durable native continuation and uses the latest successful explicit selection", async () => {
  const f = await fixture();
  const first = await f.execute(SAVED_FILE_OPEN_TOOL, { handles: [f.handles[0]!] }, "first");
  const continuation = [{ type: "function_call", call_id: "first", name: SAVED_FILE_OPEN_TOOL },
    { type: "function_call_output", call_id: "first", output: JSON.stringify(first.content) }];
  expect(openedSavedFileSelection([], continuation)).toHaveLength(1);
  const next = await f.execute(SAVED_FILE_OPEN_TOOL, { handles: [f.handles[2]!] });
  expect(openedSavedFileSelection([next], continuation)).toMatchObject([{ fileName: "invoice-scan.pdf" }]);
  expect(openedSavedFileSelection([{ ...first, name: "unrelated_tool" }])).toEqual([]);
  expect(openedSavedFileSelection([{ ...first, is_error: true }])).toEqual([]);
  expect(openedSavedFileSelection([], [{ ...continuation[1]! }])).toEqual([]);
});

it("freshly checks access before replaying a completed open receipt", async () => {
  const f = await fixture();
  const arguments_ = { handles: [f.handles[0]!] };
  const first = await f.execute(SAVED_FILE_OPEN_TOOL, arguments_, "same");
  expect(await f.execute(SAVED_FILE_OPEN_TOOL, arguments_, "same")).toEqual(first);
  f.revoke();
  const denied = await f.execute(SAVED_FILE_OPEN_TOOL, arguments_, "same");
  expect(denied.is_error).toBe(true);
  expect(JSON.stringify(denied)).not.toContain("private credential detail");
  expect(openedSavedFileSelection([denied])).toEqual([]);
});

it("returns an accurate expired-file error before dispatch or receipt replay", async () => {
  const f = await fixture(); f.expire();
  const result = await f.execute(SAVED_FILE_OPEN_TOOL, { handles: [f.handles[0]!] });
  expect(result.is_error).toBe(true);
  expect(result.content).toMatchObject([{ type: "text", text: expect.stringContaining("Upload the file again") },
    { type: "json", value: { type: "handrail.tool_failure.v1", code: "attachment_unavailable", category: "not_found" } }]);
  expect(f.readBytes).not.toHaveBeenCalled();
});

it.each([{ maximumDocuments: 1, indices: [1, 2] }, { maximumTotalBytes: 1, indices: [0] },
  { supportedDocumentMediaTypes: ["application/pdf"], indices: [3] }])("rejects unsupported or oversized explicit selections: %j", async ({ indices, ...limits }) => {
  const f = await fixture(limits);
  const result = await f.execute(SAVED_FILE_OPEN_TOOL, { handles: indices.map(index => f.handles[index]!) });
  expect(result.is_error).toBe(true);
  expect(openedSavedFileSelection([result])).toEqual([]);
});
