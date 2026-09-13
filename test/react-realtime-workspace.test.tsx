// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RealtimeWorkspaceMonitor, type RealtimeWorkspaceCall } from "../src/realtime/workspace.js";
import { RealtimeWorkspaceActivity, WorkspaceThreadPicker } from "../src/react-styled/index.js";
import { useRealtimeWorkspaceActivity } from "../src/react-headless/index.js";
import { createInitialConversationState } from "../src/conversation/state.js";
afterEach(cleanup);
const call = (conversationId: string, status: RealtimeWorkspaceCall["status"], unread = false): RealtimeWorkspaceCall => ({
  conversationId, callId: "voice", status, unread, counts: { total: 1, running: status === "active" ? 1 : 0, completed: status === "active" ? 0 : 1, failed: 0 },
});
it("shows background voice activity in the collapsed picker without changing text status or reading voice", async () => {
  let failed = false;
  const voice = new RealtimeWorkspaceMonitor({ readPage: async () => {
    if (failed) throw new Error("private transport error");
    return { calls: [call("one", "active"), call("two", "ended", true)], next: null };
  } });
  const snapshot = { selectedConversationId: "one", runningCount: 0, errorCount: 0, unreadCount: 0,
    threads: ["one", "two"].map((conversationId) => ({ conversationId, runtime: { getSnapshot: () => createInitialConversationState(conversationId as never) },
      turnStatus: "idle", unread: false, revision: 0 })) };
  const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, select: vi.fn(), markRead: vi.fn(), open: vi.fn() };
  try {
    const view = render(<WorkspaceThreadPicker workspace={workspace as never} voiceActivity={voice}/>);
    await waitFor(() => expect(view.container.querySelector("summary")?.textContent).toContain("1 voice call with unread results"));
    expect(view.container.querySelector("details")!.open).toBe(false);
    fireEvent.click(view.container.querySelector("summary")!);
    const button = screen.getByRole("button", { name: /two 1 voice call with unread results/ });
    expect(button.getAttribute("data-turn-status")).toBe("idle");
    fireEvent.click(button);
    expect(workspace.select).toHaveBeenCalledWith("two");
    expect(workspace.markRead).toHaveBeenCalledWith("two");
    expect(voice.getSnapshot().calls.find((item) => item.conversationId === "two")?.unread).toBe(true);
    failed = true;
    await act(() => voice.refresh());
    expect(view.container.querySelector("summary")?.textContent).toContain("last reported active");
    expect(screen.getByRole("status").textContent).toContain("Could not refresh voice activity");
    expect(view.container.textContent).not.toContain("private transport");
  } finally { voice.dispose(); }
});
it("offers headless state and allows hosts to hide or replace the default summary", async () => {
  const monitor = new RealtimeWorkspaceMonitor({ readPage: async () => ({ calls: [call("one", "ended", true)], next: null }) });
  function Custom() {
    const state = useRealtimeWorkspaceActivity(monitor);
    return <output>{state.calls.filter((item) => item.unread).length} custom unread</output>;
  }
  try {
    await monitor.setConversations(["one"]);
    const view = render(<><Custom/><RealtimeWorkspaceActivity monitor={monitor} render={() => null}/></>);
    expect(screen.getByText("1 custom unread")).toBeTruthy();
    expect(view.container.querySelector(".hr-chat__voice-activity")).toBeNull();
    view.rerender(<RealtimeWorkspaceActivity monitor={monitor} conversationId="one" render={({ summary }) => <output>{summary.unreadCalls} saved calls</output>}/>);
    expect(screen.getByText("1 saved calls")).toBeTruthy();
    expect(monitor.getSnapshot().calls[0]?.unread).toBe(true);
  } finally { monitor.dispose(); }
});
