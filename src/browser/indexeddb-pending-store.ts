import { parseApplicationConversationSubmission, type ApplicationConversationPendingStore,
  type ApplicationConversationSubmission } from "../client/session-submission.js";
import { ConversationDraftConflictError, parseDraftRecord, parseSavedPosition, validateDraftText,
  type ConversationDraftRecord, type ConversationLocalStateStore, type ConversationSavedPosition } from "../client/local-state.js";
import { ATTACHMENT_DRAFT_LIMITS, AttachmentDraftCapacityError, AttachmentDraftConflictError, parseAttachmentDraftFiles,
  validateAttachmentDraftFileIds, type AttachmentDraftCleanup,
  type AttachmentDraftFile, type AttachmentDraftRecord, type AttachmentDraftStore } from "../attachments/draft-store.js";

type StoredFile = Omit<AttachmentDraftFile<Blob>, "selection"> & { selection: Omit<AttachmentDraftFile<Blob>["selection"], "source"> };
interface FileDraftRow { scope: string; conversation: string; version: string; files: readonly StoredFile[]; bytes: number; count: number }
interface FileBlobRow { scope: string; conversation: string; id: string; source: Blob }
const fileMetadata = (file: AttachmentDraftFile<Blob>): StoredFile => {
  const { source, ...selection } = file.selection; void source;
  return { id: file.id, selection, ...(file.reference ? { reference: file.reference } : {}) };
};

interface Row { scope: string; conversation: string; json: string; bytes: number }
const hasControlCharacters = (value: string): boolean => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const request = <T>(operation: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error);
});
/** Durable retry intent, partitioned by authenticated account AND API endpoint.
 * Supply an opaque stable scope; never use an access token. Data remains in this
 * browser until acknowledgement or explicit account erasure. No transcripts. */
