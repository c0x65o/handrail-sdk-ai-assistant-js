/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationWorkspace, ConversationRuntimeRegistry, InMemoryConversationCatalog,
  InMemoryConversationEventStore, createConversationRuntime, type ConversationCatalogDescriptor, type ConversationId } from "../src/index.js";
import { useConversationHistory } from "../src/react/conversation-history.js";
import { InMemoryConversationActivityStore } from "../src/conversation/activity.js";
import { HandrailAssistantWorkspace, HandrailChatWorkspace } from "../src/react-styled/index.js";
import { createAttachmentUploader } from "../src/attachments/uploader.js";

const disposables: Array<() => Promise<void>> = [];
afterEach(async () => { cleanup(); for (const dispose of disposables.splice(0)) await dispose(); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(count = 3) {
  let id = 0;
  const authorizationContext = { account: crypto.randomUUID() };
  const catalog = new InMemoryConversationCatalog<typeof authorizationContext>({ authorize: ({ authorizationContext: context }) =>
    context.account === authorizationContext.account ? "allow" : "deny", createConversationId: () => `thread-${++id}` as ConversationId });
  const eventStore = new InMemoryConversationEventStore();
  const descriptors: ConversationCatalogDescriptor[] = [];
  for (let index = 0; index < count; index++) {
    const descriptor = (await catalog.create({ authorizationContext, title: `Thread ${index + 1}`, idempotencyKey: `seed-${index}` as never })).descriptor;
    descriptors.push(descriptor);
    await eventStore.append({ conversationId: descriptor.conversationId, expectedRevision: null, events: [{
      version: 1, event_id: `message-${index}` as never, conversation_id: descriptor.conversationId, revision: 1 as never,
      occurred_at: "2026-09-12T00:00:00.000Z" as never, actor: { type: "user" }, source: { type: "import" },
      payload: { type: "message.created", message_id: `question-${index}` as never, role: "user", content: [{ type: "text", text: `Saved preview ${index + 1}` }] },
    }] });
  }
  const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) => createConversationRuntime({
    conversationId, clientId: "client" as never, eventStore, transport: {} as never,
  }));
  const workspace = new ConversationWorkspace(new ConversationRuntimeRegistry({ catalog, authorize: () => "allow", createRuntime }));
  disposables.push(() => workspace.dispose());
  const activity = new InMemoryConversationActivityStore();
  return { catalog, workspace, authorizationContext, descriptors, createRuntime, activity };
}

it("loads one catalog page at a time, limits opt-in previews, and requests archived history separately", async () => {
  const f = await fixture(5);
  await f.catalog.archive({ authorizationContext: f.authorizationContext, conversationId: f.descriptors[0]!.conversationId,
    expectedVersion: f.descriptors[0]!.version, idempotencyKey: "archive" as never });
  f.activity.upsert({ conversationId: f.descriptors[1]!.conversationId, turnStatus: "completed", unread: true });
  const list = vi.spyOn(f.catalog, "list");
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2, preloadCount: 2, autoSelect: false }));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(2));
  await waitFor(() => expect(f.workspace.getSnapshot().threads).toHaveLength(2));
  expect(list).toHaveBeenCalledTimes(1);
  expect(result.current.hasMore).toBe(true);
  await act(async () => { await result.current.loadMore(); });
  expect(result.current.descriptors).toHaveLength(4);
  expect(result.current.hasMore).toBe(false);
  expect(list).toHaveBeenCalledTimes(2);
  expect(f.workspace.getSnapshot().selectedConversationId).toBeNull();
  expect(result.current.visible).toHaveLength(4);
  act(() => { result.current.setUnreadOnly(true); });
  expect(result.current.visible.map((row) => row.conversationId)).toEqual([f.descriptors[1]!.conversationId]);
  act(() => { result.current.setView("archived"); });
  await waitFor(() => expect(result.current.visible.map((row) => row.conversationId)).toEqual([f.descriptors[0]!.conversationId]));
  expect(list).toHaveBeenCalledTimes(3);
  expect(list.mock.calls[2]![0].lifecycle).toBe("archived");
  const opened = f.descriptors.find((row) => f.workspace.getSnapshot().threads.some((thread) => thread.conversationId === row.conversationId))!;
  expect(result.current.preview(opened)).toMatch(/^Saved preview/u);
});

