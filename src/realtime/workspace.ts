export type RealtimeWorkspaceCallStatus = "admitted" | "starting" | "active" | "ending" | "ended" | "uncertain";
export interface RealtimeWorkspaceCursor { readonly conversationId: string; readonly callId: string }
export interface RealtimeWorkspaceCounts { readonly total: number; readonly running: number; readonly waitingForApproval?: number; readonly completed: number; readonly failed: number }
export interface RealtimeWorkspaceCall extends RealtimeWorkspaceCursor {
  readonly status: RealtimeWorkspaceCallStatus; readonly counts: RealtimeWorkspaceCounts; readonly unread: boolean;
}
export interface RealtimeWorkspacePage { readonly calls: readonly RealtimeWorkspaceCall[]; readonly next: RealtimeWorkspaceCursor | null }
export interface RealtimeWorkspaceSnapshot {
  readonly calls: readonly RealtimeWorkspaceCall[]; readonly loading: boolean; readonly synchronized: boolean; readonly error: string | null;
}
export interface RealtimeWorkspaceMonitorOptions {
  readonly readPage: (input: { readonly conversationIds: readonly string[]; readonly after?: RealtimeWorkspaceCursor; readonly signal: AbortSignal }) => Promise<unknown>;
  /** Optional authorized catalog discovery. Without it, use setConversations(). */
  readonly loadConversationIds?: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly intervalMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly maxPages?: number;
}
const statuses: readonly RealtimeWorkspaceCallStatus[] = ["admitted", "starting", "active", "uncertain", "ending", "ended"];
const key = (value: RealtimeWorkspaceCursor) => JSON.stringify([value.conversationId, value.callId]);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid voice workspace record.");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 512) throw new TypeError("Invalid voice workspace identity.");
  return value;
}
function cursor(value: unknown): RealtimeWorkspaceCursor {
  const data = object(value);
  return Object.freeze({ conversationId: identity(data.conversationId), callId: identity(data.callId) });
}
function conversationIds(input: readonly string[]): readonly string[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new TypeError("Invalid voice workspace conversation scope.");
  return Object.freeze([...new Set(input.map(identity))].sort());
}
export function parseRealtimeWorkspacePage(input: unknown): RealtimeWorkspacePage {
  const page = object(input);
  if (!Array.isArray(page.calls) || page.calls.length > 50 || !("next" in page)) throw new TypeError("Invalid voice workspace page.");
  const calls = page.calls.map((input) => {
    const value = object(input), raw = object(value.counts);
    if (!statuses.includes(value.status as RealtimeWorkspaceCallStatus) || typeof value.unread !== "boolean" ||
      value.unread && value.status !== "ended") throw new TypeError("Invalid voice workspace lifecycle.");
    for (const name of ["total", "running", "completed", "failed"]) {
      if (!Number.isSafeInteger(raw[name]) || (raw[name] as number) < 0) throw new TypeError("Invalid voice workspace counts.");
    }
    const waiting = raw.waitingForApproval ?? 0;
    if (!Number.isSafeInteger(waiting) || (waiting as number) < 0) throw new TypeError("Invalid voice approval counts.");
    const counts = Object.freeze({ ...(waiting === 0 ? {} : { waitingForApproval: waiting as number }), total: raw.total as number, running: raw.running as number, completed: raw.completed as number, failed: raw.failed as number });
    if (counts.total !== counts.running + counts.completed + counts.failed + (waiting as number)) throw new TypeError("Invalid voice workspace counts.");
    return Object.freeze({ ...cursor(value), status: value.status as RealtimeWorkspaceCallStatus, counts, unread: value.unread });
  });
  return Object.freeze({ calls: Object.freeze(calls), next: page.next === null ? null : cursor(page.next) });
}
export const EMPTY_REALTIME_WORKSPACE: RealtimeWorkspaceSnapshot = Object.freeze({ calls: Object.freeze([]), loading: false, synchronized: false, error: null });
export function summarizeRealtimeWorkspace(snapshot: RealtimeWorkspaceSnapshot, conversationId?: string) {
  let activeCalls = 0, unconfirmedCalls = 0, unreadCalls = 0, unresolvedTools = 0;
  for (const call of snapshot.calls) {
    if (conversationId !== undefined && call.conversationId !== conversationId) continue;
    const active = ["admitted", "starting", "active"].includes(call.status);
    if (active) activeCalls++;
    if (["uncertain", "ending"].includes(call.status)) unconfirmedCalls++;
    if (call.unread) unreadCalls++;
    if (!active) unresolvedTools += call.counts.running;
  }
  return Object.freeze({ activeCalls, unconfirmedCalls, unreadCalls, unresolvedTools });
}
export type RealtimeWorkspaceSummary = ReturnType<typeof summarizeRealtimeWorkspace>;

