import {
  AI_RUNTIME_ATTACHMENT_ID_GRAMMAR,
  AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR,
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_DOCUMENT_EXTENSIONS,
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  type ApplicationToolResult,
  type AttachmentReference,
  type CancellationReason,
  type ChatMessage,
  type JsonObject,
  type ProtocolMetadata,
  type StreamEvent,
} from "../protocol.js";
import {
  CITATION_LIMITS,
  normalizeCitationRecords,
  normalizeCitationSource,
  type CitationRecordSet,
} from "../citations.js";
import { parseProviderDocumentInputCapability } from "./index.js";
import type {
  ClientRequestError,
  DocumentInputCapabilityDescriptor,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAdapterInvocation,
  ProviderAdapterMetadata,
  ProviderAdapterResult,
  ProviderAdapterStream,
  ProviderUsage,
} from "./index.js";
import {
  createOpenAIProviderContextCapability,
  type OpenAIProviderContextCompactRequestFunction,
  type OpenAIProviderContextInput,
  type OpenAIProviderContextMeasureRequestFunction,
} from "./openai-context.js";
import {
  describeProviderContextCapability,
  type ProviderContextCapability,
} from "../provider-context.js";

export * from "./openai-context.js";
export * from "./openai-responses-tools.js";
export * from "./openai-responses.js";
export * from "./openai-transcription.js";

export interface OpenAIImageSource {
  readonly url: string;
  readonly detail?: "auto" | "low" | "high";
}

export interface OpenAIChatCompletionTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenAIChatCompletionImagePart {
  readonly type: "image_url";
  readonly image_url: OpenAIImageSource;
}

export interface OpenAIChatCompletionFileSource {
  readonly filename: string;
  readonly file_data: string;
}

export interface OpenAIChatCompletionFilePart {
  readonly type: "file";
  readonly file: OpenAIChatCompletionFileSource;
}

export interface OpenAIChatCompletionMessage {
  readonly role: "user" | "assistant";
  readonly content:
    | string
    | readonly (
        | OpenAIChatCompletionTextPart
        | OpenAIChatCompletionImagePart
        | OpenAIChatCompletionFilePart
      )[];
}

export interface OpenAIChatCompletionToolResultMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export interface OpenAIChatCompletionAssistantToolCallMessage {
  readonly role: "assistant";
  readonly content: null;
  readonly tool_calls: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly arguments: "{}";
    };
  }[];
}

export interface OpenAIChatCompletionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}

/**
 * The SDK-independent subset accepted by OpenAI's streaming Chat Completions
 * boundary. Hosts may adapt this to an already-configured OpenAI client.
 */
export interface OpenAIChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly (
    | OpenAIChatCompletionMessage
    | OpenAIChatCompletionAssistantToolCallMessage
    | OpenAIChatCompletionToolResultMessage
  )[];
  readonly tools?: readonly OpenAIChatCompletionTool[];
  readonly parallel_tool_calls?: false;
  readonly max_completion_tokens: number;
  readonly temperature: number;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
}

export interface OpenAIRequestOptions {
  readonly signal: AbortSignal;
}

export type OpenAIChatCompletionRequestFunction = (
  request: OpenAIChatCompletionRequest,
  options: OpenAIRequestOptions,
) =>
  | AsyncIterable<unknown>
  | Promise<AsyncIterable<unknown>>;

export type OpenAIImageReferenceResolver = (
  attachment: AttachmentReference,
) => OpenAIImageSource | Promise<OpenAIImageSource>;

export interface OpenAIProviderAdapterOptions {
  readonly model: string;
  readonly request: OpenAIChatCompletionRequestFunction;
  readonly measure_context?: OpenAIProviderContextMeasureRequestFunction;
  readonly compact_context?: OpenAIProviderContextCompactRequestFunction;
  readonly resolve_image_reference?: OpenAIImageReferenceResolver;
  /** Explicit PDF limits; document input remains unsupported when omitted. */
  readonly document_input?: DocumentInputCapabilityDescriptor;
  readonly context_window_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly supports_tool_calls?: boolean;
}

