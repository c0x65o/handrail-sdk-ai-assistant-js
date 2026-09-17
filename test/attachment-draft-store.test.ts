import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import { IndexedDBApplicationConversationPendingStore } from "../src/browser/indexeddb-pending-store.js";
import { AttachmentDraftCapacityError, AttachmentDraftConflictError, InMemoryAttachmentDraftStore, type AttachmentDraftFile } from "../src/attachments/draft-store.js";

const file = (id: string, conversationId = "chat", source = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" })): AttachmentDraftFile<Blob> => ({
  id, selection: { source, kind: "document", mediaType: "application/pdf", byteSize: source.size,
    filename: `${id}.pdf`, fingerprint: `fingerprint:${id}`, idempotencyKey: `upload:${id}`, conversationId },
});
const reference = (value: AttachmentDraftFile<Blob>) => ({ attachment_id: `att_${value.id}`, content_ref: `ref_${value.id}`,
  byte_size: value.selection.byteSize, media_type: value.selection.mediaType,
  ...(value.selection.filename === undefined ? {} : { filename: value.selection.filename }) });

it("removes accepted selections atomically from newer drafts without hydrating bytes or crossing scopes", async () => {
  const indexedDB = new IDBFactory(), store = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "a:api" });
  const other = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "b:api" });
  const first = file("sent"), next = file("next"), get = IDBObjectStore.prototype.get;
  try {
    const saved = (await store.writeAttachmentDraft("chat", [first, next], null))!;
    await other.writeAttachmentDraft("chat", [first], null);
    let blobReads = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "attachment_blobs") blobReads++; return get.apply(this, args);
    });
    try {
      const result = await store.discardAcceptedFiles("chat", ["sent"]);
      expect(result.previousVersion).toBe(saved.version); expect(result.version).not.toBe(saved.version);
      expect(blobReads).toBe(0);
      expect(await store.discardAcceptedFiles("chat", ["sent"])).toEqual({ previousVersion: result.version, version: result.version });
    } finally { spy.mockRestore(); }
    expect((await store.readAttachmentDraft("chat"))?.files.map(value => value.id)).toEqual(["next"]);
    expect((await other.readAttachmentDraft("chat"))?.files.map(value => value.id)).toEqual(["sent"]);
    await store.eraseConversation("chat");
    expect(await store.discardAcceptedFiles("chat", ["next"])).toEqual({ previousVersion: null, version: null });
    await expect(store.writeAttachmentDraft("chat", [next], null)).rejects.toThrow("permanently deleted");
  } finally { store.close(); other.close(); }
});

it("rolls back accepted file cleanup when the remaining metadata cannot be saved", async () => {
  const store = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
  const saved = await store.writeAttachmentDraft("chat", [file("sent"), file("kept")], null), put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "attachment_drafts") throw new DOMException("quota", "QuotaExceededError");
    return put.apply(this, args);
  });
  try { await expect(store.discardAcceptedFiles("chat", ["sent"])).rejects.toThrow("quota"); }
  finally { spy.mockRestore(); }
  try {
    const restored = await store.readAttachmentDraft("chat");
    expect(restored?.version).toBe(saved?.version); expect(restored?.files.map(value => value.id)).toEqual(["sent", "kept"]);
    expect([...new Uint8Array(await restored!.files[0]!.selection.source.arrayBuffer())]).toEqual([1, 2, 3]);
  } finally { store.close(); }
});

it("the account-memory fallback preserves identities and rejects stale writes and deleted chats", async () => {
  const store = new InMemoryAttachmentDraftStore<Blob>();
  try {
    const selected = file("first"), initial = (await store.writeAttachmentDraft("chat", [selected], null))!;
    const saved = (await store.writeAttachmentDraft("chat", [{ ...selected, reference: reference(selected) }], initial.version))!;
    expect(saved.files[0]!.selection.source).toBe(selected.selection.source);
    await expect(store.writeAttachmentDraft("chat", [{ ...selected, reference: reference(selected),
      selection: { ...selected.selection, source: new Blob([new Uint8Array([9, 8, 7])]) } }], saved.version)).rejects.toThrow("identity changed");
    await expect(store.writeAttachmentDraft("chat", [], initial.version)).rejects.toBeInstanceOf(AttachmentDraftConflictError);
    await expect(store.writeAttachmentDraft("chat", [selected], saved.version)).rejects.toThrow("identity changed");
    await store.eraseConversation("chat");
    await expect(store.writeAttachmentDraft("chat", [selected], null)).rejects.toThrow("permanently deleted");
    expect(await store.readAttachmentDraft("chat")).toBeNull();
  } finally { store.dispose(); }
});

