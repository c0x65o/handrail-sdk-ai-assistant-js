// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createInitialConversationState, InMemoryConversationActivityStore, type ConversationWorkspaceSnapshot } from "../src/index.js";
import { useConversationReadState } from "../src/react/workspace.js";

describe("visible conversation read acknowledgements", () => {
  it("waits for the visible transcript, reads failures, and acknowledges later replies while open", async () => {
    const activity = new InMemoryConversationActivityStore();
    activity.upsert({ conversationId: "chat", turnId: "first", turnStatus: "error", unread: true });
    let localStatus = "running";
    let localTurn = "first";
    const runtime = { getSnapshot: () => ({ ...createInitialConversationState("chat" as never),
      turns: [{ turn_id: localTurn, status: localStatus }] }) };
    const snapshot = { selectedConversationId: "chat", threads: [{ conversationId: "chat", runtime,
      turnStatus: "running", unread: false, revision: 1 }], runningCount: 1, unreadCount: 0, errorCount: 0 } as unknown as ConversationWorkspaceSnapshot;
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => undefined, setVisible: vi.fn(), markRead: vi.fn() };
    const acknowledge = vi.fn(async (id: string) => activity.markRead(id));
    const view = renderHook(({ visible }) => useConversationReadState(workspace, activity, visible, acknowledge), { initialProps: { visible: false } });
    expect(acknowledge).not.toHaveBeenCalled();
    view.rerender({ visible: true });
    expect(acknowledge).not.toHaveBeenCalled();
    localStatus = "failed";
    view.rerender({ visible: true });
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
    expect(activity.getSnapshot()[0]?.unread).toBe(false);
    act(() => activity.upsert({ conversationId: "chat", turnId: "second", turnRevision: 3, turnStatus: "completed", unread: true }));
    expect(acknowledge).toHaveBeenCalledTimes(1);
    localTurn = "second";
    localStatus = "completed";
    view.rerender({ visible: true });
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
    view.unmount();
    expect(workspace.setVisible).toHaveBeenLastCalledWith(false);
  });

  it("leaves a reply unread in a hidden browser tab until the tab is visible", async () => {
    const activity = new InMemoryConversationActivityStore();
    activity.upsert({ conversationId: "chat", turnId: "turn", turnStatus: "error", unread: true });
    const snapshot = { selectedConversationId: "chat", threads: [{ conversationId: "chat", unread: false, turnStatus: "error",
      runtime: { getSnapshot: () => ({ turns: [{ turn_id: "turn", status: "failed" }] }) } }] } as unknown as ConversationWorkspaceSnapshot;
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => undefined, setVisible: vi.fn() };
    const acknowledge = vi.fn(async (id: string) => activity.markRead(id));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const view = renderHook(() => useConversationReadState(workspace, activity, true, acknowledge));
    try {
      expect(acknowledge).not.toHaveBeenCalled();
      expect(workspace.setVisible).toHaveBeenLastCalledWith(false);
      visibility.mockReturnValue("visible");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(acknowledge).toHaveBeenCalledOnce());
    } finally { view.unmount(); visibility.mockRestore(); }
  });
});
