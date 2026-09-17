import type { AttachmentSelection, AttachmentUploadAdapter, AttachmentUploadItem } from "./types.js";
import { AttachmentUploader } from "./uploader.js";
import { AI_RUNTIME_PROTOCOL_LIMITS } from "../protocol.js";
import { ATTACHMENT_DRAFT_LIMITS, AttachmentDraftCapacityError, AttachmentDraftConflictError,
  parseAttachmentDraftFiles, discardAcceptedAttachmentFiles, validateAttachmentDraftFileIds,
  type AttachmentDraftFile, type AttachmentDraftStore } from "./draft-store.js";

export interface AttachmentDraftEntry<TSource> extends AttachmentDraftFile<TSource> {
  readonly uploadId: string;
}
export interface AttachmentDraftSnapshot<TSource> {
  readonly files: readonly AttachmentDraftEntry<TSource>[];
  readonly status: "loading" | "saving" | "saved" | "error";
  readonly error: string | null;
}

/** One account/API owner, independent of mounted composers and transcript caches.
 * Binary sources are bounded even while a cancelled adapter is still settling. */
export class AttachmentDraftWorkspace<TSource> {
  private readonly controllers = new Map<string, AttachmentDraftController<TSource>>();
  private retained = new Map<string, { file: AttachmentDraftFile<TSource>; count: number }>();
  private readonly deleted = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private closed = false;
  readonly adapter: AttachmentUploadAdapter<TSource>;

  constructor(readonly store: AttachmentDraftStore<TSource>, adapter: AttachmentUploadAdapter<TSource>) {
    this.adapter = { upload: async request => {
      const retained = [...this.retained.values()].find(value => value.file.selection.idempotencyKey === request.idempotencyKey &&
        value.file.selection.conversationId === request.metadata.conversationId);
      if (!retained || this.closed) throw new Error("Attachment draft is no longer available");
      const file = retained.file;
      this.replace([], [file]);
      let entered = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            const index = this.waiters.indexOf(enter);
            if (index >= 0) this.waiters.splice(index, 1);
            request.signal.removeEventListener("abort", abort);
            reject(new Error("Attachment upload cancelled"));
          };
          const enter = () => {
            request.signal.removeEventListener("abort", abort);
            if (request.signal.aborted || this.closed) { reject(new Error("Attachment upload cancelled")); return; }
            this.active++; entered = true; resolve();
          };
          if (request.signal.aborted) { abort(); return; }
          if (this.active < 2) enter();
          else { this.waiters.push(enter); request.signal.addEventListener("abort", abort, { once: true }); }
        });
        request.signal.throwIfAborted();
        return await adapter.upload(request);
      } finally {
        this.replace([file], []);
        if (entered) this.active--;
        while (this.active < 2 && this.waiters.length) this.waiters.shift()!();
      }
    } };
  }

  forConversation(conversationId: string): AttachmentDraftController<TSource> {
    if (this.closed || this.deleted.has(conversationId)) throw new Error("Attachment workspace is unavailable");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(conversationId)) throw new TypeError("Invalid attachment conversation");
    const old = this.controllers.get(conversationId);
    if (old) { this.controllers.delete(conversationId); this.controllers.set(conversationId, old); return old; }
    // Empty, unobserved controllers carry no unsent work. Retain file drafts
    // independently of the (smaller) transcript runtime cache.
    for (const [id, controller] of this.controllers) {
      if (this.controllers.size < ATTACHMENT_DRAFT_LIMITS.conversations + 1) break;
      if (controller.evictable) { controller.release(); this.controllers.delete(id); }
    }
    if (this.controllers.size >= ATTACHMENT_DRAFT_LIMITS.conversations + 1) throw new AttachmentDraftCapacityError();
    const controller = new AttachmentDraftController(conversationId, this);
    this.controllers.set(conversationId, controller);
    return controller;
  }

  /** Internal atomic reservations include files, writes, and real host futures. */
  replace(previous: readonly AttachmentDraftFile<TSource>[], next: readonly AttachmentDraftFile<TSource>[]): void {
    const values = new Map([...this.retained].map(([id, value]) => [id, { ...value }]));
    for (const file of previous) {
      const key = JSON.stringify([file.selection.conversationId, file.id]), value = values.get(key);
      if (value && --value.count === 0) values.delete(key);
    }
    for (const file of next) {
      const key = JSON.stringify([file.selection.conversationId, file.id]), value = values.get(key);
      if (value) value.count++;
      else values.set(key, { file, count: 1 });
    }
    if (values.size > ATTACHMENT_DRAFT_LIMITS.files ||
        [...values.values()].reduce((bytes, value) => bytes + value.file.selection.byteSize, 0) > ATTACHMENT_DRAFT_LIMITS.bytes ||
        new Set([...values.values()].map(value => value.file.selection.conversationId)).size > ATTACHMENT_DRAFT_LIMITS.conversations) {
      throw new AttachmentDraftCapacityError();
    }
    this.retained = values;
  }

  /** Fence ownership immediately after remote deletion, before fallible storage cleanup. */
  forgetConversation(conversationId: string): void {
    this.deleted.add(conversationId);
    this.controllers.get(conversationId)?.release();
    this.controllers.delete(conversationId);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const controllers = [...this.controllers.values()];
    for (const controller of controllers) controller.stopUploads();
    try { await Promise.all(controllers.map(controller => controller.flush().catch(() => undefined))); }
    finally {
      for (const controller of controllers) controller.release();
      this.controllers.clear();
    }
  }
}

