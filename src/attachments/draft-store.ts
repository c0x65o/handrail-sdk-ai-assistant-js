import type { AttachmentReference } from "../protocol.js";
import type { AttachmentSelection } from "./types.js";
import { validateAttachmentSelection, validateAttachmentUploadReference } from "./uploader.js";

/** Device-owned selection. A new selection always gets a fresh ID; reusing an
 * ID means the exact same immutable bytes, metadata and upload identity. */
export interface AttachmentDraftFile<TSource> {
  readonly id: string;
  readonly selection: AttachmentSelection<TSource>;
  /** Ready uploads can restore without uploading the same bytes again. */
  readonly reference?: AttachmentReference;
}
export interface AttachmentDraftRecord<TSource> {
  readonly version: string;
  readonly files: readonly AttachmentDraftFile<TSource>[];
}
export interface AttachmentDraftStore<TSource> {
  readAttachmentDraft(conversationId: string): Promise<AttachmentDraftRecord<TSource> | null>;
  /** Atomic compare/replace; [] removes only the expected revision. Enforce
   * account-wide bounds without evicting another unsent selection. */
  writeAttachmentDraft(conversationId: string, files: readonly AttachmentDraftFile<TSource>[],
    expectedVersion: string | null): Promise<AttachmentDraftRecord<TSource> | null>;
  eraseConversation?(conversationId: string): Promise<void>;
  /** Confirmed admission only: remove exact selection IDs, preserving newer
   * selections/references, without hydrating binary data where supported. */
  discardAcceptedFiles?(conversationId: string, fileIds: readonly string[]): Promise<AttachmentDraftCleanup>;
}
export interface AttachmentDraftCleanup { readonly previousVersion: string | null; readonly version: string | null }
export function validateAttachmentDraftFileIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length > 64 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id))) throw new TypeError("Invalid attachment cleanup identities");
}
/** Compatibility path for scoped custom stores with atomic compare/replace. */
export async function discardAcceptedAttachmentFiles<TSource>(store: AttachmentDraftStore<TSource>, conversationId: string,
  ids: readonly string[]): Promise<AttachmentDraftCleanup> {
  validateAttachmentDraftFileIds(ids);
  if (store.discardAcceptedFiles) return store.discardAcceptedFiles(conversationId, ids);
  const selected = new Set(ids);
  for (let attempt = 0; attempt < 3; attempt++) {
    const old = await store.readAttachmentDraft(conversationId);
    if (!old) return { previousVersion: null, version: null };
    const files = parseAttachmentDraftFiles(old.files, conversationId).filter(file => !selected.has(file.id));
    if (files.length === old.files.length) return { previousVersion: old.version, version: old.version };
    try {
      const next = await store.writeAttachmentDraft(conversationId, files, old.version);
      return { previousVersion: old.version, version: next?.version ?? null };
    } catch (cause) { if (!(cause instanceof AttachmentDraftConflictError)) throw cause; }
  }
  throw new AttachmentDraftConflictError();
}
export const ATTACHMENT_DRAFT_LIMITS = Object.freeze({ conversations: 32, files: 64, bytes: 64 * 1024 * 1024 });
export class AttachmentDraftConflictError extends Error {
  constructor() { super("The saved files changed in another view. Your current selections remain available."); this.name = "AttachmentDraftConflictError"; }
}
export class AttachmentDraftCapacityError extends Error {
  constructor() { super("Saved files have reached the device limit. Send or remove files from another draft before adding more."); this.name = "AttachmentDraftCapacityError"; }
}
export function isAttachmentDraftStore<TSource>(value: unknown): value is AttachmentDraftStore<TSource> {
  return !!value && typeof value === "object" &&
    ["readAttachmentDraft", "writeAttachmentDraft"].every(name => typeof (value as Record<string, unknown>)[name] === "function");
}
/** Validates metadata without reading source bytes. Blob/native source checks
 * belong to the concrete device storage adapter. */
