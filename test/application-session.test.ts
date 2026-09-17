import { afterEach, expect, it, vi } from "vitest";
import { ApplicationConversationSession, type ApplicationConversationReader } from "../src/client/application-session.js";
import { parseApplicationConversationSubmission, type ApplicationConversationPendingStore,
  type ApplicationConversationSubmission } from "../src/client/session-submission.js";
import type { ConversationDisplayControl, ConversationDisplayTurnControl } from "../src/conversation/display-control.js";
import type { ConversationDisplayPage, ConversationDisplayRecord } from "../src/conversation/display-history.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { AppendMutationsInput, AppendMutationsResult } from "../src/sync/types.js";
import { InMemoryConversationLocalStateStore, type ConversationLocalStateStore } from "../src/client/local-state.js";

const sessions: ApplicationConversationSession<{ text: string }>[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers(); });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(count = 0, localStateStore?: ConversationLocalStateStore) {
  const records: ConversationDisplayRecord[] = Array.from({ length: count }, (_, index) => ({
    kind: "message", id: `message-${index + 1}`, revision: index + 1, turnId: null, bytes: 200, deferred: false,
    value: { message_id: `message-${index + 1}` as never, role: "user", content: [{ type: "text", text: `Text ${index + 1}` }],
      attachments: [], attribution: null, created_at: null },
  }));
  let revision = count, turn: ConversationDisplayTurnControl | null = null, saved: ApplicationConversationSubmission<{ text: string }> | null = null;
  const calls: string[] = [];
  const control = (requested?: string): ConversationDisplayControl => ({ schemaVersion: 1, conversationId: "chat", generation: 0,
    revision, canonicalRevision: revision, status: "ready", activeTurnId: turn?.remoteMayStillBeRunning ? turn.turnId : null,
    activeTurn: turn?.remoteMayStillBeRunning ? turn : null, latestTurn: turn,
    requestedTurn: requested === turn?.turnId ? turn : null });
  const page = (rows: readonly ConversationDisplayRecord[], more = false): ConversationDisplayPage => ({ ...control(), records: rows, nextCursor: more ? "next" : null });
  const reader: ApplicationConversationReader = {
    control: vi.fn(async input => control(input.turnId)),
    page: vi.fn(async input => {
      if (input.view?.type === "context") return page([]);
      const anchor = input.anchor, count = input.limit ?? 30;
      const edge = anchor ? records.findIndex(row => row.id === anchor.messageId) : records.length;
      const start = anchor?.direction === "newer" ? edge + (anchor.inclusive ? 0 : 1) : Math.max(0, edge - count);
      const end = anchor?.direction === "newer" ? start + count : edge;
      return page(records.slice(start, end), anchor?.direction === "newer" ? end < records.length : start > 0);
    }),
    changes: vi.fn(async input => ({ ...page(records.filter(row => row.revision > input.afterRevision)), throughRevision: revision })),
  };
  const pendingStore: ApplicationConversationPendingStore<{ text: string }> = {
    load: vi.fn(async () => saved),
    retain: vi.fn(async value => { calls.push("retain");
      if (saved && JSON.stringify(saved) !== JSON.stringify(value)) throw new Error("Different pending submission"); saved = value; }),
    acknowledge: vi.fn(async value => { calls.push("acknowledge"); if (JSON.stringify(saved) === JSON.stringify(value)) saved = null; }),
  };
  const resources = { appendMutations: vi.fn(async (input: AppendMutationsInput): Promise<AppendMutationsResult> => {
    calls.push("append"); revision = Math.max(revision, (input.expectedRevision ?? 0) + input.mutations.length);
    const payload = input.mutations.at(-1)!.events[0]!.payload;
    if (payload.type !== "turn.started") throw new Error("Expected admission");
    turn ??= { turnId: payload.turn_id, revision, status: "running", remoteMayStillBeRunning: true, error: null };
    return { status: "mutations", latestRevision: revision as never,
      acknowledgements: input.mutations.map(mutation => ({ status: "accepted", mutationId: mutation.mutationId, events: mutation.events as never })) };
  }) };
  const cancellation = vi.fn(async () => ({ ok: true, value: { status: "cancellation_requested" } } as const));
  const disconnect = vi.fn();
  const transport: ConversationTransport<unknown, { text: string }> = {
    capabilities: { authoritativeCancellation: { supported: true, capability: { cancelTurn: cancellation } },
      documentInput: { supported: false }, attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
    startTurn: vi.fn<ConversationTransport<unknown, { text: string }>["startTurn"]>(async input => {
      calls.push("start"); turn = { turnId: input.conversationTurnId, revision, status: "completed", remoteMayStillBeRunning: false, error: null };
      return { ok: true, value: { conversationId: input.conversationId, turnId: input.conversationTurnId, mutationId: input.mutationId,
        observation: { events: { async *[Symbol.asyncIterator]() {} }, disconnect,
          result: Promise.resolve({ status: "disconnected", checkpoint: { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null } }) } } };
    }),
    resumeTurn: vi.fn(),
  };
  let sequence = 0;
  const session = new ApplicationConversationSession({ conversationId: "chat" as never, clientId: "client" as never,
    reader, resources, transport, pendingStore, pollMilliseconds: 100, idlePollMilliseconds: 1000,
    ...(localStateStore ? { localStateStore } : {}),
    createId: () => `op${++sequence}`, now: () => "2026-09-16T12:00:00.000Z" });
  sessions.push(session);
  return { session, reader, resources, transport, pendingStore, calls, records, cancellation, disconnect, control, page,
    saved: () => saved, setTurn: (value: ConversationDisplayTurnControl) => { turn = value; revision = Math.max(revision, value.revision); },
    addMessage: () => { revision++; records.push({ ...records.at(-1)!, id: `message-${records.length + 1}`, revision }); } };
}

it("opens only the newest message page, bounds history while scrolling, and evicts inactive bodies", async () => {
  const f = fixture(200); await f.session.initialize();
  expect(f.session.getSnapshot().window.records.map(row => row.id)).toEqual(Array.from({ length: 30 }, (_, i) => `message-${171 + i}`));
  expect(f.reader.page).toHaveBeenCalledTimes(2); // one message page and one related-entity page
  await f.session.window.loadOlder(); await f.session.window.loadOlder(); await f.session.window.loadOlder();
  expect(f.session.getSnapshot().window.records).toHaveLength(90);
  const before = f.session.getSnapshot().window.records;
  f.addMessage(); await f.session.refresh();
  expect(f.session.getSnapshot().window.records).toEqual(before);
  expect(f.session.getSnapshot().window.hasNewer).toBe(true);
  await f.session.window.jumpToLatest(); expect(f.session.getSnapshot().window.records.at(-1)?.id).toBe("message-201");
  await f.session.setActive(false); expect(f.session.getSnapshot().window.records).toEqual([]);
  vi.mocked(f.reader.page).mockClear(); await f.session.refresh(); expect(f.reader.page).not.toHaveBeenCalled();
  await f.session.setActive(true); expect(f.session.getSnapshot().window.records).toHaveLength(30);
  expect(f.transport.resumeTurn).not.toHaveBeenCalled(); expect(f.resources.appendMutations).not.toHaveBeenCalled();
  expect(f.session.getSnapshot()).not.toHaveProperty("processed_event_ids");
});

it("restores one indexed anchor page and flushes the latest position when its session closes", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  await storage.writePosition("chat", { messageId: "message-80", generation: 0, offset: -20, following: false });
  const f = fixture(200, storage); await f.session.initialize();
  expect(f.session.getSnapshot().window.records[0]?.id).toBe("message-80");
  expect(f.session.getSnapshot().window.records).toHaveLength(30);
  expect(vi.mocked(f.reader.page).mock.calls[0]![0].anchor).toEqual({ messageId: "message-80", generation: 0, direction: "newer", inclusive: true });
  expect(f.session.getPosition()).toMatchObject({ offset: -20, following: false });
  f.session.savePosition({ messageId: "message-90", generation: 0, offset: -5, following: false });
  f.session.dispose();
  await vi.waitFor(async () => expect(await storage.readPosition("chat")).toMatchObject({ messageId: "message-90" }));
  const reopened = fixture(200, storage); await reopened.session.initialize();
  expect(reopened.session.getSnapshot().window.records[0]?.id).toBe("message-90");
});

