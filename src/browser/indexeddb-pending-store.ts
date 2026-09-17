import { parseApplicationConversationSubmission, type ApplicationConversationPendingStore,
  type ApplicationConversationSubmission } from "../client/session-submission.js";
import { ConversationDraftConflictError, parseDraftRecord, parseSavedPosition, validateDraftText,
  type ConversationDraftRecord, type ConversationLocalStateStore, type ConversationSavedPosition } from "../client/local-state.js";

interface Row { scope: string; conversation: string; json: string; bytes: number }
const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error);
});
/** Durable retry intent, partitioned by authenticated account AND API endpoint.
 * Supply an opaque stable scope; never use an access token. Data remains in this
 * browser until acknowledgement or explicit account erasure. No transcripts. */
export class IndexedDBApplicationConversationPendingStore<TRequest = unknown> implements ApplicationConversationPendingStore<TRequest>, ConversationLocalStateStore {
  private connection: Promise<IDBDatabase> | null = null;
  private closed = false;
  constructor(private readonly options: { readonly scope: string; readonly databaseName?: string; readonly indexedDB?: IDBFactory }) {
    if (!options.scope || options.scope.length > 512 || /[\u0000-\u001f\u007f]/u.test(options.scope)) throw new TypeError("An account/API storage scope is required");
  }
  private database(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("Pending message store is closed"));
    if (!this.connection) this.connection = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new Error("Durable browser storage is unavailable")); return; }
      const opening = factory.open(this.options.databaseName ?? "handrail-ai-pending-v1", 2);
      let blocked = false;
      opening.onupgradeneeded = () => {
        for (const name of ["pending", "drafts", "positions"]) if (!opening.result.objectStoreNames.contains(name)) {
          const store = opening.result.createObjectStore(name, { keyPath: ["scope", "conversation"] }); store.createIndex("scope", "scope");
        }
      };
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => { blocked = true; reject(new Error("Pending message storage is blocked")); };
      opening.onsuccess = () => { const db = opening.result;
        db.onversionchange = () => { db.close(); this.connection = null; };
        if (this.closed || blocked) { db.close(); reject(new Error("Pending message store is closed")); } else resolve(db); };
    }).catch(cause => { this.connection = null; throw cause; });
    return this.connection;
  }
  private async transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => Promise<T>, name = "pending"): Promise<T> {
    const db = await this.database(); if (this.closed) throw new Error("Pending message store is closed");
    const tx = db.transaction(name, mode);
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Pending message transaction failed"));
    });
    try { const value = await operation(tx.objectStore(name)); await complete; return value; }
    catch (cause) { try { tx.abort(); } catch { /* Already settled. */ } await complete.catch(() => undefined); throw cause; }
  }
  async load(conversationId: string): Promise<ApplicationConversationSubmission<TRequest> | null> {
    return this.transact("readonly", async store => {
      const row = await request<Row | undefined>(store.get([this.options.scope, conversationId]));
      if (!row) return null;
      if (typeof row.json !== "string" || row.json.length > 1024 * 1024) throw new Error("Invalid pending message journal");
      return parseApplicationConversationSubmission<TRequest>(JSON.parse(row.json), conversationId);
    });
  }
  async retain(input: ApplicationConversationSubmission<TRequest>): Promise<void> {
    const value = parseApplicationConversationSubmission<TRequest>(input, input.start.conversationId), json = JSON.stringify(value);
    const row: Row = { scope: this.options.scope, conversation: value.start.conversationId, json, bytes: new TextEncoder().encode(json).byteLength };
    await this.transact("readwrite", async store => {
      const old = await request<Row | undefined>(store.get([row.scope, row.conversation]));
      if (old) { if (old.json !== json) throw new Error("A different message is awaiting confirmation"); return; }
      // The index is scope-local and only contains bounded pending intents.
      const rows = await request<Row[]>(store.index("scope").getAll(this.options.scope, 33));
      if (rows.length >= 32 || rows.reduce((bytes, entry) => bytes + entry.bytes, row.bytes) > 4 * 1024 * 1024) throw new Error("Pending message storage is full");
      await request(store.add(row));
    });
  }
  async acknowledge(input: ApplicationConversationSubmission<TRequest>): Promise<void> {
    const value = parseApplicationConversationSubmission<TRequest>(input, input.start.conversationId);
    await this.transact("readwrite", async store => {
      const key = [this.options.scope, value.start.conversationId], old = await request<Row | undefined>(store.get(key));
      if (old?.json === JSON.stringify(value)) await request(store.delete(key));
    });
  }
  /** Explicit logout/account-erasure policy; never invoked by ordinary close. */
  async eraseAccount(): Promise<void> {
    for (const name of ["pending", "drafts", "positions"]) await this.transact("readwrite", async store => {
      const keys = await request(store.index("scope").getAllKeys(this.options.scope));
      await Promise.all(keys.map(key => request(store.delete(key))));
    }, name);
  }
  async readDraft(conversationId: string): Promise<ConversationDraftRecord | null> {
    return this.transact("readonly", async store => {
      const row = await request<ConversationDraftRecord | undefined>(store.get([this.options.scope, conversationId]));
      return row ? parseDraftRecord(row) : null;
    }, "drafts");
  }
  async writeDraft(conversation: string, text: string, expectedVersion: string | null): Promise<ConversationDraftRecord | null> {
    validateDraftText(text);
    return this.transact("readwrite", async store => {
      const scope = this.options.scope, key = [scope, conversation];
      const old = await request<(ConversationDraftRecord & { bytes: number }) | undefined>(store.get(key));
      if ((old?.version ?? null) !== expectedVersion) throw new ConversationDraftConflictError();
      if (!text) { await request(store.delete(key)); return null; }
      const rows = await request<{ conversation: string; bytes: number }[]>(store.index("scope").getAll(scope, 33));
      const bytes = new TextEncoder().encode(text).byteLength;
      if (!old && rows.length >= 32 || rows.reduce((sum, row) => row.conversation === conversation ? sum : sum + row.bytes, bytes) > 512 * 1024) throw new Error("Local draft storage is full");
      const result = Object.freeze({ text, version: crypto.randomUUID() }); await request(store.put({ scope, conversation, bytes, ...result }));
      return result;
    }, "drafts");
  }
  async readPosition(conversationId: string): Promise<ConversationSavedPosition | null> {
    return this.transact("readonly", async store => {
      const row = await request<ConversationSavedPosition | undefined>(store.get([this.options.scope, conversationId]));
      return row ? parseSavedPosition(row) : null;
    }, "positions");
  }
  async writePosition(conversation: string, position: ConversationSavedPosition): Promise<void> {
    const value = parseSavedPosition(position);
    await this.transact("readwrite", async store => {
      const scope = this.options.scope;
      await request(store.put({ scope, conversation, updatedAt: Date.now(), ...value }));
      const rows = await request<{ conversation: string; updatedAt: number }[]>(store.index("scope").getAll(scope));
      const others = rows.filter(row => row.conversation !== conversation).sort((a, b) => a.updatedAt - b.updatedAt || a.conversation.localeCompare(b.conversation));
      for (const row of others.slice(0, Math.max(0, rows.length - 32))) await request(store.delete([scope, row.conversation]));
    }, "positions");
  }
  close(): void { this.closed = true; void this.connection?.then(db => db.close()).catch(() => undefined); }
}
