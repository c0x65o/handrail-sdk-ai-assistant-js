// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const bootstrap = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/client/bootstrap.js", () => ({ createHandrailAiClient: bootstrap.create }));
import { RealtimeWorkspaceMonitor } from "../src/realtime/workspace.js";
import { HandrailAssistantLauncher } from "../src/react-styled/index.js";
import { InMemoryApplicationConversationPendingStore, prepareApplicationConversationSubmission } from "../src/client/session-submission.js";
import type { ChatRequest } from "../src/protocol.js";
afterEach(cleanup);
it.each(["activityPollingMilliseconds", "synchronizationPollingMilliseconds", "idleSynchronizationPollingMilliseconds"] as const)(
  "forwards %s and rebinds only when it changes, retaining pending identity", async option => {
    bootstrap.create.mockReset();
    const snapshot = { selectedConversationId: null, threads: [], runningCount: 0, errorCount: 0, unreadCount: 0 };
    const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open: vi.fn(),
      select: vi.fn(), markRead: vi.fn(), setVisible: vi.fn() };
    const dispose = vi.fn();
    bootstrap.create.mockResolvedValue({ workspace, attachmentUpload: null, activity: null, dispose,
      capabilities: { attachments: false, documentInput: false }, presenceControllerFor: () => null,
      catalog: { list: async () => ({ items: [], hasMore: false }),
        capabilities: { archive: { supported: false }, restore: { supported: false } } } });
    const props = { endpoint: "/polling", presentation: "page" as const, autoTitle: false, includeStyles: false };
    const view = render(<HandrailAssistantLauncher {...props} {...{ [option]: 6000 }}/>);
    await view.findByRole("button", { name: "New" });
    const first = bootstrap.create.mock.calls[0]![0];
    expect(first[option]).toBe(6000);
    const pending = prepareApplicationConversationSubmission<ChatRequest>({ conversationId: "chat" as never,
      clientId: first.conversations.clientId, revision: 0, operationId: "pending", now: "2026-10-06T00:00:00.000Z",
      input: { content: "uncertain", request: first.buildRequest({ content: "uncertain", attachments: [] }) } });
    await first.pendingStore.retain(pending);
    view.rerender(<HandrailAssistantLauncher {...props} {...{ [option]: 6000 }} title="Rerender"/>);
    expect(bootstrap.create).toHaveBeenCalledTimes(1);
    view.rerender(<HandrailAssistantLauncher {...props} {...{ [option]: 12000 }}/>);
    await view.findByRole("button", { name: "New" });
    expect(bootstrap.create).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    const second = bootstrap.create.mock.calls[1]![0];
    expect(second[option]).toBe(12000);
    expect(second.pendingStore).toBe(first.pendingStore);
    expect(await second.pendingStore.load("chat")).toEqual(pending);
    expect(second.conversations.clientId).toBe(first.conversations.clientId);
    expect(second.conversations.deviceId).toBe(first.conversations.deviceId);
    expect(view.container.innerHTML.toLowerCase()).not.toContain(option.toLowerCase());
    view.rerender(<HandrailAssistantLauncher {...props}/>);
    await view.findByRole("button", { name: "New" });
    expect(bootstrap.create).toHaveBeenCalledTimes(3);
    expect(bootstrap.create.mock.calls[2]![0]).not.toHaveProperty(option);
    // A new account/endpoint must not inherit the fallback journal or identity.
    view.rerender(<HandrailAssistantLauncher {...props} endpoint="/other-account"/>);
    await view.findByRole("button", { name: "New" });
    expect(bootstrap.create.mock.calls[3]![0].pendingStore).not.toBe(first.pendingStore);
    expect(bootstrap.create.mock.calls[3]![0].conversations.clientId).not.toBe(first.conversations.clientId);
    const pendingStore = new InMemoryApplicationConversationPendingStore<ChatRequest>();
    await pendingStore.retain(pending);
    view.rerender(<HandrailAssistantLauncher {...props} pendingStore={pendingStore}/>);
    await view.findByRole("button", { name: "New" });
    expect(bootstrap.create.mock.calls[4]![0].pendingStore).toBe(pendingStore);
    view.rerender(<HandrailAssistantLauncher {...props} pendingStore={pendingStore} {...{ [option]: 6000 }}/>);
    await view.findByRole("button", { name: "New" });
    expect(bootstrap.create.mock.calls[5]![0].pendingStore).toBe(pendingStore);
    expect(await pendingStore.load("chat")).toEqual(pending);
  });

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

