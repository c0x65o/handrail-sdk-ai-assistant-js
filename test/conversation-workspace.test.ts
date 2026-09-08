import { describe, expect, it, vi } from "vitest";
import {
  ConversationWorkspace,
  ConversationRuntimeRegistry,
  InMemoryConversationCatalog,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createInitialConversationState,
  type ConversationId,
  type ConversationRuntime,
  type ConversationState,
} from "../src/index.js";

function fakeRuntime(conversationId: string) {
  let state = createInitialConversationState(conversationId as ConversationId);
  const listeners = new Set<() => void>();
  const runtime = {
    store: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
  } as unknown as ConversationRuntime<unknown>;
  return {
    runtime,
    update(next: ConversationState) { state = next; for (const listener of listeners) listener(); },
  };
}

describe("ConversationWorkspace", () => {
  it("opens saved history through the real registry without forwarding workspace selection options", async () => {
    const authorizationContext = { userId: "owner" };
    const catalog = new InMemoryConversationCatalog<typeof authorizationContext>({ authorize: () => "allow" });
    const created = await catalog.create({ authorizationContext, idempotencyKey: "saved-history" as never });
    const conversationId = created.descriptor.conversationId;
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({ conversationId, expectedRevision: null, events: [{
      version: 1, event_id: "saved-message" as never, conversation_id: conversationId, revision: 1 as never,
      occurred_at: "2026-09-07T00:00:00.000Z" as never, actor: { type: "user" }, source: { type: "import" },
      payload: { type: "message.created", message_id: "question" as never, role: "user",
        content: [{ type: "text", text: "Saved question" }] },
    }] });
    const get = vi.spyOn(catalog, "get");
    const authorize = vi.fn(() => "allow" as const);
    const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) =>
      createConversationRuntime({ conversationId, clientId: "web" as never, eventStore, transport: {} as never }));
    const registry = new ConversationRuntimeRegistry({ catalog, authorize, createRuntime });
    const workspace = new ConversationWorkspace(registry);
    try {
      const runtime = await workspace.open({ authorizationContext, conversationId, select: false });
      expect(workspace.getSnapshot().selectedConversationId).toBeNull();
      expect(workspace.getSnapshot().threads).toHaveLength(1);
      expect(runtime.getSnapshot().messages[0]?.content).toEqual([{ type: "text", text: "Saved question" }]);
      expect(get).toHaveBeenCalledExactlyOnceWith({ authorizationContext, conversationId });
      expect(authorize).toHaveBeenCalledWith({ action: "open", authorizationContext, descriptor: created.descriptor });
      await workspace.open({ authorizationContext, conversationId, select: true });
      expect(workspace.getSnapshot().selectedConversationId).toBe(conversationId);
      expect(createRuntime).toHaveBeenCalledOnce();
      await workspace.close(conversationId);
      // Picker opens also supply select:true to a cold workspace.
      await workspace.pickerRegistry().open({ authorizationContext, conversationId });
      expect(workspace.getSnapshot().selectedConversationId).toBe(conversationId);
      expect(createRuntime).toHaveBeenCalledTimes(2);
    } finally { await workspace.dispose(); }
  });

  it("keeps real catalog authorization in force when prefetching history", async () => {
    const catalog = new InMemoryConversationCatalog<string>({
      authorize: ({ authorizationContext }) => authorizationContext === "owner" ? "allow" : "deny",
    });
    const created = await catalog.create({ authorizationContext: "owner", idempotencyKey: "private-history" as never });
    const createRuntime = vi.fn();
    const registry = new ConversationRuntimeRegistry({ catalog, authorize: () => "allow", createRuntime });
    const workspace = new ConversationWorkspace(registry);
    try {
      await expect(workspace.open({ authorizationContext: "other", conversationId: created.descriptor.conversationId,
        select: false })).rejects.toMatchObject({ name: "ConversationCatalogError", code: "forbidden" });
      expect(createRuntime).not.toHaveBeenCalled();
      expect(workspace.getSnapshot()).toMatchObject({ selectedConversationId: null, threads: [] });
    } finally { await workspace.dispose(); }
  });

  it("keeps only the visible selected conversation polling actively", async () => {
    const first = fakeRuntime("first");
    const second = fakeRuntime("second");
    const firstPolling = vi.fn();
    const secondPolling = vi.fn();
    Object.assign(first.runtime, { setSynchronizationActive: firstPolling });
    Object.assign(second.runtime, { setSynchronizationActive: secondPolling });
    const registry = { open: async ({ conversationId }: { conversationId: string }) =>
      conversationId === "first" ? first.runtime : second.runtime } as unknown as ConversationRuntimeRegistry<unknown>;
    const workspace = new ConversationWorkspace(registry);
    await workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId });
    expect(firstPolling).toHaveBeenLastCalledWith(true);
    await workspace.open({ authorizationContext: undefined, conversationId: "second" as ConversationId, select: false });
    expect(secondPolling).not.toHaveBeenCalled();
    workspace.select("second" as ConversationId);
    expect(firstPolling).toHaveBeenLastCalledWith(false);
    expect(secondPolling).toHaveBeenLastCalledWith(true);
    workspace.setVisible(false);
    expect(secondPolling).toHaveBeenLastCalledWith(false);
    workspace.setVisible(true);
    expect(secondPolling).toHaveBeenLastCalledWith(true);
    workspace.select(null);
    expect(secondPolling).toHaveBeenLastCalledWith(false);
  });

  it("shares one subscription and recovery when a click joins an in-flight prefetch", async () => {
    const first = fakeRuntime("first");
    const subscribe = vi.spyOn(first.runtime.store, "subscribe");
    const restore = vi.fn(async () => null);
    Object.assign(first.runtime, { restoreActiveTurn: restore });
    let finish!: (runtime: ConversationRuntime<unknown>) => void;
    const pending = new Promise<ConversationRuntime<unknown>>((resolve) => { finish = resolve; });
    const registry = { open: () => pending, release: vi.fn(async () => true) } as unknown as ConversationRuntimeRegistry<unknown>;
    const workspace = new ConversationWorkspace(registry, { restoreActiveTurns: true });
    const prefetch = workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId, select: false });
    const click = workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId });
    finish(first.runtime);
    await Promise.all([prefetch, click]);
    expect(subscribe).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(workspace.getSnapshot().selectedConversationId).toBe("first");
    await workspace.close("first" as ConversationId);
    const changed = vi.fn();
    workspace.subscribe(changed);
    first.update(first.runtime.store.getSnapshot());
    expect(changed).not.toHaveBeenCalled();
  });

  it("opens while recovery is pending and observes background completion", async () => {
    const first = fakeRuntime("first");
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: "turn-1" as never,
      turns: [{ turn_id: "turn-1", status: "running" } as never] });
    let finish!: () => void;
    const recovery = new Promise<null>((resolve) => { finish = () => resolve(null); });
    const restore = vi.fn(() => recovery);
    Object.assign(first.runtime, { restoreActiveTurn: restore });
    const registry = { open: vi.fn(async () => first.runtime) } as unknown as ConversationRuntimeRegistry<unknown>;
    const workspace = new ConversationWorkspace(registry, { restoreActiveTurns: true });
    const opened = workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId });
    await expect(opened).resolves.toBe(first.runtime);
    expect(restore).toHaveBeenCalledOnce();
    expect(workspace.getSnapshot().runningCount).toBe(1);
    workspace.select(null);
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: null,
      turns: [{ turn_id: "turn-1", status: "completed" } as never] });
    finish();
    await recovery;
    expect(workspace.getSnapshot()).toMatchObject({ runningCount: 0, unreadCount: 1 });
  });

  it("retains unread failures for a selected but hidden conversation without archiving it", async () => {
    const first = fakeRuntime("first");
    const registry = { open: vi.fn(async () => first.runtime) } as unknown as ConversationRuntimeRegistry<unknown>;
    const workspace = new ConversationWorkspace(registry);
    workspace.setVisible(false);
    await workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId });
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: "turn-1" as never,
      turns: [{ turn_id: "turn-1", status: "running" } as never] });
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: null,
      turns: [{ turn_id: "turn-1", status: "failed" } as never] });
    expect(workspace.getSnapshot()).toMatchObject({ selectedConversationId: "first", runningCount: 0, unreadCount: 1 });
    workspace.select("first" as ConversationId);
    expect(workspace.getSnapshot().unreadCount).toBe(1);
    workspace.setVisible(true);
    expect(workspace.getSnapshot()).toMatchObject({ unreadCount: 0, errorCount: 1 });
    expect(workspace.getSnapshot().threads).toHaveLength(1);
  });

  it("reports recovery rejection after opening", async () => {
    const first = fakeRuntime("first");
    const error = new Error("offline");
    Object.assign(first.runtime, { restoreActiveTurn: vi.fn(async () => { throw error; }) });
    const onRecoveryError = vi.fn();
    const registry = { open: vi.fn(async () => first.runtime) } as unknown as ConversationRuntimeRegistry<unknown>;
    const workspace = new ConversationWorkspace(registry, { restoreActiveTurns: true, onRecoveryError });
    await workspace.open({ authorizationContext: undefined, conversationId: "first" as ConversationId });
    await vi.waitFor(() => expect(onRecoveryError).toHaveBeenCalledWith("first", error));
    expect(workspace.getSnapshot().selectedConversationId).toBe("first");
  });

  it("retains concurrent runtimes and marks background terminal turns unread", async () => {
    const first = fakeRuntime("first");
    const second = fakeRuntime("second");
    const release = vi.fn(async () => true);
    const registry = {
      open: vi.fn(async ({ conversationId }: { conversationId: string }) =>
        conversationId === "first" ? first.runtime : second.runtime),
      release, clear: vi.fn(), archive: vi.fn(), restore: vi.fn(), permanentlyDelete: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as ConversationRuntimeRegistry<unknown, { userId: string }>;
    const workspace = new ConversationWorkspace(registry);
    await workspace.open({ authorizationContext: { userId: "u1" }, conversationId: "first" as ConversationId });
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: "turn-1" as never,
      turns: [{ turn_id: "turn-1", status: "running" } as never] });
    await workspace.open({ authorizationContext: { userId: "u1" }, conversationId: "second" as ConversationId });
    expect(release).not.toHaveBeenCalled();
    expect(workspace.getSnapshot()).toMatchObject({ selectedConversationId: "second", runningCount: 1 });
    first.update({ ...first.runtime.store.getSnapshot(), active_turn_id: null,
      turns: [{ turn_id: "turn-1", status: "completed" } as never] });
    expect(workspace.getSnapshot()).toMatchObject({ runningCount: 0, unreadCount: 1 });
    workspace.select("first" as ConversationId);
    expect(workspace.getSnapshot().unreadCount).toBe(0);
  });
});