it("shows the complete assistant's saved threads by default and keeps compact history opt-in", async () => {
  const f = await fixture(1);
  const client = { workspace: f.workspace, catalog: f.catalog, activity: f.activity,
    capabilities: { attachments: false }, resources: {}, presenceControllerFor: () => null,
    markActivityRead: async () => undefined };
  const props = { client: client as never, authorizationContext: f.authorizationContext,
    autoTitle: false, approvals: false as const };
  const view = render(<HandrailAssistantWorkspace {...props}/>);
  await waitFor(() => expect(view.getByRole("button", { name: /^Thread 1/u })).toBeTruthy());
  expect(view.getByRole("complementary", { name: "Conversation history" })).toBeTruthy();
  expect(view.queryByText("Threads")).toBeNull();
  view.rerender(<HandrailAssistantWorkspace {...props} historyLayout="compact"/>);
  expect(view.queryByRole("complementary", { name: "Conversation history" })).toBeNull();
  expect(view.getByText("Threads").closest("details")?.open).toBe(false);
});

it("does not fetch unseen catalog pages or hydrate unselected transcripts by default", async () => {
  const f = await fixture(8);
  const list = vi.spyOn(f.catalog, "list");
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2 }));
  await waitFor(() => expect(result.current.snapshot.selectedConversationId).not.toBeNull());
  expect(result.current.descriptors).toHaveLength(2);
  expect(result.current.hasMore).toBe(true);
  expect(list).toHaveBeenCalledTimes(1);
  expect(f.createRuntime).toHaveBeenCalledTimes(1);
  await act(async () => { await result.current.loadMore(); });
  expect(result.current.descriptors).toHaveLength(4);
  expect(list).toHaveBeenCalledTimes(2);
  expect(f.createRuntime).toHaveBeenCalledTimes(1);
});

it("keeps loaded rows on a failed next page and coalesces double clicks when retrying", async () => {
  const f = await fixture(5);
  const original = f.catalog.list.bind(f.catalog);
  const list = vi.spyOn(f.catalog, "list");
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2, autoSelect: false }));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(2));
  const firstPage = result.current.descriptors;
  list.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await result.current.loadMore(); });
  expect(result.current.descriptors).toEqual(firstPage);
  expect(result.current.loadMoreFailed).toBe(true);
  const gate = deferred<void>();
  list.mockImplementationOnce(async input => { await gate.promise; return original(input); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadMore(); void result.current.loadMore(); });
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => { gate.resolve(); await pending; });
  expect(result.current.loadMoreFailed).toBe(false);
  expect(result.current.descriptors).toHaveLength(4);
});

it("discards a delayed active page after switching to the archived view", async () => {
  const f = await fixture(5);
  await f.catalog.archive({ authorizationContext: f.authorizationContext, conversationId: f.descriptors[0]!.conversationId,
    expectedVersion: f.descriptors[0]!.version, idempotencyKey: "archive" as never });
  const original = f.catalog.list.bind(f.catalog), gate = deferred<void>();
  const list = vi.spyOn(f.catalog, "list");
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2, autoSelect: false }));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(2));
  list.mockImplementationOnce(async input => { const page = await original(input); await gate.promise; return page; });
  let pending!: Promise<void>;
  act(() => { pending = result.current.loadMore(); });
  act(() => result.current.setView("archived"));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(1));
  await act(async () => { gate.resolve(); await pending; });
  expect(result.current.visible.map(row => row.conversationId)).toEqual([f.descriptors[0]!.conversationId]);
  expect(result.current.hasMore).toBe(false);
  expect(result.current.loadingMore).toBe(false);
});

it("retains authoritative selected-chat metadata when refreshing a list with older pages open", async () => {
  const f = await fixture(5);
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2, autoSelect: false }));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(2));
  await act(async () => { await result.current.loadMore(); });
  const older = result.current.descriptors[3]!;
  await act(async () => { await result.current.select(older); });
  const get = vi.spyOn(f.catalog, "get");
  await act(async () => { await result.current.refresh(); });
  expect(result.current.descriptors).toHaveLength(2);
  expect(result.current.selected).toEqual(older);
  expect(get).toHaveBeenCalledWith({ authorizationContext: f.authorizationContext, conversationId: older.conversationId });
  expect(f.createRuntime).toHaveBeenCalledTimes(1);
});

