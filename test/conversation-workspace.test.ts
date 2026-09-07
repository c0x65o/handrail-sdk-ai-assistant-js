import { describe, expect, it, vi } from "vitest";
import {
  ConversationWorkspace,
  createInitialConversationState,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeRegistry,
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
