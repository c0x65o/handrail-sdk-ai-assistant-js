import { awaitWithSignal } from "../await-signal.js";
import {
  normalizeCitationRecords,
  type CitationId,
  type CitationMessageId,
  type CitationSourceId,
} from "../citations.js";
import {
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  type AttachmentReference,
  type CancellationReason,
  type JsonObject,
  type StreamEvent,
} from "../protocol.js";
import { PROVIDER_CONTEXT_NOT_SUPPORTED } from "../provider-context.js";
import { createDeferredToolDiscoveryPlan, type DeferredToolDiscoveryPlan, type ToolNamespaceDefinition } from "../tools/deferred.js";
import {
  parseProviderDocumentInputCapability,
  type DocumentInputCapabilityDescriptor,
  type ProviderAdapter,
  type ProviderAdapterError,
  type ProviderAdapterInvocation,
  type ProviderAdapterMetadata,
  type ProviderAdapterResult,
  type ProviderAdapterStream,
  type ProviderDocumentInputCapability,
  type ProviderUsage,
} from "./index.js";
import { buildOpenAIResponsesRequest, type OpenAIResponsesHostedToolsOptions, type OpenAIResponsesRequest } from "./openai-responses-tools.js";

export interface OpenAIResponsesProviderOptions {
  readonly model: string;
  readonly request: (request: OpenAIResponsesRequest, options: { readonly signal: AbortSignal }) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  readonly namespaces?: readonly ToolNamespaceDefinition[];
  /** Host-only eager catalog limit (1-1024). Defaults to 16; the total catalog limit remains 256. */
  readonly maximumEagerTools?: number;
  readonly hosted?: OpenAIResponsesHostedToolsOptions;
  readonly supportsToolSearch?: boolean;
  /** Provider schema strictness. False preserves optional/open input schemas; host validation still applies. Defaults true. */
  readonly functionStrict?: boolean;
  readonly instructions?: string;
  /** Provider-native tool selection. A resolver can force grounding only on the initial invocation. */
  readonly toolChoice?: "auto" | "required" | ((invocation: ProviderAdapterInvocation) => "auto" | "required");
  /** Requests the encrypted reasoning item required for store:false tool continuations. */
  readonly includeReasoningEncryptedContent?: boolean;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly contextWindowTokens?: number | null;
  readonly maxOutputTokens?: number | null;
  /** Optional host transcript policy; Spartan configures this to 30. */
  readonly maximumInputMessages?: number;
  readonly resolveAttachment?: (reference: AttachmentReference) => JsonObject;
  /** Explicit file-input limits; document input remains unsupported when omitted. */
  readonly document_input?: DocumentInputCapabilityDescriptor;
  /** Trusted, server-local retention for store:false tool continuations. */
  readonly continuationStore?: OpenAIResponsesContinuationStore;
}

export interface OpenAIResponsesContinuationRecord {
  readonly requestId: string;
  readonly inputItems: readonly JsonObject[];
}

export interface OpenAIResponsesContinuationStore {
  load(requestId: string): OpenAIResponsesContinuationRecord | null | Promise<OpenAIResponsesContinuationRecord | null>;
  save(record: OpenAIResponsesContinuationRecord): void | Promise<void>;
}

export class InMemoryOpenAIResponsesContinuationStore implements OpenAIResponsesContinuationStore {
  readonly #records = new Map<string, OpenAIResponsesContinuationRecord>();
  constructor(readonly maximumRecords = 256) {
    if (!Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 4_096) {
      throw new TypeError("maximumRecords must be an integer between 1 and 4096");
    }
  }
  load(requestId: string): OpenAIResponsesContinuationRecord | null {
    return this.#records.get(requestId) ?? null;
  }
  save(record: OpenAIResponsesContinuationRecord): void {
    this.#records.delete(record.requestId);
    this.#records.set(record.requestId, immutableContinuationRecord(record));
    while (this.#records.size > this.maximumRecords) this.#records.delete(this.#records.keys().next().value!);
  }
}

type RecordValue = Record<string, unknown>;

class OpenAIResponsesPreflightError extends Error {}
class OpenAIResponsesMalformedStreamError extends Error {}

const MAX_CONTINUATION_ITEMS = 256;
const MAX_CONTINUATION_BYTES = 2 * 1024 * 1024;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("OpenAI Responses stream event is invalid");
  return value as RecordValue;
}

function jsonObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenAIResponsesMalformedStreamError(label);
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new OpenAIResponsesMalformedStreamError(label); }
  const clone = JSON.parse(serialized) as unknown;
  if (!clone || typeof clone !== "object" || Array.isArray(clone)) throw new OpenAIResponsesMalformedStreamError(label);
  return clone as JsonObject;
}

function immutableContinuationRecord(record_: OpenAIResponsesContinuationRecord): OpenAIResponsesContinuationRecord {
  if (!record_.requestId || record_.requestId.length > 256 || record_.inputItems.length > MAX_CONTINUATION_ITEMS) {
    throw new TypeError("OpenAI Responses continuation record is invalid");
  }
  const inputItems = record_.inputItems.map((item) => jsonObject(item, "OpenAI Responses continuation item is invalid"));
  if (new TextEncoder().encode(JSON.stringify(inputItems)).byteLength > MAX_CONTINUATION_BYTES) {
    throw new TypeError("OpenAI Responses continuation record exceeds its byte bound");
  }
  return Object.freeze({ requestId: record_.requestId, inputItems: Object.freeze(inputItems) });
}

function opaqueHash(value: string): string {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function safeFilename(value: string): boolean {
  return value.length > 0 && value.length <= AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength && value !== "." && value !== ".." &&
    ![...value].some((character) => character.codePointAt(0)! <= 31 || character.codePointAt(0) === 127 || '<>:"/\\|?*'.includes(character));
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!, second = bytes[index + 1], third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet.charAt((value >>> 18) & 63) + alphabet.charAt((value >>> 12) & 63) +
      (second === undefined ? "=" : alphabet.charAt((value >>> 6) & 63)) +
      (third === undefined ? "=" : alphabet.charAt(value & 63));
  }
  return output;
}

function toolResultItems(invocation: ProviderAdapterInvocation): JsonObject[] {
  return invocation.tool_results.map((result) => {
    const onlyText = result.content.length === 1 && result.content[0]?.type === "text"
      ? result.content[0].text
      : undefined;
    return {
      type: "function_call_output", call_id: result.tool_call_id,
      output: onlyText ?? JSON.stringify(result.content),
    };
  });
}

function allowedToolIdentities(plan: DeferredToolDiscoveryPlan): Map<string, string | null> {
  const identities = new Map<string, string | null>();
  for (const tool of plan.eagerTools) identities.set(tool.name, null);
  for (const namespace of plan.namespaces) for (const tool of namespace.tools) identities.set(tool.name, namespace.name);
  return identities;
}

function validateToolIdentity(event: RecordValue, identities: ReadonlyMap<string, string | null>): { name: string; namespace?: string } {
  if (typeof event.name !== "string") throw new OpenAIResponsesMalformedStreamError("OpenAI Responses function name is invalid");
  const expectedNamespace = identities.get(event.name);
  if (expectedNamespace === undefined) throw new OpenAIResponsesMalformedStreamError("OpenAI Responses requested an unadvertised function");
  const actualNamespace = event.namespace;
  if (expectedNamespace === null) {
    if (actualNamespace !== undefined && actualNamespace !== null) throw new OpenAIResponsesMalformedStreamError("OpenAI Responses function namespace is invalid");
    return { name: event.name };
  }
  if (actualNamespace !== expectedNamespace) throw new OpenAIResponsesMalformedStreamError("OpenAI Responses function namespace is invalid");
  return { name: event.name, namespace: expectedNamespace };
}

interface WebCitation { readonly title: string; readonly url: string }

function webCitation(value: unknown): WebCitation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const annotation = value as RecordValue;
  if (annotation.type !== "url_citation" || typeof annotation.url !== "string" || typeof annotation.title !== "string") return null;
  const title = annotation.title.trim(), url = annotation.url.trim();
  if (!title || title.length > 512 || !url || url.length > 2_048) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
    return { title, url: parsed.toString() };
  } catch { return null; }
}

