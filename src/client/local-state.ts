import { draftTextBytes, DraftTextCapacityError, DraftTextRetentionOwner } from "./draft-retention.js";
/** Browser/native-local data only. Hosts partition storage by account and API. */
export interface ConversationDraftRecord { readonly version: string; readonly text: string }
export interface ConversationSavedPosition {
  readonly messageId: string; readonly generation: number; readonly offset: number; readonly following: boolean;
}
export interface ConversationLocalStateStore {
  readDraft(conversationId: string): Promise<ConversationDraftRecord | null>;
  /** Atomic compare/replace; empty text removes only the matching revision. */
  writeDraft(conversationId: string, text: string, expectedVersion: string | null): Promise<ConversationDraftRecord | null>;
  /** Confirmed admission only: compare/delete one exact stored text revision. */
  discardDraftVersion?(conversationId: string, version: string): Promise<"removed" | "absent" | "changed">;
  readPosition(conversationId: string): Promise<ConversationSavedPosition | null>;
  writePosition(conversationId: string, position: ConversationSavedPosition): Promise<void>;
  /** After confirmed permanent deletion, erase only this conversation and reject
   * future writes to its immutable identity, including writes from old tabs. */
  eraseConversation?(conversationId: string): Promise<void>;
}
export class ConversationDraftConflictError extends Error {
  constructor() { super("A draft changed in another tab. Your text remains in this editor."); this.name = "ConversationDraftConflictError"; }
}
export function validateDraftText(text: string): void {
  draftTextBytes(text);
}
export function parseSavedPosition(value: ConversationSavedPosition): ConversationSavedPosition {
  if (!value || typeof value.messageId !== "string" || !value.messageId || value.messageId.length > 512 ||
    Array.from(value.messageId).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !Number.isSafeInteger(value.generation) || value.generation < 0 ||
    !Number.isFinite(value.offset) || Math.abs(value.offset) > 100_000_000 || typeof value.following !== "boolean") throw new TypeError("Invalid scroll position");
  return Object.freeze({ messageId: value.messageId, generation: value.generation, offset: value.offset, following: value.following });
}
export function parseDraftRecord(value: ConversationDraftRecord): ConversationDraftRecord {
  if (!value || typeof value.version !== "string" || !value.version || value.version.length > 128) throw new TypeError("Invalid saved draft");
  validateDraftText(value.text); return Object.freeze({ version: value.version, text: value.text });
}
export function isConversationLocalStateStore(value: unknown): value is ConversationLocalStateStore {
  return !!value && typeof value === "object" && ["readDraft", "writeDraft", "readPosition", "writePosition"]
    .every(name => typeof (value as Record<string, unknown>)[name] === "function");
}
export class InMemoryConversationLocalStateStore implements ConversationLocalStateStore {
  private readonly drafts = new Map<string, ConversationDraftRecord>();
  private readonly positions = new Map<string, ConversationSavedPosition>();
  private readonly deleted = new Set<string>();
  async readDraft(id: string) { return this.drafts.get(id) ?? null; }
  async writeDraft(id: string, text: string, expectedVersion: string | null) {
    if (this.deleted.has(id)) throw new Error("Conversation was permanently deleted");
    validateDraftText(text); const previous = this.drafts.get(id);
    if ((previous?.version ?? null) !== expectedVersion) throw new ConversationDraftConflictError();
    if (!text) { this.drafts.delete(id); return null; }
    const bytes = [...this.drafts].reduce((sum, [key, value]) => key === id ? sum : sum + new TextEncoder().encode(value.text).byteLength,
      new TextEncoder().encode(text).byteLength);
    if (!previous && this.drafts.size >= 32 || bytes > 512 * 1024) throw new Error("Local draft storage is full");
    const record = Object.freeze({ version: crypto.randomUUID(), text }); this.drafts.set(id, record); return record;
  }
  async readPosition(id: string) { return this.positions.get(id) ?? null; }
  async discardDraftVersion(id: string, version: string): Promise<"removed" | "absent" | "changed"> {
    const saved = this.drafts.get(id);
    if (!saved) return "absent";
    if (saved.version !== version) return "changed";
    this.drafts.delete(id); return "removed";
  }
  async writePosition(id: string, position: ConversationSavedPosition) {
    if (this.deleted.has(id)) throw new Error("Conversation was permanently deleted");
    const value = parseSavedPosition(position); this.positions.delete(id); this.positions.set(id, value);
    while (this.positions.size > 32) this.positions.delete(this.positions.keys().next().value!);
  }
  async eraseConversation(id: string) { this.deleted.add(id); this.drafts.delete(id); this.positions.delete(id); }
  dispose() { this.drafts.clear(); this.positions.clear(); this.deleted.clear(); }
}

