import { afterEach, expect, it, vi } from "vitest";
import { ApplicationConversationSession, type ApplicationConversationReader } from "../src/client/application-session.js";
import { parseApplicationConversationSubmission, type ApplicationConversationPendingStore,
  type ApplicationConversationSubmission } from "../src/client/session-submission.js";
import type { ConversationDisplayControl, ConversationDisplayTurnControl } from "../src/conversation/display-control.js";
import type { ConversationDisplayPage, ConversationDisplayRecord } from "../src/conversation/display-history.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { AppendMutationsInput, AppendMutationsResult } from "../src/sync/types.js";
import { InMemoryConversationLocalStateStore, type ConversationLocalStateStore } from "../src/client/local-state.js";
import { applicationConversationPresentation } from "../src/client/application-runtime.js";
import { relatedViews } from "../src/client/related-records.js";
import { toConversationAttachmentReference } from "../src/attachments/references.js";

const sessions: ApplicationConversationSession<{ text: string }>[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers(); });
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(count = 0, localStateStore?: ConversationLocalStateStore, reconcileAcceptedFiles?: (ids: readonly string[]) => Promise<void>, recordText = false) {
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
    reader, resources, transport, pendingStore, pollMilliseconds: 100, idlePollMilliseconds: 1000, recordText, approvalReview: recordText,
    ...(localStateStore ? { localStateStore } : {}),
    ...(reconcileAcceptedFiles ? { reconcileAcceptedFiles } : {}),
    createId: () => `op${++sequence}`, now: () => "2026-09-16T12:00:00.000Z" });
  sessions.push(session);
  return { session, reader, resources, transport, pendingStore, calls, records, cancellation, disconnect, control, page,
    saved: () => saved, setTurn: (value: ConversationDisplayTurnControl) => { turn = value; revision = Math.max(revision, value.revision); },
    addMessage: () => { revision++; records.push({ ...records.at(-1)!, id: `message-${records.length + 1}`, revision }); } };
}

it("releases definitively rejected admission for correction without clearing the draft or starting a provider", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  const cleanup = vi.fn(async () => {}), f = fixture(0, storage, cleanup);
  await f.session.initialize(); f.session.draft!.setText("keep this draft"); await f.session.draft!.flush();
  const accepted = vi.fn();
  vi.mocked(f.resources.appendMutations).mockResolvedValueOnce({ status: "rejected", code: "attachment_expired", message: "ignored server detail" });
  await expect(f.session.sendMessage({ content: "keep this draft", request: { text: "expired file" }, onAccepted: accepted }))
    .rejects.toMatchObject({ code: "attachment_expired", retryable: false, message: "A file upload expired before the message was saved. Select the file again." });
  expect(f.saved()).toBeNull(); expect(f.session.getSnapshot().hasPendingSubmission).toBe(false);
  expect((await storage.readDraft("chat"))?.text).toBe("keep this draft");
  expect(cleanup).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled(); expect(f.transport.startTurn).not.toHaveBeenCalled();
  await f.session.sendMessage({ content: "corrected", request: { text: "replacement file" } });
  expect(f.transport.startTurn).toHaveBeenCalledOnce();
});

it("keeps a rejected send journal if exact local removal fails and retries only that identity", async () => {
  const f = fixture(); await f.session.initialize();
  vi.mocked(f.resources.appendMutations).mockResolvedValue({ status: "rejected", code: "attachment_expired", message: "expired" });
  vi.mocked(f.pendingStore.acknowledge).mockRejectedValueOnce(new Error("device unavailable"));
  await expect(f.session.sendMessage({ content: "draft", request: { text: "draft" } })).rejects.toMatchObject({ retryable: true });
  const original = f.saved(); expect(original).not.toBeNull();
  await expect(f.session.retryPending()).rejects.toMatchObject({ code: "attachment_expired", retryable: false });
  expect(f.resources.appendMutations).toHaveBeenNthCalledWith(2, original!.admission);
  expect(f.saved()).toBeNull(); expect(f.transport.startTurn).not.toHaveBeenCalled();
});

