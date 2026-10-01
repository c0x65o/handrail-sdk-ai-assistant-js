import { expect, it, vi } from "vitest";
import { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import type { ConversationTransport, StartTurnInput, CancelTurnInput, TurnObservationResult } from "../src/transports/types.js";

const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const input: StartTurnInput<string> = { conversationId: "conversation", conversationTurnId: "turn" as never,
  mutationId: "start", idempotencyKey: "start", request: "request" };
const stop: CancelTurnInput = { conversationId: "conversation", turnId: "turn", mutationId: "stop", idempotencyKey: "stop", reason: "user" };
const wait: TurnObservationResult = { status: "waiting_for_approval", pendingToolCallIds: ["effect"], checkpoint };
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { release, promise }; };
const failure = { ok: false as const, error: { code: "unavailable" as const, message: "unavailable", retryable: true } };
function fixture() {
  const store = new InMemoryDurableApplicationTurnStore<string, never>();
  const cancelTurn = vi.fn<NonNullable<Extract<ConversationTransport<never, string>["capabilities"]["authoritativeCancellation"], { supported: true }>["capability"]>["cancelTurn"]>(async () =>
    ({ ok: true, value: { status: "cancellation_requested" } }));
  const startTurn = vi.fn<ConversationTransport<never, string>["startTurn"]>(async i => ({ ok: true, value: {
    conversationId: i.conversationId, turnId: `remote-${i.conversationTurnId}`, mutationId: i.mutationId,
    observation: { events: (async function* () {})(), result: Promise.resolve(wait), disconnect() {} },
  } }));
  const delegate: ConversationTransport<never, string> = { startTurn, async resumeTurn() { return failure; },
    capabilities: { authoritativeCancellation: { supported: true, capability: { cancelTurn } },
      attachmentUpload: { supported: false }, documentInput: { supported: false }, presence: { supported: false }, synchronization: { supported: false } } };
  let authorized = true, clock = Date.now();
  const worker = (workerId: string, extra: Partial<Parameters<typeof createDurableApplicationTransport<never, string, string>>[0]> = {}) =>
    createDurableApplicationTransport({ store, delegate, workerId, pollMilliseconds: 25, leaseMilliseconds: 1000,
      maximumAttempts: 1, authorizeRecovery: () => authorized, now: () => clock,
      requestCodec: { encode: r => r, decode: r => r, fingerprint: r => r }, checkpointForEvent: () => checkpoint, ...extra });
  const cancel = (w: ReturnType<typeof worker>, value = stop) => {
    const c = w.capabilities.authoritativeCancellation; if (!c.supported) throw Error(); return c.capability.cancelTurn(value);
  };
  const status = async (value: string) => vi.waitFor(async () => expect((await store.load("conversation", "turn"))?.record.status).toBe(value));
  const paused = async () => { const w = worker("first"); await w.startTurn(input); await status("waiting_for_approval"); await w.stopWorkers(); return w; };
  return { store, delegate, startTurn, cancelTurn, worker, cancel, status, paused,
    deny: () => { authorized = false; }, allow: () => { authorized = true; }, advance: (n: number) => { clock += n; } };
}

it("duplicate concurrent Stop retains one mutation and does not admit or approve another turn", async () => {
  const f = fixture(); await f.paused();
  const other = f.worker("other"); await other.startTurn({ ...input, conversationId: "other" }); await other.stopWorkers();
  const untouched = await f.store.load("other", "turn");
  const w = f.worker("stopping"), held = gate(); f.cancelTurn.mockImplementation(async () => { await held.promise; return { ok: true, value: { status: "cancellation_requested" } }; });
  const replies = await Promise.all(Array.from({ length: 8 }, () => f.cancel(w)));
  expect(replies.every(r => r.ok)).toBe(true);
  await vi.waitFor(() => expect(f.cancelTurn).toHaveBeenCalledOnce());
  await Promise.all([w.resumeApprovalTurn("conversation", "turn"), w.resumeTurn({ conversationId: "conversation", turnId: "turn", resumeFrom: checkpoint })]);
  held.release(); await f.status("cancelled"); await w.stopWorkers();
  expect(f.startTurn).toHaveBeenCalledTimes(2); expect(await f.store.load("other", "turn")).toEqual(untouched);
  expect((await f.store.load("conversation", "turn"))?.record.cancellation).toMatchObject({ mutationId: "stop", idempotencyKey: "stop", reason: "user" });
});

