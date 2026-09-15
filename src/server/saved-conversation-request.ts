import { assertConversationAttachmentMatches, conversationAttachmentKind } from "../attachments/references.js";
import { awaitWithSignal } from "../await-signal.js";
import type { ConversationAttachmentReference } from "../conversation/events.js";
import type { ConversationMessageRecord } from "../conversation/state.js";
import { AI_RUNTIME_PROTOCOL_LIMITS, parseChatRequest, type AttachmentReference, type ChatRequest } from "../protocol.js";

export class SavedConversationPreparationError extends Error {
  constructor(readonly code: "saved_input_unavailable" | "attachment_limit" | "attachment_changed") {
    super(code === "saved_input_unavailable" ? "The saved user input is unavailable."
      : code === "attachment_limit" ? "The selected files exceed this request's attachment limits."
        : "A resolved file does not match its saved reference.");
  }
}

export interface SavedConversationFile {
  readonly messageId: string;
  readonly attachment: Readonly<ConversationAttachmentReference>;
  readonly included: boolean;
}

export interface SavedConversationRequestOptions {
  readonly request: ChatRequest;
  /** Fresh, authorized canonical messages. Callers must recheck admission after
   * preparation and before provider dispatch if history or access can change. */
  readonly messages: readonly ConversationMessageRecord[];
  readonly inputMessageIds: readonly string[];
  readonly turnId: string;
  readonly signal: AbortSignal;
  /** Resolves metadata only after account/conversation/message/file authorization.
   * Byte retrieval remains the provider's protected attachment resolver. */
  readonly resolveAttachment: (attachment: Readonly<ConversationAttachmentReference>,
    messageId: string, signal: AbortSignal) => Promise<AttachmentReference>;
  /** Explicit historical selection. Omit to include the most recent files that
   * fit. Current input attachments are always required and take priority. */
  readonly historicalAttachmentIds?: readonly string[];
  readonly maximumHistoricalMessages?: number;
  readonly maximumHistoricalTextCharacters?: number;
  readonly maximumImages?: number;
  readonly maximumDocuments?: number;
  readonly maximumDocumentsPerMessage?: number;
}

/** Common provider input construction from saved messages. Bounds historical
 * bytes without losing their catalog identities or accepting client history.
 * The returned file catalog must be exposed through the caller's authorized
 * prior-file tools; omitted files must never be represented as already read. */
export async function prepareSavedConversationRequest(options: SavedConversationRequestOptions): Promise<{
  request: ChatRequest; files: readonly SavedConversationFile[];
}> {
  const signal = options.signal;
  signal.throwIfAborted();
  const bounded = (value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER) => {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new RangeError("Invalid saved-history limit");
    return result;
  };
  const imageLimit = bounded(options.maximumImages, AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest,
    AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest);
  const documentLimit = bounded(options.maximumDocuments, AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest,
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest);
  const perMessageDocuments = bounded(options.maximumDocumentsPerMessage,
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage, AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage);
  const messageLimit = bounded(options.maximumHistoricalMessages, 20);
  const textLimit = bounded(options.maximumHistoricalTextCharacters, 24_000);
  const inputs = new Set(options.inputMessageIds);
  if (inputs.size === 0 || inputs.size !== options.inputMessageIds.length) throw new SavedConversationPreparationError("saved_input_unavailable");
  // Capture immutable scalar metadata before any host callback can yield.
  const snapshot = options.messages.map(message => ({ ...message,
    content: message.content.map(part => ({ ...part })), attachments: message.attachments.map(file => ({ ...file })) }));
  for (const id of inputs) {
    const matching = snapshot.filter(message => message.message_id === id);
    if (matching.length !== 1 || matching[0]!.role !== "user") throw new SavedConversationPreparationError("saved_input_unavailable");
  }
  const lastInput = Math.max(...snapshot.map((message, index) => inputs.has(message.message_id) ? index : -1));
  const history = snapshot.slice(0, lastInput + 1).filter(message =>
    (message.role === "user" || message.role === "assistant") &&
    (inputs.has(message.message_id) || message.turn_id !== options.turnId));
  const files = history.filter(message => message.role === "user").flatMap(message => message.attachments.map(attachment => ({
    messageId: String(message.message_id), attachment, included: false,
  })));
  const explicit = options.historicalAttachmentIds === undefined ? null : new Set(options.historicalAttachmentIds);
  if (explicit && [...explicit].some(id => !files.some(file => file.attachment.attachment_id === id))) {
    throw new SavedConversationPreparationError("saved_input_unavailable");
  }
  const selectedIds = new Set<string>(), messageCounts = new Map<string, { image: number; document: number }>();
  const totals = { image: 0, document: 0 };
  const select = (file: typeof files[number], required: boolean) => {
    const kind = conversationAttachmentKind(file.attachment);
    if (selectedIds.has(file.attachment.attachment_id)) return;
    const counts = messageCounts.get(file.messageId) ?? { image: 0, document: 0 };
    const totalLimit = kind === "image" ? imageLimit : documentLimit;
    const perMessage = kind === "image" ? AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage : perMessageDocuments;
    if (totals[kind] >= totalLimit || counts[kind] >= perMessage) {
      if (required) throw new SavedConversationPreparationError("attachment_limit");
      return;
    }
    counts[kind]++; totals[kind]++;
    messageCounts.set(file.messageId, counts);
    file.included = true; selectedIds.add(file.attachment.attachment_id);
  };
  for (const file of files.filter(file => inputs.has(file.messageId))) select(file, true);
  for (const file of [...files].reverse().filter(file => !inputs.has(file.messageId))) {
    if (!explicit || explicit.has(file.attachment.attachment_id)) select(file, explicit !== null);
  }
  // Keep recent text plus every message carrying required/current or selected
  // file input. The catalog still includes older files excluded from this pass.
  const texts = new Map<string, ChatRequest["messages"][number]["content"]>();
  let textRemaining = textLimit, historicalCount = 0;
  for (const message of [...history].reverse()) {
    if (inputs.has(message.message_id)) { texts.set(message.message_id, message.content); continue; }
    const length = message.content.reduce((sum, part) => sum + part.text.length, 0);
    if (historicalCount < messageLimit && length <= textRemaining) {
      texts.set(message.message_id, message.content); textRemaining -= length; historicalCount++;
    }
  }
  const messages: ChatRequest["messages"] = [];
  for (const message of history) {
    signal.throwIfAborted();
    const content = [...(texts.get(message.message_id) ?? [])] as ChatRequest["messages"][number]["content"];
    for (const file of files.filter(file => file.messageId === message.message_id && file.included)) {
      const resolved = await awaitWithSignal(signal, () =>
        options.resolveAttachment(Object.freeze({ ...file.attachment }), file.messageId, signal));
      signal.throwIfAborted();
      let canonical;
      try { canonical = assertConversationAttachmentMatches(file.attachment, resolved); }
      catch { throw new SavedConversationPreparationError("attachment_changed"); }
      content.push({ type: canonical.kind, attachment: { ...resolved } } as ChatRequest["messages"][number]["content"][number]);
    }
    if (content.length > 0) messages.push({ role: message.role as "user" | "assistant", content });
  }
  signal.throwIfAborted();
  return { request: parseChatRequest({ ...options.request, messages, continuation_of: null, tool_results: [] }),
    files: Object.freeze(files.map(file => Object.freeze({ ...file, attachment: Object.freeze(file.attachment) }))) };
}
