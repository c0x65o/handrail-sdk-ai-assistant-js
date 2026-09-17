import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDBApplicationConversationPendingStore } from "../src/browser/indexeddb-pending-store.js";
import { ConversationDraftController, InMemoryConversationLocalStateStore, type ConversationDraftRecord } from "../src/client/local-state.js";
const controllers: ConversationDraftController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); });
const make = (store: InMemoryConversationLocalStateStore, id = "chat") => { const controller = new ConversationDraftController(id, store); controllers.push(controller); return controller; };

it("restores drafts, preserves typing ahead of storage, and clears only the admitted edit", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  await storage.writeDraft("chat", "old saved text", null);
  const read = storage.readDraft.bind(storage); let release!: (value: ConversationDraftRecord | null) => void;
  vi.spyOn(storage, "readDraft").mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const controller = make(storage); controller.setText("typed before restore");
  release(await read("chat")); await controller.flush();
  expect(controller.getSnapshot()).toMatchObject({ text: "typed before restore", status: "saved" });
  const sent = controller.getSnapshot().edit;
  controller.setText("newer draft"); controller.accepted(sent); await controller.flush();
  expect((await storage.readDraft("chat"))?.text).toBe("newer draft");
  controller.accepted(controller.getSnapshot().edit); await controller.flush(); expect(await storage.readDraft("chat")).toBeNull();
});

it("coalesces slow writes and flushes edits captured just before account disposal", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage);
  const original = storage.writeDraft.bind(storage); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(storage, "writeDraft").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  controller.setText("first"); const saving = controller.flush();
  await vi.waitFor(() => expect(storage.writeDraft).toHaveBeenCalledOnce());
  controller.setText("last"); const closed = controller.dispose(); release(); await saving; await closed;
  expect((await storage.readDraft("chat"))?.text).toBe("last"); expect(storage.writeDraft).toHaveBeenCalledTimes(2);
  expect(controller.getSnapshot().text).toBe("");
});

it("does not silently overwrite another tab and permits explicit saved-draft reload", async () => {
  const storage = new InMemoryConversationLocalStateStore(), a = make(storage), b = make(storage);
  await a.flush(); await b.flush(); a.setText("tab A"); await a.flush();
  b.setText("tab B"); await expect(b.flush()).rejects.toThrow("another tab");
  expect(b.getSnapshot()).toMatchObject({ text: "tab B", status: "error" }); expect((await storage.readDraft("chat"))?.text).toBe("tab A");
  await b.reload(); expect(b.getSnapshot()).toMatchObject({ text: "tab A", status: "saved" });
  b.setText("edited after reload"); await b.flush(); expect((await storage.readDraft("chat"))?.text).toBe("edited after reload");
});

it("enforces draft byte/count limits without discarding existing user text", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  for (let i = 0; i < 32; i++) await storage.writeDraft(`c${i}`, "kept", null);
  await expect(storage.writeDraft("overflow", "extra", null)).rejects.toThrow("full");
  await expect(storage.writeDraft("large", "😀".repeat(20000), null)).rejects.toThrow("64 KiB");
  expect((await storage.readDraft("c0"))?.text).toBe("kept");
});

it("persists drafts and bounded scroll anchors across reloads with account/API isolation and atomic tab conflicts", async () => {
  const indexedDB = new IDBFactory(), options = { indexedDB, scope: "account:api" };
  const first = new IndexedDBApplicationConversationPendingStore(options);
  const stored = await first.writeDraft("chat", "saved across reload", null);
  for (let i = 0; i < 40; i++) await first.writePosition(`c${i}`, { messageId: `m${i}`, generation: 4, offset: -20, following: false });
  first.close(); const next = new IndexedDBApplicationConversationPendingStore(options);
  const other = new IndexedDBApplicationConversationPendingStore({ indexedDB, scope: "other:api" });
  try {
    expect(await next.readDraft("chat")).toEqual(stored); expect(await other.readDraft("chat")).toBeNull();
    expect(await next.readPosition("c0")).toBeNull(); expect(await next.readPosition("c39")).toMatchObject({ messageId: "m39", offset: -20 });
    expect(await other.readPosition("c39")).toBeNull();
    const edits = await Promise.allSettled([next.writeDraft("chat", "A", stored!.version), next.writeDraft("chat", "B", stored!.version)]);
    expect(edits.filter(edit => edit.status === "fulfilled")).toHaveLength(1);
    await expect(next.writeDraft("chat", "", stored!.version)).rejects.toThrow("another tab");
    expect(await next.readDraft("chat")).not.toBeNull(); await next.eraseAccount();
    expect(await next.readDraft("chat")).toBeNull(); expect(await next.readPosition("c39")).toBeNull();
  } finally { next.close(); other.close(); }
});