type UnknownRecord = Record<string, unknown>;

interface ToolCallAssembly {
  id?: string;
  name?: string;
  argumentsText: string;
}

interface ParsedCompletion {
  outcome: "stop" | "length" | "tool_calls";
  toolCalls: readonly {
    tool_call_id: string;
    name: string;
    arguments: JsonObject;
  }[];
  citationRecords: CitationRecordSet;
  usage: ProviderUsage;
}

interface OpenAIUrlCitationAnnotation {
  readonly type: "url_citation";
  readonly startIndex: number;
  readonly endIndex: number;
  readonly title: string;
  readonly url: string;
}

interface OpenAIFileCitationAnnotation {
  readonly type: "file_citation";
  readonly index: number;
  readonly fileId: string;
  readonly filename: string;
}

type OpenAIRecognizedAnnotation =
  | OpenAIUrlCitationAnnotation
  | OpenAIFileCitationAnnotation;

class OpenAIPreflightError extends Error {}
class OpenAIMalformedStreamError extends Error {}

const ATTACHMENT_ID_PATTERN = new RegExp(AI_RUNTIME_ATTACHMENT_ID_GRAMMAR);
const CONTENT_REFERENCE_PATTERN = new RegExp(
  AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR,
);
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function opaqueHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function boundedUpstreamString(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new OpenAIMalformedStreamError();
  }
  return value;
}

function parseOpenAIAnnotation(value: unknown): OpenAIRecognizedAnnotation | null {
  const annotation = record(value);
  if (!annotation || typeof annotation.type !== "string") {
    throw new OpenAIMalformedStreamError();
  }
  if (annotation.type === "url_citation") {
    if (
      !exactKeys(annotation, [
        "type",
        "start_index",
        "end_index",
        "title",
        "url",
      ])
    ) {
      throw new OpenAIMalformedStreamError();
    }
    const startIndex = safeInteger(annotation.start_index);
    const endIndex = safeInteger(annotation.end_index);
    if (startIndex === null || endIndex === null || endIndex < startIndex) {
      throw new OpenAIMalformedStreamError();
    }
    return {
      type: "url_citation",
      startIndex,
      endIndex,
      title: boundedUpstreamString(
        annotation.title,
        CITATION_LIMITS.labelLength,
      ),
      url: boundedUpstreamString(
        annotation.url,
        CITATION_LIMITS.locatorLength,
      ),
    };
  }
  if (annotation.type === "file_citation") {
    if (!exactKeys(annotation, ["type", "index", "file_id", "filename"])) {
      throw new OpenAIMalformedStreamError();
    }
    const index = safeInteger(annotation.index);
    if (index === null) throw new OpenAIMalformedStreamError();
    return {
      type: "file_citation",
      index,
      fileId: boundedUpstreamString(
        annotation.file_id,
        CITATION_LIMITS.identifierLength,
      ),
      filename: boundedUpstreamString(
        annotation.filename,
        CITATION_LIMITS.labelLength,
      ),
    };
  }

  // Unknown OpenAI annotation types are intentionally ignored. Their payloads
  // are neither inspected nor retained at the provider-neutral boundary.
  return null;
}