it("cancels selected approval reads and prevents decisions after a chat is deactivated", async () => {
  const f = fixture(4, undefined, undefined, true); await f.session.initialize();
  const held = deferred<import("../src/conversation/approval-display-review.js").ConversationApprovalDisplayReview>();
  f.reader.approvalReview = vi.fn(() => held.promise); f.reader.decideApproval = vi.fn();
  const input = { conversationId: "chat", generation: 0, proposalId: "proposal" };
  const signal = new AbortController().signal;
  await expect(f.session.readApprovalReview({ ...input, conversationId: "other" }, signal)).rejects.toThrow("unavailable");
  const reading = f.session.readApprovalReview(input, signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await f.session.setActive(false); expect(vi.mocked(f.reader.approvalReview).mock.calls[0]?.[1]?.aborted).toBe(true);
  held.resolve({ ...input, schemaVersion: 1, status: "preparing", review: null }); await rejected;
  await expect(f.session.decideApproval({ conversationId: "chat", proposalId: "proposal", expectedVersion: 1,
    proposalBinding: "a".repeat(64), status: "confirmed", idempotencyKey: "choice", idempotencyFingerprint: "choice" }, signal)).rejects.toThrow("unavailable");
  expect(f.reader.decideApproval).not.toHaveBeenCalled();
});

it("scopes explicit record inspection to negotiated active account/selection lifetime", async () => {
  const f = fixture(4, undefined, undefined, true); await f.session.initialize();
  const held = deferred<{ encoding: "plain-text"; text: string; nextOffset: null; revision: number }>();
  f.reader.content = vi.fn(() => held.promise);
  const input = { conversationId: "chat", generation: 0, kind: "tool" as const, id: "call", revision: 4, format: "record-text" as const };
  const signal = new AbortController().signal;
  await expect(f.session.readRecordText({ ...input, conversationId: "other" }, signal)).rejects.toThrow("unavailable");
  await expect(f.session.readRecordText({ ...input, generation: 1 }, signal)).rejects.toThrow("unavailable");
  expect(f.reader.content).not.toHaveBeenCalled();
  const reading = f.session.readRecordText(input, signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await f.session.setActive(false);
  expect(vi.mocked(f.reader.content).mock.calls[0]![1]!.aborted).toBe(true);
  held.resolve({ encoding: "plain-text", text: "old chat", nextOffset: null, revision: 4 });
  await rejected;
  await expect(f.session.readRecordText(input, signal)).rejects.toThrow("unavailable");
  const legacy = fixture(4); legacy.reader.content = vi.fn(); await legacy.session.initialize();
  expect(legacy.session.supportsRecordText).toBe(false);
});

it("replays a saved draft origin after process loss without sending device metadata to the server", async () => {
  const storage = new InMemoryConversationLocalStateStore(), f = fixture(0, storage);
  await f.session.initialize(); f.session.draft!.setText("accepted before crash");
  const version = (await f.session.draft!.captureVersion(f.session.draft!.getSnapshot().edit))!;
  vi.spyOn(storage, "discardDraftVersion").mockRejectedValueOnce(new Error("device disconnected"));
  const pending = await f.session.prepare({ content: "accepted before crash", request: { text: "accepted before crash" }, localDraft: { version: 1, textVersion: version } });
  expect(pending.version).toBe(2);
  expect(() => parseApplicationConversationSubmission({ ...pending, version: 1 }, "chat")).toThrow();
  expect(() => parseApplicationConversationSubmission({ ...pending, localDraft: undefined }, "chat")).toThrow();
  await expect(f.session.submit(pending)).rejects.toMatchObject({ code: "draft_cleanup_failed", retryable: true });
  expect(f.saved()).toEqual(pending); expect(f.transport.startTurn).not.toHaveBeenCalled();
  expect((await storage.readDraft("chat"))?.text).toBe("accepted before crash");
  f.session.dispose(); await f.session.draft!.dispose();
  const restarted = new ApplicationConversationSession({ conversationId: "chat" as never, clientId: "new-client" as never,
    reader: f.reader, resources: f.resources, transport: f.transport, pendingStore: f.pendingStore, localStateStore: storage }); sessions.push(restarted);
  await restarted.initialize(); await restarted.retryPending();
  expect(await storage.readDraft("chat")).toBeNull(); expect(restarted.draft!.getSnapshot().text).toBe(""); expect(f.saved()).toBeNull();
  expect(f.resources.appendMutations).toHaveBeenNthCalledWith(1, pending.admission);
  expect(f.resources.appendMutations).toHaveBeenNthCalledWith(2, pending.admission);
  expect(f.transport.startTurn).toHaveBeenCalledExactlyOnceWith(pending.start);
  expect(JSON.stringify(vi.mocked(f.resources.appendMutations).mock.calls)).not.toContain("textVersion");
  expect(JSON.stringify(vi.mocked(f.transport.startTurn).mock.calls)).not.toContain("localDraft");
});

it("preserves a same-text newer draft across retry after partial local cleanup", async () => {
  const storage = new InMemoryConversationLocalStateStore(), files = vi.fn<(ids: readonly string[]) => Promise<void>>().mockRejectedValueOnce(new Error("disk"))
    .mockResolvedValue(undefined), f = fixture(0, storage, files);
  await f.session.initialize(); f.session.draft!.setText("same text");
  const version = (await f.session.draft!.captureVersion(f.session.draft!.getSnapshot().edit))!;
  const pending = await f.session.prepare({ content: "same text", request: { text: "same text" },
    attachments: [toConversationAttachmentReference({ attachment_id: "att_file", content_ref: "ref_file", media_type: "application/pdf", byte_size: 3 })],
    localDraft: { version: 1, textVersion: version, fileIds: ["selected-file"] } });
  await expect(f.session.submit(pending)).rejects.toMatchObject({ code: "draft_cleanup_failed" });
  expect(await storage.readDraft("chat")).toBeNull(); expect(f.saved()).toEqual(pending);
  f.session.draft!.setText("same text"); await f.session.draft!.flush();
  await f.session.retryPending();
  expect((await storage.readDraft("chat"))?.text).toBe("same text"); expect(f.session.draft!.getSnapshot().text).toBe("same text");
  expect(files).toHaveBeenNthCalledWith(1, ["selected-file"]); expect(files).toHaveBeenNthCalledWith(2, ["selected-file"]);
  expect(f.saved()).toBeNull();
});

it("does not clean any local draft until exact server admission is confirmed", async () => {
  const storage = new InMemoryConversationLocalStateStore(), f = fixture(0, storage); await f.session.initialize();
  f.session.draft!.setText("not confirmed"); const version = (await f.session.draft!.captureVersion(f.session.draft!.getSnapshot().edit))!;
  const discard = vi.spyOn(storage, "discardDraftVersion");
  vi.mocked(f.resources.appendMutations).mockResolvedValueOnce({ status: "mutations", latestRevision: 2 as never, acknowledgements: [] });
  await expect(f.session.sendMessage({ content: "not confirmed", request: { text: "not confirmed" }, localDraft: { version: 1, textVersion: version } }))
    .rejects.toMatchObject({ code: "admission_unconfirmed" });
  expect(discard).not.toHaveBeenCalled(); expect((await storage.readDraft("chat"))?.text).toBe("not confirmed"); expect(f.saved()).not.toBeNull();
});

it("rejects malformed draft origins before any journal or network mutation", async () => {
  const f = fixture(); await f.session.initialize();
  const pending = await f.session.prepare({ content: "text", request: { text: "text" } });
  for (const localDraft of [{ version: 2 }, { version: 1, textVersion: "" }, { version: 1, fileIds: ["same", "same"] },
    { version: 1, fileIds: ["https://file.invalid/private"] }, { version: 1, accountId: "injected" }, { version: 1, fileIds: ["not-attached"] }]) {
    expect(() => f.session.submit({ ...pending, version: 2, localDraft } as never)).toThrow();
  }
  expect(f.pendingStore.retain).not.toHaveBeenCalled(); expect(f.resources.appendMutations).not.toHaveBeenCalled();
});

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

it("retains earlier activity pages within hard bounds, refreshes loaded records and exposes a restart", async () => {
  const f = fixture(30);
  f.setTurn({ turnId: "turn", revision: 30, status: "running", remoteMayStillBeRunning: true, error: null });
  const base = f.reader.page;
  const tool = (id: number, revision = 30): ConversationDisplayRecord => ({ kind: "tool", id: `tool-${id}`, turnId: "turn",
    revision, bytes: 200, deferred: false, value: { tool_call_id: `tool-${id}`, turn_id: "turn", name: `Tool ${id}`, status: "completed" } as never });
  let first = 90;
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal)
    : { ...f.page(Array.from({ length: 30 }, (_, index) => tool((input.cursor ? Number(input.cursor) : first) + index))),
      nextCursor: input.cursor === "0" ? null : String((input.cursor ? Number(input.cursor) : first) - 30) });
  await f.session.initialize(); await f.session.loadMoreRelated();
  expect(f.session.getSnapshot().related).toHaveLength(60);
  expect(f.session.getSnapshot().related.map(row => row.id)).toContain("tool-119");
  await f.session.loadMoreRelated(); await f.session.loadMoreRelated();
  expect(f.session.getSnapshot().related).toHaveLength(90);
  expect(f.session.getSnapshot().relatedTruncated).toBe(true);
  // A live update outside the latest activity page still updates/removes cached records.
  f.setTurn({ turnId: "turn", revision: 31, status: "running", remoteMayStillBeRunning: true, error: null });
  vi.mocked(f.reader.changes).mockResolvedValue({ ...f.page([{ ...tool(70, 31), deleted: true, value: null }]), throughRevision: 31 });
  await f.session.refresh();
  expect(f.session.getSnapshot().related.some(row => row.id === "tool-70")).toBe(false);
  expect(f.session.getSnapshot().related.some(row => row.id === "tool-30")).toBe(true);
  first = 90;
  await f.session.showLatestRelated();
  expect(f.session.getSnapshot().related).toHaveLength(30);
  expect(f.session.getSnapshot().relatedTruncated).toBe(false);
});