it.each(["unavailable", "throw", "timeout"])("keeps %s cancellation discoverable beyond execution retry exhaustion", async mode => {
  const f = fixture(); await f.paused();
  f.cancelTurn.mockImplementation(async () => { if (mode === "throw") throw Error("private failure"); if (mode === "timeout") return new Promise(() => {}); return failure; });
  const w = f.worker("stop"); await f.cancel(w);
  await vi.waitFor(() => expect(w.activeWorkerCount).toBe(0), { timeout: 3000 });
  expect((await f.store.load("conversation", "turn"))?.record).toMatchObject({ status: "pending", terminal: null, lease: null });
  expect((await f.store.scanRecoveryCandidates(5)).candidates).toHaveLength(1);
  f.cancelTurn.mockResolvedValue({ ok: true, value: { status: "cancellation_requested" } });
  const restarted = f.worker("restarted"); expect((await restarted.recoverPending()).length).toBe(1);
  await f.status("cancelled"); await restarted.stopWorkers();
  expect(f.startTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn.mock.calls.every(([s]) => s.idempotencyKey === "stop" && s.turnId === "remote-turn")).toBe(true);
});

it("rejects conflicting concurrent cancellations inside the CAS and preserves the winner", async () => {
  const f = fixture(); await f.paused(); const w = f.worker("stopped"); await w.stopWorkers();
  const results = await Promise.all([f.cancel(w), f.cancel(w, { ...stop, idempotencyKey: "different", reason: "runtime_shutdown" })]);
  expect(results.filter(r => r.ok)).toHaveLength(1); expect(results.filter(r => !r.ok && r.error.code === "conflict")).toHaveLength(1);
  expect((await f.store.load("conversation", "turn"))?.record.cancellation?.idempotencyKey).toBe("stop");
});

it("reauthorizes delivery after persistence and lets the next authorized context recover", async () => {
  const f = fixture(); await f.paused(); const w = f.worker("revoked", {
    onTurnStatusChanged: status => { if (status.status === "pending") f.deny(); },
  });
  expect(await f.cancel(w)).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(w.activeWorkerCount).toBe(0));
  expect(f.cancelTurn).not.toHaveBeenCalled(); expect(await f.cancel(w)).toMatchObject({ ok: false });
  f.allow(); const fresh = f.worker("fresh"); await fresh.recoverPending(); await f.status("cancelled"); await fresh.stopWorkers();
  expect(f.cancelTurn).toHaveBeenCalledOnce(); expect(f.startTurn).toHaveBeenCalledOnce();
});

it("a live lease excludes another cancellation worker; an expired claim cannot acknowledge for its successor", async () => {
  const f = fixture(); await f.paused(); const firstGate = gate();
  f.cancelTurn.mockImplementationOnce(async () => { await firstGate.promise; return { ok: true, value: { status: "cancellation_requested" } }; });
  const first = f.worker("first-stop"), second = f.worker("second-stop"); await f.cancel(first);
  await vi.waitFor(() => expect(f.cancelTurn).toHaveBeenCalledOnce());
  expect(await second.recoverTurn("conversation", "turn")).toMatchObject({ value: { status: "already_running" } });
  f.advance(2000); await second.recoverTurn("conversation", "turn"); await f.status("cancelled");
  const saved = await f.store.load("conversation", "turn"); firstGate.release(); await first.stopWorkers(); await second.stopWorkers();
  expect(await f.store.load("conversation", "turn")).toEqual(saved); expect(f.startTurn).toHaveBeenCalledOnce();
});

it("Stop during in-flight admission waits for the actual remote identity and never admits twice", async () => {
  const f = fixture(), admitted = gate(), release = gate(); const original = f.startTurn.getMockImplementation()!;
  f.startTurn.mockImplementation(async (...args) => { admitted.release(); await release.promise; return original(...args); });
  const w = f.worker("racing"); await w.startTurn(input); await admitted.promise; await f.cancel(w);
  expect(f.cancelTurn).not.toHaveBeenCalled(); expect((await f.store.load("conversation", "turn"))?.record.terminal).toBeNull();
  release.release(); await f.status("cancelled"); await w.stopWorkers();
  expect(f.cancelTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn.mock.calls[0]![0].turnId).toBe("remote-turn"); expect(f.startTurn).toHaveBeenCalledOnce();
});

it("does not fabricate a terminal or replay a start whose admission response was lost", async () => {
  const f = fixture(); f.startTurn.mockResolvedValue(failure); const w = f.worker("uncertain");
  // Hold a dispatched start so explicit Stop wins before the lost response.
  const held = gate(), entered = gate(); f.startTurn.mockImplementation(async () => { entered.release(); await held.promise; return failure; });
  await w.startTurn(input); await entered.promise; await f.cancel(w); held.release();
  await vi.waitFor(() => expect(w.activeWorkerCount).toBe(0));
  const restarted = f.worker("restart"); await restarted.recoverPending(); await restarted.stopWorkers();
  expect((await f.store.load("conversation", "turn"))?.record).toMatchObject({ status: "pending", terminal: null, delegateStartAttempted: true });
  expect(f.startTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn).not.toHaveBeenCalled();
});

