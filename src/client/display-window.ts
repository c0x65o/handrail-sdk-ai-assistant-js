import { CONVERSATION_DISPLAY_LIMITS, type ConversationDisplayChanges, type ConversationDisplayChangesInput,
  type ConversationDisplayPage, type ConversationDisplayPageInput, type ConversationDisplayRecord } from "../conversation/display-history.js";

export interface ConversationDisplayReader {
  page(input: ConversationDisplayPageInput, signal?: AbortSignal): Promise<ConversationDisplayPage>;
  changes(input: ConversationDisplayChangesInput, signal?: AbortSignal): Promise<ConversationDisplayChanges>;
}
export type DisplayWindowOperation = "initial" | "older" | "newer" | "latest" | "changes";
export interface ConversationDisplayWindowSnapshot {
  readonly conversationId: string | null;
  readonly status: "empty" | "loading" | "preparing" | "ready" | "error";
  readonly generation: number;
  readonly revision: number;
  readonly activeTurnId: string | null;
  readonly records: readonly ConversationDisplayRecord[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly loading: DisplayWindowOperation | null;
  readonly error: { readonly operation: DisplayWindowOperation; readonly cause: unknown } | null;
  /** Increases only for a visible record replacement, allowing scroll anchoring. */
  readonly version: number;
  readonly change: DisplayWindowOperation;
  readonly retainedBytes: number;
}
export interface ConversationDisplayWindowOptions {
  readonly reader: ConversationDisplayReader;
  /** Validated, current-generation changes for a separate bounded activity view. */
  readonly onChanges?: (page: ConversationDisplayChanges) => void;
  readonly pageSize?: number;
  readonly pageBytes?: number;
  readonly maximumMessages?: number;
  readonly maximumBytes?: number;
}
const initial = (): ConversationDisplayWindowSnapshot => Object.freeze({ conversationId: null, status: "empty",
  generation: 0, revision: 0, activeTurnId: null, records: Object.freeze([]), hasOlder: false, hasNewer: false,
  loading: null, error: null, version: 0, change: "initial", retainedBytes: 0 });
const encoder = new TextEncoder();
const recordBytes = (record: ConversationDisplayRecord) => encoder.encode(JSON.stringify(record)).byteLength;

/** A presentation-only, account-owned window. Never a canonical store/checkpoint.
 * One selected thread, one in-flight read, bounded records and bytes, no transcript
 * persistence. Create a new instance for each authenticated account and dispose
 * it on logout. UI state stores may persist anchors independently of content. */
export class ConversationDisplayWindow {
  readonly pageSize: number;
  readonly pageBytes: number;
  readonly maximumMessages: number;
  readonly maximumBytes: number;
  private state = initial();
  private readonly listeners = new Set<() => void>();
  private selection = new AbortController();
  private pending: Promise<void> | null = null;
  private disposed = false;
  private changesCursor: string | null = null;
  private changesAfter = 0;
  private initialAnchor: ConversationDisplayPageInput["anchor"];

