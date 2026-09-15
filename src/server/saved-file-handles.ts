import { createHash } from "node:crypto";
import { awaitWithSignal } from "../await-signal.js";
import { assertConversationAttachmentMatches, conversationAttachmentKind } from "../attachments/references.js";
import type { ConversationAttachmentReference } from "../conversation/events.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { replayConversation } from "../conversation/replay.js";
import { AI_RUNTIME_PROTOCOL_LIMITS, type AttachmentReference } from "../protocol.js";
import { SavedConversationFileUnavailableError, SavedConversationPreparationError } from "./saved-conversation-request.js";

export interface SavedFileLocation {
  readonly conversationId: string;
  readonly signal: AbortSignal;
}
export interface SavedFileHandleEntry {
  /** Stable opaque identity, not a bearer credential. Every operation authorizes anew. */
  readonly handle: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly kind: "image" | "document";
  readonly mediaType: string;
  readonly fileName: string | null;
  readonly byteSize: number | null;
  readonly createdAt: string | null;
}
export interface SavedFileHandlesOptions {
  /** Trusted tenant/account/service identity. Never derive it from model arguments. */
  readonly namespace: readonly string[];
  readonly eventStore: ConversationEventStore;
  readonly authorize: (input: SavedFileLocation) => void | Promise<void>;
  readonly maximumBytes?: number;
  readonly resolveMetadata: (input: SavedFileLocation & {
    readonly messageId: string; readonly attachment: Readonly<ConversationAttachmentReference>;
  }) => Promise<{ readonly reference: AttachmentReference; readonly sha256?: string }>;
  readonly readBytes: (input: SavedFileLocation & {
    readonly messageId: string; readonly reference: Readonly<AttachmentReference>;
  }) => Promise<{ readonly mediaType: string; readonly bytes: Uint8Array }>;
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const changed = () => new SavedConversationPreparationError("attachment_changed");

/** Shared canonical provenance and protected original-byte access. Listing is
 * metadata only and does not assert that historical storage is still available.
 * Handles survive process recreation but cannot cross a scope/conversation or
 * silently rebind to changed saved metadata. No historical data is rewritten. */
export function createSavedFileHandles(options: SavedFileHandlesOptions) {
  const namespace = [...options.namespace];
  if (!namespace.length || namespace.some(value => typeof value !== "string" || !value || value.length > 512)) {
    throw new TypeError("Invalid saved-file namespace");
  }
  const maximumBytes = options.maximumBytes ?? AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new RangeError("Invalid saved-file byte limit");
  const authorize = (input: SavedFileLocation) => awaitWithSignal(input.signal, () => options.authorize(input));
  const capture = (input: SavedFileLocation): SavedFileLocation => Object.freeze({ conversationId: input.conversationId, signal: input.signal });
  const load = async (input: SavedFileLocation) => {
    const replay = await replayConversation({ conversationId: input.conversationId as never,
      eventStore: options.eventStore, checkpointPolicy: false, onEvent: () => input.signal.throwIfAborted() });
    try {
      input.signal.throwIfAborted();
      if (replay.state.replay_error) throw new SavedConversationPreparationError("saved_input_unavailable");
      return replay.state.messages.filter(message => message.role === "user").flatMap(message =>
        message.attachments.map(attachment => {
          const kind = conversationAttachmentKind(attachment);
          const fingerprint = JSON.stringify([message.message_id, message.attribution?.actor ?? null,
            attachment.attachment_id, kind, attachment.media_type, attachment.size_bytes ?? null, attachment.filename ?? null]);
          const entry: SavedFileHandleEntry = Object.freeze({ handle: `file_${digest(JSON.stringify([namespace, input.conversationId, fingerprint]))}`,
            messageId: message.message_id, attachmentId: attachment.attachment_id, kind,
            mediaType: attachment.media_type, fileName: attachment.filename ?? null,
            byteSize: attachment.size_bytes ?? null, createdAt: message.created_at });
          return { entry, attachment: Object.freeze({ ...attachment }), fingerprint };
        }));
    } finally { replay.store.destroy(); }
  };
  return Object.freeze({
    async list(input: SavedFileLocation & { readonly limit?: number; readonly after?: string }) {
      const location = capture(input), limit = input.limit ?? 20, after = input.after;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Invalid saved-file page size");
      await authorize(location);
      const files = await awaitWithSignal(location.signal, () => load(location));
      const start = after === undefined ? 0 : files.findIndex(file => file.entry.handle === after) + 1;
      if (after !== undefined && start === 0) throw new SavedConversationFileUnavailableError("not_found");
      const page = files.slice(start, start + limit).map(file => file.entry);
      await authorize(location);
      return Object.freeze({ files: Object.freeze(page), next: start + limit < files.length ? page.at(-1)!.handle : null });
    },
    async read(input: SavedFileLocation & { readonly handle: string }) {
      const location = capture(input), handle = input.handle;
      await authorize(location);
      if (!/^file_[a-f0-9]{64}$/u.test(handle)) throw new SavedConversationFileUnavailableError("not_found");
      const find = async () => {
        const matches = (await load(location)).filter(file => file.entry.handle === handle);
        if (matches.length !== 1) throw new SavedConversationFileUnavailableError("not_found");
        return matches[0]!;
      };
      const source = await awaitWithSignal(location.signal, find);
      await authorize(location);
      const metadata = await awaitWithSignal(location.signal, () => options.resolveMetadata({ ...location,
        messageId: source.entry.messageId, attachment: source.attachment }));
      const reference = Object.freeze({ ...metadata.reference }), expectedSha256 = metadata.sha256;
      try { assertConversationAttachmentMatches(source.attachment, reference); } catch { throw changed(); }
      if (reference.byte_size > maximumBytes) throw new SavedConversationPreparationError("attachment_limit");
      if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw changed();
      await authorize(location);
      const resolved = await awaitWithSignal(location.signal, () => options.readBytes({ ...location,
        messageId: source.entry.messageId, reference }));
      if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength !== reference.byte_size ||
        resolved.mediaType !== reference.media_type) throw changed();
      const bytes = new Uint8Array(resolved.bytes), sha256 = digest(bytes);
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw changed();
      await authorize(location);
      const current = await awaitWithSignal(location.signal, find);
      if (current.fingerprint !== source.fingerprint) throw changed();
      await authorize(location);
      location.signal.throwIfAborted();
      return Object.freeze({ entry: Object.freeze({ ...source.entry, byteSize: reference.byte_size,
        fileName: reference.filename ?? source.entry.fileName }), reference, bytes, sha256 });
    },
  });
}

export type SavedFileHandles = ReturnType<typeof createSavedFileHandles>;