it.each([false, true])("single-conversation presentation confirms Clear and recovers a version conflict: %s", async (versionConflict) => {
  const f = await fixture(1);
  const originalClear = f.catalog.clear.bind(f.catalog);
  const clear = vi.spyOn(f.catalog, "clear");
  if (versionConflict) clear.mockImplementationOnce(async input => {
    await originalClear({ ...input, idempotencyKey: "other-device-clear" as never });
    throw Object.assign(new Error("Another device cleared the conversation"), { code: "version_conflict" });
  });
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("unused"); } });
  const view = render(<HandrailChatWorkspace workspace={f.workspace} threads={false} showConversationTitle={false}
    title="Family Assistant" catalogOptions={{ catalog: f.catalog, authorizationContext: f.authorizationContext }}
    composerForConversation={() => ({ uploader, conversationId: f.descriptors[0]!.conversationId, createRequest: () => ({}) })}
    approvals={false} transcription={false} attachmentsEnabled={false}/>);
  await waitFor(() => expect(view.getByText("Saved preview 1")).toBeTruthy());
  expect(view.queryByRole("complementary", { name: "Conversation history" })).toBeNull();
  expect(view.queryByText("Thread 1")).toBeNull();
  expect(view.queryByRole("button", { name: "New" })).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Clear conversation" }));
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Clear conversation" }));
  fireEvent.click(view.getByRole("button", { name: /^Clear$/ }));
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  expect(clear.mock.calls[0]![0].conversationId).toBe(f.descriptors[0]!.conversationId);
  if (versionConflict) {
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: /^Clear$/ }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(2));
    expect(clear.mock.calls[1]![0].expectedVersion).toBe(2);
    expect(clear.mock.calls[1]![0].idempotencyKey).not.toBe(clear.mock.calls[0]![0].idempotencyKey);
  }
});

it("an account switch discards Clear confirmation even when catalog IDs coincide", async () => {
  const first = await fixture(1), second = await fixture(1);
  const clearFirst = vi.spyOn(first.catalog, "clear"), clearSecond = vi.spyOn(second.catalog, "clear");
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("unused"); } });
  const component = (f: typeof first) => <HandrailChatWorkspace threads={false} workspace={f.workspace}
    catalogOptions={{ catalog: f.catalog, authorizationContext: f.authorizationContext }}
    composerForConversation={() => ({ uploader, conversationId: f.descriptors[0]!.conversationId, createRequest: () => ({}) })}
    attachmentsEnabled={false} approvals={false} transcription={false}/>;
  const view = render(component(first));
  await waitFor(() => expect(view.getByText("Saved preview 1")).toBeTruthy());
  fireEvent.click(view.getByRole("button", { name: "Clear conversation" }));
  expect(view.getByRole("group", { name: "Clear conversation confirmation" })).toBeTruthy();
  view.rerender(component(second));
  await waitFor(() => expect(view.getByRole("button", { name: "Clear conversation" })).toBeTruthy());
  expect(view.queryByRole("group", { name: "Clear conversation confirmation" })).toBeNull();
  expect(clearFirst).not.toHaveBeenCalled(); expect(clearSecond).not.toHaveBeenCalled();
});