it("keeps the authenticated client and exposes shared retry when catalog loading fails", async () => {
  const snapshot = { selectedConversationId: null, threads: [], runningCount: 0, errorCount: 0, unreadCount: 0 };
  const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open: vi.fn(),
    select: vi.fn(), markRead: vi.fn(), setVisible: vi.fn() };
  const list = vi.fn(async () => { throw new Error("private catalog failure"); });
  const dispose = vi.fn();
  bootstrap.create.mockResolvedValue({ workspace, attachmentUpload: null, activity: null, dispose,
    capabilities: { attachments: false, documentInput: false }, presenceControllerFor: () => null,
    catalog: { list, capabilities: { archive: { supported: false }, restore: { supported: false } } } });
  const view = render(<HandrailAssistantLauncher endpoint="/failed" presentation="page" autoTitle={false} includeStyles={false}/>);
  const retry = await view.findByRole("button", { name: "Retry history" });
  expect(view.getByRole("button", { name: "New" })).toBeTruthy();
  expect(view.container.textContent).not.toContain("private catalog failure");
  expect(dispose).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  view.unmount(); expect(dispose).toHaveBeenCalledOnce();
});

it.each([undefined, true])("keeps New and history navigation usable when a saved conversation cannot open (picker=%s)", async (conversationPicker) => {
  const snapshot = { selectedConversationId: null, threads: [], runningCount: 0, errorCount: 0, unreadCount: 0 };
  const open = vi.fn(async ({ conversationId }: { conversationId: string }) => {
    if (conversationId === "unavailable") throw new Error("private history conflict");
  });
  const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open,
    select: vi.fn(), markRead: vi.fn(), setVisible: vi.fn() };
  const descriptor = { conversationId: "unavailable", lifecycle: "active", title: "Saved conversation", updatedAt: "2026-09-12T00:00:00.000Z" };
  const list = vi.fn(async () => ({ items: [descriptor], hasMore: false, nextCursor: null }));
  const create = vi.fn(async () => ({ descriptor: { conversationId: "new" } }));
  const dispose = vi.fn();
  bootstrap.create.mockResolvedValue({ workspace, catalog: { list, create,
    capabilities: { archive: { supported: false }, restore: { supported: false } } },
    activity: null, attachmentUpload: null, capabilities: { attachments: false, documentInput: false },
    dispose, presenceControllerFor: () => null });
  const view = render(<HandrailAssistantLauncher endpoint="/history-failure" presentation="page"
    conversationPicker={conversationPicker} autoTitle={false} approvals={null} includeStyles={false}/>);
  await view.findByRole("button", { name: "New" });
  expect(create).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("private history conflict");
  expect(view.getByRole("button", { name: "Archived" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Unread conversations (0)" })).toBeTruthy();
  fireEvent.click(await view.findByRole("button", { name: /^Saved conversation/ }));
  await waitFor(() => expect(view.getAllByRole("alert").some(node => node.textContent?.includes("Select another conversation"))).toBe(true));
  fireEvent.click(view.getByRole("button", { name: "New" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "new" })));
  expect(create).toHaveBeenCalledOnce();
  view.unmount();
  expect(dispose).toHaveBeenCalledOnce();
});

it("provides history recovery when the conversation picker is hidden", async () => {
  const snapshot = { selectedConversationId: null, threads: [], runningCount: 0, errorCount: 0, unreadCount: 0 };
  const open = vi.fn(async () => { throw new Error("private history failure"); });
  const workspace = { getSnapshot: () => snapshot, subscribe: () => () => {}, open,
    select: vi.fn(), markRead: vi.fn(), setVisible: vi.fn() };
  const dispose = vi.fn(), create = vi.fn();
  bootstrap.create.mockResolvedValue({ workspace, attachmentUpload: null, activity: null, dispose,
    capabilities: { attachments: false, documentInput: false }, presenceControllerFor: () => null,
    catalog: { create, list: vi.fn(async () => ({ items: [{ conversationId: "one", lifecycle: "active" }], hasMore: false })),
      capabilities: { archive: { supported: false }, restore: { supported: false } } } });
  const view = render(<HandrailAssistantLauncher endpoint="/fixed" presentation="page" autoTitle={false}
    conversationPicker={false} includeStyles={false}/>);
  const retry = await view.findByRole("button", { name: "Retry history" });
  expect(view.queryByRole("button", { name: "Archived" })).toBeNull();
  expect(dispose).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("private history failure");
  const attempts = open.mock.calls.length; fireEvent.click(retry);
  await waitFor(() => expect(open.mock.calls.length).toBeGreaterThan(attempts));
  view.unmount(); expect(dispose).toHaveBeenCalledOnce();
});
