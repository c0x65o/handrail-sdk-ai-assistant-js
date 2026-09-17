import {
  AI_RUNTIME_ATTACHMENT_ID_GRAMMAR,
  AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR,
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type AttachmentReference,
} from "../protocol.js";
import {
  AttachmentUploadAdapterError,
  AttachmentUploadValidationError,
  type AttachmentSelection,
  type AttachmentUploadAdapter,
  type AttachmentUploadFailure,
  type AttachmentUploadItem,
  type AttachmentUploadKind,
  type AttachmentUploadProgress,
  type AttachmentUploaderListener,
  type AttachmentUploaderOptions,
  type AttachmentUploaderSnapshot,
  type NormalizedAttachmentUploadMetadata,
} from "./types.js";

export const ATTACHMENT_UPLOAD_MAX_CONCURRENCY = 16 as const;

interface InternalItem<TSource> {
  held: boolean;
  source: TSource | undefined;
  sourceRetained: boolean;
  item: AttachmentUploadItem;
  controller: AbortController | null;
  runToken: number;
}

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const ATTACHMENT_ID_PATTERN = new RegExp(AI_RUNTIME_ATTACHMENT_ID_GRAMMAR);
const CONTENT_REFERENCE_PATTERN = new RegExp(
  AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR,
);
const IMAGE_MIME_TYPES = new Set<string>(AI_RUNTIME_IMAGE_MIME_TYPES);
const DOCUMENT_MIME_TYPES = new Set<string>(AI_RUNTIME_DOCUMENT_MIME_TYPES);

function metadataFrom(
  selection: {
    readonly kind?: AttachmentUploadKind;
    readonly mediaType: NormalizedAttachmentUploadMetadata["mediaType"];
    readonly byteSize: number;
    readonly filename?: string;
    readonly conversationId?: string;
  },
): NormalizedAttachmentUploadMetadata {
  const kind = selection.kind ?? "image";
  return (selection.filename === undefined
    ? { kind, mediaType: selection.mediaType, byteSize: selection.byteSize,
        ...(selection.conversationId === undefined ? {} : { conversationId: selection.conversationId }) }
    : {
        kind,
        mediaType: selection.mediaType,
        byteSize: selection.byteSize,
        filename: selection.filename,
        ...(selection.conversationId === undefined ? {} : { conversationId: selection.conversationId }),
      }) as NormalizedAttachmentUploadMetadata;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasCredentialMaterial(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function validateSafeFilename(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength ||
    value === "." ||
    value === ".." ||
    hasCredentialMaterial(value) ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 ||
        codePoint === 127 ||
        '<>:"/\\|?*'.includes(character);
    })
  ) {
    throw new AttachmentUploadValidationError("Attachment filename is invalid");
  }
}

function validateOpaqueKey(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ||
    /^(?:data|blob|https?):/i.test(value) ||
    hasCredentialMaterial(value)
  ) {
    throw new AttachmentUploadValidationError(
      `${field} must be a safe opaque identifier of at most 256 characters`,
    );
  }
}

function validateMetadata(
  metadata: NormalizedAttachmentUploadMetadata,
): void {
  const isImage = metadata.kind === "image";
  const supportedMime = isImage
    ? IMAGE_MIME_TYPES.has(metadata.mediaType)
    : DOCUMENT_MIME_TYPES.has(metadata.mediaType);
  const minBytes = isImage
    ? AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes
    : AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes;
  const maxBytes = isImage
    ? AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes
    : AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes;
  if (
    !supportedMime ||
    !Number.isSafeInteger(metadata.byteSize) ||
    metadata.byteSize < minBytes ||
    metadata.byteSize > maxBytes
  ) {
    throw new AttachmentUploadValidationError(
      "Attachment kind, media type, or byte size is invalid",
    );
  }
  if (metadata.filename !== undefined) validateSafeFilename(metadata.filename);
  if (metadata.conversationId !== undefined) validateOpaqueKey(metadata.conversationId, "conversationId");
}

