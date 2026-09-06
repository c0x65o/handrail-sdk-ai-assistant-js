import { describe, expect, it, vi } from "vitest";
import {
  createConversationActivityHttpHandler,
  createConversationActivityReporter,
  createInMemoryLiveConversationActivityDelivery,
  InMemoryConversationActivityStore,
  PollingConversationActivity,
  type ConversationActivityRecord,
} from "../src/index.js";

describe("conversation activity", () => {
  it("does not erase live activity with a snapshot requested before that activity arrived", async () => {
    let completeLoad!: (records: ConversationActivityRecord[]) => void;
    const pending = new Promise<ConversationActivityRecord[]>((resolve) => { completeLoad = resolve; });
    const delivery = createInMemoryLiveConversationActivityDelivery();
    const activity = new PollingConversationActivity({ load: () => pending, intervalMilliseconds: 60_000,
      subscribe: (signal) => (async function* () {
        for await (const envelope of delivery.subscribe(signal)) yield envelope.record;
      })() });
    activity.start();
    try {
      await delivery.publish({ conversationId: "new", turnStatus: "running", unread: false });
      await vi.waitFor(() => expect(activity.getSnapshot()).toHaveLength(1));
      completeLoad([{ conversationId: "new", turnStatus: "completed", unread: true }]);
      await pending;
      await Promise.resolve();
      expect(activity.getSnapshot()[0]).toMatchObject({ conversationId: "new", turnStatus: "running" });
    } finally { activity.stop(); }
  });

  it("keeps one poll timer after manual refreshes and ignores a stopped request's late response", async () => {
    vi.useFakeTimers();
    const activity = new PollingConversationActivity({ load: async () => [], intervalMilliseconds: 1_000 });
    try {
      await activity.refresh();
      await activity.refresh();
      await activity.refresh();
      expect(vi.getTimerCount()).toBe(1);
      activity.stop();
      expect(vi.getTimerCount()).toBe(0);
      let finish!: (records: ConversationActivityRecord[]) => void;
      const stopped = new PollingConversationActivity({ load: () => new Promise<ConversationActivityRecord[]>((resolve) => { finish = resolve; }) });
      const changed = vi.fn(); stopped.subscribe(changed);
      const refresh = stopped.refresh();
      stopped.stop();
      finish([{ conversationId: "late", turnStatus: "running", unread: false }]);
      await refresh;
      expect(changed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { activity.stop(); vi.useRealTimers(); }
  });

  it("keeps completion and read state when live delivery and polling arrive out of order", () => {
    const store = new InMemoryConversationActivityStore();
    const turn = { conversationId: "conversation", turnId: "first", turnRevision: 2 };
    store.upsert({ ...turn, turnStatus: "completed", unread: true });
    store.replace([{ ...turn, turnStatus: "running", unread: false }]);
    expect(store.getSnapshot()[0]).toMatchObject({ turnStatus: "completed", unread: true });
    store.replace([{ ...turn, turnStatus: "completed", unread: false }]);
    store.upsert({ ...turn, turnStatus: "completed", unread: true });
    expect(store.getSnapshot()[0]?.unread).toBe(false);
    store.upsert({ ...turn, turnId: "second", turnRevision: 20, turnStatus: "running", unread: false });
    store.replace([{ ...turn, turnStatus: "completed", unread: true }]);
    expect(store.getSnapshot()[0]).toMatchObject({ turnId: "second", turnStatus: "running" });
  });

  it("tracks remote running, unread completion, errors, and read state", () => {
    const store = new InMemoryConversationActivityStore();
    const changed = vi.fn(); store.subscribe(changed);
    store.upsert({ conversationId: "remote-a", turnStatus: "running", unread: false,
      updatedAt: "2026-08-31T01:00:00.000Z" });
    store.upsert({ conversationId: "remote-b", turnStatus: "completed", unread: true,
      updatedAt: "2026-08-31T02:00:00.000Z" });
    expect(store.getSnapshot().map((record) => [record.conversationId, record.turnStatus, record.unread])).toEqual([
      ["remote-b", "completed", true], ["remote-a", "running", false],
    ]);
    store.markRead("remote-b");
    expect(store.getSnapshot()[0]?.unread).toBe(false);
    store.upsert({ conversationId: "remote-a", turnStatus: "error", unread: true });
    expect(store.getSnapshot().find((record) => record.conversationId === "remote-a"))
      .toMatchObject({ turnStatus: "error", unread: true });
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("publishes one bounded shared summary with optional numeric progress", async () => {
    let retained: import("../src/index.js").ConversationActivityRecord | null = null;
    const delivery = createInMemoryLiveConversationActivityDelivery();
    const subscription = delivery.subscribe();
    const reporter = createConversationActivityReporter({
      store: {
        async list() { return retained ? [retained] : []; },
        async upsert(record) { retained = record; return record; },
        async markRead() { return retained; },
      },
      delivery,
      now: () => new Date("2026-09-04T18:00:00.000Z"),
    });
    const published = reporter.report({ conversationId: "bulk-revenue",
      summary: "Tracing prior invoice revenue accounts",
      progress: { completed: 18, total: 43, unit: "products" } });
    const envelope = await subscription[Symbol.asyncIterator]().next();
    await expect(published).resolves.toEqual(expect.objectContaining({
      conversationId: "bulk-revenue", turnStatus: "running", unread: false,
      summary: "Tracing prior invoice revenue accounts",
      progress: { completed: 18, total: 43, unit: "products" },
    }));
    expect(envelope.value?.record).toEqual(retained);
    subscription.close();
  });

  it("rejects invalid activity summaries and progress", () => {
    const store = new InMemoryConversationActivityStore();
    expect(() => store.upsert({ conversationId: "bulk", turnStatus: "running", unread: false,
      summary: "x".repeat(241) })).toThrow(/summary/u);
    expect(() => store.upsert({ conversationId: "bulk", turnStatus: "running", unread: false,
      summary: "Updating", progress: { completed: 4, total: 3 } })).toThrow(/progress/u);
  });

  it("loads a server-backed snapshot through the cross-platform polling adapter", async () => {
    const load = vi.fn(async () => [{ conversationId: "remote", turnStatus: "running" as const, unread: false }]);
    const activity = new PollingConversationActivity({ load, intervalMilliseconds: 60_000 });
    await activity.refresh();
    expect(activity.getSnapshot()).toEqual([expect.objectContaining({ conversationId: "remote", turnStatus: "running" })]);
    expect(load).toHaveBeenCalledOnce();
    activity.stop();
  });

  it("diagnoses polling and live fallback failures without stopping convergence", async () => {
    const diagnostics = vi.fn();
    const activity = new PollingConversationActivity({
      load: async () => { throw new Error("private poll failure"); },
      subscribe: () => (async function* () {
        throw new Error("private stream failure");
        yield { conversationId: "unreachable", turnStatus: "idle" as const, unread: false };
      })(),
      intervalMilliseconds: 60_000,
      diagnostics,
    });
    activity.start();
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      domain: "activity", operation: "live_subscribe", code: "activity_stream_unavailable",
    })));
    await activity.refresh();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      domain: "activity", operation: "poll", code: "activity_poll_unavailable",
    }));
    activity.stop();
  });

  it("applies live activity immediately while retaining polling convergence", async () => {
    const delivery = createInMemoryLiveConversationActivityDelivery();
    const activity = new PollingConversationActivity({
      load: async () => [],
      intervalMilliseconds: 60_000,
      subscribe: (signal) => (async function* () {
        for await (const envelope of delivery.subscribe(signal)) yield envelope.record;
      })(),
    });
    activity.start();
    await Promise.resolve();
    await delivery.publish({ conversationId: "remote-live", turnStatus: "running", unread: false });
    await vi.waitFor(() => expect(activity.getSnapshot()).toEqual([
      expect.objectContaining({ conversationId: "remote-live", turnStatus: "running" }),
    ]));
    activity.stop();
  });

  it("serves protected list and read operations through a scope-bound handler", async () => {
    const markRead = vi.fn(async () => ({ conversationId: "remote", turnStatus: "completed" as const, unread: false }));
    const handler = createConversationActivityHttpHandler({
      async list() { return [{ conversationId: "remote", turnStatus: "completed", unread: true }]; },
      async upsert(record) { return record; }, markRead,
    });
    const listed = await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "list" }) }));
    expect((await listed.json()).value).toEqual([expect.objectContaining({ conversationId: "remote", unread: true })]);
    const read = await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "mark_read", conversationId: "remote" }) }));
    expect((await read.json()).value.unread).toBe(false);
    expect(markRead).toHaveBeenCalledWith("remote", undefined);
    const observed = { conversationId: "remote", turnId: "seen", turnStatus: "error", unread: true };
    await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "mark_read", conversationId: "remote", observed }) }));
    expect(markRead).toHaveBeenLastCalledWith("remote", observed);
    const invalid = await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "mark_read", conversationId: "other", observed }) }));
    expect(invalid.status).toBe(400);
  });

  it("streams an initial activity snapshot and later updates over SSE", async () => {
    const delivery = createInMemoryLiveConversationActivityDelivery();
    const handler = createConversationActivityHttpHandler({
      async list() { return [{ conversationId: "initial", turnStatus: "completed", unread: true }]; },
      async upsert(record) { return record; },
      async markRead() { return null; },
    }, { delivery });
    const response = await handler(new Request("https://app.example/activity"));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('"conversationId":"initial"');
    await delivery.publish({ conversationId: "remote-live", turnStatus: "error", unread: true });
    const update = await reader.read();
    expect(new TextDecoder().decode(update.value)).toContain('"conversationId":"remote-live"');
    await reader.cancel();
  });
});
