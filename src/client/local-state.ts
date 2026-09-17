/** Browser/native-local data only. Hosts partition storage by account and API. */
export interface ConversationDraftRecord { readonly version: string; readonly text: string }
export interface ConversationSavedPosition {
  readonly messageId: string; readonly generation: number; readonly offset: number; readonly following: boolean;
}
export interface ConversationLocalStateStore {
  readDraft(conversationId: string): Promise<ConversationDraftRecord | null>;
  /** Atomic compare/replace; empty text removes only the matching revision. */
  writeDraft(conversationId: string, text: string, expectedVersion: string | null): Promise<ConversationDraftRecord | null>;
  readPosition(conversationId: string): Promise<ConversationSavedPosition | null>;
  writePosition(conversationId: string, position: ConversationSavedPosition): Promise<void>;
}
export class ConversationDraftConflictError extends Error {
  constructor() { super("A draft changed in another tab. Your text remains in this editor."); this.name = "ConversationDraftConflictError"; }
}
export function validateDraftText(text: string): void {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 65536) throw new TypeError("Draft exceeds the 64 KiB local storage limit");
}
export function parseSavedPosition(value: ConversationSavedPosition): ConversationSavedPosition {
  if (!value || typeof value.messageId !== "string" || !value.messageId || value.messageId.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value.messageId) || !Number.isSafeInteger(value.generation) || value.generation < 0 ||
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
  async readDraft(id: string) { return this.drafts.get(id) ?? null; }
  async writeDraft(id: string, text: string, expectedVersion: string | null) {
    validateDraftText(text); const previous = this.drafts.get(id);
    if ((previous?.version ?? null) !== expectedVersion) throw new ConversationDraftConflictError();
    if (!text) { this.drafts.delete(id); return null; }
    const bytes = [...this.drafts].reduce((sum, [key, value]) => key === id ? sum : sum + new TextEncoder().encode(value.text).byteLength,
      new TextEncoder().encode(text).byteLength);
    if (!previous && this.drafts.size >= 32 || bytes > 512 * 1024) throw new Error("Local draft storage is full");
    const record = Object.freeze({ version: crypto.randomUUID(), text }); this.drafts.set(id, record); return record;
  }
  async readPosition(id: string) { return this.positions.get(id) ?? null; }
  async writePosition(id: string, position: ConversationSavedPosition) {
    const value = parseSavedPosition(position); this.positions.delete(id); this.positions.set(id, value);
    while (this.positions.size > 32) this.positions.delete(this.positions.keys().next().value!);
  }
  dispose() { this.drafts.clear(); this.positions.clear(); }
}

export interface ConversationDraftSnapshot {
  readonly text: string; readonly edit: number; readonly status: "loading" | "saved" | "saving" | "error";
  readonly error: string | null;
}
/** One composer per account/chat. Captures edits synchronously, coalesces writes,
 * and refuses to overwrite another writer's revision. Contains no attachments. */
export class ConversationDraftController {
  private state: ConversationDraftSnapshot = Object.freeze({ text: "", edit: 0, status: "loading", error: null });
  private readonly listeners = new Set<() => void>();
  private version: string | null = null;
  private loaded = false;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private savedEdit = 0;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly initial: Promise<void>;
  constructor(readonly conversationId: string, private readonly storage: ConversationLocalStateStore) {
    this.initial = this.restore();
  }
  getSnapshot = (): ConversationDraftSnapshot => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ConversationDraftSnapshot>) {
    this.state = Object.freeze({ ...this.state, ...patch });
    if (!this.disposed) for (const listener of this.listeners) { try { listener(); } catch { /* View only. */ } }
  }
  private async restore() {
    try {
      const saved = await this.storage.readDraft(this.conversationId);
      const value = saved ? parseDraftRecord(saved) : null;
      this.version = value?.version ?? null; this.loaded = true;
      // Typing while local storage opens always wins over late restoration.
      if (this.state.edit === 0) this.publish({ text: value?.text ?? "", status: "saved", error: null });
      else if (!this.disposed) this.schedule();
    } catch { this.publish({ status: "error", error: "The saved draft could not be opened. Retry before closing this chat." }); }
  }
  setText(text: string): void {
    if (this.disposed) return;
    this.publish({ text, edit: this.state.edit + 1, status: "saving", error: null }); this.schedule();
  }
  /** Clears only the edit that was actually admitted, never a newer draft. */
  accepted(edit: number): void { if (!this.disposed && this.state.edit === edit) this.setText(""); }
  private schedule() {
    clearTimeout(this.timer); this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, 250);
  }
  flush = (): Promise<void> => {
    if (this.disposal) return this.disposal;
    clearTimeout(this.timer); this.timer = undefined;
    if (this.pending) return this.pending;
    const work = Promise.resolve().then(async () => {
      await this.initial;
      if (!this.loaded) await this.restore();
      if (!this.loaded) throw new Error("Draft storage is unavailable");
      while (this.savedEdit !== this.state.edit) {
        const { text, edit } = this.state;
        const saved = await this.storage.writeDraft(this.conversationId, text, this.version);
        this.version = saved?.version ?? null; this.savedEdit = edit;
      }
      this.publish({ status: "saved", error: null });
    }).catch((cause: unknown) => {
      this.publish({ status: "error", error: cause instanceof ConversationDraftConflictError ? cause.message
        : "This draft could not be saved on this device. Keep this chat open and retry." }); throw cause;
    }).finally(() => { if (this.pending === work) this.pending = null; });
    this.pending = work; return work;
  };
  /** Reload is explicit: never discard local edits to resolve a conflict automatically. */
  async reload(): Promise<void> {
    if (this.disposed) return;
    clearTimeout(this.timer); this.timer = undefined;
    await this.pending?.catch(() => undefined);
    const currentEdit = this.state.edit;
    const saved = await this.storage.readDraft(this.conversationId);
    if (this.disposed || currentEdit !== this.state.edit) return;
    const value = saved ? parseDraftRecord(saved) : null;
    clearTimeout(this.timer); this.timer = undefined; this.version = value?.version ?? null; this.loaded = true;
    const edit = this.state.edit + 1; this.savedEdit = edit; this.publish({ text: value?.text ?? "", edit, status: "saved", error: null });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    // Flush still owns its account-scoped storage; no view notifications follow teardown.
    this.disposed = true; this.listeners.clear();
    this.disposal = this.flush().catch(() => undefined).finally(() => {
      this.version = null;
      this.state = Object.freeze({ text: "", edit: 0, status: "saved", error: null });
    });
    return this.disposal;
  }
}
