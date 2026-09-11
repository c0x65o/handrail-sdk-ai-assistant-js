/** Stop observing a read/preparation callback when its execution is cancelled.
 * The callback still receives the signal and must release its own resources.
 * Both late fulfillment and rejection are observed without resuming dispatch. */
export function awaitWithSignal<T>(signal: AbortSignal, run: () => T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(
      value => { cleanup(); if (signal.aborted) abort(); else resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}