export function validateAttachmentSelection<TSource>(
  selection: AttachmentSelection<TSource>,
): NormalizedAttachmentUploadMetadata {
  if (selection === null || typeof selection !== "object") {
    throw new AttachmentUploadValidationError("Attachment selection must be an object");
  }
  validateOpaqueKey(selection.fingerprint, "fingerprint");
  validateOpaqueKey(selection.idempotencyKey, "idempotencyKey");
  if (
    selection.kind !== undefined &&
    selection.kind !== "image" &&
    selection.kind !== "document"
  ) {
    throw new AttachmentUploadValidationError(
      "Attachment kind, media type, or byte size is invalid",
    );
  }
  const metadata = metadataFrom(selection);
  validateMetadata(metadata);
  return metadata;
}

function validatedAdapterResult(
  value: unknown,
  requested: NormalizedAttachmentUploadMetadata,
): AttachmentReference {
  if (!isPlainRecord(value)) {
    throw new AttachmentUploadValidationError("Attachment adapter result is unsafe");
  }
  const requiredKeys = ["attachment_id", "content_ref", "media_type", "byte_size"];
  const allowedKeys = new Set([...requiredKeys, "filename"]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.attachment_id !== "string" ||
    value.attachment_id.length > AI_RUNTIME_PROTOCOL_LIMITS.attachmentIdLength ||
    !ATTACHMENT_ID_PATTERN.test(value.attachment_id) ||
    hasCredentialMaterial(value.attachment_id) ||
    typeof value.content_ref !== "string" ||
    value.content_ref.length >
      AI_RUNTIME_PROTOCOL_LIMITS.attachmentContentReferenceLength ||
    !CONTENT_REFERENCE_PATTERN.test(value.content_ref) ||
    hasCredentialMaterial(value.content_ref)
  ) {
    throw new AttachmentUploadValidationError("Attachment adapter result is unsafe");
  }
  if (Object.hasOwn(value, "filename")) validateSafeFilename(value.filename);

  if (
    value.media_type !== requested.mediaType ||
    value.byte_size !== requested.byteSize ||
    value.filename !== requested.filename ||
    (requested.kind === "image"
      ? !IMAGE_MIME_TYPES.has(String(value.media_type))
      : !DOCUMENT_MIME_TYPES.has(String(value.media_type)))
  ) {
    throw new AttachmentUploadValidationError(
      "Attachment adapter result does not match the requested identity",
    );
  }
  const reference = value as unknown as AttachmentReference;
  return Object.freeze(
    reference.filename === undefined
      ? {
          attachment_id: reference.attachment_id,
          content_ref: reference.content_ref,
          media_type: reference.media_type,
          byte_size: reference.byte_size,
        }
      : {
          attachment_id: reference.attachment_id,
          content_ref: reference.content_ref,
          media_type: reference.media_type,
          byte_size: reference.byte_size,
          filename: reference.filename,
        },
  );
}

export function validateAttachmentUploadReference(
  value: unknown,
  requested: NormalizedAttachmentUploadMetadata,
): AttachmentReference {
  try {
    return validatedAdapterResult(value, requested);
  } catch (error) {
    if (error instanceof AttachmentUploadValidationError) throw error;
    throw new AttachmentUploadValidationError("Attachment adapter result is unsafe");
  }
}

function initialProgress(totalBytes: number): AttachmentUploadProgress {
  return { uploadedBytes: 0, totalBytes };
}

function normalizedFailure(error: unknown): AttachmentUploadFailure {
  if (error instanceof AttachmentUploadValidationError) {
    return {
      code: "invalid_result",
      message: "The attachment service returned an invalid result.",
      retryable: false,
    };
  }
  return {
    code: "upload_failed",
    message: "The attachment could not be uploaded.",
    retryable:
      error instanceof AttachmentUploadAdapterError && error.retryable === true,
  };
}

export class AttachmentUploader<TSource = unknown> {
  readonly #adapter: AttachmentUploadAdapter<TSource>;
  readonly #concurrency: number;
  readonly #maxCounts: Readonly<Record<AttachmentUploadKind, number>>;
  readonly #items = new Map<string, InternalItem<TSource>>();
  readonly #listeners = new Set<AttachmentUploaderListener>();
  #activeCount = 0;
  #nextId = 1;
  #disposed = false;

