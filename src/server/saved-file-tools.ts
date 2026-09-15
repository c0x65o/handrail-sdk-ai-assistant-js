import { createToolPlugin } from "../tools/plugin.js";
import { ToolFailureError } from "../tools/recovery.js";
import type { ApplicationToolAdmission, ApplicationToolExecutor, ApplicationToolExecutionLocation } from "../tools/executor.js";
import { AttachmentStagingError } from "../attachments/staging.js";
import { AI_RUNTIME_PROTOCOL_LIMITS, type ApplicationToolResult, type JsonObject } from "../protocol.js";
import { SavedConversationFileUnavailableError, SavedConversationPreparationError } from "./saved-conversation-request.js";
import type { SavedFileHandles } from "./saved-file-handles.js";

export const SAVED_FILE_LIST_TOOL = "handrail_files_list";
export const SAVED_FILE_OPEN_TOOL = "handrail_files_open";
export interface SavedFileToolOptions<TContext> {
  readonly filesFor: (context: TContext, location: ApplicationToolExecutionLocation) => SavedFileHandles;
  readonly supportedDocumentMediaTypes: readonly string[];
  readonly maximumDocuments: number;
  readonly maximumImages?: number;
  readonly maximumDocumentBytes?: number;
  readonly maximumTotalBytes?: number;
  /** Validate the selected files together with the current admitted message.
   * Called before a successful receipt, including cached receipt replay. */
  readonly validateSelection?: (input: { readonly context: TContext; readonly location: ApplicationToolExecutionLocation;
    readonly signal: AbortSignal; readonly files: readonly OpenedSavedFile[] }) => void | Promise<void>;
}
export interface OpenedSavedFile {
  readonly handle: string;
  readonly attachmentId: string;
  readonly messageId: string;
  readonly mediaType: string;
  readonly fileName: string | null;
  readonly byteSize: number;
  readonly sha256: string;
}
const failure = (code: string, message: string) => new ToolFailureError({ category: "invalid_input", code, message });
const fileFailure = (error: unknown): never => {
  if (error instanceof ToolFailureError) throw error;
  if (error instanceof SavedConversationFileUnavailableError || error instanceof SavedConversationPreparationError) {
    throw new ToolFailureError({ category: error instanceof SavedConversationFileUnavailableError ? "not_found" : "invalid_input",
      code: error.code, message: error.message });
  }
  if (error instanceof AttachmentStagingError && ["expired", "not_found"].includes(error.code)) {
    throw new ToolFailureError({ category: "not_found", code: "saved_file_unavailable",
      message: "The saved file is no longer available. Ask the user to upload it again." });
  }
  // Arbitrary host/storage errors never become model-visible exception text.
  throw new ToolFailureError({ category: "missing_capability", code: "saved_file_read_failed",
    message: "The saved file could not be read with current access. Do not claim its contents were read." });
};

/** The plugin uses the assistant's normal execution ledger, approvals and result
 * events. Results contain public metadata/checksums only, never binary data or
 * private storage identities. Install its admission hook for fresh checks even
 * when a completed execution receipt is replayed. */