it("does not resurrect activity when a changes read overtakes an older page", async () => {
  const f = fixture(2), base = f.reader.page;
  const tool: ConversationDisplayRecord = { kind: "tool", id: "gone", revision: 2, turnId: null,
    bytes: 100, deferred: false, value: { tool_call_id: "gone", status: "completed" } as never };
  const held = deferred<ConversationDisplayPage>();
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal)
    : input.cursor ? held.promise : { ...f.page([tool]), nextCursor: "older" });
  await f.session.initialize();
  const more = f.session.loadMoreRelated();
  vi.mocked(f.reader.changes).mockResolvedValue({ ...f.page([{ ...tool, revision: 3, value: null, deleted: true }]),
    revision: 3, canonicalRevision: 3, throughRevision: 3 });
  await f.session.window.refresh();
  held.resolve(f.page([tool])); await more;
  expect(f.session.getSnapshot().related).toEqual([]);
  // A lagging response read after the watermark advanced must also be rejected.
  vi.mocked(f.reader.page).mockImplementation(async (input, signal) => input.view?.type !== "context" ? base(input, signal) : f.page([tool]));
  await expect(f.session.refresh()).rejects.toMatchObject({ code: "stale_activity", retryable: true });
  expect(f.session.getSnapshot().related).toEqual([]);
});

