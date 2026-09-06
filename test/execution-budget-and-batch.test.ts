import { afterEach, describe, expect, it, vi } from "vitest";
import { createActiveExecutionBudget } from "../src/tools/active-budget.js";
import { runIndependentReadBatch } from "../src/tools/read-batch.js";

afterEach(() => vi.useRealTimers());
describe("active execution budget", () => {
  it("bounds active work across steps but excludes approval waiting", async () => {
    vi.useFakeTimers();
    const budget = createActiveExecutionBudget(undefined, 100);
    try {
      await vi.advanceTimersByTimeAsync(60);
      await budget.withApprovalWait(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(budget.signal.aborted).toBe(false);
      });
      await vi.advanceTimersByTimeAsync(41);
      expect(budget.signal.reason).toMatchObject({ code: "ETIMEDOUT" });
    } finally { budget.dispose(); }
  });
  it("still cancels during an approval wait and releases timers", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const budget = createActiveExecutionBudget(parent.signal, 100);
    await budget.withApprovalWait(async () => { parent.abort("stop"); });
    expect(budget.signal.reason).toBe("stop");
    budget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("independent read batches", () => {
  it("authorizes every call before dispatch", async () => {
    const execute = vi.fn();
    await expect(runIndependentReadBatch({ calls: [{ name: "read", arguments: {} }, { name: "write", arguments: {} }],
      isReadAllowed: (name) => name === "read", execute, signal: new AbortController().signal })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it("bounds concurrency, preserves order and retains per-call failures", async () => {
    let running = 0, peak = 0;
    const results = await runIndependentReadBatch({ calls: Array.from({ length: 10 }, (_, i) => ({ name: `read_${i}`, arguments: {} })),
      isReadAllowed: () => true, signal: new AbortController().signal,
      async execute(call) { running++; peak = Math.max(peak, running); await Promise.resolve(); running--;
        if (call.name === "read_1") throw new Error("private upstream data"); return call.name; } });
    expect(peak).toBe(3);
    expect(results.map((result) => result.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results[1]).toMatchObject({ ok: false });
    expect(JSON.stringify(results)).not.toContain("private upstream data");
    expect(results[9]).toMatchObject({ ok: true, value: "read_9" });
  });
  it("does not dispatch later groups after cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(); return null; });
    await expect(runIndependentReadBatch({ calls: Array.from({ length: 6 }, () => ({ name: "read", arguments: {} })),
      isReadAllowed: () => true, execute, signal: controller.signal })).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