it("restores exact bytes and upload identity while readiness updates touch metadata only", async () => {
  const options = { indexedDB: new IDBFactory(), scope: "account:api" };
  const first = new IndexedDBApplicationConversationPendingStore(options), selected = file("first");
  let blobAdds = 0, blobReads = 0;
  const add = IDBObjectStore.prototype.add, get = IDBObjectStore.prototype.get;
  const additions = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "attachment_blobs") blobAdds++;
    return add.apply(this, args);
  });
  const reads = vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "attachment_blobs") blobReads++;
    return get.apply(this, args);
  });
  try {
    const original = await first.writeAttachmentDraft("chat", [selected], null);
    await first.writeAttachmentDraft("other", [file("other", "other")], null);
    expect(blobAdds).toBe(2); expect(blobReads).toBe(0);
    const ready = { ...selected, reference: reference(selected) };
    await first.writeAttachmentDraft("chat", [ready], original!.version);
    expect(blobAdds).toBe(2); expect(blobReads).toBe(0);
    first.close();
    const reopened = new IndexedDBApplicationConversationPendingStore(options);
    try {
      const restored = await reopened.readAttachmentDraft("chat");
      expect(blobReads).toBe(1); // The other chat's Blob was not hydrated.
      expect(restored?.files[0]?.reference).toEqual(ready.reference);
      expect(restored?.files[0]?.selection.idempotencyKey).toBe(selected.selection.idempotencyKey);
      expect([...new Uint8Array(await restored!.files[0]!.selection.source.arrayBuffer())]).toEqual([1, 2, 3]);
      await reopened.writeAttachmentDraft("chat", [], restored!.version);
      expect(await reopened.readAttachmentDraft("chat")).toBeNull();
    } finally { reopened.close(); }
  } finally { additions.mockRestore(); reads.mockRestore(); first.close(); }
});

