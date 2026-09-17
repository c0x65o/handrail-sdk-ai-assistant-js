import { expect, it, vi } from "vitest";
import { ConversationDraftWorkspace } from "../src/client/draft-workspace.js";
import { InMemoryConversationLocalStateStore } from "../src/client/local-state.js";

it("preserves a failed text save independently of many evicted transcript leases", async () => {
  const storage = new InMemoryConversationLocalStateStore(), owner = new ConversationDraftWorkspace(storage);
  const write = storage.writeDraft.bind(storage); let fail = true;
  vi.spyOn(storage, "writeDraft").mockImplementation((...args) => fail ? Promise.reject(new Error("device full")) : write(...args));
  try {
    const first = owner.acquire("first"); await first.flush(); first.setText("recoverable draft");
    await owner.release(first); expect(first.getSnapshot().status).toBe("error");
    for (let index = 0; index < 30; index++) { const draft = owner.acquire(`other-${index}`); await owner.release(draft); }
    const reopened = owner.acquire("first"); expect(reopened).toBe(first);
    expect(reopened.getSnapshot().text).toBe("recoverable draft");
    fail = false; await reopened.flush(); await owner.release(reopened);
    expect((await storage.readDraft("first"))?.text).toBe("recoverable draft");
    for (let index = 30; index < 45; index++) { const draft = owner.acquire(`other-${index}`); await owner.release(draft); }
    const fresh = owner.acquire("first"); expect(fresh).not.toBe(first); await fresh.flush();
    expect(fresh.getSnapshot().text).toBe("recoverable draft"); await owner.release(fresh);
  } finally { await owner.dispose(); }
});

it("reopening during a slow lease release reuses the same revision owner", async () => {
  const storage = new InMemoryConversationLocalStateStore(), owner = new ConversationDraftWorkspace(storage);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const write = storage.writeDraft.bind(storage);
  vi.spyOn(storage, "writeDraft").mockImplementationOnce(async (...args) => { entered(); await gate; return write(...args); });
  try {
    const first = owner.acquire("first"); await first.flush(); first.setText("old edit");
    const closing = owner.release(first); await started;
    const reopened = owner.acquire("first"); expect(reopened).toBe(first); reopened.setText("newer edit");
    const closedAgain = owner.release(reopened); release(); await closing; await closedAgain;
    expect((await storage.readDraft("first"))?.text).toBe("newer edit");
    expect(reopened.getSnapshot().error).toBeNull();
  } finally { release?.(); await owner.dispose(); }
});

it("bounds empty uncertain-owner metadata and recovers capacity without erasing work", async () => {
  const storage = new InMemoryConversationLocalStateStore(), owner = new ConversationDraftWorkspace(storage);
  const write = storage.writeDraft.bind(storage); let fail = true;
  vi.spyOn(storage, "writeDraft").mockImplementation((...args) => fail ? Promise.reject(new Error("uncertain")) : write(...args));
  try {
    for (let index = 0; index < 64; index++) {
      const draft = owner.acquire(`draft-${index}`); await draft.flush(); draft.setText(""); await owner.release(draft);
    }
    expect(() => owner.acquire("overflow")).toThrow("account’s text limit");
    fail = false;
    const retained = owner.acquire("draft-0"); expect(retained.hasUnpersistedEdit).toBe(true);
    await retained.flush(); await owner.release(retained);
    // Repair more than the eight-entry clean idle cache before another open.
    for (let index = 1; index < 10; index++) { const draft = owner.acquire(`draft-${index}`); await draft.flush(); await owner.release(draft); }
    const extra = owner.acquire("now-fits"); await owner.release(extra);
  } finally { await owner.dispose(); }
});

it("confirmed deletion forgets an editor and fenced storage rejects its late writes", async () => {
  const storage = new InMemoryConversationLocalStateStore(), owner = new ConversationDraftWorkspace(storage);
  try {
    const first = owner.acquire("deleted"); await first.flush(); first.setText("removed draft");
    owner.forgetConversation("deleted"); await storage.eraseConversation("deleted");
    await first.dispose(); expect(first.setText("late")).toBe(false);
    expect(await storage.readDraft("deleted")).toBeNull();
    const other = owner.acquire("other"); await other.flush(); other.setText("kept"); await owner.release(other);
    expect((await storage.readDraft("other"))?.text).toBe("kept");
  } finally { await owner.dispose(); }
});