function normalizeOpenAIAnnotations(
  annotations: readonly OpenAIRecognizedAnnotation[],
  requestId: string,
  traceId: string,
): CitationRecordSet {
  const target = {
    type: "assistant_message" as const,
    message_id: `assistant:${opaqueHash(`${requestId}\u0000${traceId}`)}`,
  };
  const sources: unknown[] = [];
  const citations: unknown[] = [];
  const seenAnnotations = new Set<string>();
  const seenSources = new Map<string, string>();

  for (const annotation of annotations) {
    let source: ReturnType<typeof normalizeCitationSource>;
    let annotationIdentity: string;
    if (annotation.type === "url_citation") {
      const canonical = normalizeCitationSource({
        source_id: "source:pending",
        type: "web",
        label: annotation.title,
        locator: annotation.url,
      });
      const sourceHash = opaqueHash(`url\u0000${canonical.locator}`);
      source = normalizeCitationSource({
        ...canonical,
        source_id: `source:${sourceHash}`,
      });
      annotationIdentity = JSON.stringify([
        annotation.type,
        annotation.startIndex,
        annotation.endIndex,
        source.label,
        source.locator,
      ]);
    } else {
      const sourceHash = opaqueHash(`file\u0000${annotation.fileId}`);
      source = normalizeCitationSource({
        source_id: `source:${sourceHash}`,
        type: "document",
        label: annotation.filename,
        locator: `document:${sourceHash}`,
      });
      annotationIdentity = JSON.stringify([
        annotation.type,
        annotation.index,
        annotation.fileId,
        source.label,
      ]);
    }
    if (seenAnnotations.has(annotationIdentity)) continue;
    seenAnnotations.add(annotationIdentity);
    const sourceFingerprint = JSON.stringify(source);
    const previousSource = seenSources.get(source.source_id);
    if (previousSource === undefined) {
      seenSources.set(source.source_id, sourceFingerprint);
      sources.push(source);
    } else if (previousSource !== sourceFingerprint) {
      // Retain a conflicting identity so the shared parser remains the
      // authoritative rejection path for provider-neutral source records.
      sources.push(source);
    }
    const order = citations.length;
    citations.push({
      citation_id: `citation:${opaqueHash(annotationIdentity)}`,
      source_id: source.source_id,
      order,
      target,
    });
  }

  try {
    return normalizeCitationRecords({ sources, citations });
  } catch {
    throw new OpenAIMalformedStreamError();
  }
}

function aborted(): never {
  throw new DOMException("Aborted", "AbortError");
}

function rejectCredentialMaterial(value: string): void {
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new OpenAIPreflightError();
  }
}

function safeFilename(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength ||
    value === "." ||
    value === ".." ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    return false;
  }
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint <= 31 ||
      codePoint === 127 ||
      '<>:"/\\|?*'.includes(character)
    );
  });
}

function validateDocumentAttachment(
  attachment: AttachmentReference,
  maxDocumentBytes: number,
): void {
  const attachmentRecord = record(attachment);
  const attachmentKeys = attachmentRecord
    ? Object.keys(attachmentRecord).sort()
    : [];
  const allowedKeys = [
    "attachment_id",
    "byte_size",
    "content_ref",
    "filename",
    "media_type",
  ];
  if (
    !attachmentRecord ||
    attachmentKeys.some((key) => !allowedKeys.includes(key)) ||
    !["attachment_id", "byte_size", "content_ref", "media_type"].every(
      (key) => attachmentKeys.includes(key),
    ) ||
    typeof attachment.attachment_id !== "string" ||
    !ATTACHMENT_ID_PATTERN.test(attachment.attachment_id) ||
    typeof attachment.content_ref !== "string" ||
    /^(?:data|blob|https?):/i.test(attachment.content_ref) ||
    !CONTENT_REFERENCE_PATTERN.test(attachment.content_ref) ||
    !AI_RUNTIME_DOCUMENT_MIME_TYPES.includes(attachment.media_type as never) ||
    !Number.isSafeInteger(attachment.byte_size) ||
    attachment.byte_size < AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes ||
    attachment.byte_size > maxDocumentBytes ||
    (attachment.filename !== undefined && !safeFilename(attachment.filename))
  ) {
    throw new OpenAIPreflightError();
  }
  rejectCredentialMaterial(attachment.attachment_id);
  rejectCredentialMaterial(attachment.content_ref);
}

function documentFilename(
  attachmentId: string,
  mediaType: (typeof AI_RUNTIME_DOCUMENT_MIME_TYPES)[number],
): string {
  const suffix = AI_RUNTIME_DOCUMENT_EXTENSIONS[mediaType];
  return `${attachmentId.slice(0, 251 - suffix.length)}${suffix}`;
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1]! : 0;
    const third = hasThird ? bytes[index + 2]! : 0;
    chunk +=
      BASE64_ALPHABET[first >> 2]! +
      BASE64_ALPHABET[((first & 3) << 4) | (second >> 4)]! +
      (hasSecond
        ? BASE64_ALPHABET[((second & 15) << 2) | (third >> 6)]!
        : "=") +
      (hasThird ? BASE64_ALPHABET[third & 63]! : "=");
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.join("");
}

