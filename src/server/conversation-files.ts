import { createHash } from "node:crypto";
import { AttachmentStagingError, createAttachmentStagingService, type StagedAttachmentRecord } from "../attachments/staging.js";
import { assertPostgresConversationWritable, lockPostgresAttachmentBlob } from "../postgres/conversation-deletion.js";
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
  readonly contentRef: string;
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
  /** Stable service partition for the explicit SDK staging-expiry worker. Only
   * uploads created with this policy are eligible; old rows are never adopted. */
  readonly maintenanceScopeId?: string;
  readonly now?: () => number;
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
 * This adapter shares SDK staging and Postgres stores. Standard
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
  const clock = options.now ?? Date.now;
  const maintenanceScopeId = options.maintenanceScopeId ?? "conversation-files";
  if (typeof maintenanceScopeId !== "string" || !maintenanceScopeId || maintenanceScopeId.length > 256) throw new TypeError("Invalid file maintenance scope.");
  class ManagedStagingMetadata extends PostgresAttachmentStagingMetadataStore {
    override create(record: StagedAttachmentRecord) {
      const managed = { ...record, retention: { version: 1, scopeId: maintenanceScopeId } };
      return super.create(managed);
    }
  }
  const stagingFor = (store: PostgresAiPersistence) => createAttachmentStagingService({
    blobs: new PostgresAttachmentBlobStore(store, tenantId),
    metadata: new ManagedStagingMetadata(store, tenantId, uploadScope), now: clock,
    limits: { maximumBytes: limits.maximumBytesPerFile, acceptedMediaTypes: limits.acceptedMediaTypes,
      ttlMilliseconds: limits.stagingTtlMilliseconds ?? 15 * 60_000, cleanupBatchSize: 100 },
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  const staging = stagingFor(persistence);
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
      typeof value.contentRef !== "string" || typeof value.blobKey !== "string" ||
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
  const retain = (conversationId: string, attachmentId: string, contentRef: string, input: ConversationFileInput, staged: StagedAttachmentRecord) => {
    const file = validate(input);
    const scopeId = savedScope(conversationId);
    const value: RetainedConversationFile = { schemaVersion: 1, principalId, conversationId, attachmentId, contentRef,
      fileName: file.fileName, mediaType: file.mediaType, byteSize: file.data.byteLength, sha256: digest(file.data),
      blobKey: blobKey(conversationId, attachmentId) };
    return persistence.client.transaction(async client => {
      // Match deletion's lock order: conversation, then blobs/references.
      await assertPostgresConversationWritable(client, tenantId, conversationId);
      await lockPostgresAttachmentBlob(client, tenantId, staged.blobKey);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify([options.identity?.lockNamespace ?? "assistant-file", tenantId, scopeId, attachmentId])]);
      const transaction = new PostgresAiPersistence(client);
      const existing = await saved(conversationId, attachmentId, transaction);
      if (existing) {
        if (Object.keys(value).some(key => existing[key as keyof RetainedConversationFile] !== value[key as keyof RetainedConversationFile])) throw invalid();
        return existing;
      }
      const current = await transaction.getDocument<StagedAttachmentRecord>(tenantId, "attachment", uploadScope, staged.contentRef);
      if (!current || current.value.consumedAt || JSON.stringify(current.value) !== JSON.stringify(staged)) throw unavailable();
      if (Date.parse(current.value.expiresAt) <= clock()) throw new AttachmentStagingError("expired");
      await new PostgresAttachmentBlobStore(transaction, tenantId).put({
        key: value.blobKey, bytes: file.data, mediaType: file.mediaType, expiresAt: "infinity" });
      await transaction.compareAndSetDocument({ tenantId, kind: "attachment", scopeId,
        recordId: attachmentId, expectedVersion: null, value });
      await transaction.compareAndSetDocument({ ...current, expectedVersion: current.version,
        value: { ...current.value, consumedAt: new Date(clock()).toISOString(), retainedConversationId: conversationId } });
      // Consumption and retained bytes commit together. Keep other SDK/business
      // references if a host deliberately shares this blob identity.
      await client.query(`DELETE FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2
        AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'
          AND payload->>'blobKey'=$2 AND NOT (scope_id=$3 AND record_id=$4))`,
      [tenantId, staged.blobKey, uploadScope, staged.contentRef]);
      return value;
    });
  };
  return Object.freeze({
    async stage(input: ConversationFileInput & { readonly idempotencyKey: string }): Promise<AttachmentReference> {
      if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(input.idempotencyKey)) throw invalid();
      const file = validate(input);
      // Blob allocation and metadata claim share one transaction: a failed or
      // lost stage cannot leave an undiscoverable new binary orphan.
      return persistence.client.transaction(client => stagingFor(new PostgresAiPersistence(client)).stage({
        ownerScopeId: uploadScope, conversationId: uploadScope, idempotencyKey: input.idempotencyKey,
        fingerprint: digest(JSON.stringify([file.fileName, file.mediaType, file.data.byteLength, digest(file.data)])),
        mediaType: file.mediaType, filename: file.fileName, bytes: file.data }));
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
            fileName: staged.record.filename ?? "attachment", mediaType: staged.record.mediaType, data: staged.bytes }, staged.record);
        }
        if (file.contentRef !== reference.content_ref || file.mediaType !== reference.media_type ||
          file.byteSize !== reference.byte_size || file.fileName !== reference.filename) throw invalid();
        result.push({ fileName: file.fileName, mediaType: file.mediaType, data: await bytes(file) });
      }
      await options.authorizeConversation(conversationId);
      return result;
    },
    async download(conversationId: string, attachmentId: string): Promise<ConversationFileInput> {
      await options.authorizeConversation(conversationId);
      const file = await saved(conversationId, attachmentId);
      if (!file) throw new AttachmentStagingError("not_found");
      const data = await bytes(file);
      await options.authorizeConversation(conversationId);
      return { fileName: file.fileName, mediaType: file.mediaType, data };
    },
  });
}