it("preserves the latest selection when an older history request finishes later", async () => {
  const f = await fixture();
  const gate = deferred<void>();
  const original = f.createRuntime.getMockImplementation()!;
  f.createRuntime.mockImplementation(async (input) => {
    if (input.conversationId === f.descriptors[0]!.conversationId) await gate.promise;
    return original(input);
  });
  const { result } = renderHook(() => useConversationHistory({ ...f, preloadCount: 0, autoSelect: false }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let first!: Promise<void>;
  act(() => { first = result.current.select(f.descriptors[0]!); });
  await act(async () => { await result.current.select(f.descriptors[1]!); });
  expect(f.workspace.getSnapshot().selectedConversationId).toBe(f.descriptors[1]!.conversationId);
  await act(async () => { gate.resolve(); await first; });
  expect(f.workspace.getSnapshot().selectedConversationId).toBe(f.descriptors[1]!.conversationId);
  expect(f.workspace.getSnapshot().threads).toHaveLength(2);
});

it("reuses a New identity after a saved conversation fails to hydrate and prevents duplicate New clicks", async () => {
  const f = await fixture(0);
  const create = vi.spyOn(f.catalog, "create");
  const gate = deferred<void>();
  f.createRuntime.mockImplementationOnce(async () => { await gate.promise; throw new Error("history unavailable"); });
  const { result } = renderHook(() => useConversationHistory({ ...f, autoSelect: false, preloadCount: 0, recover: false }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  let first!: Promise<void>;
  act(() => { first = result.current.create(); void result.current.create(); });
  await waitFor(() => expect(f.createRuntime).toHaveBeenCalledOnce());
  await act(async () => { gate.resolve(); await first; });
  expect(create).toHaveBeenCalledOnce();
  expect(result.current.error).toMatch(/New to retry/u);
  await act(async () => { await result.current.create(); });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]![0].idempotencyKey).toBe(create.mock.calls[1]![0].idempotencyKey);
  expect(result.current.descriptors).toHaveLength(1);
  expect(f.workspace.getSnapshot().selectedConversationId).toBe("thread-1");
});

it("preserves the selected runtime after rejected archive and releases it only after success", async () => {
  const f = await fixture(1);
  const { result } = renderHook(() => useConversationHistory({ ...f, preloadCount: 0, recover: false }));
  await waitFor(() => expect(result.current.snapshot.selectedConversationId).toBe(f.descriptors[0]!.conversationId));
  const runtime = f.workspace.getSnapshot().threads[0]!.runtime;
  const archive = vi.spyOn(f.catalog, "archive").mockRejectedValueOnce(new Error("temporarily unavailable"));
  await act(async () => { await result.current.changeLifecycle(f.descriptors[0]!); });
  expect(() => runtime.store.subscribe(() => undefined)()).not.toThrow();
  expect(f.workspace.getSnapshot().threads[0]!.runtime).toBe(runtime);
  await act(async () => { await result.current.changeLifecycle(f.descriptors[0]!); });
  expect(() => runtime.store.subscribe(() => undefined)).toThrow("destroyed");
  expect(archive.mock.calls[0]![0].idempotencyKey).toBe(archive.mock.calls[1]![0].idempotencyKey);
  expect(result.current.descriptors).toHaveLength(0);
  act(() => result.current.setView("archived"));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(1));
  expect(result.current.descriptors[0]!.lifecycle).toBe("archived");
  await act(async () => { await result.current.changeLifecycle(result.current.descriptors[0]!); });
  expect(result.current.descriptors[0]!.lifecycle).toBe("active");
  expect(result.current.snapshot.selectedConversationId).toBe(f.descriptors[0]!.conversationId);
});

it("keeps failed saved history visible and automatically recovers reads without creating a replacement", async () => {
  const f = await fixture(1);
  const create = vi.spyOn(f.catalog, "create");
  f.createRuntime.mockRejectedValueOnce(new Error("history unavailable"));
  const { result } = renderHook(() => useConversationHistory({ ...f, preloadCount: 0 }));
  await waitFor(() => expect(result.current.failedThreads.size).toBe(1));
  expect(result.current.descriptors).toHaveLength(1);
  expect(result.current.snapshot.selectedConversationId).toBeNull();
  await waitFor(() => expect(result.current.snapshot.selectedConversationId).toBe(f.descriptors[0]!.conversationId), { timeout: 2500 });
  expect(result.current.failedThreads.size).toBe(0);
  expect(create).not.toHaveBeenCalled();
});

it("removes old account history immediately and ignores its pending load", async () => {
  const first = await fixture(), second = await fixture(1);
  const initial = await first.catalog.list({ authorizationContext: first.authorizationContext, lifecycle: "all", pageSize: 50,
    order: { field: "updated_at", direction: "desc" } });
  const pending = deferred<typeof initial>();
  vi.spyOn(first.catalog, "list").mockImplementationOnce(() => pending.promise);
  const { result, rerender } = renderHook((f) => useConversationHistory({ ...f, autoSelect: false, preloadCount: 0 }), { initialProps: first });
  rerender(second);
  expect(result.current.descriptors).toHaveLength(0);
  await waitFor(() => expect(result.current.descriptors).toHaveLength(1));
  await act(async () => { pending.resolve(initial); });
  expect(result.current.descriptors).toHaveLength(1);
  expect(first.createRuntime).not.toHaveBeenCalled();
});

it("manually retries cached history without changing selection or retaining a recovered error", async () => {
  const f = await fixture(1);
  const original = f.createRuntime.getMockImplementation()!;
  const synchronize = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("temporary read failure"));
  f.createRuntime.mockImplementation(async (input) => ({ ...await original(input), synchronize }));
  const { result } = renderHook(() => useConversationHistory({ ...f, preloadCount: 0, recover: false }));
  await waitFor(() => expect(result.current.snapshot.selectedConversationId).toBe(f.descriptors[0]!.conversationId));
  await act(async () => { await result.current.select(f.descriptors[0]!); });
  expect(result.current.failedThreads.size).toBe(1);
  expect(result.current.error).not.toBeNull();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.failedThreads.size).toBe(0);
  expect(result.current.error).toBeNull();
  expect(synchronize).toHaveBeenCalledTimes(2);
  expect(result.current.snapshot.selectedConversationId).toBe(f.descriptors[0]!.conversationId);
});