async function resolveWithAbort<T>(
  resolution: T | Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(resolution).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function setStableFragment(
  assembly: ToolCallAssembly,
  key: "id" | "name",
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenAIMalformedStreamError();
  }
  if (assembly[key] !== undefined && assembly[key] !== value) {
    throw new OpenAIMalformedStreamError();
  }
  assembly[key] = value;
}

function parseUsage(value: unknown): ProviderUsage {
  const usage = record(value);
  if (!usage) throw new OpenAIMalformedStreamError();

  const inputTokens = safeInteger(usage.prompt_tokens);
  const outputTokens = safeInteger(usage.completion_tokens);
  const totalTokens = safeInteger(usage.total_tokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new OpenAIMalformedStreamError();
  }

  const promptDetails =
    usage.prompt_tokens_details === undefined
      ? null
      : record(usage.prompt_tokens_details);
  const completionDetails =
    usage.completion_tokens_details === undefined
      ? null
      : record(usage.completion_tokens_details);
  if (
    (usage.prompt_tokens_details !== undefined && !promptDetails) ||
    (usage.completion_tokens_details !== undefined && !completionDetails)
  ) {
    throw new OpenAIMalformedStreamError();
  }

  const cachedTokens =
    promptDetails?.cached_tokens === undefined
      ? 0
      : safeInteger(promptDetails.cached_tokens);
  const cacheWriteTokens =
    promptDetails?.cache_write_tokens === undefined
      ? 0
      : safeInteger(promptDetails.cache_write_tokens);
  const reasoningTokens =
    completionDetails?.reasoning_tokens === undefined
      ? 0
      : safeInteger(completionDetails.reasoning_tokens);
  if (
    cachedTokens === null ||
    cacheWriteTokens === null ||
    reasoningTokens === null ||
    cachedTokens + cacheWriteTokens > inputTokens ||
    reasoningTokens > outputTokens
  ) {
    throw new OpenAIMalformedStreamError();
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    ...(cacheWriteTokens ? { cache_write_input_tokens: cacheWriteTokens } : {}),
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    provider_cost: { known: false },
  };
}

function toolResultContent(result: ApplicationToolResult): string {
  const content = result.content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("\n");
  return result.is_error ? `[tool error]\n${content}` : content;
}

async function mapMessage(
  message: ChatMessage,
  resolveImageReference: OpenAIImageReferenceResolver | undefined,
  invocation: ProviderAdapterInvocation,
  maxDocumentBytes: number | null,
): Promise<OpenAIChatCompletionMessage> {
  if (message.content.every((part) => part.type === "text")) {
    return {
      role: message.role,
      content: message.content.map((part) => part.text).join(""),
    };
  }

  const content: (
    | OpenAIChatCompletionTextPart
    | OpenAIChatCompletionImagePart
    | OpenAIChatCompletionFilePart
  )[] = [];
  for (const part of message.content) {
    if (invocation.signal.aborted) aborted();
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      if (!resolveImageReference) throw new OpenAIPreflightError();
      const source = await resolveWithAbort(
        resolveImageReference(part.attachment),
        invocation.signal,
      );
      if (
        !source ||
        typeof source.url !== "string" ||
        source.url.length === 0 ||
        (source.detail !== undefined &&
          !["auto", "low", "high"].includes(source.detail))
      ) {
        throw new OpenAIPreflightError();
      }
      content.push({ type: "image_url", image_url: source });
      continue;
    }

    if (maxDocumentBytes === null || !invocation.resolve_document_reference) {
      throw new OpenAIPreflightError();
    }
    const resolved = await resolveWithAbort(
      invocation.resolve_document_reference(part.attachment, {
        signal: invocation.signal,
      }),
      invocation.signal,
    );
    const resolvedRecord = record(resolved);
    if (
      !resolvedRecord ||
      Object.keys(resolvedRecord).sort().join(",") !== "bytes,media_type" ||
      resolved.media_type !== part.attachment.media_type ||
      !(resolved.bytes instanceof Uint8Array) ||
      resolved.bytes.length !== part.attachment.byte_size ||
      resolved.bytes.length <
        AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes ||
      resolved.bytes.length > maxDocumentBytes
    ) {
      throw new OpenAIPreflightError();
    }
    const filename = part.attachment.filename ?? documentFilename(
      part.attachment.attachment_id,
      part.attachment.media_type,
    );
    if (!safeFilename(filename)) throw new OpenAIPreflightError();
    content.push({
      type: "file",
      file: {
        filename,
        file_data: `data:${resolved.media_type};base64,${base64(resolved.bytes)}`,
      },
    });
  }
  return { role: message.role, content };
}

