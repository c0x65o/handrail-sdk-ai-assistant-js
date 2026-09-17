import { ConversationDraftController, type ConversationLocalStateStore } from "./local-state.js";
import { DraftTextCapacityError } from "./draft-retention.js";

interface Entry { readonly draft: ConversationDraftController; users: number; unsubscribe(): void }
/** Account-owned text editors, independent of bounded transcript runtimes.
 * A failed save survives runtime eviction. Clean unused editors use an eight
 * entry cache; all live/closing owners have a separate 64-entry metadata cap.
 * Text and callback content still share the store-scoped retention budget. */
export class ConversationDraftWorkspace {
  private readonly entries = new Map<string, Entry>();
  private readonly closing = new Set<Promise<void>>();
  private closed: Promise<void> | null = null;
  constructor(private readonly storage: ConversationLocalStateStore) {}
  acquire(conversationId: string): ConversationDraftController {
    if (this.closed) throw new Error("Draft workspace is closed");
    let entry = this.entries.get(conversationId);
    if (!entry) {
      this.trim();
      if (this.entries.size + this.closing.size >= 64) throw new DraftTextCapacityError("account");
      const draft = new ConversationDraftController(conversationId, this.storage);
      entry = { draft, users: 0, unsubscribe: draft.subscribe(() => this.trim()) };
      this.entries.set(conversationId, entry);
    }
    entry.users++;
    return entry.draft;
  }
  async release(draft: ConversationDraftController): Promise<void> {
    const entry = this.entries.get(draft.conversationId);
    if (!entry || entry.draft !== draft || entry.users === 0) return;
    entry.users--;
    try { await draft.flush(); } catch { /* Keep recoverable edits owned by the account. */ }
    this.trim();
  }
  /** Confirmed permanent deletion; the scoped store also fences old writers. */
  forgetConversation(id: string): void {
    const entry = this.entries.get(id); if (!entry) return;
    this.entries.delete(id); this.close(entry);
  }
  private close(entry: Entry): void {
    entry.unsubscribe();
    const closing = entry.draft.dispose(); this.closing.add(closing);
    void closing.finally(() => this.closing.delete(closing));
  }
  private trim(): void {
    if (this.closed) return;
    const idle = [...this.entries].filter(([, entry]) => entry.users === 0 && !entry.draft.hasUnpersistedEdit);
    for (const [id, entry] of idle.slice(0, Math.max(0, idle.length - 8))) {
      this.entries.delete(id); this.close(entry);
    }
  }
  dispose(): Promise<void> {
    if (this.closed) return this.closed;
    for (const entry of this.entries.values()) this.close(entry);
    this.entries.clear();
    this.closed = Promise.all([...this.closing]).then(() => undefined);
    return this.closed;
  }
}