export class IndexedDBApplicationConversationPendingStore<TRequest = unknown> implements ApplicationConversationPendingStore<TRequest>, ConversationLocalStateStore, AttachmentDraftStore<Blob> {
  private connection: Promise<IDBDatabase> | null = null;
  private closed = false;
  constructor(private readonly options: { readonly scope: string; readonly databaseName?: string; readonly indexedDB?: IDBFactory }) {
    if (!options.scope || options.scope.length > 512 || hasControlCharacters(options.scope)) throw new TypeError("An account/API storage scope is required");
  }
  private database(): Promise<IDBDatabase> {
    if (this.closed) return Promise.reject(new Error("Pending message store is closed"));
    if (!this.connection) this.connection = new Promise<IDBDatabase>((resolve, reject) => {
      const factory = this.options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new Error("Durable browser storage is unavailable")); return; }
      const opening = factory.open(this.options.databaseName ?? "handrail-ai-pending-v1", 4);
      let blocked = false;
      opening.onupgradeneeded = () => {
        for (const name of ["pending", "drafts", "positions", "deleted", "attachment_drafts"]) if (!opening.result.objectStoreNames.contains(name)) {
          const store = opening.result.createObjectStore(name, { keyPath: ["scope", "conversation"] }); store.createIndex("scope", "scope");
        }
        if (!opening.result.objectStoreNames.contains("attachment_blobs")) {
          const store = opening.result.createObjectStore("attachment_blobs", { keyPath: ["scope", "conversation", "id"] });
          store.createIndex("scope", "scope"); store.createIndex("conversation", ["scope", "conversation"]);
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
  private async transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, deleted: IDBObjectStore, tx: IDBTransaction) => Promise<T>, name = "pending", extra: readonly string[] = []): Promise<T> {
    const db = await this.database(); if (this.closed) throw new Error("Pending message store is closed");
    const tx = db.transaction([...new Set([name, "deleted", ...extra])], mode);
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Pending message transaction failed"));
    });
    try { const value = await operation(tx.objectStore(name), tx.objectStore("deleted"), tx); await complete; return value; }
    catch (cause) { try { tx.abort(); } catch { /* Already settled. */ } await complete.catch(() => undefined); throw cause; }
  }
  private async assertWritable(deleted: IDBObjectStore, conversation: string): Promise<void> {
    if (await request(deleted.getKey([this.options.scope, conversation])) !== undefined) throw new Error("Conversation was permanently deleted");
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
    await this.transact("readwrite", async (store, deleted) => {
      await this.assertWritable(deleted, row.conversation);
      const old = await request<Row | undefined>(store.get([row.scope, row.conversation]));
      if (old) { if (old.json !== json) throw new Error("A different message is awaiting confirmation"); return; }
      // The index is scope-local and only contains bounded pending intents.
      const rows = await request<Row[]>(store.index("scope").getAll(this.options.scope, 33));
      if (rows.length >= 32 || rows.reduce((bytes, entry) => bytes + entry.bytes, row.bytes) > 4 * 1024 * 1024) throw new Error("Pending message storage is full");
      await request(store.add(row));
    });
  }
  /** Atomic account/chat erasure. The content-free tombstone is durable so a
   * delayed save in another tab cannot resurrect a permanently deleted identity. */
  async eraseConversation(conversation: string): Promise<void> {
    if (!conversation || conversation.length > 256 || hasControlCharacters(conversation)) throw new TypeError("Invalid conversation identity");
    const db = await this.database(); if (this.closed) throw new Error("Pending message store is closed");
    const tx = db.transaction(["pending", "drafts", "positions", "deleted", "attachment_drafts", "attachment_blobs"], "readwrite");
    const complete = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Conversation erasure failed"));
    });
    const scope = this.options.scope, key = [scope, conversation];
    try {
      for (const name of ["pending", "drafts", "positions", "attachment_drafts"]) tx.objectStore(name).delete(key);
      await this.eraseIndexedRows(tx.objectStore("attachment_blobs"), "conversation", key);
      tx.objectStore("deleted").put({ scope, conversation });
      await complete;
    } catch (cause) {
      try { tx.abort(); } catch { /* Already settled. */ }
      await complete.catch(() => undefined); throw cause;
    }
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
    for (const name of ["pending", "drafts", "positions", "attachment_drafts", "attachment_blobs", "deleted"]) await this.transact("readwrite", async store => {
      // Deleted identities contain no content but can outnumber live drafts.
      // Walk their keys without materializing the account's entire delete log.
      await this.eraseIndexedRows(store, "scope", this.options.scope);
    }, name);
  }
  private async eraseIndexedRows(store: IDBObjectStore, index: string, key: IDBValidKey): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const scan = store.index(index).openKeyCursor(key);
        scan.onerror = () => reject(scan.error);
        scan.onsuccess = () => {
          const cursor = scan.result;
          if (!cursor) { resolve(); return; }
          store.delete(cursor.primaryKey); cursor.continue();
        };
      });
  }
  async readDraft(conversationId: string): Promise<ConversationDraftRecord | null> {
    return this.transact("readonly", async store => {
      const row = await request<ConversationDraftRecord | undefined>(store.get([this.options.scope, conversationId]));
      return row ? parseDraftRecord(row) : null;
    }, "drafts");
  }
  async writeDraft(conversation: string, text: string, expectedVersion: string | null): Promise<ConversationDraftRecord | null> {
    validateDraftText(text);
    return this.transact("readwrite", async (store, deleted) => {
      await this.assertWritable(deleted, conversation);
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
  async discardDraftVersion(conversation: string, version: string): Promise<"removed" | "absent" | "changed"> {
    return this.transact("readwrite", async store => {
      const key = [this.options.scope, conversation], saved = await request<ConversationDraftRecord | undefined>(store.get(key));
      if (!saved) return "absent";
      if (saved.version !== version) return "changed";
      await request(store.delete(key)); return "removed";
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
    await this.transact("readwrite", async (store, deleted) => {
      await this.assertWritable(deleted, conversation);
      const scope = this.options.scope;
      await request(store.put({ scope, conversation, updatedAt: Date.now(), ...value }));
      const rows = await request<{ conversation: string; updatedAt: number }[]>(store.index("scope").getAll(scope));
      const others = rows.filter(row => row.conversation !== conversation).sort((a, b) => a.updatedAt - b.updatedAt || a.conversation.localeCompare(b.conversation));
      for (const row of others.slice(0, Math.max(0, rows.length - 32))) await request(store.delete([scope, row.conversation]));
    }, "positions");
  }

  async readAttachmentDraft(conversation: string): Promise<AttachmentDraftRecord<Blob> | null> {
    return this.transact("readonly", async (store, _deleted, tx) => {
      const row = await request<FileDraftRow | undefined>(store.get([this.options.scope, conversation]));
      if (!row) return null;
      if (typeof row.version !== "string" || !row.version || row.version.length > 128 || !Array.isArray(row.files)) throw new TypeError("Invalid saved attachment draft");
      // Validate bounded metadata before looking up any source. No other chat's
      // bytes are hydrated when one conversation is selected.
      const metadata = parseAttachmentDraftFiles(row.files.map(file => ({ ...file, selection: { ...file.selection, source: undefined } })), conversation);
      if (row.count !== metadata.length || row.bytes !== metadata.reduce((sum, file) => sum + file.selection.byteSize, 0)) throw new TypeError("Invalid saved attachment draft bounds");
      const blobs = tx.objectStore("attachment_blobs"), files: AttachmentDraftFile<Blob>[] = [];
      for (const file of metadata) {
        const blob = await request<FileBlobRow | undefined>(blobs.get([this.options.scope, conversation, file.id]));
        if (!blob || !(blob.source instanceof Blob) || blob.source.size !== file.selection.byteSize) throw new TypeError("Saved attachment bytes are unavailable");
        files.push(Object.freeze({ ...file, selection: Object.freeze({ ...file.selection, source: blob.source }) }));
      }
      return Object.freeze({ version: row.version, files: Object.freeze(files) });
    }, "attachment_drafts", ["attachment_blobs"]);
  }

  async writeAttachmentDraft(conversation: string, input: readonly AttachmentDraftFile<Blob>[], expectedVersion: string | null): Promise<AttachmentDraftRecord<Blob> | null> {
    if (!conversation || conversation.length > 256 || hasControlCharacters(conversation)) throw new TypeError("Invalid conversation identity");
    const files = parseAttachmentDraftFiles(input, conversation);
    for (const file of files) if (!(file.selection.source instanceof Blob) || file.selection.source.size !== file.selection.byteSize) throw new TypeError("Attachment bytes do not match their metadata");
    const metadata = files.map(fileMetadata), bytes = files.reduce((sum, file) => sum + file.selection.byteSize, 0);
    return this.transact("readwrite", async (store, deleted, tx) => {
      await this.assertWritable(deleted, conversation);
      const scope = this.options.scope, key = [scope, conversation];
      const old = await request<FileDraftRow | undefined>(store.get(key));
      if ((old?.version ?? null) !== expectedVersion) throw new AttachmentDraftConflictError();
      const rows = await request<FileDraftRow[]>(store.index("scope").getAll(scope, ATTACHMENT_DRAFT_LIMITS.conversations + 1));
      let totalFiles = files.length, totalBytes = bytes, conversations = files.length ? 1 : 0;
      for (const row of rows) {
        if (row.conversation === conversation) continue;
        if (!Number.isSafeInteger(row.count) || row.count < 0 || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new TypeError("Invalid saved attachment budget");
        conversations++; totalFiles += row.count; totalBytes += row.bytes;
      }
      if (conversations > ATTACHMENT_DRAFT_LIMITS.conversations || totalFiles > ATTACHMENT_DRAFT_LIMITS.files || totalBytes > ATTACHMENT_DRAFT_LIMITS.bytes) throw new AttachmentDraftCapacityError();
      const blobs = tx.objectStore("attachment_blobs"), previous = new Map((old?.files ?? []).map(file => [file.id, file]));
      const retained = new Set(files.map(file => file.id));
      for (const file of old?.files ?? []) if (!retained.has(file.id)) await request(blobs.delete([scope, conversation, file.id]));
      for (const [index, file] of files.entries()) {
        const saved = previous.get(file.id), next = metadata[index]!;
        if (saved) {
          // Upload completion changes only the small reference. An existing
          // selection's immutable Blob is never rewritten or read for that save.
          if (JSON.stringify(saved.selection) !== JSON.stringify(next.selection) ||
              saved.reference && JSON.stringify(saved.reference) !== JSON.stringify(next.reference)) throw new TypeError("Saved attachment identity changed");
        } else await request(blobs.add({ scope, conversation, id: file.id, source: file.selection.source } satisfies FileBlobRow));
      }
      if (!files.length) { await request(store.delete(key)); return null; }
      const version = crypto.randomUUID();
      await request(store.put({ scope, conversation, version, files: metadata, bytes, count: files.length } satisfies FileDraftRow));
      return Object.freeze({ version, files });
    }, "attachment_drafts", ["attachment_blobs"]);
  }
  async discardAcceptedFiles(conversation: string, fileIds: readonly string[]): Promise<AttachmentDraftCleanup> {
    validateAttachmentDraftFileIds(fileIds); const ids = new Set(fileIds);
    return this.transact("readwrite", async (store, _deleted, tx) => {
      const scope = this.options.scope, key = [scope, conversation], old = await request<FileDraftRow | undefined>(store.get(key));
      if (!old) return { previousVersion: null, version: null };
      // Validate bounded metadata only. Accepted cleanup never reads a Blob.
      const metadata = parseAttachmentDraftFiles(old.files.map(file => ({ ...file, selection: { ...file.selection, source: undefined } })), conversation);
      const files = old.files.filter(file => !ids.has(file.id));
      if (files.length === metadata.length) return { previousVersion: old.version, version: old.version };
      const version = files.length ? crypto.randomUUID() : null;
      for (const file of old.files) if (ids.has(file.id)) await request(tx.objectStore("attachment_blobs").delete([scope, conversation, file.id]));
      if (version) await request(store.put({ scope, conversation, files, version,
        count: files.length, bytes: files.reduce((sum, file) => sum + file.selection.byteSize, 0) } satisfies FileDraftRow));
      else await request(store.delete(key));
      return { previousVersion: old.version, version };
    }, "attachment_drafts", ["attachment_blobs"]);
  }
  close(): void { this.closed = true; void this.connection?.then(db => db.close()).catch(() => undefined); }
}