it("captures content and request before asynchronous storage or refresh; retains exact intent before writes", async () => {
  const f = fixture(), gate = deferred<null>(); vi.mocked(f.pendingStore.load).mockReturnValueOnce(gate.promise);
  const input = { content: [{ type: "text" as const, text: "original" }], request: { text: "original" } };
  const result = f.session.sendMessage(input); input.content[0]!.text = "changed"; input.request.text = "changed";
  gate.resolve(null); expect((await result).status).toBe("completed");
  expect(f.calls).toEqual(["retain", "append", "start", "acknowledge"]);
  const admission = f.resources.appendMutations.mock.calls[0]![0];
  expect(admission.expectedRevision).toBeNull(); expect(admission.mutations[0]!.events[0]!.payload).toMatchObject({ content: [{ text: "original" }] });
  expect(vi.mocked(f.transport.startTurn).mock.calls[0]![0].request).toEqual({ text: "original" }); expect(f.saved()).toBeNull();
});

it("coalesces an identical submission, notifies each caller once, and preserves identity after uncertain replies", async () => {
  const f = fixture(); const submission = await f.session.prepare({ content: "hello", request: { text: "hello" } });
  f.resources.appendMutations.mockRejectedValueOnce(new Error("lost response"));
  await expect(f.session.submit(submission)).rejects.toMatchObject({ retryable: true });
  expect(f.saved()).toEqual(submission); expect(f.transport.startTurn).not.toHaveBeenCalled();
  const first = vi.fn(), second = vi.fn(); const retry = f.session.submit(submission, first);
  expect(f.session.submit(submission, second)).toBe(retry); await retry;
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  expect(f.resources.appendMutations.mock.calls[0]![0]).toEqual(f.resources.appendMutations.mock.calls[1]![0]);
  expect(f.transport.startTurn).toHaveBeenCalledOnce(); expect(f.saved()).toBeNull();
});