export interface ConversationDraftSnapshot {
  readonly text: string; readonly edit: number; readonly status: "loading" | "saved" | "saving" | "error";
  readonly error: string | null;
  /** Rejected edits preserve the current text, revision and storage status. */
  readonly inputError: string | null;
}
/** One composer per account/chat. Captures edits synchronously, coalesces writes,
 * and refuses to overwrite another writer's revision. Contains no attachments. */
export class ConversationDraftController {
  private state: ConversationDraftSnapshot = Object.freeze({ text: "", edit: 0, status: "loading", error: null, inputError: null });
  private readonly listeners = new Set<() => void>();
  private version: string | null = null;
  private loaded = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private savedEdit = 0;
  private uncertainWrite = false;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly initial: Promise<void>;
  private readonly retention: DraftTextRetentionOwner;
  constructor(readonly conversationId: string, private readonly storage: ConversationLocalStateStore) {
    this.retention = new DraftTextRetentionOwner(storage);
    this.initial = this.restore();
  }
  getSnapshot = (): ConversationDraftSnapshot => this.state;
  get hasUnpersistedEdit(): boolean { return this.uncertainWrite || this.savedEdit !== this.state.edit; }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ConversationDraftSnapshot>) {
    this.state = Object.freeze({ ...this.state, ...patch });
    if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* View only. */ } }
  }
  private async restore() {
    try {
      const saved = await this.storage.readDraft(this.conversationId);
      const value = saved ? parseDraftRecord(saved) : null;
      if (this.state.edit === 0) this.retention.replace(value?.text ?? "");
      this.version = value?.version ?? null; this.loaded = true;
      // Typing while local storage opens always wins over late restoration.
      if (this.state.edit === 0) this.publish({ text: value?.text ?? "", status: "saved", error: null });
      else if (!this.disposed) this.schedule();
    } catch (cause) { this.publish({ status: "error", error: cause instanceof DraftTextCapacityError ? cause.message
      : "The saved draft could not be opened. Retry before closing this chat." }); }
  }
  setText(text: string): boolean {
    if (this.disposed) return false;
    try { this.retention.replace(text); }
    catch (cause) {
      const inputError = cause instanceof DraftTextCapacityError ? cause.message : "This edit could not be retained.";
      if (this.state.inputError !== inputError) this.publish({ inputError });
      return false;
    }
    this.publish({ text, edit: this.state.edit + 1, status: "saving", error: null, inputError: null }); this.schedule();
    return true;
  }
  /** Keep a captured send charged even after acceptance clears its editor. The
   * caller releases only when its send/request callback actually settles. */
  retainText(text: string): () => void {
    if (this.disposed) throw new Error("Draft owner is closed");
    return this.retention.retain(text);
  }
  /** Clears only the edit that was actually admitted, never a newer draft. */
  accepted(edit: number): void { if (!this.disposed && this.state.edit === edit) this.setText(""); }
  /** Bind only the exact persisted edit captured by Send. If the editor changed
   * during the flush, that newer draft must not enter the old send's receipt. */
  async captureVersion(edit: number): Promise<string | undefined> {
    await this.flush();
    return this.savedEdit === edit && this.state.edit === edit ? this.version ?? undefined : undefined;
  }
  /** Serialize cleanup with local writes. New typing during cleanup uses the
   * resulting base revision rather than reviving an already admitted draft. */
  reconcileAccepted(version: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Draft owner is closed"));
    clearTimeout(this.timer); this.timer = undefined;
    const previous = this.pending;
    const work = Promise.resolve().then(async () => {
      await previous?.catch(() => undefined); await this.initial;
      const discard = this.storage.discardDraftVersion?.bind(this.storage);
      let outcome: "removed" | "absent" | "changed";
      if (discard) outcome = await discard(this.conversationId, version);
      else {
        try { await this.storage.writeDraft(this.conversationId, "", version); outcome = "removed"; }
        catch (cause) {
          if (!(cause instanceof ConversationDraftConflictError)) throw cause;
          const current = await this.storage.readDraft(this.conversationId);
          if (current?.version === version) throw cause;
          outcome = current ? "changed" : "absent";
        }
      }
      if (this.version !== version) return;
      if (outcome !== "changed") this.version = null;
      if (this.savedEdit === this.state.edit) {
        const edit = this.state.edit + 1; this.savedEdit = edit;
        this.retention.clear();
        this.publish({ text: "", edit, inputError: null, status: outcome === "changed" ? "error" : "saved",
          error: outcome === "changed" ? "The saved draft changed in another view. Reload it before editing." : null });
      }
    }).catch((cause: unknown) => {
      this.publish({ status: "error", error: "The message was accepted, but its local draft could not be cleared. Retry the saved message." });
      throw cause;
    }).finally(() => {
      if (this.pending === work) { this.pending = null; if (!this.disposed && this.savedEdit !== this.state.edit) this.schedule(); }
    });
    this.pending = work; return work;
  }
  private schedule() {
    clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, 250);
  }
  flush = (): Promise<void> => this.disposal ?? this.flushPending();
  private flushPending(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    if (this.pending) return this.pending.then(() => this.savedEdit === this.state.edit ? undefined : this.flushPending());
    const work = Promise.resolve().then(async () => {
      await this.initial;
      if (!this.loaded) await this.restore();
      if (!this.loaded) throw new Error("Draft storage is unavailable");
      while (this.savedEdit !== this.state.edit) {
        const { text, edit } = this.state;
        const release = this.retention.retain(text);
        try {
          const saved = await this.storage.writeDraft(this.conversationId, text, this.version);
          this.version = saved?.version ?? null; this.savedEdit = edit; this.uncertainWrite = false;
        } catch (cause) { this.uncertainWrite = true; throw cause; } finally { release(); }
      }
      this.publish({ status: "saved", error: null });
    }).catch((cause: unknown) => {
      this.publish({ status: "error", error: cause instanceof ConversationDraftConflictError || cause instanceof DraftTextCapacityError ? cause.message
        : !this.loaded && this.state.error ? this.state.error : "This draft could not be saved on this device. Keep this chat open and retry." }); throw cause;
    }).finally(() => { if (this.pending === work) this.pending = null; });
    this.pending = work; return work;
  }
  /** Reload is explicit: never discard local edits to resolve a conflict automatically. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer); this.timer = undefined;
    await this.pending?.catch(() => undefined);
    const currentEdit = this.state.edit;
    const saved = await this.storage.readDraft(this.conversationId);
    if (this.disposed || currentEdit !== this.state.edit) return;
    let value: ConversationDraftRecord | null;
    try { value = saved ? parseDraftRecord(saved) : null; this.retention.replace(value?.text ?? ""); }
    catch (cause) {
      this.publish({ status: "error", error: cause instanceof DraftTextCapacityError ? cause.message : "The saved draft could not be opened." });
      throw cause;
    }
    clearTimeout(this.timer); this.timer = undefined; this.version = value?.version ?? null; this.loaded = true;
    const edit = this.state.edit + 1; this.savedEdit = edit; this.uncertainWrite = false; this.publish({ text: value?.text ?? "", edit, status: "saved", error: null, inputError: null });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    // Flush still owns its account-scoped storage; no view notifications follow teardown.
    this.disposed = true; this.listeners.clear();
    this.disposal = this.flushPending().catch(() => undefined).finally(() => {
      this.version = null; this.retention.clear();
      this.state = Object.freeze({ text: "", edit: 0, status: "saved", error: null, inputError: null });
    });
    return this.disposal;
  }
}
