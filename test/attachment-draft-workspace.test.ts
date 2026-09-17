import { expect, it, vi } from "vitest";
import { AttachmentDraftWorkspace } from "../src/attachments/draft-workspace.js";
import { AttachmentDraftCapacityError, InMemoryAttachmentDraftStore } from "../src/attachments/draft-store.js";
import { AttachmentUploadAdapterError, type AttachmentSelection, type AttachmentUploadRequest } from "../src/attachments/types.js";
import type { AttachmentReference } from "../src/protocol.js";

const selection = (id: string, bytes = 3): AttachmentSelection<Blob> => ({ source: new Blob([new Uint8Array(bytes)]),
  kind: "document", mediaType: "application/pdf", byteSize: bytes, filename: `${id}.pdf`, fingerprint: `file:${id}`, idempotencyKey: `intake:${id}` });
const reference = (request: AttachmentUploadRequest<Blob>): AttachmentReference => ({ attachment_id: "att_test", content_ref: "ref_test",
  media_type: request.metadata.mediaType, byte_size: request.metadata.byteSize,
  ...(request.metadata.filename ? { filename: request.metadata.filename } : {}) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it("reconciles exact selected files after owner replacement while preserving newly selected identical content", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), upload = vi.fn(async (request: AttachmentUploadRequest<Blob>) => reference(request));
  const owner = new AttachmentDraftWorkspace(store, { upload }), chat = owner.forConversation("chat"); await chat.flush();
  chat.add([selection("first")]); await vi.waitFor(() => expect(chat.getSnapshot().files[0]?.reference).toBeDefined()); await chat.flush();
  const ids = chat.captureFileIds(chat.getSnapshot().files.map(file => file.uploadId)); await owner.dispose();
  const next = new AttachmentDraftWorkspace(store, { upload });
  try {
    const restored = next.forConversation("chat"); await restored.flush();
    await restored.reconcileAccepted(ids); expect(await store.readAttachmentDraft("chat")).toBeNull();
    restored.add([selection("first")]); await restored.flush();
    await restored.reconcileAccepted(ids); expect(restored.getSnapshot().files).toHaveLength(1);
    expect((await store.readAttachmentDraft("chat"))?.files[0]?.id).not.toBe(ids[0]);
  } finally { await next.dispose(); }
});

it("preserves selections added while accepted cleanup is still writing", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), gate = deferred<void>(), original = store.discardAcceptedFiles.bind(store);
  const owner = new AttachmentDraftWorkspace(store, { upload: async request => reference(request) });
  try {
    const chat = owner.forConversation("chat"); await chat.flush(); chat.add([selection("sent")]);
    await vi.waitFor(() => expect(chat.getSnapshot().files[0]?.reference).toBeDefined()); await chat.flush();
    const ids = chat.captureFileIds(chat.getSnapshot().files.map(file => file.uploadId));
    vi.spyOn(store, "discardAcceptedFiles").mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
    const cleanup = chat.reconcileAccepted(ids); await vi.waitFor(() => expect(store.discardAcceptedFiles).toHaveBeenCalledOnce());
    chat.add([selection("newer")]); gate.resolve(); await cleanup; await chat.flush();
    expect((await store.readAttachmentDraft("chat"))?.files.map(file => file.selection.filename)).toEqual(["newer.pdf"]);
    expect(chat.getSnapshot().files.map(file => file.selection.filename)).toEqual(["newer.pdf"]);
  } finally { gate.resolve(); await owner.dispose(); }
});

it("cleans accepted IDs from a newer tab revision without rebasing conflicting local selections over it", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), owner = new AttachmentDraftWorkspace(store, { upload: async request => reference(request) });
  try {
    const chat = owner.forConversation("chat"); await chat.flush(); chat.add([selection("sent")]);
    await vi.waitFor(() => expect(chat.getSnapshot().files[0]?.reference).toBeDefined()); await chat.flush();
    const saved = (await store.readAttachmentDraft("chat"))!, ids = saved.files.map(file => file.id);
    await store.writeAttachmentDraft("chat", [...saved.files, { id: "remote", selection: { ...selection("remote"), conversationId: "chat" } }], saved.version);
    await chat.reconcileAccepted(ids);
    expect((await store.readAttachmentDraft("chat"))?.files.map(file => file.id)).toEqual(["remote"]);
    expect(chat.getSnapshot()).toMatchObject({ files: [], status: "error" });
    chat.add([selection("local")]); await expect(chat.flush()).rejects.toThrow("another view");
    expect((await store.readAttachmentDraft("chat"))?.files.map(file => file.id)).toEqual(["remote"]);
    await chat.reload(); expect(chat.getSnapshot().files[0]?.id).toBe("remote");
  } finally { await owner.dispose(); }
});