  constructor(private readonly options: ConversationDisplayWindowOptions) {
    this.pageSize = options.pageSize ?? CONVERSATION_DISPLAY_LIMITS.defaultPageSize;
    this.pageBytes = options.pageBytes ?? CONVERSATION_DISPLAY_LIMITS.defaultPageBytes;
    this.maximumMessages = options.maximumMessages ?? 90;
    this.maximumBytes = options.maximumBytes ?? 256 * 1024;
    if (![this.pageSize, this.pageBytes, this.maximumMessages, this.maximumBytes].every(Number.isSafeInteger) ||
      this.pageSize < 1 || this.pageSize > 50 || this.pageBytes < 8192 || this.pageBytes > 262144 ||
      this.maximumMessages < this.pageSize * 2 || this.maximumMessages > 1000 ||
      this.maximumBytes < this.pageBytes * 2 || this.maximumBytes > 8 * 1024 * 1024) {
      throw new TypeError("Invalid display window bounds");
    }
  }
  getSnapshot = (): ConversationDisplayWindowSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error("Display window is disposed");
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<ConversationDisplayWindowSnapshot>) {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private current(signal: AbortSignal) { return !this.disposed && this.selection.signal === signal && !signal.aborted; }

  select(conversationId: string | null, anchor?: ConversationDisplayPageInput["anchor"]): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Display window is disposed"));
    if (conversationId !== null && (!conversationId || conversationId.length > 512)) return Promise.reject(new TypeError("Invalid conversation"));
    this.selection.abort(); this.selection = new AbortController(); this.pending = null;
    this.changesCursor = null; this.changesAfter = 0; this.initialAnchor = anchor;
    this.state = { ...initial(), version: this.state.version + 1 };
    this.publish({ conversationId, status: conversationId ? "loading" : "empty" });
    return conversationId === null ? Promise.resolve() : this.read("initial");
  }
  loadOlder = (): Promise<void> => this.state.hasOlder ? this.read("older") : Promise.resolve();
  loadNewer = (): Promise<void> => this.state.hasNewer ? this.read("newer") : Promise.resolve();
  jumpToLatest = (): Promise<void> => this.read("latest");
  refresh = (): Promise<void> => this.read(this.state.status === "ready" ? "changes" : "initial");
  retry = (): Promise<void> => this.read(this.state.error?.operation ?? (this.state.status === "ready" ? "changes" : "initial"));

