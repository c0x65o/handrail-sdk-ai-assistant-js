import { afterEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { IndexedDBApplicationConversationPendingStore } from "../src/browser/indexeddb-pending-store.js";
import { ConversationDraftController, InMemoryConversationLocalStateStore, type ConversationDraftRecord } from "../src/client/local-state.js";
const controllers: ConversationDraftController[] = [];
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); });
const make = (store: InMemoryConversationLocalStateStore, id = "chat") => { const controller = new ConversationDraftController(id, store); controllers.push(controller); return controller; };

it("rejects oversized edits before encoding, without replacing a valid draft or receipt", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage);
  await controller.flush(); controller.setText("kept"); await controller.flush();
  const before = controller.getSnapshot(), saved = await storage.readDraft("chat");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    expect(controller.setText("x".repeat(5 * 1024 * 1024))).toBe(false);
    expect(encode).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ text: "kept", edit: before.edit, status: "saved", inputError: expect.stringContaining("64 KiB") });
    expect(controller.setText("🦊".repeat(16385))).toBe(false);
    expect(controller.getSnapshot().edit).toBe(before.edit);
    expect(await storage.readDraft("chat")).toEqual(saved);
    expect(controller.setText("🦊".repeat(16384))).toBe(true);
    expect(controller.getSnapshot().inputError).toBeNull();
  } finally { encode.mockRestore(); }
});

it("caps retained editors across a shared account and excludes another account", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  const active = Array.from({ length: 32 }, (_, i) => make(storage, `chat-${i}`));
  await Promise.all(active.map(c => c.flush()));
  for (const c of active) expect(c.setText("draft")).toBe(true);
  const extra = make(storage, "extra"); await extra.flush();
  expect(extra.setText("extra")).toBe(false); expect(extra.getSnapshot().text).toBe("");
  expect(extra.getSnapshot().inputError).toContain("account’s text limit");
  const isolated = make(new InMemoryConversationLocalStateStore(), "extra");
  expect(isolated.setText("another account")).toBe(true);
  active[0]!.setText(""); expect(extra.setText("now fits")).toBe(true);
});

it("keeps a removed or disposed editor's slow write charged until its callback settles", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  const active = Array.from({ length: 8 }, (_, i) => make(storage, `chat-${i}`));
  await Promise.all(active.map(c => c.flush()));
  for (const c of active) expect(c.setText("x".repeat(65536))).toBe(true);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const original = storage.writeDraft.bind(storage);
  vi.spyOn(storage, "writeDraft").mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
  const saving = active[0]!.flush(); await started;
  expect(active[0]!.setText("y".repeat(65536))).toBe(false);
  active[0]!.setText(""); const closing = active[0]!.dispose();
  const extra = make(storage, "extra");
  try {
    expect(extra.setText("new")).toBe(false);
  } finally { release(); await saving; await closing; }
  expect(extra.setText("y".repeat(65536))).toBe(true);
});

it("captured sends survive editor acceptance/disposal and release only their own reservation", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  const active = Array.from({ length: 8 }, (_, i) => make(storage, `chat-${i}`));
  await Promise.all(active.map(c => c.flush()));
  for (const c of active) c.setText("x".repeat(65536));
  const first = active[0]!, release = first.retainText(first.getSnapshot().text);
  first.accepted(first.getSnapshot().edit); await first.dispose();
  const extra = make(storage, "extra");
  expect(extra.setText("new")).toBe(false);
  release(); release(); // Idempotent release must not free another owner's bytes.
  expect(extra.setText("y".repeat(65536))).toBe(true);
  expect(active[1]!.getSnapshot().text.length).toBe(65536);
});

it("an over-budget restoration keeps durable content available for later retry", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  const saved = await storage.writeDraft("saved", "saved content", null);
  const active = Array.from({ length: 8 }, (_, i) => make(storage, `chat-${i}`));
  await Promise.all(active.map(c => c.flush()));
  for (const c of active) c.setText("x".repeat(65536));
  const restored = make(storage, "saved"); await expect(restored.flush()).rejects.toThrow();
  expect(restored.getSnapshot()).toMatchObject({ text: "", status: "error", error: expect.stringContaining("account’s text limit") });
  expect(await storage.readDraft("saved")).toEqual(saved);
  active[0]!.setText(""); await restored.flush();
  expect(restored.getSnapshot().text).toBe("saved content");
});