function cancellationReason(signal: AbortSignal): CancellationReason {
  return signal.reason === "deadline_exceeded" ||
    signal.reason === "policy_revoked" ||
    signal.reason === "runtime_shutdown"
    ? signal.reason
    : "runtime_shutdown";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  try {
    return record(error)?.name === "AbortError";
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number | null {
  try {
    const status = record(error)?.status;
    return Number.isInteger(status) ? (status as number) : null;
  } catch {
    return null;
  }
}

function normalizeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof OpenAIPreflightError) {
    return {
      kind: "client",
      retryable: false,
      code: "invalid_request",
      message: "The request uses a capability not configured for this adapter.",
    };
  }
  if (error instanceof OpenAIMalformedStreamError) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider returned malformed streaming data.",
    };
  }

  const status = errorStatus(error);
  if (status === 429) {
    return {
      kind: "provider",
      retryable: true,
      code: "rate_limited",
      message: "The provider rate limit was reached.",
    };
  }
  if (status === 408) {
    return {
      kind: "provider",
      retryable: true,
      code: "deadline_exceeded",
      message: "The provider request timed out.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider is temporarily unavailable.",
    };
  }

  const clientError = (
    code: ClientRequestError["code"],
    message: string,
  ): ClientRequestError => ({
    kind: "client",
    retryable: false,
    code,
    message,
  });
  if (status === 401) return clientError("unauthenticated", "Provider authentication failed.");
  if (status === 403) return clientError("forbidden", "The provider denied the request.");
  if (status === 409) {
    return clientError("idempotency_conflict", "The provider rejected a conflicting request.");
  }
  if (status !== null && status >= 400 && status < 500) {
    return clientError("invalid_request", "The provider rejected the request as invalid.");
  }
  return {
    kind: "provider",
    retryable: true,
    code: "upstream_unavailable",
    message: "The provider request failed.",
  };
}

