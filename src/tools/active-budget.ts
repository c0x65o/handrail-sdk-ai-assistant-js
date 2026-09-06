/** Shared active execution deadline. Only a separately bounded approval wait may pause it. */
export function createActiveExecutionBudget(parentSignal: AbortSignal | undefined, milliseconds: number) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 2_147_483_647) {
    throw new RangeError("Execution budget must be a positive timer-safe integer");
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) abortFromParent();
  let remaining = milliseconds, startedAt = Date.now(), pauses = 0, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = () => controller.abort(Object.assign(new Error("The active execution budget was exhausted"), {
    code: "ETIMEDOUT", name: "TimeoutError",
  }));
  const arm = () => {
    if (disposed || controller.signal.aborted) return;
    startedAt = Date.now();
    if (remaining <= 0) expire();
    else timer = setTimeout(expire, remaining);
  };
  arm();
  return {
    signal: controller.signal,
    async withApprovalWait<T>(wait: () => Promise<T>): Promise<T> {
      controller.signal.throwIfAborted();
      if (pauses === 0) {
        clearTimeout(timer);
        remaining -= Date.now() - startedAt;
        if (remaining <= 0) { expire(); controller.signal.throwIfAborted(); }
      }
      pauses++;
      try { return await wait(); }
      finally { pauses--; if (pauses === 0) arm(); }
    },
    dispose() { disposed = true; clearTimeout(timer); parentSignal?.removeEventListener("abort", abortFromParent); },
  };
}
