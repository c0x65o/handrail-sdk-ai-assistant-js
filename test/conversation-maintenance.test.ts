import { afterEach, expect, it, vi } from "vitest";
import { ConversationMaintenanceQueue } from "../src/server/conversation-maintenance.js";

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("defers work beyond the response microtasks, coalesces wake-ups and bounds concurrency and capacity", async () => {
  vi.useFakeTimers();
  const gate = deferred(), onError = vi.fn();
  const queue = new ConversationMaintenanceQueue({ concurrency: 1, capacity: 2, onError });
  const stale = vi.fn(), first = vi.fn(() => gate.promise), second = vi.fn(async () => {});
  expect(queue.enqueue("account-a/chat", stale)).toBe(true);
  expect(queue.enqueue("account-a/chat", first)).toBe(true);
  expect(queue.enqueue("account-b/chat", second)).toBe(true);
  expect(queue.enqueue("overflow", second)).toBe(false);
  await Promise.resolve();
  expect(first).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(stale).not.toHaveBeenCalled();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
  const followUp = vi.fn(async () => {});
  queue.enqueue("account-a/chat", followUp);
  queue.enqueue("account-a/chat", followUp);
  gate.resolve();
  await vi.runAllTimersAsync();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(followUp).toHaveBeenCalledTimes(1);
  expect(stale).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  await queue.stop();
});

it("contains failures and retries a durable wake-up on a later read", async () => {
  vi.useFakeTimers();
  const onError = vi.fn(), queue = new ConversationMaintenanceQueue({ onError });
  const work = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
  queue.enqueue("scope/chat", work);
  await vi.runAllTimersAsync();
  expect(onError).toHaveBeenCalledTimes(1);
  queue.enqueue("scope/chat", work);
  await vi.runAllTimersAsync();
  expect(work).toHaveBeenCalledTimes(2);
  await queue.stop();
});

it("shutdown discards queued credentials, drains running work, and rejects subsequent scheduling", async () => {
  vi.useFakeTimers();
  const gate = deferred(), queued = vi.fn(async () => {});
  const queue = new ConversationMaintenanceQueue({ concurrency: 1, onError: vi.fn() });
  queue.enqueue("running", () => gate.promise);
  queue.enqueue("queued", queued);
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stop = queue.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(queue.enqueue("late", queued)).toBe(false);
  gate.resolve();
  await stop;
  await vi.runAllTimersAsync();
  expect(queued).not.toHaveBeenCalled();
});