it("persists exact source/key before uploading, restores only the selected chat, and never reuploads ready files", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), read = vi.spyOn(store, "readAttachmentDraft");
  const upload = vi.fn(async (request: AttachmentUploadRequest<Blob>) => {
    const persisted = await store.readAttachmentDraft(request.metadata.conversationId!);
    expect(persisted?.files[0]?.selection.idempotencyKey).toBe(request.idempotencyKey);
    expect(persisted?.files[0]?.selection.source).toBe(request.source);
    return reference(request);
  });
  const first = new AttachmentDraftWorkspace(store, { upload });
  try {
    expect(read).not.toHaveBeenCalled();
    const chat = first.forConversation("chat"); await chat.flush();
    chat.add([selection("first")]);
    await vi.waitFor(() => expect(chat.getSnapshot().files[0]?.reference).toBeDefined()); await chat.flush();
    await first.dispose();
    const second = new AttachmentDraftWorkspace(store, { upload });
    try {
      const restored = second.forConversation("chat"); await restored.flush();
      expect(restored.getSnapshot().files[0]?.reference).toBeDefined();
      expect(restored.uploader.getSnapshot().items[0]?.status).toBe("ready");
      expect(upload).toHaveBeenCalledTimes(1);
      expect(read.mock.calls.every(([id]) => id === "chat")).toBe(true);
    } finally { await second.dispose(); }
  } finally { await first.dispose(); }
});

it("retains failed storage selections and retries admission before invoking an upload", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), upload = vi.fn(async (request: AttachmentUploadRequest<Blob>) => reference(request));
  const workspace = new AttachmentDraftWorkspace(store, { upload });
  try {
    const chat = workspace.forConversation("chat"); await chat.flush();
    vi.spyOn(store, "writeAttachmentDraft").mockRejectedValueOnce(new Error("quota"));
    chat.add([selection("first")]);
    await vi.waitFor(() => expect(chat.getSnapshot().status).toBe("error"));
    expect(chat.getSnapshot().files).toHaveLength(1); expect(upload).not.toHaveBeenCalled();
    await chat.flush(); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await chat.flush(); expect(chat.getSnapshot().status).toBe("saved");
  } finally { await workspace.dispose(); }
});

it("retries a failed upload with the exact persisted bytes/key and restores it after owner replacement", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>();
  const upload = vi.fn(async (request: AttachmentUploadRequest<Blob>) => {
    if (upload.mock.calls.length === 1) throw new AttachmentUploadAdapterError({ retryable: true });
    return reference(request);
  });
  const first = new AttachmentDraftWorkspace(store, { upload });
  const chat = first.forConversation("chat"); await chat.flush(); chat.add([selection("first")]);
  await vi.waitFor(() => expect(chat.uploader.getSnapshot().items[0]?.status).toBe("failed"));
  await first.dispose();
  const second = new AttachmentDraftWorkspace(store, { upload });
  try {
    const restored = second.forConversation("chat"); await restored.flush();
    await vi.waitFor(() => expect(restored.uploader.getSnapshot().items[0]?.status).toBe("ready"));
    expect(upload.mock.calls[1]![0].idempotencyKey).toBe(upload.mock.calls[0]![0].idempotencyKey);
    expect(upload.mock.calls[1]![0].source).toBe(upload.mock.calls[0]![0].source);
  } finally { await second.dispose(); }
});