function publicError(error: ProviderAdapterError) {
  if (error.kind === "policy") {
    return {
      category: "policy" as const,
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error.kind === "provider") {
    return {
      category: "upstream" as const,
      code: error.code,
      message: error.message,
      retryable: true,
    };
  }
  return {
    category:
      error.code === "unauthenticated"
        ? ("authentication" as const)
        : error.code === "forbidden"
          ? ("authorization" as const)
          : ("request" as const),
    code: error.code,
    message: error.message,
    retryable: false,
  };
}

function envelope(
  invocation: ProviderAdapterInvocation,
  type: StreamEvent["type"],
  sequence: number,
): {
  type: StreamEvent["type"];
  protocol_version: typeof AI_RUNTIME_PROTOCOL_VERSION;
  request_id: string;
  trace_id: string;
  sequence: number;
  metadata?: ProtocolMetadata;
} {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id,
    sequence,
    ...(invocation.context.metadata === undefined
      ? {}
      : { metadata: invocation.context.metadata }),
  };
}

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context: ProviderContextCapability<OpenAIProviderContextInput>;
  private readonly request: OpenAIChatCompletionRequestFunction;
  private readonly resolveImageReference: OpenAIImageReferenceResolver | undefined;

  constructor(options: OpenAIProviderAdapterOptions) {
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (typeof options.request !== "function") {
      throw new TypeError("request must be a function");
    }
    this.request = options.request;
    this.resolveImageReference = options.resolve_image_reference;
    const documentInput =
      options.document_input === undefined
        ? parseProviderDocumentInputCapability({ supported: false })
        : parseProviderDocumentInputCapability({
            supported: true,
            capability: options.document_input,
          });
    if (
      documentInput.supported &&
      !documentInput.capability.requires_host_resolution
    ) {
      throw new TypeError(
        "document_input must require host resolution",
      );
    }
    this.provider_context = createOpenAIProviderContextCapability({
      model: options.model,
      ...(options.measure_context === undefined
        ? {}
        : { measure_context: options.measure_context }),
      ...(options.compact_context === undefined
        ? {}
        : { compact_context: options.compact_context }),
    });
    this.metadata = {
      provider_id: "openai",
      model_id: options.model,
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: options.supports_tool_calls ?? true,
        parallel_tool_calls: false,
        reasoning: true,
        document_input: documentInput,
        citation_projection: { supported: true },
        provider_context: describeProviderContextCapability(this.provider_context),
        context_window_tokens: options.context_window_tokens ?? null,
        max_output_tokens: options.max_output_tokens ?? null,
      },
    };
  }

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    return this.stream(invocation);
  }

  private async requestPayload(
    invocation: ProviderAdapterInvocation,
  ): Promise<OpenAIChatCompletionRequest> {
    if (invocation.messages.length === 0) throw new OpenAIPreflightError();
    if (
      !this.metadata.capabilities.tool_calls &&
      (invocation.tools.length > 0 || invocation.tool_results.length > 0)
    ) {
      throw new OpenAIPreflightError();
    }
    if (
      this.metadata.capabilities.max_output_tokens !== null &&
      invocation.generation.max_output_tokens >
        this.metadata.capabilities.max_output_tokens
    ) {
      throw new OpenAIPreflightError();
    }
    const documentParts = invocation.messages.flatMap((message) =>
      message.content.filter((part) => part.type === "document"),
    );
    const documentInput = this.metadata.capabilities.document_input;
    if (documentParts.length > 0) {
      if (
        !documentInput.supported ||
        !invocation.resolve_document_reference ||
        documentParts.length > documentInput.capability.max_document_count ||
        invocation.messages.some(
          (message) =>
            message.content.filter((part) => part.type === "document").length >
            AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage,
        ) ||
        invocation.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some((part) => part.type === "document"),
        )
      ) {
        throw new OpenAIPreflightError();
      }
      for (const part of documentParts) {
        validateDocumentAttachment(
          part.attachment,
          documentInput.capability.max_document_bytes,
        );
      }
    }
    if (
      invocation.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "image"),
      ) ||
      (invocation.messages.some((message) =>
        message.content.some((part) => part.type === "image"),
      ) &&
        !this.resolveImageReference)
    ) {
      throw new OpenAIPreflightError();
    }

    const messages: OpenAIChatCompletionMessage[] = [];
    for (const message of invocation.messages) {
      messages.push(
        await mapMessage(
          message,
          this.resolveImageReference,
          invocation,
          documentInput.supported
            ? documentInput.capability.max_document_bytes
            : null,
        ),
      );
    }
    const toolResults: OpenAIChatCompletionToolResultMessage[] =
      invocation.tool_results.map((result) => ({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: toolResultContent(result),
      }));
    const toolResultContext: OpenAIChatCompletionAssistantToolCallMessage[] =
      invocation.tool_results.length === 0
        ? []
        : [{
            role: "assistant",
            content: null,
            tool_calls: invocation.tool_results.map((result) => ({
              id: result.tool_call_id,
              type: "function",
              function: { name: result.name, arguments: "{}" },
            })),
          }];
    const tools = invocation.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    return {
      model: this.metadata.model_id,
      messages: [...messages, ...toolResultContext, ...toolResults],
      ...(tools.length === 0
        ? {}
        : { tools, parallel_tool_calls: false as const }),
      max_completion_tokens: invocation.generation.max_output_tokens,
      temperature: invocation.generation.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  private async *stream(
    invocation: ProviderAdapterInvocation,
  ): ProviderAdapterStream {
    let sequence = 0;
    yield {
      ...envelope(invocation, "response.started", sequence++),
      type: "response.started",
      attribution: invocation.context.attribution,
    };

    if (invocation.signal.aborted) {
      const reason = cancellationReason(invocation.signal);
      yield {
        ...envelope(invocation, "response.cancelled", sequence),
        type: "response.cancelled",
        reason,
      };
      return { status: "cancelled", reason, usage: null };
    }

    let parsed: ParsedCompletion;
    try {
      const payload = await this.requestPayload(invocation);
      if (invocation.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunks = await this.request(payload, { signal: invocation.signal });
      if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
        throw new OpenAIMalformedStreamError();
      }

      const toolCalls = new Map<number, ToolCallAssembly>();
      const annotations: OpenAIRecognizedAnnotation[] = [];
      let finishReason: string | null = null;
      let usage: ProviderUsage | null = null;

      for await (const chunkValue of chunks) {
        if (invocation.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const chunk = record(chunkValue);
        if (!chunk || !Array.isArray(chunk.choices) || chunk.choices.length > 1) {
          throw new OpenAIMalformedStreamError();
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usage !== null) throw new OpenAIMalformedStreamError();
          usage = parseUsage(chunk.usage);
        }
        if (chunk.choices.length === 0) continue;

        const choice = record(chunk.choices[0]);
        if (!choice) throw new OpenAIMalformedStreamError();
        if (choice.index !== undefined && choice.index !== 0) {
          throw new OpenAIMalformedStreamError();
        }
        const delta = choice.delta === undefined ? null : record(choice.delta);
        if (choice.delta !== undefined && !delta) {
          throw new OpenAIMalformedStreamError();
        }
        if (delta?.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") {
            throw new OpenAIMalformedStreamError();
          }
          if (delta.content.length > 0) {
            yield {
              ...envelope(invocation, "response.text.delta", sequence++),
              type: "response.text.delta",
              delta: delta.content,
            };
          }
        }
        if (delta?.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) {
            throw new OpenAIMalformedStreamError();
          }
          for (const fragmentValue of delta.tool_calls) {
            const fragment = record(fragmentValue);
            const index = safeInteger(fragment?.index);
            if (!fragment || index === null) {
              throw new OpenAIMalformedStreamError();
            }
            const assembly = toolCalls.get(index) ?? { argumentsText: "" };
            setStableFragment(assembly, "id", fragment.id);
            const fn = fragment.function === undefined ? null : record(fragment.function);
            if (fragment.function !== undefined && !fn) {
              throw new OpenAIMalformedStreamError();
            }
            setStableFragment(assembly, "name", fn?.name);
            if (fn?.arguments !== undefined && fn.arguments !== null) {
              if (typeof fn.arguments !== "string") {
                throw new OpenAIMalformedStreamError();
              }
              assembly.argumentsText += fn.arguments;
            }
            toolCalls.set(index, assembly);
          }
        }
        if (delta?.annotations !== undefined) {
          if (!Array.isArray(delta.annotations)) {
            throw new OpenAIMalformedStreamError();
          }
          for (const annotationValue of delta.annotations) {
            const annotation = parseOpenAIAnnotation(annotationValue);
            if (annotation === null) continue;
            if (annotations.length >= CITATION_LIMITS.citationsPerRecordSet) {
              throw new OpenAIMalformedStreamError();
            }
            annotations.push(annotation);
          }
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (
            typeof choice.finish_reason !== "string" ||
            (finishReason !== null && finishReason !== choice.finish_reason)
          ) {
            throw new OpenAIMalformedStreamError();
          }
          finishReason = choice.finish_reason;
        }
      }

      if (!usage || finishReason === null) throw new OpenAIMalformedStreamError();
      let citationRecords: CitationRecordSet;
      try {
        citationRecords = normalizeOpenAIAnnotations(
          annotations,
          invocation.context.request_id,
          invocation.context.trace_id,
        );
      } catch {
        throw new OpenAIMalformedStreamError();
      }
      if (finishReason === "content_filter") {
        const policyError: ProviderAdapterError = {
          kind: "policy",
          retryable: false,
          code: "policy_denied",
          message: "The provider stopped the response due to policy.",
        };
        yield {
          ...envelope(invocation, "response.usage", sequence++),
          type: "response.usage",
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
          },
        };
        yield {
          ...envelope(invocation, "response.error", sequence++),
          type: "response.error",
          error: publicError(policyError),
        };
        return { status: "failed", error: policyError, usage };
      }

      const outcome =
        finishReason === "stop"
          ? "stop"
          : finishReason === "length"
            ? "length"
            : finishReason === "tool_calls" || finishReason === "function_call"
              ? "tool_calls"
              : null;
      if (!outcome) throw new OpenAIMalformedStreamError();

      const completedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, assembly], position) => {
          if (index !== position) throw new OpenAIMalformedStreamError();
          if (!assembly.id || !assembly.name) {
            throw new OpenAIMalformedStreamError();
          }
          let argumentsValue: unknown;
          try {
            argumentsValue = JSON.parse(assembly.argumentsText);
          } catch {
            throw new OpenAIMalformedStreamError();
          }
          if (!record(argumentsValue)) throw new OpenAIMalformedStreamError();
          return {
            tool_call_id: assembly.id,
            name: assembly.name,
            arguments: argumentsValue as JsonObject,
          };
        });
      if (
        new Set(completedToolCalls.map((toolCall) => toolCall.tool_call_id)).size !==
        completedToolCalls.length
      ) {
        throw new OpenAIMalformedStreamError();
      }
      if (
        (outcome === "tool_calls" && completedToolCalls.length === 0) ||
        (outcome !== "tool_calls" && completedToolCalls.length > 0)
      ) {
        throw new OpenAIMalformedStreamError();
      }
      parsed = {
        outcome,
        toolCalls: completedToolCalls,
        citationRecords,
        usage,
      };
    } catch (error) {
      if (isAbortError(error, invocation.signal)) {
        const reason = cancellationReason(invocation.signal);
        yield {
          ...envelope(invocation, "response.cancelled", sequence),
          type: "response.cancelled",
          reason,
        };
        return { status: "cancelled", reason, usage: null };
      }
      const normalized = normalizeFailure(error);
      yield {
        ...envelope(invocation, "response.error", sequence),
        type: "response.error",
        error: publicError(normalized),
      };
      return { status: "failed", error: normalized, usage: null };
    }

    for (const toolCall of parsed.toolCalls) {
      yield {
        ...envelope(invocation, "response.tool_call", sequence++),
        type: "response.tool_call",
        ...toolCall,
      };
    }
    if (parsed.citationRecords.citations.length > 0) {
      const firstCitation = parsed.citationRecords.citations[0]!;
      if (firstCitation.target.type !== "assistant_message") {
        throw new OpenAIMalformedStreamError();
      }
      yield {
        ...envelope(invocation, "response.citation_batch", sequence++),
        type: "response.citation_batch",
        target: firstCitation.target,
        sources: parsed.citationRecords.sources,
        citations: parsed.citationRecords.citations,
      };
    }
    yield {
      ...envelope(invocation, "response.usage", sequence++),
      type: "response.usage",
      usage: {
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        total_tokens: parsed.usage.total_tokens,
      },
    };
    yield {
      ...envelope(invocation, "response.completed", sequence),
      type: "response.completed",
      outcome: parsed.outcome,
    };
    return {
      status: "completed",
      outcome: parsed.outcome,
      usage: parsed.usage,
    } satisfies ProviderAdapterResult;
  }
}

export function createOpenAIProviderAdapter(
  options: OpenAIProviderAdapterOptions,
): OpenAIProviderAdapter {
  return new OpenAIProviderAdapter(options);
}
