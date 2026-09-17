import type { DurableApplicationRecoveryCursor } from "../transports/durable.js";

export interface ContextRecoveryPage {
  readonly started: readonly unknown[];
  readonly cursor: DurableApplicationRecoveryCursor | null;
  /** No execution slot: retry this same page after yielding. */
  readonly deferred?: true;
}
type RecoveryStep = (cursor: DurableApplicationRecoveryCursor | undefined, signal: AbortSignal,
  limit: number) => Promise<ContextRecoveryPage | null>;
type Entry = { step: RecoveryStep; expiresAt: number; due: number;
  cursor: DurableApplicationRecoveryCursor | undefined; running: Promise<void> | undefined };

/** Bounded, short-lived authorization wake-ups. Durable records, not this queue,
 * retain work across process restarts. Every page invokes the latest resolver. */
export class ContextRecoveryScheduler {
  readonly #entries = new Map<string, Entry>();
  readonly #closed = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active = 0;
  #manual = 0;
  #manualTail: Promise<unknown> = Promise.resolve();
  readonly #concurrency: number;
  readonly #capacity: number;
  readonly #lifetime: number;
  readonly #retry: number;
  readonly #pageSize: number;
  constructor(readonly options: {
    concurrency?: number; capacity?: number; lifetimeMs?: number; retryMs?: number; pageSize?: number;
    onError: (cause: unknown) => void;
  }) {
    this.#concurrency = options.concurrency ?? 2; this.#capacity = options.capacity ?? 128;
    this.#lifetime = options.lifetimeMs ?? 60_000; this.#retry = options.retryMs ?? 15_000;
    this.#pageSize = options.pageSize ?? 25;
    for (const value of [this.#concurrency, this.#capacity, this.#lifetime, this.#retry, this.#pageSize]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Recovery scheduler limits must be positive integers");
    }
  }
  enqueue(key: string, step: RecoveryStep): boolean {
    if (this.#closed.signal.aborted) return false;
    const now = Date.now();
    for (const [id, item] of this.#entries) if (!item.running && item.expiresAt <= now) this.#entries.delete(id);
    const entry = this.#entries.get(key);
    if (entry) {
      // Keep the scan position and throttle, while replacing retained credentials.
      entry.step = step; entry.expiresAt = now + this.#lifetime;
    } else {
      if (this.#entries.size >= this.#capacity) return false;
      this.#entries.set(key, { step, expiresAt: now + this.#lifetime, due: now, cursor: undefined, running: undefined });
    }
    this.#schedule(); return true;
  }
  #schedule() {
    if (this.#closed.signal.aborted || this.#manual > 0 || this.#active >= this.#concurrency) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let due = Infinity;
    for (const entry of this.#entries.values()) if (!entry.running) due = Math.min(due, entry.due, entry.expiresAt);
    if (!Number.isFinite(due)) return;
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#pump(); }, Math.max(0, due - Date.now()));
    this.#timer.unref?.();
  }
  #pump() {
    if (this.#closed.signal.aborted || this.#manual > 0) return;
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.running) continue;
      if (entry.expiresAt <= now) { this.#entries.delete(key); continue; }
      if (entry.due > now || this.#active >= this.#concurrency) continue;
      this.#active++;
      entry.running = this.#run(key, entry).finally(() => {
        entry.running = undefined; this.#active--;
        // Put continuations behind other authenticated scopes.
        if (this.#entries.get(key) === entry) { this.#entries.delete(key); this.#entries.set(key, entry); }
        this.#schedule();
      });
    }
    this.#schedule();
  }
  async #run(key: string, entry: Entry) {
    const step = entry.step;
    try {
      const page = await this.#step(entry, entry.cursor, this.#pageSize, step);
      if (!page) {
        if (step === entry.step) this.#entries.delete(key);
        else { entry.cursor = undefined; entry.due = Date.now(); }
        return;
      }
      if (!page.deferred) entry.cursor = page.cursor ?? undefined;
      entry.due = Date.now() + (page.deferred ? 1_000 : page.cursor ? 0 : this.#retry);
    } catch (cause) {
      entry.due = Date.now() + (step === entry.step ? this.#retry : 0);
      if (!this.#closed.signal.aborted) { try { this.options.onError(cause); } catch { /* diagnostic only */ } }
    }
  }
  async #step(entry: Entry, cursor: DurableApplicationRecoveryCursor | undefined, limit: number, step = entry.step) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.#closed.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, entry.expiresAt - Date.now()));
    timer.unref?.();
    try {
      if (this.#closed.signal.aborted || entry.expiresAt <= Date.now()) controller.abort();
      controller.signal.throwIfAborted();
      return await step(cursor, controller.signal, limit);
    } finally { clearTimeout(timer); this.#closed.signal.removeEventListener("abort", abort); }
  }
  /** Explicit host drain: fresh authorization for each page, globally bounded
   * starts, no waiting for provider completion. Periodic discovery yields to it. */
  recoverNow(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("Recovery limit is invalid");
    this.#manual++;
    const operation = this.#manualTail.then(() => this.#recoverNow(limit)).finally(() => {
      this.#manual--; this.#schedule();
    });
    this.#manualTail = operation.catch(() => {});
    return operation;
  }
  async #recoverNow(limit: number): Promise<number> {
    await Promise.all([...this.#entries.values()].flatMap(entry => entry.running ? [entry.running] : []));
    let started = 0;
    for (const [key, entry] of [...this.#entries]) {
      if (this.#closed.signal.aborted || started >= limit) break;
      if (entry.expiresAt <= Date.now()) continue;
      await entry.running;
      if (this.#closed.signal.aborted || this.#entries.get(key) !== entry) continue;
      let resolve!: () => void;
      entry.running = new Promise<void>(done => { resolve = done; }); this.#active++;
      try {
        let cursor: DurableApplicationRecoveryCursor | undefined;
        let replaced = false;
        do {
          const step = entry.step;
          const page = await this.#step(entry, cursor, Math.min(this.#pageSize, limit - started), step);
          if (!page) {
            replaced = step !== entry.step;
            if (!replaced) this.#entries.delete(key);
            break;
          }
          started += page.started.length;
          if (page.deferred) break;
          cursor = page.cursor ?? undefined;
        } while (cursor && started < limit && !this.#closed.signal.aborted && entry.expiresAt > Date.now());
        entry.cursor = undefined; entry.due = Date.now() + (replaced ? 0 : this.#retry);
      } finally { entry.running = undefined; this.#active--; resolve(); this.#schedule(); }
    }
    return started;
  }
  /** Abort discovery, release queued credentials and join in-flight store/auth calls. */
  async stop(): Promise<void> {
    this.#closed.abort();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const running = [...this.#entries.values()].flatMap(entry => entry.running ? [entry.running] : []);
    this.#entries.clear(); await Promise.all([...running, this.#manualTail]);
  }
}