it("limits real upload futures across chats, including cancelled adapters which ignore abort", async () => {
  const pending: { request: AttachmentUploadRequest<Blob>; done: ReturnType<typeof deferred<AttachmentReference>> }[] = [];
  const workspace = new AttachmentDraftWorkspace(new InMemoryAttachmentDraftStore<Blob>(), { upload: request => {
    const done = deferred<AttachmentReference>(); pending.push({ request, done }); return done.promise;
  } });
  try {
    const chats = ["a", "b", "c"].map(id => workspace.forConversation(id));
    for (const [index, chat] of chats.entries()) { await chat.flush(); chat.add([selection(String(index))]); await chat.flush(); }
    expect(pending).toHaveLength(2);
    chats[0]!.remove(chats[0]!.getSnapshot().files.map(file => file.uploadId));
    await chats[0]!.flush(); expect(pending[0]!.request.signal.aborted).toBe(true); expect(pending).toHaveLength(2);
    pending[0]!.done.resolve(reference(pending[0]!.request));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(chats[0]!.getSnapshot().files).toHaveLength(0);
    for (const operation of pending.slice(1)) operation.done.resolve(reference(operation.request));
    await vi.waitFor(() => expect(chats[2]!.getSnapshot().files[0]?.reference).toBeDefined());
  } finally { for (const operation of pending) operation.done.resolve(reference(operation.request)); await workspace.dispose(); }
});

it("charges cancelled source bytes until the host future settles and admits nothing over the account budget", async () => {
  const pending: { request: AttachmentUploadRequest<Blob>; done: ReturnType<typeof deferred<AttachmentReference>> }[] = [];
  const workspace = new AttachmentDraftWorkspace(new InMemoryAttachmentDraftStore<Blob>(), { upload: request => {
    const done = deferred<AttachmentReference>(); pending.push({ request, done }); return done.promise;
  } });
  try {
    const a = workspace.forConversation("a"), b = workspace.forConversation("b"); await a.flush(); await b.flush();
    a.add([selection("large", 24 * 1024 * 1024)]); await a.flush();
    a.remove(a.getSnapshot().files.map(file => file.uploadId)); await a.flush();
    b.add([selection("other", 24 * 1024 * 1024)]); await b.flush();
    expect(() => b.add([selection("excess", 24 * 1024 * 1024)])).toThrow(AttachmentDraftCapacityError);
    expect(b.getSnapshot().files).toHaveLength(1);
    pending[0]!.done.resolve(reference(pending[0]!.request)); await vi.waitFor(() => expect(a.uploader.getSnapshot().activeCount).toBe(0));
    b.add([selection("fits", 24 * 1024 * 1024)]); await b.flush(); expect(b.getSnapshot().files).toHaveLength(2);
  } finally { for (const operation of pending) operation.done.resolve(reference(operation.request)); await workspace.dispose(); }
});

it("retains a captured write's sources after removal until the storage operation settles", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), gate = deferred<void>(), original = store.writeAttachmentDraft.bind(store);
  const write = vi.spyOn(store, "writeAttachmentDraft").mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
  const workspace = new AttachmentDraftWorkspace(store, { upload: async request => reference(request) });
  try {
    const a = workspace.forConversation("a"), b = workspace.forConversation("b"); await a.flush(); await b.flush();
    a.add([selection("big", 24 * 1024 * 1024)]); await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    a.remove(a.getSnapshot().files.map(file => file.uploadId));
    b.add([selection("next", 24 * 1024 * 1024)]);
    expect(() => b.add([selection("excess", 24 * 1024 * 1024)])).toThrow(AttachmentDraftCapacityError);
    gate.resolve(); await a.flush(); expect(await store.readAttachmentDraft("a")).toBeNull();
    b.add([selection("fits", 24 * 1024 * 1024)]); await b.flush();
  } finally { gate.resolve(); await workspace.dispose(); }
});

it("keeps cross-tab conflicts visible until explicit replacement, and never clears another view's newer selection", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), adapter = { upload: async (request: AttachmentUploadRequest<Blob>) => reference(request) };
  const first = new AttachmentDraftWorkspace(store, adapter), second = new AttachmentDraftWorkspace(store, adapter);
  try {
    const a = first.forConversation("chat"), b = second.forConversation("chat"); await a.flush(); await b.flush();
    a.add([selection("first")]); await vi.waitFor(() => expect(a.getSnapshot().files[0]?.reference).toBeDefined()); await a.flush();
    b.add([selection("second")]); await vi.waitFor(() => expect(b.getSnapshot().status).toBe("error"));
    expect(b.getSnapshot().files[0]?.selection.filename).toBe("second.pdf");
    expect((await store.readAttachmentDraft("chat"))?.files[0]?.selection.filename).toBe("first.pdf");
    await b.reload(); expect(b.getSnapshot().files[0]?.selection.filename).toBe("first.pdf");
    expect(b.getSnapshot().status).toBe("saved");
  } finally { await first.dispose(); await second.dispose(); }
});