  constructor(
    adapter: AttachmentUploadAdapter<TSource>,
    options: AttachmentUploaderOptions = {},
  ) {
    const concurrency = options.concurrency ?? 3;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > ATTACHMENT_UPLOAD_MAX_CONCURRENCY
    ) {
      throw new AttachmentUploadValidationError(
        `concurrency must be an integer from 1 through ${ATTACHMENT_UPLOAD_MAX_CONCURRENCY}`,
      );
    }
    this.#adapter = adapter;
    this.#concurrency = concurrency;
    const maxImageCount = options.maxImageCount ??
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest;
    const maxDocumentCount = options.maxDocumentCount ??
      AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest;
    this.#validateCountLimit(
      maxImageCount,
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest,
      "maxImageCount",
    );
    this.#validateCountLimit(
      maxDocumentCount,
      AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest,
      "maxDocumentCount",
    );
    this.#maxCounts = Object.freeze({
      image: maxImageCount,
      document: maxDocumentCount,
    });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getSnapshot(): AttachmentUploaderSnapshot {
    const items = [...this.#items.values()].map((entry) =>
      Object.freeze({
        ...entry.item,
        progress: Object.freeze({ ...entry.item.progress }),
        ...(entry.item.status === "ready"
          ? { reference: Object.freeze({ ...entry.item.reference }) }
          : {}),
      }) as AttachmentUploadItem,
    );
    return Object.freeze({
      items: Object.freeze(items),
      activeCount: this.#disposed ? 0 : this.#activeCount,
      queuedCount: items.filter((item) => item.status === "queued").length,
    });
  }

  subscribe(listener: AttachmentUploaderListener): () => void {
    this.#assertUsable();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  enqueue(selection: AttachmentSelection<TSource>, options: {
    /** Hold a new upload until its immutable source and upload key are durable. */
    readonly defer?: boolean;
    /** Restore a validated completed upload without sending its bytes again. */
    readonly reference?: AttachmentReference;
  } = {}): string {
    this.#assertUsable();
    const metadata = validateAttachmentSelection(selection);
    const reference = options.reference === undefined ? undefined : validateAttachmentUploadReference(options.reference, metadata);

    for (const entry of this.#items.values()) {
      if (entry.item.fingerprint === selection.fingerprint) return entry.item.id;
    }

    const kindCount = [...this.#items.values()].filter(
      (entry) => entry.item.kind === metadata.kind,
    ).length;
    if (kindCount >= this.#maxCounts[metadata.kind]) {
      throw new AttachmentUploadValidationError(
        `Attachment ${metadata.kind} count exceeds the configured queue limit`,
      );
    }

    const id = `attachment-upload-${this.#nextId}`;
    this.#nextId += 1;
    const base = {
      id,
      fingerprint: selection.fingerprint,
      idempotencyKey: selection.idempotencyKey,
      ...metadata,
      attempt: 0,
    };
    const item: AttachmentUploadItem = reference === undefined
      ? { ...base, status: "queued", progress: initialProgress(metadata.byteSize) }
      : { ...base, status: "ready", reference, progress: { uploadedBytes: metadata.byteSize, totalBytes: metadata.byteSize } };
    this.#items.set(id, {
      held: options.defer === true,
      source: reference === undefined ? selection.source : undefined,
      sourceRetained: reference === undefined,
      item,
      controller: null,
      runToken: 0,
    });
    this.#emit();
    this.#pump();
    return id;
  }

  /** Release an upload held for durable draft admission. */
  start(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry || !entry.held || entry.item.status !== "queued") return false;
    entry.held = false;
    this.#pump();
    return true;
  }

  /** Adopt completion saved by another view of this exact selected upload. */
  restoreReady(id: string, reference: AttachmentReference): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry) return false;
    const validated = validateAttachmentUploadReference(reference, metadataFrom(entry.item));
    entry.runToken++;
    entry.controller?.abort();
    entry.source = undefined; entry.sourceRetained = false; entry.held = false;
    entry.item = { ...entry.item, status: "ready", reference: validated,
      progress: { uploadedBytes: entry.item.byteSize, totalBytes: entry.item.byteSize } };
    this.#emit(); this.#pump(); return true;
  }

  cancel(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry || (entry.item.status !== "queued" && entry.item.status !== "uploading")) {
      return false;
    }
    entry.item = {
      ...entry.item,
      status: "cancelled",
    };
    entry.runToken += 1;
    entry.controller?.abort();
    entry.source = undefined;
    entry.sourceRetained = false;
    this.#emit();
    this.#pump();
    return true;
  }

  retry(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (
      !entry ||
      entry.item.status !== "failed" ||
      !entry.item.error.retryable
    ) {
      return false;
    }
    const { error: previousError, ...item } = entry.item;
    void previousError;
    entry.item = {
      ...item,
      status: "queued",
      progress: initialProgress(entry.item.byteSize),
    };
    this.#emit();
    this.#pump();
    return true;
  }

  remove(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry) return false;
    entry.runToken += 1;
    entry.controller?.abort();
    this.#items.delete(id);
    this.#emit();
    this.#pump();
    return true;
  }

  getReadyReferences(itemIds?: readonly string[]): readonly AttachmentReference[] {
    const entries = itemIds === undefined
      ? [...this.#items.values()]
      : itemIds.flatMap((id) => {
          const entry = this.#items.get(id);
          return entry === undefined ? [] : [entry];
        });
    return Object.freeze(
      entries.flatMap((entry) =>
        entry.item.status === "ready" ? [entry.item.reference] : [],
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#items.values()) {
      entry.runToken += 1;
      entry.controller?.abort();
    }
    this.#items.clear();
    this.#listeners.clear();
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AttachmentUploadValidationError("Attachment uploader is disposed");
    }
  }

  #validateCountLimit(value: number, protocolMaximum: number, field: string): void {
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > protocolMaximum
    ) {
      throw new AttachmentUploadValidationError(
        `${field} must be an integer from 0 through ${protocolMaximum}`,
      );
    }
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observer failures do not alter upload lifecycle state.
      }
    }
  }

  #pump(): void {
    if (this.#disposed) return;
    while (this.#activeCount < this.#concurrency) {
      const entry = [...this.#items.values()].find(
        (candidate) => !candidate.held && candidate.item.status === "queued",
      );
      if (!entry) return;
      void this.#upload(entry);
    }
  }

  async #upload(entry: InternalItem<TSource>): Promise<void> {
    if (!entry.sourceRetained) return;
    const source = entry.source as TSource;
    const controller = new AbortController();
    const token = entry.runToken + 1;
    entry.runToken = token;
    entry.controller = controller;
    this.#activeCount += 1;
    entry.item = {
      ...entry.item,
      attempt: entry.item.attempt + 1,
      status: "uploading",
    };
    this.#emit();

    const metadata = metadataFrom(entry.item);
    const reportProgress = (progress: AttachmentUploadProgress): void => {
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading" ||
        progress.totalBytes !== entry.item.byteSize ||
        !Number.isFinite(progress.uploadedBytes) ||
        !Number.isInteger(progress.uploadedBytes) ||
        progress.uploadedBytes < entry.item.progress.uploadedBytes ||
        progress.uploadedBytes > entry.item.byteSize
      ) {
        return;
      }
      entry.item = {
        ...entry.item,
        progress: {
          uploadedBytes: progress.uploadedBytes,
          totalBytes: progress.totalBytes,
        },
      };
      this.#emit();
    };

    try {
      const result = await this.#adapter.upload({
        source,
        metadata,
        idempotencyKey: entry.item.idempotencyKey,
        signal: controller.signal,
        onProgress: reportProgress,
      });
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading"
      ) {
        return;
      }
      const reference = validateAttachmentUploadReference(result, metadata);
      entry.item = {
        ...entry.item,
        status: "ready",
        progress: {
          uploadedBytes: entry.item.byteSize,
          totalBytes: entry.item.byteSize,
        },
        reference,
      };
      entry.source = undefined;
      entry.sourceRetained = false;
      this.#emit();
    } catch (error) {
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading"
      ) {
        return;
      }
      const failure = normalizedFailure(error);
      entry.item = {
        ...entry.item,
        status: "failed",
        error: failure,
      };
      if (!failure.retryable) {
        entry.source = undefined;
        entry.sourceRetained = false;
      }
      this.#emit();
    } finally {
      if (entry.controller === controller) entry.controller = null;
      this.#activeCount -= 1;
      if (!this.#disposed) {
        this.#emit();
        this.#pump();
      }
    }
  }
}

export function createAttachmentUploader<TSource = unknown>(
  adapter: AttachmentUploadAdapter<TSource>,
  options?: AttachmentUploaderOptions,
): AttachmentUploader<TSource> {
  return new AttachmentUploader(adapter, options);
}