/** Server voice observation, independent of text state and read acknowledgements. */
export class RealtimeWorkspaceMonitor {
  readonly #options: RealtimeWorkspaceMonitorOptions;
  readonly #interval: number;
  readonly #timeout: number;
  readonly #maxPages: number;
  readonly #listeners = new Set<() => void>();
  #snapshot = EMPTY_REALTIME_WORKSPACE;
  #ids: readonly string[] = Object.freeze([]);
  #reading: Promise<void> | null = null;
  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #generation = 0;
  #disposed = false;
  constructor(options: RealtimeWorkspaceMonitorOptions) {
    this.#options = { ...options };
    this.#interval = options.intervalMilliseconds ?? 3000;
    this.#timeout = options.requestTimeoutMilliseconds ?? 15000;
    this.#maxPages = options.maxPages ?? 100;
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 250 || !Number.isSafeInteger(this.#timeout) || this.#timeout < 50 ||
      !Number.isSafeInteger(this.#maxPages) || this.#maxPages < 1 || this.#maxPages > 1000) throw new TypeError("Invalid voice workspace limits.");
  }
  get usesConversationLoader(): boolean { return this.#options.loadConversationIds !== undefined; }
  getSnapshot = (): RealtimeWorkspaceSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #emit(snapshot: RealtimeWorkspaceSnapshot) {
    if (this.#disposed) return;
    this.#snapshot = Object.freeze({ ...snapshot, calls: Object.freeze([...snapshot.calls]) });
    for (const listener of this.#listeners) listener();
  }
  async setConversations(input: readonly string[]): Promise<void> {
    if (this.#disposed) return;
    if (this.usesConversationLoader) throw new TypeError("This voice workspace uses an authorized catalog loader.");
    const ids = conversationIds(input);
    if (JSON.stringify(ids) === JSON.stringify(this.#ids)) return this.refresh();
    this.#generation++; this.#abort?.abort(); this.#ids = ids;
    this.#emit({ calls: this.#snapshot.calls.filter((call) => ids.includes(call.conversationId)), loading: false, synchronized: ids.length === 0, error: null });
    await this.#reading;
    if (!this.#disposed) await this.refresh();
  }
  start(): void {
    if (this.#disposed || this.#timer !== null) return;
    void this.refresh(); this.#timer = setInterval(() => { void this.refresh(); }, this.#interval);
  }
  async #request<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error("Voice workspace read cancelled or timed out."));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) rejectAbort();
      });
      timer = setTimeout(abort, this.#timeout);
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("Voice workspace read cancelled.");
        return operation(controller.signal);
      }), cancelled]);
    } finally {
      clearTimeout(timer); parent.removeEventListener("abort", abort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  }
  refresh = (): Promise<void> => {
    if (this.#disposed) return Promise.resolve();
    if (this.#reading) return this.#reading;
    const generation = this.#generation, controller = new AbortController(); this.#abort = controller;
    this.#reading = Promise.resolve().then(async () => {
      if (this.#disposed || generation !== this.#generation) return;
      let before = this.#snapshot;
      this.#emit({ ...before, loading: true });
      try {
        const ids = this.#options.loadConversationIds
          ? conversationIds(await this.#request(this.#options.loadConversationIds, controller.signal)) : this.#ids;
        if (this.#disposed || generation !== this.#generation) return;
        before = { ...before, calls: before.calls.filter((call) => ids.includes(call.conversationId)) };
        this.#emit({ ...before, loading: true });
        const calls = new Map<string, RealtimeWorkspaceCall>(); let pages = 0;
        for (let offset = 0; offset < ids.length; offset += 100) {
          const chunk = Object.freeze(ids.slice(offset, offset + 100));
          let after: RealtimeWorkspaceCursor | null = null; const cursors = new Set<string>();
          do {
            if (++pages > this.#maxPages) throw new TypeError("Voice workspace page limit reached.");
            const page = parseRealtimeWorkspacePage(await this.#request((signal) => this.#options.readPage({ conversationIds: chunk,
              ...(after ? { after } : {}), signal }), controller.signal));
            if (this.#disposed || generation !== this.#generation) return;
            for (const call of page.calls) {
              if (!chunk.includes(call.conversationId) || calls.has(key(call))) throw new TypeError("Foreign or duplicate voice call.");
              calls.set(key(call), call);
            }
            after = page.next;
            if (after && (!page.calls.length || key(after) !== key(page.calls.at(-1)!) || cursors.has(key(after)))) throw new TypeError("Voice workspace cursor did not advance.");
            if (after) cursors.add(key(after));
          } while (after);
        }
        for (const old of before.calls) {
          const next = calls.get(key(old));
          if (!next || next.counts.total < old.counts.total || next.counts.completed < old.counts.completed || next.counts.failed < old.counts.failed ||
            statuses.indexOf(next.status) < statuses.indexOf(old.status)) throw new TypeError("Voice workspace evidence regressed.");
        }
        this.#emit({ calls: [...calls.values()], loading: false, synchronized: true, error: null });
      } catch {
        if (!this.#disposed && generation === this.#generation) this.#emit({ ...before, loading: false, error: "Could not refresh voice activity. Retrying…" });
      }
    }).finally(() => { this.#reading = null; if (this.#abort === controller) this.#abort = null; });
    return this.#reading;
  };
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#generation++; this.#abort?.abort();
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#listeners.clear();
  }
}