it("evicts empty controllers but preserves unsent files when more than 32 chats are opened", async () => {
  const workspace = new AttachmentDraftWorkspace(new InMemoryAttachmentDraftStore<Blob>(), { upload: async request => reference(request) });
  try {
    const protectedChat = workspace.forConversation("protected"); await protectedChat.flush(); protectedChat.add([selection("keep")]); await protectedChat.flush();
    for (let index = 0; index < 80; index++) await workspace.forConversation(`chat-${index}`).flush();
    expect(workspace.forConversation("protected")).toBe(protectedChat);
    expect(protectedChat.getSnapshot().files).toHaveLength(1);
  } finally { await workspace.dispose(); }
});

it("replaces a full queue from another tab, including the same fingerprint with a new upload identity", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), adapter = { upload: async (request: AttachmentUploadRequest<Blob>) => reference(request) };
  const first = new AttachmentDraftWorkspace(store, adapter), second = new AttachmentDraftWorkspace(store, adapter);
  try {
    const a = first.forConversation("chat"), b = second.forConversation("chat"); await a.flush(); await b.flush();
    a.add([selection("same"), selection("a2"), selection("a3"), selection("a4")]);
    await vi.waitFor(() => expect(a.getSnapshot().files.every(file => file.reference)).toBe(true)); await a.flush();
    b.add([selection("same"), selection("b2"), selection("b3"), selection("b4")]);
    await vi.waitFor(() => expect(b.getSnapshot().status).toBe("error"));
    await b.reload();
    expect(b.getSnapshot().status).toBe("saved");
    expect(b.getSnapshot().files.map(file => file.id)).toEqual(a.getSnapshot().files.map(file => file.id));
    expect(b.uploader.getSnapshot().items).toHaveLength(4);
    expect(b.uploader.getSnapshot().items.every(item => item.status === "ready")).toBe(true);
  } finally { await first.dispose(); await second.dispose(); }
});

it("fences deleted owners and aborts uploads without letting late completion resurrect a draft", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>(), done = deferred<AttachmentReference>();
  let request!: AttachmentUploadRequest<Blob>;
  const workspace = new AttachmentDraftWorkspace(store, { upload: input => { request = input; return done.promise; } });
  try {
    const chat = workspace.forConversation("chat"); await chat.flush(); chat.add([selection("first")]); await chat.flush();
    workspace.forgetConversation("chat"); await store.eraseConversation("chat");
    expect(request.signal.aborted).toBe(true); done.resolve(reference(request));
    await chat.flush(); expect(await store.readAttachmentDraft("chat")).toBeNull();
    expect(() => workspace.forConversation("chat")).toThrow("unavailable");
  } finally { done.resolve(reference(request)); await workspace.dispose(); }
});

it("accounts for identical saved file IDs in different conversations independently", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>();
  for (const conversationId of ["a", "b"]) {
    const selected = { ...selection(conversationId, 24 * 1024 * 1024), conversationId };
    await store.writeAttachmentDraft(conversationId, [{ id: "same-local-id", selection: selected,
      reference: { attachment_id: "att_saved", content_ref: "ref_saved", media_type: selected.mediaType,
        byte_size: selected.byteSize, filename: selected.filename! } }], null);
  }
  const upload = vi.fn(async (request: AttachmentUploadRequest<Blob>) => reference(request));
  const workspace = new AttachmentDraftWorkspace(store, { upload });
  try {
    await workspace.forConversation("a").flush(); await workspace.forConversation("b").flush();
    const third = workspace.forConversation("c"); await third.flush();
    expect(() => third.add([selection("excess", 24 * 1024 * 1024)])).toThrow(AttachmentDraftCapacityError);
    expect(third.getSnapshot().files).toHaveLength(0); expect(upload).not.toHaveBeenCalled();
  } finally { await workspace.dispose(); }
});