export function parseAttachmentDraftFile<TSource>(input: AttachmentDraftFile<TSource>, conversationId: string): AttachmentDraftFile<TSource> {
  if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.id)) throw new TypeError("Invalid attachment draft identity");
  const metadata = validateAttachmentSelection(input.selection);
  if (metadata.conversationId !== conversationId) throw new TypeError("Attachment draft belongs to another conversation");
  const selection = Object.freeze({ ...metadata, fingerprint: input.selection.fingerprint,
    idempotencyKey: input.selection.idempotencyKey, source: input.selection.source });
  return Object.freeze({ id: input.id, selection,
    ...(input.reference === undefined ? {} : { reference: validateAttachmentUploadReference(input.reference, metadata) }) });
}
export function parseAttachmentDraftFiles<TSource>(input: readonly AttachmentDraftFile<TSource>[], conversationId: string): readonly AttachmentDraftFile<TSource>[] {
  if (!Array.isArray(input) || input.length > ATTACHMENT_DRAFT_LIMITS.files) throw new AttachmentDraftCapacityError();
  const ids = new Set<string>(), uploadKeys = new Set<string>(), fingerprints = new Set<string>();
  let bytes = 0;
  return Object.freeze(input.map(value => {
    const file = parseAttachmentDraftFile<TSource>(value, conversationId);
    if (ids.has(file.id) || uploadKeys.has(file.selection.idempotencyKey) || fingerprints.has(file.selection.fingerprint)) throw new TypeError("Duplicate attachment draft identity");
    ids.add(file.id); uploadKeys.add(file.selection.idempotencyKey); fingerprints.add(file.selection.fingerprint);
    bytes += file.selection.byteSize;
    if (bytes > ATTACHMENT_DRAFT_LIMITS.bytes) throw new AttachmentDraftCapacityError();
    return file;
  }));
}

/** Account-lifetime fallback. It retains immutable sources within the same
 * content budgets as durable adapters; it does not survive process reload. */
export class InMemoryAttachmentDraftStore<TSource> implements AttachmentDraftStore<TSource> {
  private readonly drafts = new Map<string, AttachmentDraftRecord<TSource>>();
  private readonly deleted = new Set<string>();
  async readAttachmentDraft(id: string): Promise<AttachmentDraftRecord<TSource> | null> { return this.drafts.get(id) ?? null; }
  async writeAttachmentDraft(id: string, input: readonly AttachmentDraftFile<TSource>[], expectedVersion: string | null): Promise<AttachmentDraftRecord<TSource> | null> {
    if (this.deleted.has(id)) throw new Error("Conversation was permanently deleted");
    const files = parseAttachmentDraftFiles(input, id), old = this.drafts.get(id);
    if ((old?.version ?? null) !== expectedVersion) throw new AttachmentDraftConflictError();
    let count = files.length, bytes = files.reduce((sum, file) => sum + file.selection.byteSize, 0), conversations = files.length ? 1 : 0;
    for (const [other, draft] of this.drafts) if (other !== id) {
      conversations++; count += draft.files.length;
      bytes += draft.files.reduce((sum, file) => sum + file.selection.byteSize, 0);
    }
    if (count > ATTACHMENT_DRAFT_LIMITS.files || bytes > ATTACHMENT_DRAFT_LIMITS.bytes || conversations > ATTACHMENT_DRAFT_LIMITS.conversations) throw new AttachmentDraftCapacityError();
    for (const file of files) {
      const saved = old?.files.find(previous => previous.id === file.id);
      if (saved && (saved.selection.source !== file.selection.source ||
          JSON.stringify({ ...saved.selection, source: undefined }) !== JSON.stringify({ ...file.selection, source: undefined }) ||
          saved.reference && JSON.stringify(saved.reference) !== JSON.stringify(file.reference))) throw new TypeError("Saved attachment identity changed");
    }
    if (!files.length) { this.drafts.delete(id); return null; }
    const value = Object.freeze({ version: crypto.randomUUID(), files }); this.drafts.set(id, value); return value;
  }
  async eraseConversation(id: string): Promise<void> { this.deleted.add(id); this.drafts.delete(id); }
  async discardAcceptedFiles(id: string, fileIds: readonly string[]): Promise<AttachmentDraftCleanup> {
    validateAttachmentDraftFileIds(fileIds);
    const previous = this.drafts.get(id), ids = new Set(fileIds);
    if (!previous) return { previousVersion: null, version: null };
    const files = previous.files.filter(file => !ids.has(file.id));
    if (files.length === previous.files.length) return { previousVersion: previous.version, version: previous.version };
    const version = files.length ? crypto.randomUUID() : null;
    if (version) this.drafts.set(id, Object.freeze({ version, files: Object.freeze(files) }));
    else this.drafts.delete(id);
    return { previousVersion: previous.version, version };
  }
  dispose(): void { this.drafts.clear(); this.deleted.clear(); }
}