function collectWebCitations(value: unknown, citations: Map<string, WebCitation>): void {
  if (Array.isArray(value)) { value.forEach((item) => collectWebCitations(item, citations)); return; }
  if (!value || typeof value !== "object") return;
  const source = value as RecordValue;
  const direct = webCitation(source);
  if (direct) citations.set(direct.url, direct);
  for (const [key, item] of Object.entries(source)) {
    if (["response", "annotations", "content", "output", "annotation", "item"].includes(key)) collectWebCitations(item, citations);
  }
}

function citationBatch(invocation: ProviderAdapterInvocation, values: readonly WebCitation[], sequence: number): StreamEvent | null {
  if (values.length === 0) return null;
  const messageId = `${invocation.context.request_id}.assistant` as CitationMessageId;
  const sources = values.map((citation) => ({
    source_id: `openai_web_${opaqueHash(citation.url)}` as CitationSourceId,
    type: "web" as const, label: citation.title, locator: citation.url,
  }));
  const records = normalizeCitationRecords({
    sources,
    citations: sources.map((source, order) => ({
      citation_id: `openai_citation_${opaqueHash(`${source.source_id}:${order}`)}` as CitationId,
      source_id: source.source_id, order,
      target: { type: "assistant_message" as const, message_id: messageId },
    })),
  });
  return { ...envelope(invocation, "response.citation_batch", sequence), type: "response.citation_batch",
    target: { type: "assistant_message", message_id: messageId }, sources: records.sources, citations: records.citations };
}

function envelope(invocation: ProviderAdapterInvocation, type: StreamEvent["type"], sequence: number) {
  return { type, protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id, sequence,
    ...(invocation.context.metadata ? { metadata: invocation.context.metadata } : {}) };
}

function usage(value: unknown): ProviderUsage {
  const source = record(value);
  const input = source.input_tokens, output = source.output_tokens, total = source.total_tokens;
  if (![input, output, total].every((item) => Number.isSafeInteger(item) && (item as number) >= 0) || total !== (input as number) + (output as number)) {
    throw new TypeError("OpenAI Responses usage is invalid");
  }
  const inputDetails = source.input_tokens_details && typeof source.input_tokens_details === "object" ? record(source.input_tokens_details) : {};
  const outputDetails = source.output_tokens_details && typeof source.output_tokens_details === "object" ? record(source.output_tokens_details) : {};
  const cached = Number(inputDetails.cached_tokens ?? 0), cacheWrite = Number(inputDetails.cache_write_tokens ?? 0), reasoning = Number(outputDetails.reasoning_tokens ?? 0);
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > (input as number) ||
    !Number.isSafeInteger(cacheWrite) || cacheWrite < 0 || cached + cacheWrite > (input as number) ||
    !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > (output as number)) {
    throw new TypeError("OpenAI Responses usage details are invalid");
  }
  return { input_tokens: input as number, cached_input_tokens: cached,
    ...(cacheWrite ? { cache_write_input_tokens: cacheWrite } : {}),
    output_tokens: output as number, reasoning_tokens: reasoning, total_tokens: total as number,
    provider_cost: { known: false } };
}

function safeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof OpenAIResponsesPreflightError) {
    return { kind: "client", retryable: false, code: "invalid_request", message: "The request uses a capability not configured for this adapter." };
  }
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: unknown }).status) : 0;
  if (status === 429) return { kind: "provider", retryable: true, code: "rate_limited", message: "The provider rate limit was reached." };
  if (status === 408) return { kind: "provider", retryable: true, code: "deadline_exceeded", message: "The provider request timed out." };
  if (status >= 500) return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider is temporarily unavailable." };
  if (status === 401) return { kind: "client", retryable: false, code: "unauthenticated", message: "Provider authentication failed." };
  if (status === 403) return { kind: "client", retryable: false, code: "forbidden", message: "The provider denied the request." };
  if (status === 409) return { kind: "client", retryable: false, code: "idempotency_conflict", message: "The provider rejected a conflicting request." };
  if (status >= 400 && status < 500) return { kind: "client", retryable: false, code: "invalid_request", message: "The provider rejected the request as invalid." };
  return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider request failed." };
}