it("uses the actual shared workspace for readable archived history and restores the composer", async () => {
  const f = await fixture(1);
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("unused"); } });
  disposables.push(async () => { uploader.dispose(); });
  const confirmed = vi.fn();
  const view = render(<HandrailChatWorkspace workspace={f.workspace} historyLayout="sidebar"
    catalogOptions={{ catalog: f.catalog, authorizationContext: f.authorizationContext }}
    historyOptions={{ preloadCount: 0, recover: false }} includeStyles={false} transcription={false} attachmentsEnabled={false}
    approvals={<button onClick={confirmed}>Confirm request</button>}
    composerForConversation={(_runtime, conversationId) => ({ uploader, conversationId, createRequest: ({ text }) => text })}/>);
  const draft = await view.findByRole("textbox");
  fireEvent.change(draft, { target: { value: "Keep my next draft" } });
  vi.spyOn(f.catalog, "archive").mockRejectedValueOnce(new Error("rejected archive"));
  fireEvent.click(view.getByRole("button", { name: "Archive Thread 1" }));
  await view.findByRole("alert");
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Keep my next draft");
  fireEvent.click(view.getByRole("button", { name: "Archive Thread 1" }));
  await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());
  fireEvent.click(view.getByRole("button", { name: "Archived" }));
  fireEvent.click(await view.findByRole("button", { name: /^Thread 1/ }));
  await view.findByText("Archived conversations are read-only. Restore this conversation to continue.");
  expect(view.getByRole("button", { name: "Confirm request" }).matches(":disabled")).toBe(true);
  expect(view.queryByRole("textbox")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Restore Thread 1" }));
  await view.findByRole("textbox");
  expect(view.getByRole("button", { name: "Confirm request" }).matches(":disabled")).toBe(false);
  expect(confirmed).not.toHaveBeenCalled();
});

it("boots an empty catalog once and keeps the creation identity after a lost response", async () => {
  const f = await fixture(0);
  const original = f.catalog.create.bind(f.catalog);
  const create = vi.spyOn(f.catalog, "create");
  let lost = true;
  create.mockImplementation(async input => {
    const value = await original(input);
    if (lost) { lost = false; throw new Error("lost creation acknowledgement"); }
    return value;
  });
  const { result } = renderHook(() => useConversationHistory({ ...f, autoCreate: true, preloadCount: 0, recover: false }));
  await waitFor(() => expect(result.current.error).toMatch(/New to retry/u));
  expect(create).toHaveBeenCalledOnce();
  await act(async () => { await result.current.create(); });
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]?.[0].idempotencyKey).toBe(create.mock.calls[1]?.[0].idempotencyKey);
  expect(result.current.descriptors).toHaveLength(1);
  expect(result.current.snapshot.selectedConversationId).toBe("thread-1");
});

it("does not create replacement history after list or hydration failure", async () => {
  const f = await fixture(1);
  const create = vi.spyOn(f.catalog, "create");
  vi.spyOn(f.catalog, "list").mockRejectedValueOnce(new Error("list unavailable"));
  f.createRuntime.mockRejectedValue(new Error("history unavailable"));
  const { result } = renderHook(() => useConversationHistory({ ...f, autoCreate: true, preloadCount: 0, recover: false }));
  await waitFor(() => expect(result.current.loadFailed).toBe(true));
  expect(create).not.toHaveBeenCalled();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.loadFailed).toBe(false);
  expect(result.current.failedThreads.size).toBe(1);
  expect(create).not.toHaveBeenCalled();
});
