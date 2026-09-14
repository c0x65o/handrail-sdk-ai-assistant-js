import { afterEach, expect, it, vi } from "vitest";
import { RealtimeWorkspaceMonitor, parseRealtimeWorkspacePage, summarizeRealtimeWorkspace, type RealtimeWorkspaceCall } from "../src/realtime/workspace.js";
const call = (conversationId: string, callId = "voice", extra: Partial<RealtimeWorkspaceCall> = {}): RealtimeWorkspaceCall => ({
  conversationId, callId, status: "active", counts: { total: 1, running: 1, completed: 0, failed: 0 }, unread: false, ...extra,
});
const page = (...calls: RealtimeWorkspaceCall[]) => ({ calls, next: null });
afterEach(() => vi.useRealTimers());
it("distinguishes a saved approval from running or uncertain voice work", () => {
  const waiting = call("one", "voice", { status: "ended", counts: {
    total: 1, running: 0, waitingForApproval: 1, completed: 0, failed: 0 } });
  const parsed = parseRealtimeWorkspacePage(page(waiting));
  expect(parsed.calls[0]?.counts.waitingForApproval).toBe(1);
  expect(summarizeRealtimeWorkspace({ calls: parsed.calls, loading: false, synchronized: true, error: null }).unresolvedTools).toBe(0);
  expect(() => parseRealtimeWorkspacePage(page({ ...waiting, counts: { ...waiting.counts, waitingForApproval: -1 } }))).toThrow();
});
it("validates and projects public voice fields only", () => {
  expect(parseRealtimeWorkspacePage({ calls: [{ ...call("one"), providerCallRef: "secret" }], next: null })).toEqual(page(call("one")));
  for (const input of [{ calls: [] }, page(call("one", "voice", { unread: true })), page(call("one", "voice", { counts: { total: 1, running: -1, completed: 2, failed: 0 } }))]) {
    expect(() => parseRealtimeWorkspacePage(input)).toThrow();
  }
});
it("discovers independent paged calls and reads completion without acknowledging it", async () => {
  let ended = false, seen = false;
  const monitor = new RealtimeWorkspaceMonitor({ readPage: async ({ conversationIds, after }) => {
    expect(conversationIds).toEqual(["one", "two"]);
    return after ? page(call("two", "voice", { status: "uncertain" })) : {
      calls: [call("one", "voice", { status: ended ? "ended" : "active", unread: ended && !seen })],
      next: { conversationId: "one", callId: "voice" },
    };
  } });
  try {
    await monitor.setConversations(["two", "one"]);
    expect(summarizeRealtimeWorkspace(monitor.getSnapshot())).toEqual({ activeCalls: 1, unconfirmedCalls: 1, unreadCalls: 0, unresolvedTools: 1 });
    ended = true; await monitor.refresh(); await monitor.refresh();
    expect(summarizeRealtimeWorkspace(monitor.getSnapshot(), "one").unreadCalls).toBe(1);
    seen = true; await monitor.refresh();
    expect(summarizeRealtimeWorkspace(monitor.getSnapshot(), "one").unreadCalls).toBe(0);
  } finally { monitor.dispose(); }
});
it("retains complete evidence on foreign, missing, repeated, regressed and truncated feeds", async () => {
  const saved = call("one", "voice", { status: "ended", unread: true, counts: { total: 1, running: 0, completed: 1, failed: 0 } });
  let response: unknown = page(saved);
  const monitor = new RealtimeWorkspaceMonitor({ maxPages: 1, readPage: async () => response });
  try {
    await monitor.setConversations(["one"]);
    for (response of [page(), page(call("other")), page(saved, saved), page(call("one")), { calls: [saved], next: { conversationId: "one", callId: "voice" } }]) {
      await monitor.refresh();
      expect(monitor.getSnapshot()).toMatchObject({ calls: [saved], error: "Could not refresh voice activity. Retrying…", loading: false });
    }
  } finally { monitor.dispose(); }
});
it("chunks catalog discovery and retains markers if the catalog fails", async () => {
  const sizes: number[] = []; let failing = false;
  const monitor = new RealtimeWorkspaceMonitor({ loadConversationIds: async () => {
    if (failing) throw new Error("private catalog failure");
    return Array.from({ length: 101 }, (_, index) => `conversation-${index}`);
  }, readPage: async ({ conversationIds }) => { sizes.push(conversationIds.length); return page(call(conversationIds[0]!)); } });
  try {
    await monitor.refresh(); expect(sizes).toEqual([100, 1]);
    const saved = monitor.getSnapshot().calls;
    failing = true; await monitor.refresh();
    expect(monitor.getSnapshot().calls).toEqual(saved);
    expect(monitor.getSnapshot().error).not.toContain("private");
    await expect(monitor.setConversations([])).rejects.toThrow("catalog loader");
  } finally { monitor.dispose(); }
});
it("aborts old scopes, joins reads and ignores late results even if the loader ignores abort", async () => {
  let resolve: ((value: unknown) => void) | undefined; let hold = false;
  const signals: AbortSignal[] = [];
  const monitor = new RealtimeWorkspaceMonitor({ readPage: async ({ conversationIds, signal }) => {
    signals.push(signal);
    return hold ? new Promise((done) => { resolve = done; }) : page(call(conversationIds[0]!));
  } });
  await monitor.setConversations(["one"]);
  hold = true;
  const old = monitor.refresh(); expect(monitor.refresh()).toBe(old);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  hold = false;
  await monitor.setConversations(["two"]);
  expect(signals[1]!.aborted).toBe(true);
  resolve!(page(call("one"))); await old;
  expect(monitor.getSnapshot().calls[0]!.conversationId).toBe("two");
  hold = true; resolve = undefined;
  const late = monitor.refresh();
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  monitor.dispose(); const saved = monitor.getSnapshot();
  resolve!(page()); await late;
  expect(monitor.getSnapshot()).toBe(saved);
});
it("bounds requests that never return and can recover on a later poll", async () => {
  vi.useFakeTimers(); let hanging = false;
  const monitor = new RealtimeWorkspaceMonitor({ requestTimeoutMilliseconds: 50, readPage: async ({ conversationIds }) =>
    hanging ? new Promise(() => {}) : page(call(conversationIds[0]!)) });
  try {
    await monitor.setConversations(["one"]);
    hanging = true; const pending = monitor.refresh();
    await vi.advanceTimersByTimeAsync(51); await pending;
    expect(monitor.getSnapshot()).toMatchObject({ calls: [call("one")], loading: false, error: "Could not refresh voice activity. Retrying…" });
    hanging = false; await monitor.refresh(); expect(monitor.getSnapshot().error).toBeNull();
  } finally { monitor.dispose(); }
});
