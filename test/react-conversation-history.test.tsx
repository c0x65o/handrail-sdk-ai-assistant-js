/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationWorkspace, ConversationRuntimeRegistry, InMemoryConversationCatalog,
  InMemoryConversationEventStore, createConversationRuntime, type ConversationCatalogDescriptor, type ConversationId } from "../src/index.js";
import { useConversationHistory } from "../src/react/conversation-history.js";
import { InMemoryConversationActivityStore } from "../src/conversation/activity.js";
import { HandrailChatWorkspace } from "../src/react-styled/index.js";
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

it("loads all catalog pages, limits background previews, and filters active/archived/unread history", async () => {
  const f = await fixture(5);
  await f.catalog.archive({ authorizationContext: f.authorizationContext, conversationId: f.descriptors[0]!.conversationId,
    expectedVersion: f.descriptors[0]!.version, idempotencyKey: "archive" as never });
  f.activity.upsert({ conversationId: f.descriptors[1]!.conversationId, turnStatus: "completed", unread: true });
  const list = vi.spyOn(f.catalog, "list");
  const { result } = renderHook(() => useConversationHistory({ ...f, pageSize: 2, preloadCount: 2, autoSelect: false }));
  await waitFor(() => expect(result.current.descriptors).toHaveLength(5));
  await waitFor(() => expect(f.workspace.getSnapshot().threads).toHaveLength(2));
  expect(list).toHaveBeenCalledTimes(3);
  expect(f.workspace.getSnapshot().selectedConversationId).toBeNull();
  expect(result.current.visible).toHaveLength(4);
  act(() => { result.current.setUnreadOnly(true); });
  expect(result.current.visible.map((row) => row.conversationId)).toEqual([f.descriptors[1]!.conversationId]);
  act(() => { result.current.setView("archived"); });
  expect(result.current.visible.map((row) => row.conversationId)).toEqual([f.descriptors[0]!.conversationId]);
  const opened = result.current.descriptors.find((row) => f.workspace.getSnapshot().threads.some((thread) => thread.conversationId === row.conversationId))!;
  expect(result.current.preview(opened)).toMatch(/^Saved preview/u);
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