export function createSavedFileTools<TContext>(options: SavedFileToolOptions<TContext>) {
  const maximumImages = options.maximumImages ?? AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest;
  const maximumDocuments = options.maximumDocuments;
  const maximumTotalBytes = options.maximumTotalBytes ?? AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes;
  const maximumDocumentBytes = options.maximumDocumentBytes ?? AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes;
  for (const [value, bound] of [[maximumImages, AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest],
    [maximumDocuments, AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest], [maximumTotalBytes, Number.MAX_SAFE_INTEGER],
    [maximumDocumentBytes, AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes]]) {
    if (!Number.isSafeInteger(value) || value! < 0 || value! > bound!) throw new RangeError("Invalid saved-file tool limit");
  }
  const maximumFiles = maximumImages + maximumDocuments;
  if (maximumFiles < 1 || maximumTotalBytes < 1) throw new RangeError("Invalid saved-file tool limit");
  const handles = (value: unknown) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > maximumFiles ||
      value.some(handle => typeof handle !== "string" || !/^file_[a-f0-9]{64}$/u.test(handle)) || new Set(value).size !== value.length) {
      throw failure("invalid_saved_file_selection", "Select one bounded set of distinct handles returned by handrail_files_list.");
    }
    return [...value] as string[];
  };
  const open = async (context: TContext, location: ApplicationToolExecutionLocation, signal: AbortSignal, selected: readonly string[]) => {
    const { conversationId } = location;
    const files = options.filesFor(context, location), opened: OpenedSavedFile[] = [];
    let images = 0, documents = 0, bytes = 0;
    for (const handle of selected) {
      signal.throwIfAborted();
      const file = await files.read({ conversationId, signal, handle });
      const document = file.entry.kind === "document";
      if (document && !options.supportedDocumentMediaTypes.includes(file.entry.mediaType)) {
        throw failure("saved_file_unsupported", "This provider cannot analyze the selected file format. Ask for a supported file.");
      }
      images += document ? 0 : 1; documents += document ? 1 : 0; bytes += file.bytes.byteLength;
      if (images > maximumImages || documents > maximumDocuments || bytes > maximumTotalBytes || document && file.bytes.byteLength > maximumDocumentBytes) {
        throw failure("saved_file_limit", "The selected files exceed the input limit. Open fewer or smaller files at a time.");
      }
      opened.push({ handle, attachmentId: file.entry.attachmentId, messageId: file.entry.messageId,
        mediaType: file.entry.mediaType, fileName: file.entry.fileName, byteSize: file.bytes.byteLength, sha256: file.sha256 });
    }
    await options.validateSelection?.({ context, location, signal, files: opened });
    signal.throwIfAborted();
    return opened;
  };
  const execute: ApplicationToolExecutor<TContext> = async (arguments_, input) => {
    try {
      if (!input.location) throw failure("saved_file_location_required", "A saved conversation is required to read prior files.");
      const { conversationId } = input.location;
      if (input.definition.name === SAVED_FILE_LIST_TOOL) {
        const page = await options.filesFor(input.applicationContext, input.location).list({ conversationId, signal: input.signal,
          limit: typeof arguments_.limit === "number" ? arguments_.limit : 20,
          ...(typeof arguments_.after === "string" ? { after: arguments_.after } : {}) });
        return { type: "handrail.saved_files.v1", status: "listed", files: page.files.map(file => ({ ...file })), next: page.next,
          notice: "Metadata only. Use handrail_files_open to select original content for analysis; availability is checked when opened." };
      }
      const files = await open(input.applicationContext, input.location, input.signal, handles(arguments_.handles));
      return { type: "handrail.saved_files.v1", status: "opened", files: files.map(file => ({ ...file })),
        notice: "These files replace the previous opened-file selection for provider input. Read the attached original content before making claims about it." };
    } catch (error) { input.signal.throwIfAborted(); return fileFailure(error); }
  };
  const plugin = createToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext, unknown>({
    pluginId: "handrail.saved-files", version: "1.0.0", displayName: "Saved conversation files",
    registrations: [{ definition: { name: SAVED_FILE_LIST_TOOL,
      description: "List saved files in this conversation, including files outside the recent history window. Listing does not read their contents.",
      input_schema: { type: "object", additionalProperties: false, required: ["after", "limit"], properties: {
        after: { type: ["string", "null"], description: "Use the previous page's next handle, or null for the first page." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      } } }, executor: execute }, { definition: { name: SAVED_FILE_OPEN_TOOL,
      description: "Open one bounded selection of saved files for analysis. Use handles from handrail_files_list. Replaces any previous selection; does not attach files to business records.",
      input_schema: { type: "object", additionalProperties: false, required: ["handles"], properties: {
        handles: { type: "array", minItems: 1, maxItems: maximumFiles, uniqueItems: true, items: { type: "string", pattern: "^file_[a-f0-9]{64}$" } },
      } } }, executor: execute }],
    approvals: [SAVED_FILE_LIST_TOOL, SAVED_FILE_OPEN_TOOL].map(toolName => ({ toolName, mode: "never", summarize: () => "Read saved conversation files" })),
  });
  const admission: ApplicationToolAdmission<TContext> = async input => {
    if (![SAVED_FILE_LIST_TOOL, SAVED_FILE_OPEN_TOOL].includes(input.definition.name)) return { outcome: "allow" };
    if (!input.location) return { outcome: "deny" };
    try {
      // Revalidate even when the normal execution ledger returns a prior receipt.
      await options.filesFor(input.applicationContext, input.location).list({ conversationId: input.location.conversationId, signal: input.signal, limit: 1 });
      if (input.definition.name === SAVED_FILE_OPEN_TOOL) {
        await open(input.applicationContext, input.location, input.signal, handles(input.arguments.handles));
      }
      return { outcome: "allow" };
    } catch (error) { input.signal.throwIfAborted(); return fileFailure(error); }
  };
  return Object.freeze({ plugin, admission });
}

/** Extract only successful SDK open receipts from a trusted server continuation
 * and current tool results. Model-authored messages/arguments are not receipts. */
export function openedSavedFileSelection(results: readonly ApplicationToolResult[], continuation: readonly JsonObject[] = []): readonly OpenedSavedFile[] {
  let selection: OpenedSavedFile[] = [];
  const inspect = (content: unknown) => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const value = part?.type === "json" ? part.value : undefined;
      if (value?.type !== "handrail.saved_files.v1" || value.status !== "opened") continue;
      if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 12) throw new TypeError("Invalid saved-file receipt");
      selection = value.files.map((file: OpenedSavedFile) => {
        if (!file || typeof file !== "object" || !/^file_[a-f0-9]{64}$/u.test(file.handle) ||
          typeof file.attachmentId !== "string" || typeof file.messageId !== "string" || typeof file.mediaType !== "string" ||
          !(file.fileName === null || typeof file.fileName === "string") || !Number.isSafeInteger(file.byteSize) || file.byteSize < 1 ||
          !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new TypeError("Invalid saved-file receipt");
        return { handle: file.handle, attachmentId: file.attachmentId, messageId: file.messageId, mediaType: file.mediaType,
          fileName: file.fileName, byteSize: file.byteSize, sha256: file.sha256 };
      });
      if (new Set(selection.map(file => file.handle)).size !== selection.length) throw new TypeError("Invalid saved-file receipt");
    }
  };
  const calls = new Map<string, string>();
  for (const item of continuation) {
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") calls.set(item.call_id, item.name);
    if (item.type === "function_call_output" && typeof item.call_id === "string" && calls.get(item.call_id) === SAVED_FILE_OPEN_TOOL && typeof item.output === "string") {
      try { inspect(JSON.parse(item.output)); } catch { throw new TypeError("Invalid saved-file receipt"); }
    }
  }
  for (const result of results) if (result.name === SAVED_FILE_OPEN_TOOL && !result.is_error) inspect(result.content);
  return Object.freeze(selection.map(file => Object.freeze(file)));
}
