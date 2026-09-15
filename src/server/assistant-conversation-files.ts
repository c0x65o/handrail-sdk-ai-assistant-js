import { createHash } from "node:crypto";
import { createAttachmentStagingService, AttachmentStagingError, type AttachmentStagingLimits } from "../attachments/staging.js";
import { assertConversationAttachmentMatches } from "../attachments/references.js";
import { parseConversationEvent, type ConversationAttachmentReference } from "../conversation/events.js";
import { replayConversation } from "../conversation/replay.js";
import { PostgresAiPersistence, PostgresAttachmentBlobStore, PostgresAttachmentStagingMetadataStore,
  PostgresConversationEventStore } from "../postgres/index.js";
import { assertPostgresConversationWritable } from "../postgres/conversation-deletion.js";
import type { AttachmentReference } from "../protocol.js";
import { createAttachmentContentValidator, STANDARD_ATTACHMENT_MEDIA_TYPES } from "./attachment-content.js";
import { createConversationFileStorage, type ConversationFileInput } from "./conversation-files.js";
import { createSavedFileHandles } from "./saved-file-handles.js";
import { ConversationSyncMutationRejectedError } from "../sync/rejection.js";

export interface AssistantConversationFilesOptions {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly principalId: string;
  readonly assistantId: string;
  readonly limits: AttachmentStagingLimits;
  readonly authorizeConversation: (conversationId: string) => Promise<void>;
  readonly now?: () => number;
}

export type AssistantConversationFiles = ReturnType<typeof createAssistantConversationFiles>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const assistantConversationFileMaintenanceScope = (assistantId: string) => `assistant-retained-v1:${hash(assistantId)}`;
/** Only new uploads made with this explicit policy participate. Legacy uploads
 * remain in their original storage and are read without adoption or rewriting. */
