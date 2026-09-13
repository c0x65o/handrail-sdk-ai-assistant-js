import { createHash } from "node:crypto";
import { AttachmentStagingError, createAttachmentStagingService } from "../attachments/staging.js";
import type { AiDiagnosticSink } from "../diagnostics.js";
import type { AttachmentReference } from "../protocol.js";
import { PostgresAiPersistence, PostgresAttachmentBlobStore, PostgresAttachmentStagingMetadataStore } from "../postgres/index.js";

export interface ConversationFileInput {
  readonly fileName: string;
  readonly mediaType: string;
  readonly data: Uint8Array;
}

export interface RetainedConversationFile {
  readonly schemaVersion: 1;
  readonly attachmentId: string;
  readonly conversationId: string;
  readonly principalId: string;
  readonly contentRef: string | null;
  readonly blobKey: string;
  readonly sha256: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface ConversationFileStorageOptions {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  readonly principalId: string;
  /** Must check current access for every materialization and download, including replay. */
  readonly authorizeConversation: (conversationId: string) => Promise<void>;
  /** Host content policy may normalize filenames/MIME types or reject unsupported business inputs. */
  readonly validateFile: (input: ConversationFileInput) => ConversationFileInput;
  readonly limits: {
    readonly maximumFiles: number;
    readonly maximumBytesPerFile: number;
    readonly maximumTotalBytes: number;
    readonly acceptedMediaTypes: readonly string[];
    readonly stagingTtlMilliseconds?: number;
  };
  readonly diagnostics?: AiDiagnosticSink;
  /** Freeze these when adapting existing storage. Changing identities needs an explicit migration. */
  readonly identity?: {
    readonly uploadScopeId?: string;
    readonly savedScopeId?: (conversationId: string) => string;
    readonly blobKey?: (conversationId: string, attachmentId: string) => string;
    readonly lockNamespace?: string;
  };
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const invalid = () => new AttachmentStagingError("invalid_input");
const unavailable = () => new AttachmentStagingError("unavailable");

/** Retains immutable conversation files independently of temporary upload expiry.
 * This compatibility adapter shares SDK staging and Postgres stores. Standard
 * high-level assistants keep their configured staging retention unless opted in.
 */
export function createConversationFileStorage(options: ConversationFileStorageOptions) {
  const { persistence, tenantId, principalId, limits } = options;
  for (const limit of [limits.maximumFiles, limits.maximumBytesPerFile, limits.maximumTotalBytes]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Conversation file limits must be positive safe integers.");
  }
  const uploadScope = options.identity?.uploadScopeId ?? `assistant-upload:${principalId}`;
  const savedScope = options.identity?.savedScopeId ?? ((conversationId: string) =>
    `assistant-files:${digest(JSON.stringify([principalId, conversationId]))}`);
  const blobKey = options.identity?.blobKey ?? ((conversationId: string, attachmentId: string) =>
    `blob_saved_${digest(JSON.stringify([principalId, conversationId, attachmentId]))}`);
  const staging = createAttachmentStagingService({
    blobs: new PostgresAttachmentBlobStore(persistence, tenantId),
    metadata: new PostgresAttachmentStagingMetadataStore(persistence, tenantId, uploadScope),
    limits: { maximumBytes: limits.maximumBytesPerFile, acceptedMediaTypes: limits.acceptedMediaTypes,
      ttlMilliseconds: limits.stagingTtlMilliseconds ?? 15 * 60_000, cleanupBatchSize: 100 },
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  const validFileMetadata = (fileName: unknown, mediaType: unknown, byteSize: unknown) =>
    typeof fileName === "string" && fileName.length > 0 && fileName.length <= 180 &&
    typeof mediaType === "string" && limits.acceptedMediaTypes.includes(mediaType) &&
    typeof byteSize === "number" && Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= limits.maximumBytesPerFile;
  const validate = (input: ConversationFileInput): ConversationFileInput => {
    if (!(input.data instanceof Uint8Array) || input.data.byteLength < 1 || input.data.byteLength > limits.maximumBytesPerFile) throw invalid();
    // Freeze caller bytes before any asynchronous claim or storage work.
    const file = options.validateFile({ ...input, data: new Uint8Array(input.data) });
    if (!validFileMetadata(file.fileName, file.mediaType, file.data.byteLength)) throw invalid();
    return { ...file, data: new Uint8Array(file.data) };
  };
  const saved = async (conversationId: string, attachmentId: string, store = persistence) => {
    const stored = await store.getDocument<RetainedConversationFile>(tenantId, "attachment", savedScope(conversationId), attachmentId);
    if (!stored) return null;
    const value = stored.value;
    if (!value || typeof value !== "object" || value.schemaVersion !== 1 || value.principalId !== principalId ||
      value.conversationId !== conversationId || value.attachmentId !== attachmentId ||
      !(value.contentRef === null || typeof value.contentRef === "string") || typeof value.blobKey !== "string" ||
      typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256) ||
      !validFileMetadata(value.fileName, value.mediaType, value.byteSize) ||
      Object.keys(value).some(key => !["schemaVersion", "attachmentId", "conversationId", "principalId", "contentRef",
        "blobKey", "sha256", "fileName", "mediaType", "byteSize"].includes(key))) throw unavailable();
    return value;
  };
  const bytes = async (file: RetainedConversationFile) => {
    const data = await new PostgresAttachmentBlobStore(persistence, tenantId).get(file.blobKey);
    if (!data || data.byteLength !== file.byteSize || digest(data) !== file.sha256) throw unavailable();
    return data;
  };
  const retain = (conversationId: string, attachmentId: string, contentRef: string | null, input: ConversationFileInput) => {
    const file = validate(input);
    const scopeId = savedScope(conversationId);
    const value: RetainedConversationFile = { schemaVersion: 1, principalId, conversationId, attachmentId, contentRef,
      fileName: file.fileName, mediaType: file.mediaType, byteSize: file.data.byteLength, sha256: digest(file.data),
      blobKey: blobKey(conversationId, attachmentId) };
    return persistence.client.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([options.identity?.lockNamespace ?? "assistant-file", tenantId, scopeId, attachmentId])]);
      const transaction = new PostgresAiPersistence(client);
      const existing = await saved(conversationId, attachmentId, transaction);
      if (existing) {
        if (Object.keys(value).some(key => existing[key as keyof RetainedConversationFile] !== value[key as keyof RetainedConversationFile])) throw invalid();
        return existing;
      }
      await new PostgresAttachmentBlobStore(transaction, tenantId).put({
        key: value.blobKey, bytes: file.data, mediaType: file.mediaType, expiresAt: "infinity" });
      await transaction.compareAndSetDocument({ tenantId, kind: "attachment", scopeId,
        recordId: attachmentId, expectedVersion: null, value });
      return value;
    });
  };
  return Object.freeze({
    async stage(input: ConversationFileInput & { readonly idempotencyKey: string }): Promise<AttachmentReference> {
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)) throw invalid();
      const file = validate(input);
      const reference = await staging.stage({ ownerScopeId: uploadScope, conversationId: uploadScope,
        idempotencyKey: input.idempotencyKey,
        fingerprint: digest(JSON.stringify([file.fileName, file.mediaType, file.data.byteLength, digest(file.data)])),
        mediaType: file.mediaType, filename: file.fileName, bytes: file.data });
      void staging.cleanupExpired().catch(() => undefined);
      return reference;
    },
    async materialize(conversationId: string, references: readonly AttachmentReference[]): Promise<readonly ConversationFileInput[]> {
      await options.authorizeConversation(conversationId);
      if (references.length > limits.maximumFiles) throw invalid();
      const parsed = references.map(reference => {
        if (!/^att_[A-Za-z0-9][A-Za-z0-9._-]{0,251}$/u.test(reference.attachment_id) ||
          !/^(?:ref|blob)_[A-Za-z0-9][A-Za-z0-9._-]{0,251}$/u.test(reference.content_ref) ||
          !validFileMetadata(reference.filename, reference.media_type, reference.byte_size) ||
          Object.keys(reference).some(key => !["attachment_id", "content_ref", "media_type", "byte_size", "filename"].includes(key))) throw invalid();
        return { ...reference };
      });
      if (parsed.reduce((size, ref) => size + ref.byte_size, 0) > limits.maximumTotalBytes ||
        new Set(parsed.map(ref => ref.attachment_id)).size !== parsed.length) throw invalid();
      const result: ConversationFileInput[] = [];
      for (const reference of parsed) {
        let file = await saved(conversationId, reference.attachment_id);
        if (!file) {
          const staged = await staging.resolve({ ownerScopeId: uploadScope, conversationId: uploadScope, contentRef: reference.content_ref });
          if (staged.record.attachmentId !== reference.attachment_id || staged.record.mediaType !== reference.media_type ||
            staged.record.byteSize !== reference.byte_size || staged.record.filename !== reference.filename) throw invalid();
          file = await retain(conversationId, reference.attachment_id, reference.content_ref, {
            fileName: staged.record.filename ?? "attachment", mediaType: staged.record.mediaType, data: staged.bytes });
          // Retention commits before consumption. Retry can reopen saved bytes
          // after a crash even if the upload has since expired or been consumed.
          await staging.consume({ ownerScopeId: uploadScope, conversationId: uploadScope, contentRef: reference.content_ref });
        }
        if (file.contentRef !== reference.content_ref || file.mediaType !== reference.media_type ||
          file.byteSize !== reference.byte_size || file.fileName !== reference.filename) throw invalid();
        result.push({ fileName: file.fileName, mediaType: file.mediaType, data: await bytes(file) });
      }
      return result;
    },
    /** Server-trusted history import only. Caller authorizes the original source and target ownership. */
    import(conversationId: string, attachmentId: string, input: ConversationFileInput) {
      return retain(conversationId, attachmentId, null, input);
    },
    async download(conversationId: string, attachmentId: string): Promise<ConversationFileInput> {
      await options.authorizeConversation(conversationId);
      const file = await saved(conversationId, attachmentId);
      if (!file) throw new AttachmentStagingError("not_found");
      return { fileName: file.fileName, mediaType: file.mediaType, data: await bytes(file) };
    },
  });
}