it("exposes citations only with a retained source and reports incomplete citation presentation", async () => {
  const f = fixture(2), base = f.reader.page;
  const citation: ConversationDisplayRecord = { kind: "citation", id: "c", revision: 2, turnId: null,
    bytes: 150, deferred: false, value: { citation_id: "c", source_id: "s", order: 0,
      target: { type: "assistant_message", message_id: "message-2" } } as never };
  const source: ConversationDisplayRecord = { kind: "source", id: "s", revision: 2, turnId: null,
    bytes: 100, deferred: false, value: { source_id: "s", label: "Source", type: "record" } as never };
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal)
    : { ...f.page(input.cursor ? [source] : [citation]), nextCursor: input.cursor ? null : "source" });
  const view = () => applicationConversationPresentation(f.session.getSnapshot());
  await f.session.initialize();
  expect(view().citations).toEqual([]); expect(view().unresolvedCitationCount).toBe(1);
  await f.session.loadMoreRelated();
  expect(view().citations).toEqual([citation.value]); expect(view().unresolvedCitationCount).toBe(0);
  vi.mocked(f.reader.changes).mockResolvedValue({ ...f.page([{ ...source, revision: 3, deleted: true, value: null }]),
    revision: 3, canonicalRevision: 3, throughRevision: 3 });
  await f.session.window.refresh();
  expect(view().citations).toEqual([]); expect(view().unresolvedCitationCount).toBe(1);
  expect(view().citation_sources).toEqual([]);
});