it("preserves a completed result when Stop races the final observation", async () => {
  const f = fixture(); const original = f.startTurn.getMockImplementation()!;
  const entered = gate(), released = gate();
  f.startTurn.mockImplementation(async (...args) => { const r = await original(...args); if (!r.ok) return r;
    return { ...r, value: { ...r.value, observation: { ...r.value.observation,
      events: (async function* () { entered.release(); await released.promise; yield* []; })(),
      result: released.promise.then(() => ({ status: "completed" as const, checkpoint })) } } }; });
  const w = f.worker("complete"); await w.startTurn(input); await entered.promise; await f.cancel(w); released.release();
  await f.status("completed"); await w.stopWorkers();
  expect(await f.cancel(w)).toMatchObject({ ok: true, value: { status: "already_terminal" } });
  expect(f.startTurn).toHaveBeenCalledOnce();
});

it("Stop before start reserves cancellation without decoding, dispatch or delegate cancellation", async () => {
  const f = fixture(), w = f.worker("pre-start"); await w.cancelTurnBeforeStart(stop); await w.startTurn(input); await w.stopWorkers();
  await f.status("cancelled"); expect(f.startTurn).not.toHaveBeenCalled(); expect(f.cancelTurn).not.toHaveBeenCalled();
});

it("Stop wins an approval resumption suspended before delegate dispatch", async () => {
  const f = fixture(); await f.paused(); const entered = gate(), held = gate();
  const w = f.worker("approval", { requestCodec: { encode: r => r, fingerprint: r => r,
    decode: async r => { entered.release(); await held.promise; return r; } } });
  await w.resumeApprovalTurn("conversation", "turn"); await entered.promise; await f.cancel(w);
  await f.status("cancelled"); held.release(); await w.stopWorkers();
  expect(f.startTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn).toHaveBeenCalledOnce();
});

it("unsupported admitted cancellation remains pending, never substitutes disconnect for Stop", async () => {
  const f = fixture(); await f.paused();
  const w = f.worker("unsupported", { delegate: { ...f.delegate, capabilities: { ...f.delegate.capabilities,
    authoritativeCancellation: { supported: false } } } });
  await f.cancel(w); await vi.waitFor(() => expect(w.activeWorkerCount).toBe(0));
  expect((await f.store.load("conversation", "turn"))?.record).toMatchObject({ status: "pending", terminal: null, lease: null });
  expect(f.startTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn).not.toHaveBeenCalled();
});

it("retries an accepted Stop whose response was lost with the same identity", async () => {
  const f = fixture(); await f.paused(); let accepted = 0;
  f.cancelTurn.mockImplementationOnce(async () => { accepted++; throw Error('response lost after acceptance'); });
  const w = f.worker("lost-reply"); await f.cancel(w); await vi.waitFor(() => expect(w.activeWorkerCount).toBe(0));
  expect((await f.store.load("conversation", "turn"))?.record).toMatchObject({ status: "pending", terminal: null });
  f.cancelTurn.mockResolvedValue({ ok: true, value: { status: "already_terminal" } });
  const fresh = f.worker("retry"); await fresh.recoverPending(); await f.status("cancelled"); await fresh.stopWorkers();
  expect(accepted).toBe(1); expect(f.cancelTurn.mock.calls[0]).toEqual(f.cancelTurn.mock.calls[1]); expect(f.startTurn).toHaveBeenCalledOnce();
});

it("a failed observation does not strand the admitted delegate when a fresh context sends Stop", async () => {
  const f = fixture(), original = f.startTurn.getMockImplementation()!;
  f.startTurn.mockImplementation(async (...args) => {
    const started = await original(...args); if (!started.ok) return started;
    return { ...started, value: { ...started.value, observation: { ...started.value.observation,
      result: Promise.resolve({ status: 'disconnected' as const, checkpoint }) } } };
  });
  const first = f.worker("lost-observation"); await first.startTurn(input); await f.status("failed"); await first.stopWorkers();
  const fresh = f.worker("fresh-context"); await f.cancel(fresh); await f.status("cancelled"); await fresh.stopWorkers();
  expect(f.startTurn).toHaveBeenCalledOnce(); expect(f.cancelTurn).toHaveBeenCalledOnce();
  expect(f.cancelTurn.mock.calls[0]![0].turnId).toBe('remote-turn');
});
