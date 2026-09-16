/** Bounded, coalescing wake-ups for work whose source of truth is durable storage.
 * This queue owns no durable intent: a dropped wake-up is retried by the next
 * authorized read; durable turn workers remain a separate recovery path.
 * Never put a new user action here.
 */
export class ConversationMaintenanceQueue {
  readonly #pending = new Map<string, () => Promise<void>>();
  readonly #running = new Map<string, Promise<void>>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(readonly options: {
    readonly concurrency?: number;
    readonly capacity?: number;
    readonly onError: (error: unknown) => void;
  }) {
    for (const value of [options.concurrency ?? 2, options.capacity ?? 128]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Maintenance limits must be positive integers");
    }
  }

  enqueue(key: string, work: () => Promise<void>): boolean {
    if (this.#stopped) return false;
    if (!this.#pending.has(key) && this.#pending.size >= (this.options.capacity ?? 128)) return false;
    // Prefer the freshest authenticated request while this wake-up is queued.
    this.#pending.set(key, work);
    this.#schedule();
    return true;
  }

  #schedule() {
    if (this.#stopped || this.#timer !== undefined || this.#pending.size === 0 ||
      this.#running.size >= (this.options.concurrency ?? 2)) return;
    // A task boundary, not a microtask: the HTTP handler can return its small
    // metadata response before any history hydration begins.
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      while (!this.#stopped && this.#running.size < (this.options.concurrency ?? 2)) {
        // A wake-up arriving during a run gets one trailing pass. It must not
        // execute concurrently with the same key or lose a newly saved decision.
        const next = [...this.#pending.entries()].find(([key]) => !this.#running.has(key));
        if (!next) break;
        const [key, work] = next;
        this.#pending.delete(key);
        const running = Promise.resolve().then(work).catch(error => {
          try { this.options.onError(error); } catch { /* Diagnostics must not crash maintenance. */ }
        }).finally(() => {
          this.#running.delete(key);
          this.#schedule();
        });
        this.#running.set(key, running);
      }
    }, 0);
    this.#timer.unref?.();
  }

  /** Stop accepting wake-ups, release queued credentials and drain active work. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#pending.clear();
    await Promise.all(this.#running.values());
  }
}