it("reconciles a previously completed send without starting it again", async () => {
  const f = fixture(); const submission = await f.session.prepare({ content: "hello", request: { text: "hello" } });
  await f.pendingStore.retain(submission);
  f.setTurn({ turnId: submission.start.conversationTurnId, revision: 2, status: "completed", remoteMayStillBeRunning: false, error: null });
  expect((await f.session.retryPending())?.status).toBe("completed");
  expect(f.transport.startTurn).not.toHaveBeenCalled(); expect(f.saved()).toBeNull();
});

it("does not start a provider or notify later callbacks after admission closes the account", async () => {
  const f = fixture(); const submission = await f.session.prepare({ content: "hello", request: { text: "hello" } });
  const second = vi.fn(), first = f.session.submit(submission, () => f.session.dispose());
  f.session.submit(submission, second);
  await expect(first).rejects.toMatchObject({ code: "observation_closed" });
  expect(second).not.toHaveBeenCalled(); expect(f.transport.startTurn).not.toHaveBeenCalled();
  expect(f.saved()).toEqual(submission); expect(f.session.getSnapshot().control).toBeNull();
});

it("rejects corrupted persisted admissions before touching network or storage", async () => {
  const f = fixture(); const submission = await f.session.prepare({ content: "hello", request: { text: "hello" } });
  const corrupt = structuredClone(submission) as any;
  corrupt.admission.mutations[1].events[0].event_id = corrupt.admission.mutations[0].events[0].event_id;
  expect(() => parseApplicationConversationSubmission(corrupt, "chat")).toThrow();
  expect(() => f.session.submit(corrupt)).toThrow(); expect(f.pendingStore.retain).not.toHaveBeenCalled();
  expect(f.resources.appendMutations).not.toHaveBeenCalled();
  expect(() => parseApplicationConversationSubmission(submission, "other-account-chat")).toThrow();
});

it("cancels only the requested active turn and retries the exact cancellation intent", async () => {
  const f = fixture(); f.setTurn({ turnId: "running", revision: 1, status: "running", remoteMayStillBeRunning: true, error: null });
  f.cancellation.mockRejectedValueOnce(new Error("lost response"));
  await expect(f.session.cancelTurn("running", "user")).rejects.toThrow("lost response");
  await f.session.cancelTurn("running", "superseded");
  expect(f.cancellation.mock.calls[0]).toEqual(f.cancellation.mock.calls[1]);
  expect(f.session.getSnapshot().control?.activeTurnId).toBe("running");
  await expect(f.session.cancelTurn("other", "user")).rejects.toMatchObject({ code: "turn_unavailable" });
  expect(f.cancellation).toHaveBeenCalledTimes(2);
});

it("settles a wait from scalar controls even when message rendering is temporarily offline", async () => {
  const f = fixture(); f.setTurn({ turnId: "done", revision: 1, status: "completed", remoteMayStillBeRunning: false, error: null });
  vi.mocked(f.reader.page).mockRejectedValue(new Error("page offline"));
  expect((await f.session.waitForTurn("done")).status).toBe("completed");
  expect(f.session.getSnapshot().error?.retryable).toBe(true);
});

it("aborts waiting and ignores late controls when an account closes", async () => {
  const f = fixture(), gate = deferred<ConversationDisplayControl>();
  vi.mocked(f.reader.control).mockReturnValueOnce(gate.promise);
  const waiting = f.session.waitForTurn("old"); const result = expect(waiting).rejects.toMatchObject({ code: "observation_closed" });
  f.session.dispose(); gate.resolve(f.control("old")); await result;
  expect(vi.mocked(f.reader.control).mock.calls[0]![1]?.aborted).toBe(true); expect(f.session.getSnapshot().control).toBeNull();
});

it("evicts access-revoked content and stops automatic retries", async () => {
  vi.useFakeTimers(); const f = fixture(200); await f.session.initialize();
  vi.mocked(f.reader.control).mockRejectedValue({ resourceCode: "forbidden" });
  await expect(f.session.refresh()).rejects.toMatchObject({ code: "forbidden", retryable: false });
  expect(f.session.getSnapshot().window.records).toEqual([]); expect(f.session.getSnapshot().related).toEqual([]);
  const count = vi.mocked(f.reader.control).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(f.reader.control).mock.calls.length).toBeLessThanOrEqual(count + 1);
});

it("aborts and discards a late display read when switching away", async () => {
  const f = fixture(200), gate = deferred<ConversationDisplayPage>();
  vi.mocked(f.reader.page).mockReturnValueOnce(gate.promise);
  const loading = f.session.refresh(); await flush(); await f.session.setActive(false);
  const signal = vi.mocked(f.reader.page).mock.calls[0]![1]; expect(signal?.aborted).toBe(true);
  gate.resolve(f.page(f.records.slice(-30))); await loading;
  expect(f.session.getSnapshot().window.records).toEqual([]); expect(f.session.getSnapshot().related).toEqual([]);
});
