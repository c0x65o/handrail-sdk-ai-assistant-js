import { afterEach, expect, it, vi } from "vitest";
import { ContextRecoveryScheduler } from "../src/server/context-recovery.js";

afterEach(() => vi.useRealTimers());
const next = { after: { conversationId: "first", turnId: "turn" }, through: { conversationId: "last", turnId: "turn" } };
const end = { started: [], cursor: null };
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { release, promise }; }

it("yields between pages, uses refreshed authorization, and releases expired credentials", async () => {
  vi.useFakeTimers();
  const scheduler = new ContextRecoveryScheduler({ concurrency: 1, capacity: 2, lifetimeMs: 100, retryMs: 20, onError: vi.fn() });
  const held = gate(), order: string[] = [];
  const stale = vi.fn(async () => { order.push("a-first"); await held.promise; return { started: [], cursor: next }; });
  const fresh = vi.fn(async cursor => { expect(cursor).toEqual(next); order.push("a-fresh"); return null; });
  const other = vi.fn(async () => { order.push("b"); return end; });
  scheduler.enqueue("a", stale); scheduler.enqueue("b", other);
  expect(scheduler.enqueue("overflow", other)).toBe(false);
  await Promise.resolve(); expect(stale).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  scheduler.enqueue("a", fresh); held.release();
  await vi.advanceTimersByTimeAsync(5);
  expect(order).toEqual(["a-first", "b", "a-fresh"]);
  expect(stale).toHaveBeenCalledOnce(); expect(fresh).toHaveBeenCalledWith(next, expect.any(AbortSignal), 25);
  await vi.advanceTimersByTimeAsync(110);
  const calls = other.mock.calls.length;
  await vi.advanceTimersByTimeAsync(200); expect(other).toHaveBeenCalledTimes(calls);
  expect(scheduler.enqueue("new", other)).toBe(true);
  await scheduler.stop();
});

it("bounds discovery concurrency and stops before held authorization can claim", async () => {
  vi.useFakeTimers();
  const held = gate(), claim = vi.fn(), onError = vi.fn();
  const scheduler = new ContextRecoveryScheduler({ onError });
  const step = vi.fn(async (_cursor, signal: AbortSignal) => { await held.promise; signal.throwIfAborted(); claim(); return end; });
  for (let i = 0; i < 30; i++) scheduler.enqueue(`tenant-${i}`, step);
  await vi.advanceTimersByTimeAsync(0); expect(step).toHaveBeenCalledTimes(2);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  expect(scheduler.enqueue("later", step)).toBe(false);
  held.release(); await stopping;
  await vi.runAllTimersAsync(); expect(claim).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
});

it("retries a capacity-deferred page without advancing its cursor or spinning", async () => {
  vi.useFakeTimers();
  const scheduler = new ContextRecoveryScheduler({ lifetimeMs: 5_000, onError: vi.fn() });
  const step = vi.fn().mockResolvedValueOnce({ started: [], cursor: next })
    .mockResolvedValueOnce({ started: [], cursor: next, deferred: true }).mockResolvedValue(null);
  scheduler.enqueue("scope", step);
  await vi.advanceTimersByTimeAsync(5);
  expect(step).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(900); expect(step).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100); expect(step).toHaveBeenCalledTimes(3);
  expect(step.mock.calls[2]?.[0]).toEqual(next);
  await scheduler.stop();
});

it("expires held credentials before a delayed authorizer can dispatch", async () => {
  vi.useFakeTimers();
  const held = gate(), dispatch = vi.fn();
  const scheduler = new ContextRecoveryScheduler({ lifetimeMs: 100, onError: vi.fn() });
  scheduler.enqueue("expired", async (_cursor, signal) => {
    await held.promise; signal.throwIfAborted(); dispatch(); return end;
  });
  await vi.advanceTimersByTimeAsync(101); held.release();
  await vi.advanceTimersByTimeAsync(1);
  expect(dispatch).not.toHaveBeenCalled(); await scheduler.stop();
});

it("does not discard refreshed credentials when an older held authorization is denied", async () => {
  vi.useFakeTimers();
  const held = gate(), scheduler = new ContextRecoveryScheduler({ onError: vi.fn() });
  scheduler.enqueue("same-session", async () => { await held.promise; return null; });
  await vi.advanceTimersByTimeAsync(0);
  const fresh = vi.fn(async () => end);
  scheduler.enqueue("same-session", fresh); held.release();
  await vi.advanceTimersByTimeAsync(5);
  expect(fresh).toHaveBeenCalledOnce();
  await scheduler.stop();
});

it("serializes explicit drains, bounds total starts, and keeps them out of periodic discovery", async () => {
  vi.useFakeTimers();
  const scheduler = new ContextRecoveryScheduler({ onError: vi.fn() });
  const held = gate(); let active = 0, maximum = 0;
  const step = vi.fn(async () => { active++; maximum = Math.max(maximum, active); await held.promise; active--; return { started: ["turn"], cursor: null }; });
  scheduler.enqueue("a", step); scheduler.enqueue("b", step);
  const first = scheduler.recoverNow(1), second = scheduler.recoverNow(2);
  await vi.advanceTimersByTimeAsync(0); expect(step).toHaveBeenCalledTimes(1);
  held.release(); expect(await first).toBe(1); expect(await second).toBe(2);
  expect(maximum).toBe(1); expect(step).toHaveBeenCalledTimes(3);
  await scheduler.stop();
});