it("explicit reload cannot discard local work when a saved replacement exceeds the remaining budget", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  await storage.writeDraft("chat", "x".repeat(65536), null);
  const controller = make(storage); await controller.flush(); controller.setText("local");
  const active = Array.from({ length: 7 }, (_, i) => make(storage, `chat-${i}`));
  await Promise.all(active.map(c => c.flush()));
  for (const c of active) c.setText("x".repeat(65536));
  const extra = make(storage, "extra"); extra.setText("x".repeat(65531));
  await expect(controller.reload()).rejects.toThrow("account’s text limit");
  expect(controller.getSnapshot().text).toBe("local");
  extra.setText(""); await controller.reload(); expect(controller.getSnapshot().text.length).toBe(65536);
});

it("also bounds metadata from duplicate retained callbacks without double-charging identical text", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage);
  await controller.flush(); controller.setText("x".repeat(65536));
  const releases: (() => void)[] = [];
  try {
    for (let i = 0; i < 127; i++) releases.push(controller.retainText(controller.getSnapshot().text));
    expect(() => controller.retainText(controller.getSnapshot().text)).toThrow("account’s text limit");
    expect(controller.setText("x".repeat(65536))).toBe(true);
  } finally { for (const release of releases) release(); }
});

it("disposal drains typing captured while exact accepted cleanup is still pending", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage);
  await controller.flush(); controller.setText("sent"); await controller.flush();
  const version = (await storage.readDraft("chat"))!.version;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; }), original = storage.discardDraftVersion.bind(storage);
  vi.spyOn(storage, "discardDraftVersion").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const cleanup = controller.reconcileAccepted(version);
  await vi.waitFor(() => expect(storage.discardDraftVersion).toHaveBeenCalledOnce());
  controller.setText("newer while leaving"); const closed = controller.dispose();
  release(); await cleanup; await closed;
  expect((await storage.readDraft("chat"))?.text).toBe("newer while leaving");
  expect(controller.getSnapshot().text).toBe("");
});

it("captures only the exact saved edit and reconciles it idempotently after reload", async () => {
  const storage = new InMemoryConversationLocalStateStore(), first = make(storage);
  await first.flush(); first.setText("sent"); const version = (await first.captureVersion(first.getSnapshot().edit))!;
  expect(version).toBe((await storage.readDraft("chat"))?.version);
  await first.dispose(); const restored = make(storage); await restored.flush();
  await restored.reconcileAccepted(version); expect(await storage.readDraft("chat")).toBeNull(); expect(restored.getSnapshot().text).toBe("");
  restored.setText("sent"); await restored.flush(); await restored.reconcileAccepted(version);
  expect((await storage.readDraft("chat"))?.text).toBe("sent"); expect(restored.getSnapshot().text).toBe("sent");
});

it("preserves same-text newer edits during a captured save and never binds them to the old send", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage); await controller.flush();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), original = storage.writeDraft.bind(storage);
  vi.spyOn(storage, "writeDraft").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  controller.setText("same"); const captured = controller.captureVersion(controller.getSnapshot().edit);
  await vi.waitFor(() => expect(storage.writeDraft).toHaveBeenCalledOnce()); controller.setText("same"); release();
  expect(await captured).toBeUndefined(); expect((await storage.readDraft("chat"))?.text).toBe("same");
});

it("serializes typing during accepted cleanup and rebases its next save without reviving the sent text", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage); await controller.flush();
  controller.setText("sent"); const version = (await controller.captureVersion(controller.getSnapshot().edit))!;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), original = storage.discardDraftVersion.bind(storage);
  vi.spyOn(storage, "discardDraftVersion").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
  const cleanup = controller.reconcileAccepted(version);
  await vi.waitFor(() => expect(storage.discardDraftVersion).toHaveBeenCalledOnce());
  controller.setText("newer while clearing"); const during = controller.flush(); release(); await cleanup; await during; await controller.flush();
  expect((await storage.readDraft("chat"))?.text).toBe("newer while clearing"); expect(controller.getSnapshot().status).toBe("saved");
});

it("never removes another tab's newer revision during confirmed admission", async () => {
  const storage = new InMemoryConversationLocalStateStore(), controller = make(storage); await controller.flush();
  controller.setText("sent"); const version = (await controller.captureVersion(controller.getSnapshot().edit))!;
  await storage.writeDraft("chat", "other tab", version);
  await controller.reconcileAccepted(version);
  expect((await storage.readDraft("chat"))?.text).toBe("other tab");
  expect(controller.getSnapshot()).toMatchObject({ text: "", status: "error" });
  controller.setText("local replacement"); await expect(controller.flush()).rejects.toThrow("another tab");
  expect((await storage.readDraft("chat"))?.text).toBe("other tab");
  await controller.reload(); expect(controller.getSnapshot().text).toBe("other tab");
});

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