/** Only the selected conversation is read. Save failures retain selections and
 * block upload admission; conflict replacement is an explicit user action. */
export class AttachmentDraftController<TSource> {
  readonly uploader: AttachmentUploader<TSource>;
  private files: readonly AttachmentDraftEntry<TSource>[] = Object.freeze([]);
  private version: string | null = null;
  private initialized = false;
  private closed = false;
  private dirty = false;
  private loadRevision = 0;
  private adopting = false;
  private writing: Promise<void> | null = null;
  private loading: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private snapshot: AttachmentDraftSnapshot<TSource> = Object.freeze({ files: this.files, status: "loading", error: null });
  constructor(readonly conversationId: string, private readonly owner: AttachmentDraftWorkspace<TSource>) {
    this.uploader = new AttachmentUploader(owner.adapter);
    this.uploader.subscribe(snapshot => this.uploadChanged(snapshot.items));
    this.loading = this.load();
  }
  getSnapshot = (): AttachmentDraftSnapshot<TSource> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get evictable(): boolean { return !this.closed && !this.dirty && !this.writing && !this.files.length && !this.listeners.size; }

  private emit(status: AttachmentDraftSnapshot<TSource>["status"], error: string | null = null): void {
    this.snapshot = Object.freeze({ files: this.files, status, error });
    for (const listener of this.listeners) { try { listener(); } catch { /* observer boundary */ } }
  }
  private failure(error: unknown): void {
    this.emit("error", error instanceof AttachmentDraftConflictError || error instanceof AttachmentDraftCapacityError
      ? error.message : "Files could not be saved on this device. Keep this page open and retry.");
  }
  private adopt(files: readonly AttachmentDraftFile<TSource>[]): void {
    if (this.uploader.disposed) throw new Error("Attachment draft is closed");
    if (files.filter(file => (file.selection.kind ?? "image") === "image").length > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest ||
        files.filter(file => file.selection.kind === "document").length > AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest) {
      throw new AttachmentDraftCapacityError();
    }
    this.owner.replace(this.files, files);
    const previous = this.files;
    const entries: AttachmentDraftEntry<TSource>[] = [];
    this.adopting = true;
    try {
      // Remove outgoing identities before inserting their replacements: the
      // same file may have a different upload key in a newer saved revision.
      for (const file of previous) if (!files.some(value => value.id === file.id)) this.uploader.remove(file.uploadId);
      for (const file of files) {
        const old = previous.find(value => value.id === file.id);
        if (old && file.reference) this.uploader.restoreReady(old.uploadId, file.reference);
        entries.push(Object.freeze({ ...file, uploadId: old?.uploadId ?? this.uploader.enqueue(file.selection,
          { defer: true, ...(file.reference ? { reference: file.reference } : {}) }) }));
      }
    } catch (error) {
      for (const file of entries) if (!previous.some(value => value.uploadId === file.uploadId)) this.uploader.remove(file.uploadId);
      this.owner.replace(files, previous); throw error;
    } finally { this.adopting = false; }
    this.files = Object.freeze(entries);
  }
  private async load(): Promise<void> {
    const revision = ++this.loadRevision;
    this.emit("loading");
    try {
      const saved = await this.owner.store.readAttachmentDraft(this.conversationId);
      if (this.closed || revision !== this.loadRevision) return;
      const files = parseAttachmentDraftFiles(saved?.files ?? [], this.conversationId);
      this.adopt(files); this.version = saved?.version ?? null;
      this.initialized = true; this.dirty = false; this.emit("saved");
      for (const file of this.files) this.uploader.start(file.uploadId);
    } catch (error) { if (!this.closed && revision === this.loadRevision) this.failure(error); }
  }
  async reload(): Promise<void> {
    if (this.closed) return;
    await this.loading;
    await this.writing?.catch(() => undefined);
    if (this.closed) return;
    this.loading = this.load(); await this.loading;
  }
  add(selections: readonly AttachmentSelection<TSource>[]): void {
    if (this.closed || !this.initialized || this.snapshot.status === "loading") throw new Error("Files are still restoring");
    const added = selections.map(selection => {
      const id = crypto.randomUUID();
      return { id, selection: { ...selection, conversationId: this.conversationId, idempotencyKey: `draft:${id}` } };
    });
    this.adopt(parseAttachmentDraftFiles([...this.files, ...added], this.conversationId));
    this.dirty = true; this.emit("saving"); void this.flush().catch(() => undefined);
  }
  remove(uploadIds: readonly string[]): boolean {
    if (this.closed || this.snapshot.status === "loading") return false;
    const ids = new Set(uploadIds), next = this.files.filter(file => !ids.has(file.uploadId));
    if (next.length === this.files.length) return false;
    this.adopt(next); this.dirty = true; this.emit("saving"); void this.flush().catch(() => undefined); return true;
  }
  captureFileIds(uploadIds: readonly string[]): readonly string[] {
    const selected = new Set(uploadIds);
    return Object.freeze(this.files.filter(file => selected.has(file.uploadId)).map(file => file.id));
  }
  /** Replayed admission can arrive without a mounted composer. Remove only
   * its stable selection IDs and serialize against all in-flight local writes. */
  reconcileAccepted(fileIds: readonly string[]): Promise<void> {
    validateAttachmentDraftFileIds(fileIds);
    const ids = new Set(fileIds), previous = this.writing;
    const work = Promise.resolve().then(async () => {
      await previous?.catch(() => undefined); await this.loading;
      if (this.closed) throw new Error("Attachment draft is closed");
      const result = await discardAcceptedAttachmentFiles(this.owner.store, this.conversationId, fileIds);
      if (this.closed) return;
      this.adopt(this.files.filter(file => !ids.has(file.id)));
      if (this.version === result.previousVersion) {
        this.version = result.version; this.emit(this.dirty ? "saving" : "saved");
      } else {
        // Another tab's newer selection set is authoritative in storage. Keep
        // local edits visible, but do not rebase them over unobserved remote files.
        this.failure(new AttachmentDraftConflictError());
      }
    }).catch((cause: unknown) => { if (!this.closed) this.failure(cause); throw cause; }).finally(() => {
      if (this.writing === work) {
        this.writing = null;
        if (!this.closed && this.dirty) void this.flush().catch(() => undefined);
      }
    });
    this.writing = work; return work;
  }
  private uploadChanged(items: readonly AttachmentUploadItem[]): void {
    if (this.closed || this.adopting) return;
    let changed = false;
    const next = this.files.map(file => {
      const item = items.find(item => item.id === file.uploadId);
      if (file.reference || item?.status !== "ready") return file;
      changed = true; return Object.freeze({ ...file, reference: item.reference });
    });
    if (!changed) return;
    this.files = Object.freeze(next); this.dirty = true; this.emit("saving"); void this.flush().catch(() => undefined);
  }
  flush = async (): Promise<void> => {
    await this.loading;
    if (this.closed) return;
    if (!this.initialized) { this.loading = this.load(); await this.loading; return; }
    if (this.writing) { await this.writing; if (this.dirty) await this.flush(); return; }
    if (!this.dirty) return;
    const work = this.persist(); this.writing = work;
    try { await work; } finally { if (this.writing === work) this.writing = null; }
  };
  private async persist(): Promise<void> {
    try {
      while (this.dirty && !this.closed) {
        this.dirty = false; const files = this.files;
        this.owner.replace([], files); this.emit("saving");
        try {
          const saved = await this.owner.store.writeAttachmentDraft(this.conversationId, files, this.version);
          if (this.closed) return;
          this.version = saved?.version ?? null;
          for (const file of files) if (!this.uploader.disposed && this.files.some(current => current.id === file.id)) this.uploader.start(file.uploadId);
        } catch (error) { this.dirty = true; throw error; }
        finally { this.owner.replace(files, []); }
      }
      if (!this.closed) this.emit("saved");
    } catch (error) { if (!this.closed) this.failure(error); throw error; }
  }
  stopUploads(): void { this.uploader.dispose(); }
  /** Local eviction/deletion. Deliberately does not remove the saved record. */
  release(): void {
    if (this.closed) return;
    this.closed = true; this.uploader.dispose(); this.owner.replace(this.files, []);
    this.files = Object.freeze([]); this.emit("error", "Attachment draft is closed."); this.listeners.clear();
  }
}