export function createAssistantConversationFiles(options: AssistantConversationFilesOptions) {
  const { persistence, tenantId, scopeId, principalId, limits, authorizeConversation } = options;
  const types = STANDARD_ATTACHMENT_MEDIA_TYPES.filter(type => limits.acceptedMediaTypes.some(
    accepted => accepted === type || accepted.endsWith("/*") && type.startsWith(accepted.slice(0, -1))));
  const partition = (conversationId: string) => hash([options.assistantId, scopeId, conversationId]);
  const storage = (conversationId: string, store = persistence, authorize = authorizeConversation) => createConversationFileStorage({
    persistence: store, tenantId, principalId: scopeId, authorizeConversation: authorize,
    boundConversationId: conversationId,
    maintenanceScopeId: assistantConversationFileMaintenanceScope(options.assistantId),
    identity: { uploadScopeId: `assistant-draft:${partition(conversationId)}`,
      savedScopeId: () => `assistant-retained:${partition(conversationId)}`,
      blobKey: (_conversationId, attachmentId) => `blob_retained_${hash([options.assistantId, scopeId, conversationId, attachmentId])}` },
    validateFile: input => {
      const value = createAttachmentContentValidator({ maximumFiles: 1, maximumBytesPerFile: limits.maximumBytes,
        maximumTotalBytes: limits.maximumBytes, acceptedMediaTypes: types })([{
        fileName: input.fileName, declaredMediaType: input.mediaType, data: input.data,
      }])[0]!;
      return { fileName: value.fileName, mediaType: value.mediaType, data: value.data };
    },
    limits: { maximumFiles: 16, maximumBytesPerFile: limits.maximumBytes, maximumTotalBytes: limits.maximumBytes * 16,
      acceptedMediaTypes: types, stagingTtlMilliseconds: limits.ttlMilliseconds },
    ...(options.now ? { now: options.now } : {}),
  });
  const legacy = (store = persistence) => createAttachmentStagingService({
    blobs: new PostgresAttachmentBlobStore(store, tenantId), metadata: new PostgresAttachmentStagingMetadataStore(store, tenantId, scopeId),
    limits, ...(options.now ? { now: options.now } : {}),
  });
  const read = async (conversationId: string, attachmentId: string, store = persistence, authorize = authorizeConversation) => {
    await authorize(conversationId);
    try { return await storage(conversationId, store, authorize).read(conversationId, attachmentId); }
    catch (error) {
      if (!(error instanceof AttachmentStagingError) || error.code !== "not_found") throw error;
      // Fallback only for a missing identity, never for corruption, denial or expiry.
      const old = await legacy(store).download({ ownerScopeId: scopeId, conversationId, attachmentId });
      await authorize(conversationId);
      return { reference: { attachment_id: old.record.attachmentId, content_ref: old.record.contentRef,
        media_type: old.record.mediaType as AttachmentReference["media_type"], byte_size: old.record.byteSize,
        ...(old.record.filename ? { filename: old.record.filename } : {}) },
      file: { fileName: old.record.filename ?? "attachment", mediaType: old.record.mediaType, data: old.bytes },
      retained: false, legacy: true };
    }
  };
  const events = new PostgresConversationEventStore(persistence, tenantId);
  const append = events.append.bind(events);
  const appendRetained: typeof events.append = async input => {
      // Freeze caller-owned event payloads before the first authorization await.
      const captured = { ...input, events: input.events.map(event => parseConversationEvent(JSON.parse(JSON.stringify(event)))) };
      const attachments = captured.events.filter(event => event.payload.type === "message.attachment_referenced");
      if (attachments.length === 0) return append(captured);
      if (attachments.length > 16 || attachments.some(event => event.actor.type !== "user" || event.actor.id !== principalId)) {
        throw new AttachmentStagingError("forbidden");
      }
      await authorizeConversation(captured.conversationId);
      const result = await persistence.client.transaction(async client => {
        const store = new PostgresAiPersistence(client);
        await assertPostgresConversationWritable(client, tenantId, captured.conversationId);
        const transactionalEvents = new PostgresConversationEventStore(store, tenantId);
        const appended = await transactionalEvents.append(captured);
        const replay = await replayConversation({ conversationId: captured.conversationId, eventStore: transactionalEvents, checkpointPolicy: false });
        try {
          if (replay.state.replay_error !== null) throw new AttachmentStagingError("invalid_input");
          for (const event of attachments) {
            if (event.payload.type !== "message.attachment_referenced") continue;
            const payload = event.payload;
            const message = replay.state.messages.find(message => message.message_id === payload.message_id);
            if (!message || message.role !== "user" || message.attribution?.actor.id !== principalId) throw new AttachmentStagingError("forbidden");
            // Identity authorization happened immediately before this transaction.
            // Reads below use its locked storage snapshot; the public APIs always
            // authorize again and provider dispatch separately rechecks access.
            const current = await read(captured.conversationId, event.payload.attachment.attachment_id, store, async () => {});
            try { assertConversationAttachmentMatches(event.payload.attachment, current.reference); }
            catch { throw new AttachmentStagingError("conflict"); }
            if (!("legacy" in current)) {
              await storage(captured.conversationId, store, async () => {}).materialize(captured.conversationId, [current.reference]);
            }
          }
        } finally { replay.store.destroy(); }
        return appended;
      });
      await authorizeConversation(captured.conversationId);
      return result;
  };
  events.append = async input => {
    try { return await appendRetained(input); }
    catch (error) {
      if (error instanceof AttachmentStagingError) {
        const code = error.code === "expired" ? "attachment_expired" : error.code === "not_found" ? "attachment_unavailable"
          : error.code === "conflict" ? "attachment_changed" : error.code === "invalid_input" ? "attachment_invalid" : undefined;
        if (code) throw new ConversationSyncMutationRejectedError(code);
      }
      throw error;
    }
  };
  return Object.freeze({
    events,
    savedFiles: createSavedFileHandles({ namespace: [tenantId, scopeId, options.assistantId], eventStore: events,
      maximumBytes: limits.maximumBytes, authorize: ({ conversationId }) => authorizeConversation(conversationId),
      resolveMetadata: async ({ conversationId, attachment }) => {
        const current = await read(conversationId, attachment.attachment_id);
        return { reference: current.reference, sha256: createHash("sha256").update(current.file.data).digest("hex") };
      },
      readBytes: async ({ conversationId, reference }) => {
        const current = await read(conversationId, reference.attachment_id);
        if (current.reference.content_ref !== reference.content_ref) throw new AttachmentStagingError("invalid_input");
        return { mediaType: current.file.mediaType, bytes: current.file.data };
      },
    }),
    async stage(conversationId: string, input: ConversationFileInput & { readonly idempotencyKey: string }) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(input.idempotencyKey)) throw new AttachmentStagingError("invalid_input");
      const captured = { ...input, data: new Uint8Array(input.data) };
      await authorizeConversation(conversationId);
      const result = await storage(conversationId).stage({ ...captured, idempotencyKey: hash([conversationId, captured.idempotencyKey]) });
      await authorizeConversation(conversationId);
      return result;
    },
    async download(conversationId: string, attachmentId: string) { return read(conversationId, attachmentId); },
    async resolveSaved(conversationId: string, saved: Readonly<ConversationAttachmentReference>) {
      const captured = { ...saved };
      const current = await read(conversationId, captured.attachment_id);
      assertConversationAttachmentMatches(captured, current.reference);
      return current.reference;
    },
    async resolve(conversationId: string, reference: Readonly<AttachmentReference>) {
      const captured = { ...reference };
      const current = await read(conversationId, captured.attachment_id);
      if (current.reference.content_ref !== captured.content_ref || current.reference.media_type !== captured.media_type ||
        current.reference.byte_size !== captured.byte_size) throw new AttachmentStagingError("invalid_input");
      return { media_type: current.file.mediaType, bytes: current.file.data };
    },
  });
}