it("arbitrates concurrent tabs and retains newer selections when an older view clears", async () => {
  const options = { indexedDB: new IDBFactory(), scope: "account:api" };
  const a = new IndexedDBApplicationConversationPendingStore(options), b = new IndexedDBApplicationConversationPendingStore(options);
  try {
    const results = await Promise.allSettled([a.writeAttachmentDraft("chat", [file("a")], null), b.writeAttachmentDraft("chat", [file("b")], null)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const old = (await a.readAttachmentDraft("chat"))!;
    const newer = await b.writeAttachmentDraft("chat", [...old.files, file("next")], old.version);
    await expect(a.writeAttachmentDraft("chat", [], old.version)).rejects.toBeInstanceOf(AttachmentDraftConflictError);
    expect((await a.readAttachmentDraft("chat"))?.version).toBe(newer!.version);
    expect((await a.readAttachmentDraft("chat"))?.files.map(file => file.id)).toEqual([old.files[0]!.id, "next"]);
  } finally { a.close(); b.close(); }
});

it("bounds account file bytes without evicting other drafts or reading their Blobs", async () => {
  const store = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
  // Blob slices retain immutable backing data; no base64/JSON copies are needed.
  const data = new Blob([new Uint8Array(24 * 1024 * 1024)], { type: "application/pdf" });
  try {
    await store.writeAttachmentDraft("one", [file("a", "one", data)], null);
    await store.writeAttachmentDraft("two", [file("b", "two", data)], null);
    await store.writeAttachmentDraft("three", [file("c", "three", data.slice(0, 16 * 1024 * 1024))], null);
    await expect(store.writeAttachmentDraft("overflow", [file("d", "overflow")], null)).rejects.toBeInstanceOf(AttachmentDraftCapacityError);
    expect(await store.readAttachmentDraft("overflow")).toBeNull();
    const first = (await store.readAttachmentDraft("one"))!;
    expect(first.files[0]!.selection.byteSize).toBe(24 * 1024 * 1024);
    await store.writeAttachmentDraft("one", [], first.version);
    await expect(store.writeAttachmentDraft("overflow", [file("d", "overflow")], null)).resolves.not.toBeNull();
  } finally { store.close(); }
});

it("bounds draft and selection counts, validates scope and immutable identities", async () => {
  const store = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
  try {
    for (let i = 0; i < 32; i++) await store.writeAttachmentDraft(`chat${i}`, [file(`a${i}`, `chat${i}`), file(`b${i}`, `chat${i}`)], null);
    await expect(store.writeAttachmentDraft("overflow", [file("extra", "overflow")], null)).rejects.toBeInstanceOf(AttachmentDraftCapacityError);
    const old = (await store.readAttachmentDraft("chat0"))!;
    await expect(store.writeAttachmentDraft("chat0", [...old.files, file("extra", "chat0")], old.version)).rejects.toBeInstanceOf(AttachmentDraftCapacityError);
    await expect(store.writeAttachmentDraft("chat0", [file("wrong", "another")], old.version)).rejects.toThrow("another conversation");
    await expect(store.writeAttachmentDraft("chat0", [old.files[0]!, old.files[0]!], old.version)).rejects.toThrow("Duplicate");
    await expect(store.writeAttachmentDraft("chat0", [{ ...old.files[0]!, selection: { ...old.files[0]!.selection, filename: "changed.txt" } }], old.version)).rejects.toThrow("identity changed");
    expect((await store.readAttachmentDraft("chat0"))?.files).toHaveLength(2);
  } finally { store.close(); }
});

it("rolls back removals when a replacement Blob write fails", async () => {
  const store = new IndexedDBApplicationConversationPendingStore({ indexedDB: new IDBFactory(), scope: "account:api" });
  const old = (await store.writeAttachmentDraft("chat", [file("old")], null))!;
  const add = IDBObjectStore.prototype.add;
  const writes = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, ...args) {
    if (this.name === "attachment_blobs") throw new DOMException("Storage full", "QuotaExceededError");
    return add.apply(this, args);
  });
  try {
    await expect(store.writeAttachmentDraft("chat", [file("replacement")], old.version)).rejects.toThrow("Storage full");
    const restored = (await store.readAttachmentDraft("chat"))!;
    expect(restored.version).toBe(old.version); expect(restored.files.map(file => file.id)).toEqual(["old"]);
    expect(await restored.files[0]!.selection.source.arrayBuffer()).toEqual(await old.files[0]!.selection.source.arrayBuffer());
  } finally { writes.mockRestore(); store.close(); }
});

it("deletes file metadata and bytes with the conversation and isolates account/API scopes", async () => {
  const indexedDB = new IDBFactory(), stores = ["account:api", "other:api", "account:other-api"].map(scope =>
    new IndexedDBApplicationConversationPendingStore({ indexedDB, scope }));
  const [a, b, c] = stores;
  try {
    for (const store of stores) await store.writeAttachmentDraft("chat", [file("same")], null);
    await a!.writeAttachmentDraft("keep", [file("keep", "keep")], null);
    await a!.eraseConversation("chat");
    expect(await a!.readAttachmentDraft("chat")).toBeNull();
    await expect(a!.writeAttachmentDraft("chat", [file("late")], null)).rejects.toThrow("permanently deleted");
    expect((await b!.readAttachmentDraft("chat"))?.files).toHaveLength(1);
    expect((await c!.readAttachmentDraft("chat"))?.files).toHaveLength(1);
    await a!.eraseAccount();
    expect(await a!.readAttachmentDraft("keep")).toBeNull();
    expect((await b!.readAttachmentDraft("chat"))?.files).toHaveLength(1);
  } finally { for (const store of stores) store.close(); }
});