function publicFailure(error: ProviderAdapterError) {
  if (error.kind === "client") return { category: "request" as const, code: error.code, message: error.message, retryable: false };
  if (error.kind === "policy") return { category: "policy" as const, code: error.code, message: error.message, retryable: false };
  return {
    category: error.code === "rate_limited" ? "capacity" as const : "upstream" as const,
    code: error.code,
    message: error.message,
    retryable: true,
  };
}

function cancellationReason(signal: AbortSignal): CancellationReason {
  return signal.reason === "deadline_exceeded" || signal.reason === "policy_revoked" || signal.reason === "runtime_shutdown"
    ? signal.reason : "runtime_shutdown";
}

export class OpenAIResponsesProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context = PROVIDER_CONTEXT_NOT_SUPPORTED;
  readonly #continuations: OpenAIResponsesContinuationStore;
  readonly #documentInput: ProviderDocumentInputCapability;
  constructor(readonly options: OpenAIResponsesProviderOptions) {
    if (!options.model.trim()) throw new TypeError("model must not be empty");
    if (options.maximumInputMessages !== undefined && (!Number.isSafeInteger(options.maximumInputMessages) ||
      options.maximumInputMessages < 1 || options.maximumInputMessages > 1_000)) {
      throw new TypeError("maximumInputMessages must be an integer between 1 and 1000");
    }
    this.#documentInput = options.document_input === undefined
      ? parseProviderDocumentInputCapability({ supported: false })
      : parseProviderDocumentInputCapability({ supported: true, capability: options.document_input });
    if (this.#documentInput.supported && !this.#documentInput.capability.requires_host_resolution) {
      throw new TypeError("document_input must require host resolution");
    }
    this.#continuations = options.continuationStore ?? new InMemoryOpenAIResponsesContinuationStore();
    this.metadata = Object.freeze({ provider_id: "openai", model_id: options.model, capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: true,
      document_input: this.#documentInput, citation_projection: { supported: true },
      provider_context: PROVIDER_CONTEXT_NOT_SUPPORTED,
      context_window_tokens: options.contextWindowTokens ?? null,
      max_output_tokens: options.maxOutputTokens ?? null,
    } } satisfies ProviderAdapterMetadata);
  }

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream { return this.stream(invocation); }

  private async resolvedAttachments(invocation: ProviderAdapterInvocation): Promise<Map<string, JsonObject>> {
    const resolved = new Map<string, JsonObject>();
    let documentCount = 0, imageCount = 0;
    for (const message of invocation.messages) for (const part of message.content) {
      invocation.signal.throwIfAborted();
      if (part.type === "image" && invocation.resolve_attachment_reference && !this.options.resolveAttachment) {
        imageCount += 1;
        if (message.role !== "user" || imageCount > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest ||
          !Number.isSafeInteger(part.attachment.byte_size) || part.attachment.byte_size < 1 ||
          part.attachment.byte_size > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes) throw new OpenAIResponsesPreflightError();
        const image = await awaitWithSignal(invocation.signal, () => invocation.resolve_attachment_reference!(part.attachment, { signal: invocation.signal }));
        invocation.signal.throwIfAborted();
        if (image.media_type !== part.attachment.media_type || !(image.bytes instanceof Uint8Array) ||
          image.bytes.byteLength !== part.attachment.byte_size) throw new OpenAIResponsesPreflightError();
        resolved.set(part.attachment.content_ref, { type: "input_image", image_url: `data:${image.media_type};base64,${base64(image.bytes)}` });
      }
      if (part.type !== "document") continue;
      documentCount += 1;
      if (message.role !== "user" || !this.#documentInput.supported || (!invocation.resolve_document_reference && !invocation.resolve_attachment_reference) ||
        documentCount > this.#documentInput.capability.max_document_count ||
        !this.#documentInput.capability.supported_mime_types.includes(part.attachment.media_type) ||
        part.attachment.byte_size > this.#documentInput.capability.max_document_bytes) throw new OpenAIResponsesPreflightError();
      const document = await awaitWithSignal(invocation.signal, () => (invocation.resolve_attachment_reference ?? invocation.resolve_document_reference!)(part.attachment, { signal: invocation.signal }));
      invocation.signal.throwIfAborted();
      if (document.media_type !== part.attachment.media_type || !(document.bytes instanceof Uint8Array) ||
        document.bytes.byteLength !== part.attachment.byte_size) throw new OpenAIResponsesPreflightError();
      const filename = part.attachment.filename ?? documentFilename(
        part.attachment.attachment_id,
        part.attachment.media_type,
      );
      if (!safeFilename(filename)) throw new OpenAIResponsesPreflightError();
      resolved.set(part.attachment.content_ref, {
        type: "input_file",
        filename,
        file_data: `data:${document.media_type};base64,${base64(document.bytes)}`,
        ...(document.media_type === "application/pdf" ? { detail: "auto" } : {}),
      });
    }
    return resolved;
  }

  private async *stream(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    let sequence = 0;
    yield { ...envelope(invocation, "response.started", sequence++), type: "response.started", attribution: invocation.context.attribution };
    try {
      const effectiveInvocation: ProviderAdapterInvocation = optionsMaximumMessages(this.options) === null
        ? invocation
        : { ...invocation, messages: invocation.messages.slice(-optionsMaximumMessages(this.options)!) };
      const allowed = new Set(effectiveInvocation.tools.map((tool) => tool.name));
      const namespaces = (this.options.namespaces ?? []).map((namespace) => ({ ...namespace,
        toolNames: namespace.toolNames.filter((name) => allowed.has(name)) })).filter((namespace) => namespace.toolNames.length > 0);
      const plan = createDeferredToolDiscoveryPlan({ tools: invocation.tools, namespaces,
        ...(this.options.maximumEagerTools === undefined ? {} : { maximumEagerTools: this.options.maximumEagerTools }) });
      const identities = allowedToolIdentities(plan);
      const loadedParent = invocation.continuation_of ? await this.#continuations.load(invocation.continuation_of) : null;
      const parent = loadedParent === null ? null : immutableContinuationRecord(loadedParent);
      if (invocation.tool_results.length > 0 && parent === null) throw new OpenAIResponsesPreflightError();
      const resolved = await this.resolvedAttachments(effectiveInvocation);
      const resolveAttachment = (reference: AttachmentReference): JsonObject => {
        const document = resolved.get(reference.content_ref);
        if (document) return document;
        if (!this.options.resolveAttachment) throw new OpenAIResponsesPreflightError();
        return this.options.resolveAttachment(reference);
      };
      const request = buildOpenAIResponsesRequest({ model: this.options.model, invocation: effectiveInvocation, plan,
        supportsToolSearch: this.options.supportsToolSearch ?? true,
        ...(this.options.functionStrict === undefined ? {} : { functionStrict: this.options.functionStrict }),
        continuationItems: parent?.inputItems ?? [],
        ...(this.options.hosted ? { hosted: this.options.hosted } : {}),
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(this.options.toolChoice ? { toolChoice: typeof this.options.toolChoice === "function"
          ? this.options.toolChoice(effectiveInvocation) : this.options.toolChoice } : {}),
        ...(this.options.includeReasoningEncryptedContent ? { includeReasoningEncryptedContent: true } : {}),
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
        ...(resolved.size > 0 || this.options.resolveAttachment ? { resolveAttachment } : {}) });
      const source = await this.options.request(request, { signal: invocation.signal });
      let finalUsage: ProviderUsage | null = null;
      let completed = false;
      let completedOutput: JsonObject[] = [];
      const outputItems: JsonObject[] = [];
      const fallbackCalls: JsonObject[] = [];
      const citations = new Map<string, WebCitation>();
      let toolCalls = 0;
      let streamedText = false;
      for await (const item of source) {
        if (invocation.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const event = record(item);
        collectWebCitations(event, citations);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
          streamedText = true;
          yield { ...envelope(invocation, "response.text.delta", sequence++), type: "response.text.delta", delta: event.delta };
        } else if (event.type === "response.function_call_arguments.done") {
          if (typeof event.call_id !== "string" || typeof event.arguments !== "string") throw new OpenAIResponsesMalformedStreamError("OpenAI Responses function call is invalid");
          const identity = validateToolIdentity(event, identities);
          const arguments_ = JSON.parse(event.arguments) as unknown;
          if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new OpenAIResponsesMalformedStreamError("OpenAI Responses function arguments are invalid");
          toolCalls += 1;
          yield { ...envelope(invocation, "response.tool_call", sequence++), type: "response.tool_call",
            tool_call_id: event.call_id, name: identity.name, arguments: arguments_ as JsonObject };
          fallbackCalls.push({ type: "function_call", call_id: event.call_id, name: identity.name,
            arguments: event.arguments, ...(identity.namespace ? { namespace: identity.namespace } : {}) });
        } else if (event.type === "response.output_item.done") {
          outputItems.push(jsonObject(event.item, "OpenAI Responses output item is invalid"));
        } else if (event.type === "response.completed") {
          const response = record(event.response);
          finalUsage = usage(response.usage);
          if (Array.isArray(response.output)) completedOutput = response.output.map((output) => jsonObject(output, "OpenAI Responses output item is invalid"));
          if (!streamedText) {
            const text = completedOutput.flatMap((output) => output.type === "message" && Array.isArray(output.content)
              ? output.content.flatMap((part) => part && typeof part === "object" && !Array.isArray(part) &&
                part.type === "output_text" && typeof part.text === "string" ? [part.text] : []) : []).join("");
            if (text) {
              streamedText = true;
              yield { ...envelope(invocation, "response.text.delta", sequence++), type: "response.text.delta", delta: text };
            }
          }
          completed = true;
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new TypeError("OpenAI Responses request failed");
        }
      }
      if (!completed || !finalUsage) throw new TypeError("OpenAI Responses stream ended without completion");
      const projectedCitations = citationBatch(invocation, [...citations.values()], sequence);
      if (projectedCitations) { sequence += 1; yield projectedCitations; }
      yield { ...envelope(invocation, "response.usage", sequence++), type: "response.usage",
        usage: { input_tokens: finalUsage.input_tokens, output_tokens: finalUsage.output_tokens, total_tokens: finalUsage.total_tokens } };
      const outcome = toolCalls > 0 ? "tool_calls" as const : "stop" as const;
      if (toolCalls > 0) {
        const nativeOutput = completedOutput.length > 0 ? completedOutput : [...outputItems, ...fallbackCalls];
        await this.#continuations.save(immutableContinuationRecord({
          requestId: invocation.context.request_id,
          inputItems: [...(parent?.inputItems ?? []), ...toolResultItems(invocation), ...nativeOutput],
        }));
      }
      yield { ...envelope(invocation, "response.completed", sequence), type: "response.completed", outcome };
      return { status: "completed", outcome, usage: finalUsage } satisfies ProviderAdapterResult;
    } catch (error) {
      if (invocation.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        const reason = cancellationReason(invocation.signal);
        yield { ...envelope(invocation, "response.cancelled", sequence), type: "response.cancelled", reason };
        return { status: "cancelled", reason, usage: null };
      }
      const normalized = safeFailure(error);
      const failure = publicFailure(normalized);
      yield { ...envelope(invocation, "response.error", sequence), type: "response.error",
        error: failure };
      return { status: "failed", error: normalized, usage: null };
    }
  }
}

function documentFilename(
  attachmentId: string,
  mediaType: (typeof AI_RUNTIME_DOCUMENT_MIME_TYPES)[number],
): string {
  const extension: Record<(typeof AI_RUNTIME_DOCUMENT_MIME_TYPES)[number], string> = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
  };
  const suffix = extension[mediaType]!;
  return `${attachmentId.slice(0, 251 - suffix.length)}${suffix}`;
}

function optionsMaximumMessages(options: OpenAIResponsesProviderOptions): number | null {
  return options.maximumInputMessages ?? null;
}

export function createOpenAIResponsesProviderAdapter(options: OpenAIResponsesProviderOptions): OpenAIResponsesProviderAdapter {
  return new OpenAIResponsesProviderAdapter(options);
}
