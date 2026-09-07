// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const bootstrap = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/client/bootstrap.js", () => ({ createHandrailAiClient: bootstrap.create }));
import { RealtimeWorkspaceMonitor } from "../src/realtime/workspace.js";
import { HandrailAssistantLauncher } from "../src/react-styled/index.js";
afterEach(cleanup);
it("discovers voice in unopened conversations while the launcher is closed and disposes its observer", async () => {
  const observerDispose = vi.spyOn(RealtimeWorkspaceMonitor.prototype, "dispose");
  const onWorkingChange = vi.fn();
  const snapshot = { selectedConversationId: null, threads: [], runningCount: 0, errorCount: 0, unreadCount: 0 };
  const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open: vi.fn(async () => {}), select: vi.fn(), markRead: vi.fn(), setVisible: vi.fn() };
  const list = vi.fn(async (input: { pageSize: number; cursor?: string }) => input.pageSize === 1
    ? { items: [{ conversationId: "one" }], hasMore: false, nextCursor: null }
    : input.cursor ? { items: [{ conversationId: "two" }], hasMore: false, nextCursor: null }
      : { items: [{ conversationId: "one" }], hasMore: true, nextCursor: "page-two" });
  const dispose = vi.fn();
  bootstrap.create.mockResolvedValue({ workspace, catalog: { list }, activity: null, attachmentUpload: null,
    capabilities: { attachments: false, documentInput: false }, dispose, presenceControllerFor: () => null });
  let signal: AbortSignal | undefined;
  const readPage = vi.fn(async (input: { conversationIds: readonly string[]; signal: AbortSignal }) => {
    signal = input.signal;
    expect(input.conversationIds).toEqual(["one", "two"]);
    return { calls: [{ conversationId: "one", callId: "running", status: "active", unread: false,
      counts: { total: 1, running: 1, completed: 0, failed: 0 } }, { conversationId: "two", callId: "voice", status: "ended", unread: true,
      counts: { total: 1, running: 0, completed: 1, failed: 0 } }], next: null };
  });
  const view = render(<HandrailAssistantLauncher endpoint="/assistant" autoTitle={false} approvals={null}
    voiceActivity={{ readPage }} onWorkingChange={onWorkingChange} includeStyles={false}/>);
  await waitFor(() => expect(view.container.querySelector(".hr-chat__launcher-trigger")?.textContent).toContain("1 voice call with unread results"));
  expect(view.container.querySelector(".hr-chat__workspace-picker")).toBeNull();
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ cursor: "page-two", lifecycle: "active" }));
  expect(workspace.markRead).not.toHaveBeenCalled();
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(signal).toBeDefined();
  expect(onWorkingChange).toHaveBeenLastCalledWith(true);
  bootstrap.create.mockReturnValue(new Promise(() => {}));
  view.rerender(<HandrailAssistantLauncher endpoint="/another-account" autoTitle={false} approvals={null}
    voiceActivity={{ readPage }} onWorkingChange={onWorkingChange} includeStyles={false} loading={<span>Loading replacement</span>}/>);
  expect(view.container.textContent).toBe("Loading replacement");
  expect(onWorkingChange).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
  expect(observerDispose).toHaveBeenCalledOnce();
  observerDispose.mockRestore();
});

it("disposes a late bootstrap client before reading its catalog", async () => {
  let resolve!: (value: unknown) => void;
  bootstrap.create.mockReturnValue(new Promise((done) => { resolve = done; }));
  const dispose = vi.fn(), list = vi.fn();
  const view = render(<HandrailAssistantLauncher endpoint="/late" includeStyles={false}/>);
  view.unmount();
  await act(async () => { resolve({ dispose, catalog: { list } }); });
  expect(dispose).toHaveBeenCalledOnce();
  expect(list).not.toHaveBeenCalled();
});

it("disposes client resources when catalog bootstrap fails", async () => {
  const dispose = vi.fn();
  bootstrap.create.mockResolvedValue({ workspace: {}, attachmentUpload: null, dispose,
    catalog: { list: vi.fn(async () => { throw new Error("private catalog failure"); }) } });
  const view = render(<HandrailAssistantLauncher endpoint="/failed" includeStyles={false}/>);
  await waitFor(() => expect(view.container.textContent).toBe("Assistant unavailable."));
  expect(dispose).toHaveBeenCalledOnce();
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});
