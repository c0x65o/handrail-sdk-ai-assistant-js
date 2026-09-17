/** Server-owned recovery identities. Keys and cursors are opaque metadata, not
 * user credentials. Resolve must consult current access on every call. */
export interface AssistantRecoveryContextSource<TContext> {
  page(input: { readonly cursor: string | null; readonly limit: number; readonly signal: AbortSignal }):
    Promise<{ readonly keys: readonly string[]; readonly cursor: string | null }>;
  resolve(key: string, signal: AbortSignal): Promise<TContext | null>;
}

/** One bounded source page per tick, retaining only its cursor. Backpressure
 * retries that page instead of silently skipping identities when the work queue
 * fills. Restart begins a fresh scan; durable turns/decisions retain the work. */
export class RecoveryContextSourceScanner<TContext> {
  #cursor: string | null = null;
  #running: Promise<void> | undefined;
  readonly #closed = new AbortController();
  constructor(readonly source: AssistantRecoveryContextSource<TContext>, readonly accept: (
    context: TContext, resolve: (signal: AbortSignal) => Promise<TContext | null>,
  ) => boolean) {}

  scan(): Promise<void> {
    if (this.#closed.signal.aborted) return Promise.resolve();
    return this.#running ??= this.#scan().finally(() => { this.#running = undefined; });
  }
  async #scan() {
    const { signal } = this.#closed, limit = 32;
    const page = await this.source.page({ cursor: this.#cursor, limit, signal });
    signal.throwIfAborted();
    if (page.keys.length > limit || new Set(page.keys).size !== page.keys.length ||
      page.keys.some(key => typeof key !== "string" || !key.length || key.length > 1024) ||
      page.cursor !== null && (typeof page.cursor !== "string" || !page.cursor.length ||
        page.cursor.length > 4096 || page.cursor === this.#cursor)) {
      throw new TypeError("Recovery context source returned an invalid page");
    }
    for (const key of page.keys) {
      const resolve = (currentSignal: AbortSignal) => this.source.resolve(key, currentSignal);
      const context = await resolve(signal);
      signal.throwIfAborted();
      if (context && !this.accept(context, resolve)) return;
    }
    this.#cursor = page.cursor;
  }
  async stop(): Promise<void> {
    this.#closed.abort();
    await this.#running?.catch(() => {});
  }
}