  private read(operation: DisplayWindowOperation): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Display window is disposed"));
    if (this.pending) return this.pending;
    const conversationId = this.state.conversationId;
    if (!conversationId) return Promise.resolve();
    const signal = this.selection.signal;
    // Assign pending before publishing: subscribers may synchronously request reads.
    const work = Promise.resolve().then(async () => {
      if (!this.current(signal)) return;
      this.publish({ loading: operation, error: null });
      try {
        if (operation === "changes") {
          const page = await this.options.reader.changes({ conversationId, generation: this.state.generation,
            afterRevision: this.changesAfter, ...(this.changesCursor ? { cursor: this.changesCursor } : {}),
            limit: this.pageSize, maximumBytes: this.pageBytes }, signal);
          if (!this.current(signal)) return;
          if (page.status === "preparing") { this.preparing(); return; }
          this.assertPage(page, conversationId, this.state.generation);
          if (page.nextCursor !== null && page.nextCursor === this.changesCursor) throw new Error("Display changes cursor did not advance");
          const byId = new Map(page.records.filter(record => record.kind === "message").map(record => [record.id, record]));
          const ids = new Set(this.state.records.map(record => record.id));
          const records = this.state.records.map(record => {
            const next = byId.get(record.id);
            return next && next.revision >= record.revision ? next : record;
          }).filter(record => !record.deleted);
          const changed = records.length !== this.state.records.length || records.some((record, index) => record !== this.state.records[index]);
          const outside = [...byId.values()].some(record => !record.deleted && !ids.has(record.id));
          const trimmed = this.trim(records, "older");
          this.options.onChanges?.(page);
          this.changesCursor = page.nextCursor;
          if (page.nextCursor === null) this.changesAfter = page.throughRevision;
          this.publish({ records: trimmed.records, retainedBytes: trimmed.bytes, revision: page.revision,
            activeTurnId: page.activeTurnId, hasNewer: this.state.hasNewer || outside || trimmed.trimmed,
            version: this.state.version + (changed || trimmed.trimmed ? 1 : 0), change: "changes" });
        } else {
          const edge = operation === "older" ? this.state.records[0] : this.state.records.at(-1);
          const anchor = operation === "initial" ? this.initialAnchor :
            operation === "older" || operation === "newer" ? edge && { messageId: edge.id,
              generation: this.state.generation, direction: operation } : undefined;
          const page = await this.options.reader.page({ conversationId, limit: this.pageSize,
            maximumBytes: this.pageBytes, ...(anchor ? { anchor } : {}) }, signal);
          if (!this.current(signal)) return;
          if (page.status === "preparing") { this.preparing(); return; }
          this.assertPage(page, conversationId, anchor?.generation);
          if (page.records.some(record => record.kind !== "message" || record.deleted)) throw new Error("Invalid message page");
          const replacement = operation === "initial" || operation === "latest";
          const combined = replacement ? page.records : operation === "older"
            ? [...page.records, ...this.state.records] : [...this.state.records, ...page.records];
          const byId = new Map<string, ConversationDisplayRecord>();
          for (const record of combined) {
            const previous = byId.get(record.id);
            if (!previous || previous.revision <= record.revision) byId.set(record.id, record);
          }
          const trimmed = this.trim([...byId.values()], operation);
          let hasOlder = this.state.hasOlder, hasNewer = this.state.hasNewer;
          if (replacement) {
            hasOlder = anchor?.direction === "newer" ? true : page.nextCursor !== null;
            hasNewer = anchor?.direction === "newer" ? page.nextCursor !== null : anchor !== undefined;
            this.changesCursor = null; this.changesAfter = page.revision;
          } else if (operation === "older") hasOlder = page.nextCursor !== null;
          else hasNewer = page.nextCursor !== null;
          if (trimmed.trimmed) { if (operation === "older") hasNewer = true; else hasOlder = true; }
          this.publish({ status: "ready", generation: page.generation, revision: page.revision, activeTurnId: page.activeTurnId,
            records: trimmed.records, retainedBytes: trimmed.bytes, hasOlder, hasNewer,
            version: this.state.version + 1, change: operation });
        }
      } catch (cause) {
        if (!this.current(signal)) return;
        const code = cause && typeof cause === "object" ? (cause as { resourceCode?: string; code?: string }).resourceCode
          ?? (cause as { code?: string }).code ?? (cause as { transportCode?: string }).transportCode : null;
        if (["stale_cursor", "not_found", "forbidden", "unauthenticated"].includes(code ?? "")) {
          // A clear, missing saved anchor or deletion must evict stale text immediately.
          this.initialAnchor = undefined; this.changesCursor = null;
          this.publish({ ...initial(), conversationId, status: "error", version: this.state.version + 1,
            error: { operation: "initial", cause } });
        } else this.publish({ status: this.state.records.length ? "ready" : "error", error: { operation, cause } });
      } finally {
        if (this.current(signal)) { this.pending = null; this.publish({ loading: null }); }
      }
    });
    this.pending = work; return work;
  }
  private preparing() {
    this.initialAnchor = undefined; this.changesCursor = null;
    this.publish({ status: "preparing", records: Object.freeze([]), retainedBytes: 0, hasOlder: false, hasNewer: false,
      activeTurnId: null, version: this.state.version + 1 });
  }
  private assertPage(page: ConversationDisplayPage, conversationId: string, generation?: number) {
    if (page.conversationId !== conversationId || generation !== undefined && page.generation !== generation ||
      page.records.length > this.pageSize || encoder.encode(JSON.stringify(page)).byteLength > this.pageBytes) {
      throw new Error("Display response does not match the selected window");
    }
  }
  private trim(input: readonly ConversationDisplayRecord[], operation: DisplayWindowOperation) {
    const records = [...input], sizes = records.map(recordBytes);
    let bytes = sizes.reduce((sum, size) => sum + size, 0), trimmed = false;
    while (records.length > this.maximumMessages || bytes > this.maximumBytes) {
      if (operation === "older" || operation === "changes") { records.pop(); bytes -= sizes.pop()!; }
      else { records.shift(); bytes -= sizes.shift()!; }
      trimmed = true;
    }
    return { records: Object.freeze(records), bytes, trimmed };
  }
  dispose() {
    if (this.disposed) return;
    this.selection.abort(); this.pending = null; this.disposed = true;
    this.publish({ ...initial(), version: this.state.version + 1 }); this.listeners.clear();
  }
}