it("publishes activity-page errors and clears all presentation after access revocation", async () => {
  const f = fixture(2), base = f.reader.page;
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal)
    : { ...f.page([]), nextCursor: "more" });
  await f.session.initialize();
  vi.mocked(f.reader.page).mockRejectedValueOnce({ resourceCode: "forbidden", retryable: false });
  await expect(f.session.loadMoreRelated()).rejects.toMatchObject({ code: "forbidden", retryable: false });
  expect(f.session.getSnapshot().window.records).toEqual([]);
  expect(f.session.getSnapshot().related).toEqual([]);
  expect(f.session.getSnapshot().control).toBeNull();
  expect(f.session.getSnapshot().error?.code).toBe("forbidden");
});

it("bounds large activity pages by serialized bytes independently of row count", async () => {
  const f = fixture(2), base = f.reader.page;
  let sequence = 0;
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal)
    : { ...f.page(Array.from({ length: 2 }, () => ({ kind: "source", id: `source-${++sequence}`, revision: 1,
      turnId: null, bytes: 30000, deferred: false, value: { text: "x".repeat(30000) } as never }))), nextCursor: String(sequence) });
  await f.session.initialize();
  for (let i = 0; i < 6; i++) await f.session.loadMoreRelated();
  const snapshot = f.session.getSnapshot();
  expect(snapshot.related.length).toBeLessThan(9);
  expect(new TextEncoder().encode(JSON.stringify(snapshot.related)).byteLength).toBeLessThanOrEqual(262144);
  expect(snapshot.relatedTruncated).toBe(true);
});

it("pages long context references on demand without exceeding the gateway request budget", async () => {
  const f = fixture(30), base = f.reader.page;
  for (let i = 0; i < f.records.length; i++) f.records[i] = { ...f.records[i]!, id: `${"界".repeat(500)}-${i}` };
  f.reader.page = vi.fn(async (input, signal) => input.view?.type !== "context" ? base(input, signal) : f.page([]));
  await f.session.initialize();
  const contexts = () => vi.mocked(f.reader.page).mock.calls.map(([input]) => input).filter(input => input.view?.type === "context");
  expect(contexts()).toHaveLength(1);
  for (let i = 0; f.session.getSnapshot().hasMoreRelated && i < 40; i++) await f.session.loadMoreRelated();
  expect(f.session.getSnapshot().hasMoreRelated).toBe(false);
  const references = contexts().flatMap(input => input.view?.type === "context" ? input.view.messageIds : []);
  expect(new Set(references)).toEqual(new Set(f.records.map(record => record.id)));
  const views = relatedViews(f.records.map(record => record.id), "界".repeat(512));
  for (const view of views) expect(new TextEncoder().encode(JSON.stringify({ operation: "page", input: {
    conversationId: "界".repeat(512), view, cursor: "x".repeat(4096), limit: 30, maximumBytes: 65536,
  } })).byteLength).toBeLessThanOrEqual(8192);
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
  expect(f.session.getPosition()).toBeUndefined();
  await vi.waitFor(async () => expect(await storage.readPosition("chat")).toMatchObject({ messageId: "message-90" }));
  const reopened = fixture(200, storage); await reopened.session.initialize();
  expect(reopened.session.getSnapshot().window.records[0]?.id).toBe("message-90");
});

it("does not hold the transcript behind a blocked local position read", async () => {
  const storage = new InMemoryConversationLocalStateStore();
  vi.spyOn(storage, "readPosition").mockImplementation(() => new Promise(() => {}));
  const f = fixture(200, storage);
  await f.session.initialize();
  expect(f.session.getSnapshot().window.records).toHaveLength(30);
  expect(f.session.getSnapshot().window.records.at(-1)?.id).toBe("message-200");
  expect(vi.mocked(f.reader.page).mock.calls[0]![0].anchor).toBeUndefined();
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
  const corrupt = { ...submission, admission: { ...submission.admission,
    mutations: submission.admission.mutations.map(mutation => ({ ...mutation,
      events: [{ ...mutation.events[0], event_id: submission.admission.mutations[0]!.events[0]!.event_id }] as const,
    })),
  } };
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
