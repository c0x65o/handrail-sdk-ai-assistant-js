import { signalCancellationReason as cancellationReason } from "../cancellation.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type ApplicationToolResult,
  type AttachmentReference,
  type ChatMessage,
  type ImageMimeType,
  type JsonObject,
  type ProtocolMetadata,
  type StreamEvent,
} from "../protocol.js";
import {
  PROVIDER_CONTEXT_NOT_SUPPORTED,
  type ProviderContextCapability,
} from "../provider-context.js";
import type {
  ClientRequestError,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAdapterInvocation,
  ProviderAdapterMetadata,
  ProviderAdapterResult,
  ProviderAdapterStream,
  ProviderUsage,
} from "./index.js";

export interface AnthropicBase64ImageSource {
  readonly type: "base64";
  readonly media_type: ImageMimeType;
  readonly data: string;
}

export interface AnthropicUrlImageSource {
  readonly type: "url";
  readonly url: string;
}

export type AnthropicImageSource =
  | AnthropicBase64ImageSource
  | AnthropicUrlImageSource;

export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AnthropicImageBlock {
  readonly type: "image";
  readonly source: AnthropicImageSource;
}

export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error: boolean;
}

export type AnthropicMessageBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly AnthropicMessageBlock[];
}

export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonObject;
}

/**
 * The SDK-independent subset accepted by Anthropic's streaming Messages
 * boundary. Hosts may adapt it to any already-configured client or transport.
 */
export interface AnthropicMessagesRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicTool[];
  readonly tool_choice?: {
    readonly type: "auto";
    readonly disable_parallel_tool_use: true;
  };
  readonly max_tokens: number;
  readonly temperature: number;
  readonly stream: true;
}

export interface AnthropicRequestOptions {
  readonly signal: AbortSignal;
}

export type AnthropicMessagesRequestFunction = (
  request: AnthropicMessagesRequest,
  options: AnthropicRequestOptions,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export type AnthropicImageReferenceResolver = (
  attachment: AttachmentReference,
) => AnthropicImageSource | Promise<AnthropicImageSource>;

export interface AnthropicProviderAdapterOptions {
  readonly model: string;
  readonly request: AnthropicMessagesRequestFunction;
  readonly resolve_image_reference?: AnthropicImageReferenceResolver;
  readonly context_window_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly supports_tool_calls?: boolean;
  readonly supports_reasoning?: boolean;
}

type UnknownRecord = Record<string, unknown>;

interface NativeUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

interface TextBlockAssembly {
  type: "text";
  closed: boolean;
}

interface ToolBlockAssembly {
  type: "tool_use";
  closed: boolean;
  id: string;
  name: string;
  argumentsText: string;
}

interface ThinkingBlockAssembly {
  type: "thinking" | "redacted_thinking";
  closed: boolean;
}

type BlockAssembly =
  | TextBlockAssembly
  | ToolBlockAssembly
  | ThinkingBlockAssembly;

class AnthropicPreflightError extends Error {}
class AnthropicMalformedStreamError extends Error {}
class AnthropicAbortMarker extends Error {}

type StreamFailureCode =
  | "rate_limit_error"
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "request_too_large"
  | "not_found_error"
  | "timeout_error"
  | "overloaded_error"
  | "api_error"
  | "policy_error";

class AnthropicReportedStreamError extends Error {
  constructor(readonly failureCode: StreamFailureCode) {
    super();
  }
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

function requiredInteger(value: unknown): number {
  const parsed = safeInteger(value);
  if (parsed === null) throw new AnthropicMalformedStreamError();
  return parsed;
}

function optionalInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  return requiredInteger(value);
}

function addSafe(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new AnthropicMalformedStreamError();
  return total;
}

function parseInitialUsage(value: unknown): NativeUsage {
  const usage = record(value);
  if (!usage) throw new AnthropicMalformedStreamError();
  const outputTokens = requiredInteger(usage.output_tokens);
  const reasoningTokens = reasoningUsage(usage, 0);
  if (reasoningTokens > outputTokens) throw new AnthropicMalformedStreamError();
  return {
    inputTokens: requiredInteger(usage.input_tokens),
    cacheCreationInputTokens: optionalInteger(
      usage.cache_creation_input_tokens,
      0,
    ),
    cacheReadInputTokens: optionalInteger(usage.cache_read_input_tokens, 0),
    outputTokens,
    reasoningTokens,
  };
}

function reasoningUsage(usage: UnknownRecord, fallback: number): number {
  const reasoning = usage.reasoning_tokens;
  const thinking = usage.thinking_tokens;
  if (reasoning === undefined && thinking === undefined) return fallback;
  const parsedReasoning =
    reasoning === undefined ? null : requiredInteger(reasoning);
  const parsedThinking = thinking === undefined ? null : requiredInteger(thinking);
  if (
    parsedReasoning !== null &&
    parsedThinking !== null &&
    parsedReasoning !== parsedThinking
  ) {
    throw new AnthropicMalformedStreamError();
  }
  return parsedReasoning ?? parsedThinking ?? fallback;
}

function mergeFinalUsage(current: NativeUsage, value: unknown): NativeUsage {
  const usage = record(value);
  if (!usage) throw new AnthropicMalformedStreamError();
  const inputTokens = optionalInteger(usage.input_tokens, current.inputTokens);
  const cacheCreationInputTokens = optionalInteger(
    usage.cache_creation_input_tokens,
    current.cacheCreationInputTokens,
  );
  const cacheReadInputTokens = optionalInteger(
    usage.cache_read_input_tokens,
    current.cacheReadInputTokens,
  );
  if (
    inputTokens !== current.inputTokens ||
    cacheCreationInputTokens !== current.cacheCreationInputTokens ||
    cacheReadInputTokens !== current.cacheReadInputTokens
  ) {
    throw new AnthropicMalformedStreamError();
  }
  const outputTokens = requiredInteger(usage.output_tokens);
  const reasoningTokens = reasoningUsage(usage, current.reasoningTokens);
  if (outputTokens < current.outputTokens || reasoningTokens > outputTokens) {
    throw new AnthropicMalformedStreamError();
  }
  return { ...current, outputTokens, reasoningTokens };
}

function normalizeUsage(usage: NativeUsage): ProviderUsage {
  const inputTokens = addSafe(
    usage.inputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
  );
  return {
    input_tokens: inputTokens,
    cached_input_tokens: usage.cacheReadInputTokens,
    cache_write_input_tokens: usage.cacheCreationInputTokens,
    output_tokens: usage.outputTokens,
    reasoning_tokens: usage.reasoningTokens,
    total_tokens: addSafe(inputTokens, usage.outputTokens),
    provider_cost: { known: false },
  };
}

function toolResultContent(result: ApplicationToolResult): string {
  return result.content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("\n");
}

function validImageSource(
  source: AnthropicImageSource,
  attachment: AttachmentReference,
): boolean {
  if (!source || typeof source !== "object") return false;
  if (source.type === "url") {
    return typeof source.url === "string" && source.url.length > 0;
  }
  return (
    source.type === "base64" &&
    source.media_type === attachment.media_type &&
    typeof source.data === "string" &&
    source.data.length > 0
  );
}

async function mapMessage(
  message: ChatMessage,
  resolveImageReference: AnthropicImageReferenceResolver | undefined,
): Promise<AnthropicMessage> {
  const content: AnthropicMessageBlock[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (message.role !== "user" || !resolveImageReference) {
      throw new AnthropicPreflightError();
    }
    const source = await resolveImageReference(part.attachment);
    if (!validImageSource(source, part.attachment)) {
      throw new AnthropicPreflightError();
    }
    content.push({ type: "image", source });
  }
  if (content.length === 0) throw new AnthropicPreflightError();
  return { role: message.role, content };
}

function coalesceMessages(messages: readonly AnthropicMessage[]): AnthropicMessage[] {
  const output: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = output.at(-1);
    if (previous?.role === message.role) {
      output[output.length - 1] = {
        role: previous.role,
        content: [...previous.content, ...message.content],
      };
    } else {
      output.push(message);
    }
  }
  return output;
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return record(value)?.[key];
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || error instanceof AnthropicAbortMarker) return true;
  return safeProperty(error, "name") === "AbortError";
}

function errorStatus(error: unknown): number | null {
  const status = safeProperty(error, "status");
  return Number.isInteger(status) ? (status as number) : null;
}

function errorMarker(error: unknown): string | null {
  const directType = safeProperty(error, "type");
  if (typeof directType === "string") return directType;
  const nested = safeProperty(error, "error");
  const nestedType = safeProperty(nested, "type");
  return typeof nestedType === "string" ? nestedType : null;
}

function reportedStreamFailure(value: unknown): AnthropicReportedStreamError {
  const error = record(record(value)?.error);
  const type = error?.type;
  const supported: readonly StreamFailureCode[] = [
    "rate_limit_error",
    "authentication_error",
    "permission_error",
    "invalid_request_error",
    "request_too_large",
    "not_found_error",
    "timeout_error",
    "overloaded_error",
    "api_error",
    "policy_error",
  ];
  if (typeof type !== "string" || !supported.includes(type as StreamFailureCode)) {
    throw new AnthropicMalformedStreamError();
  }
  return new AnthropicReportedStreamError(type as StreamFailureCode);
}

function normalizeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof AnthropicPreflightError) {
    return {
      kind: "client",
      retryable: false,
      code: "invalid_request",
      message: "The request uses a capability not configured for this adapter.",
    };
  }
  if (error instanceof AnthropicMalformedStreamError) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider returned malformed streaming data.",
    };
  }

  const marker =
    error instanceof AnthropicReportedStreamError
      ? error.failureCode
      : errorMarker(error);
  const status = errorStatus(error);
  if (status === 429 || marker === "rate_limit_error") {
    return {
      kind: "provider",
      retryable: true,
      code: "rate_limited",
      message: "The provider rate limit was reached.",
    };
  }
  const name = safeProperty(error, "name");
  const code = safeProperty(error, "code");
  if (
    status === 408 ||
    marker === "timeout_error" ||
    name === "TimeoutError" ||
    name === "APIConnectionTimeoutError" ||
    code === "ETIMEDOUT"
  ) {
    return {
      kind: "provider",
      retryable: true,
      code: "deadline_exceeded",
      message: "The provider request timed out.",
    };
  }
  if (marker === "policy_error") {
    return {
      kind: "policy",
      retryable: false,
      code: "policy_denied",
      message: "The provider denied the request due to policy.",
    };
  }
  if (
    (status !== null && status >= 500) ||
    marker === "overloaded_error" ||
    marker === "api_error"
  ) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider is temporarily unavailable.",
    };
  }

  const clientError = (
    clientCode: ClientRequestError["code"],
    message: string,
  ): ClientRequestError => ({
    kind: "client",
    retryable: false,
    code: clientCode,
    message,
  });
  if (status === 401 || marker === "authentication_error") {
    return clientError("unauthenticated", "Provider authentication failed.");
  }
  if (status === 403 || marker === "permission_error") {
    return clientError("forbidden", "The provider denied the request.");
  }
  if (status === 409) {
    return clientError(
      "idempotency_conflict",
      "The provider rejected a conflicting request.",
    );
  }
  if (
    (status !== null && status >= 400 && status < 500) ||
    marker === "invalid_request_error" ||
    marker === "request_too_large" ||
    marker === "not_found_error"
  ) {
    return clientError(
      "invalid_request",
      "The provider rejected the request as invalid.",
    );
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

export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context: ProviderContextCapability = PROVIDER_CONTEXT_NOT_SUPPORTED;
  private readonly request: AnthropicMessagesRequestFunction;
  private readonly resolveImageReference:
    | AnthropicImageReferenceResolver
    | undefined;

  constructor(options: AnthropicProviderAdapterOptions) {
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (typeof options.request !== "function") {
      throw new TypeError("request must be a function");
    }
    this.request = options.request;
    this.resolveImageReference = options.resolve_image_reference;
    this.metadata = {
      provider_id: "anthropic",
      model_id: options.model,
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: options.supports_tool_calls ?? true,
        parallel_tool_calls: false,
        reasoning: options.supports_reasoning ?? true,
        document_input: { supported: false },
        citation_projection: { supported: false },
        provider_context: this.provider_context,
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
  ): Promise<AnthropicMessagesRequest> {
    if (
      invocation.messages.length === 0 ||
      !Number.isSafeInteger(invocation.generation.max_output_tokens) ||
      invocation.generation.max_output_tokens <= 0 ||
      !Number.isFinite(invocation.generation.temperature) ||
      invocation.generation.temperature < 0 ||
      invocation.generation.temperature > 1
    ) {
      throw new AnthropicPreflightError();
    }
    if (
      !this.metadata.capabilities.tool_calls &&
      (invocation.tools.length > 0 || invocation.tool_results.length > 0)
    ) {
      throw new AnthropicPreflightError();
    }
    if (
      this.metadata.capabilities.max_output_tokens !== null &&
      invocation.generation.max_output_tokens >
        this.metadata.capabilities.max_output_tokens
    ) {
      throw new AnthropicPreflightError();
    }
    if (
      invocation.messages.some((message) =>
        message.content.some((part) => part.type === "document"),
      )
    ) {
      throw new AnthropicPreflightError();
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
      throw new AnthropicPreflightError();
    }

    const mappedMessages = await Promise.all(
      invocation.messages.map((message) =>
        mapMessage(message, this.resolveImageReference),
      ),
    );
    if (mappedMessages[0]?.role !== "user") {
      throw new AnthropicPreflightError();
    }

    const resultContext: AnthropicMessage[] =
      invocation.tool_results.length === 0
        ? []
        : [
            {
              role: "assistant",
              content: invocation.tool_results.map((result) => ({
                type: "tool_use" as const,
                id: result.tool_call_id,
                name: result.name,
                input: {},
              })),
            },
            {
              role: "user",
              content: invocation.tool_results.map((result) => ({
                type: "tool_result" as const,
                tool_use_id: result.tool_call_id,
                content: toolResultContent(result),
                is_error: result.is_error,
              })),
            },
          ];
    const messages = coalesceMessages([...mappedMessages, ...resultContext]);
    const tools = invocation.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }));

    return {
      model: this.metadata.model_id,
      messages,
      ...(tools.length === 0
        ? {}
        : {
            tools,
            tool_choice: {
              type: "auto" as const,
              disable_parallel_tool_use: true as const,
            },
          }),
      max_tokens: invocation.generation.max_output_tokens,
      temperature: invocation.generation.temperature,
      stream: true,
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

    let outcome: "stop" | "length" | "tool_calls";
    let usage: ProviderUsage;
    let completedToolCalls: {
      tool_call_id: string;
      name: string;
      arguments: JsonObject;
    }[];

    try {
      const payload = await this.requestPayload(invocation);
      if (invocation.signal.aborted) throw new AnthropicAbortMarker();
      const chunks = await this.request(payload, { signal: invocation.signal });
      if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
        throw new AnthropicMalformedStreamError();
      }

      const blocks = new Map<number, BlockAssembly>();
      let nativeUsage: NativeUsage | null = null;
      let finishReason: string | null = null;
      let messageStarted = false;
      let messageStopped = false;

      for await (const chunkValue of chunks) {
        if (invocation.signal.aborted) throw new AnthropicAbortMarker();
        const chunk = record(chunkValue);
        if (!chunk || typeof chunk.type !== "string" || messageStopped) {
          throw new AnthropicMalformedStreamError();
        }

        if (chunk.type === "ping") continue;
        if (chunk.type === "error") throw reportedStreamFailure(chunk);

        if (chunk.type === "message_start") {
          const message = record(chunk.message);
          if (
            messageStarted ||
            !message ||
            message.type !== "message" ||
            message.role !== "assistant" ||
            !Array.isArray(message.content) ||
            message.content.length !== 0
          ) {
            throw new AnthropicMalformedStreamError();
          }
          nativeUsage = parseInitialUsage(message.usage);
          messageStarted = true;
          continue;
        }

        if (!messageStarted || nativeUsage === null) {
          throw new AnthropicMalformedStreamError();
        }

        if (chunk.type === "content_block_start") {
          const index = safeInteger(chunk.index);
          const block = record(chunk.content_block);
          if (index === null || index !== blocks.size || !block) {
            throw new AnthropicMalformedStreamError();
          }
          if (block.type === "text" && typeof block.text === "string") {
            blocks.set(index, { type: "text", closed: false });
            if (block.text.length > 0) {
              yield {
                ...envelope(invocation, "response.text.delta", sequence++),
                type: "response.text.delta",
                delta: block.text,
              };
            }
            continue;
          }
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            block.id.length > 0 &&
            typeof block.name === "string" &&
            block.name.length > 0 &&
            record(block.input) &&
            Object.keys(block.input as UnknownRecord).length === 0
          ) {
            blocks.set(index, {
              type: "tool_use",
              closed: false,
              id: block.id,
              name: block.name,
              argumentsText: "",
            });
            continue;
          }
          if (
            block.type === "thinking" &&
            typeof block.thinking === "string"
          ) {
            blocks.set(index, { type: "thinking", closed: false });
            continue;
          }
          if (
            block.type === "redacted_thinking" &&
            typeof block.data === "string"
          ) {
            blocks.set(index, { type: "redacted_thinking", closed: false });
            continue;
          }
          throw new AnthropicMalformedStreamError();
        }

        if (chunk.type === "content_block_delta") {
          const index = safeInteger(chunk.index);
          const block = index === null ? undefined : blocks.get(index);
          const delta = record(chunk.delta);
          if (!block || block.closed || !delta) {
            throw new AnthropicMalformedStreamError();
          }
          if (
            block.type === "text" &&
            delta.type === "text_delta" &&
            typeof delta.text === "string"
          ) {
            if (delta.text.length > 0) {
              yield {
                ...envelope(invocation, "response.text.delta", sequence++),
                type: "response.text.delta",
                delta: delta.text,
              };
            }
            continue;
          }
          if (
            block.type === "tool_use" &&
            delta.type === "input_json_delta" &&
            typeof delta.partial_json === "string"
          ) {
            block.argumentsText += delta.partial_json;
            continue;
          }
          if (
            block.type === "thinking" &&
            ((delta.type === "thinking_delta" &&
              typeof delta.thinking === "string") ||
              (delta.type === "signature_delta" &&
                typeof delta.signature === "string"))
          ) {
            continue;
          }
          throw new AnthropicMalformedStreamError();
        }

        if (chunk.type === "content_block_stop") {
          const index = safeInteger(chunk.index);
          const block = index === null ? undefined : blocks.get(index);
          if (!block || block.closed) throw new AnthropicMalformedStreamError();
          block.closed = true;
          continue;
        }

        if (chunk.type === "message_delta") {
          const delta = record(chunk.delta);
          if (
            !delta ||
            (delta.stop_reason !== null &&
              typeof delta.stop_reason !== "string") ||
            [...blocks.values()].some((block) => !block.closed)
          ) {
            throw new AnthropicMalformedStreamError();
          }
          if (typeof delta.stop_reason === "string") {
            if (
              finishReason !== null &&
              finishReason !== delta.stop_reason
            ) {
              throw new AnthropicMalformedStreamError();
            }
            finishReason = delta.stop_reason;
          }
          nativeUsage = mergeFinalUsage(nativeUsage, chunk.usage);
          continue;
        }

        if (chunk.type === "message_stop") {
          if (finishReason === null) throw new AnthropicMalformedStreamError();
          messageStopped = true;
          continue;
        }

        throw new AnthropicMalformedStreamError();
      }

      if (!messageStopped || finishReason === null || nativeUsage === null) {
        throw new AnthropicMalformedStreamError();
      }
      usage = normalizeUsage(nativeUsage);

      if (finishReason === "refusal") {
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
          ...envelope(invocation, "response.error", sequence),
          type: "response.error",
          error: publicError(policyError),
        };
        return { status: "failed", error: policyError, usage };
      }

      outcome =
        finishReason === "end_turn" || finishReason === "stop_sequence"
          ? "stop"
          : finishReason === "max_tokens" ||
              finishReason === "model_context_window_exceeded"
            ? "length"
            : finishReason === "tool_use"
              ? "tool_calls"
              : (() => {
                  throw new AnthropicMalformedStreamError();
                })();

      completedToolCalls = [...blocks.values()].flatMap((block) => {
        if (block.type !== "tool_use") return [];
        let argumentsValue: unknown;
        try {
          argumentsValue = JSON.parse(block.argumentsText);
        } catch {
          throw new AnthropicMalformedStreamError();
        }
        if (!record(argumentsValue)) throw new AnthropicMalformedStreamError();
        return [{
            tool_call_id: block.id,
            name: block.name,
            arguments: argumentsValue as JsonObject,
        }];
      });
      if (
        new Set(completedToolCalls.map((call) => call.tool_call_id)).size !==
          completedToolCalls.length ||
        (outcome === "tool_calls" && completedToolCalls.length === 0) ||
        (outcome !== "tool_calls" && completedToolCalls.length > 0)
      ) {
        throw new AnthropicMalformedStreamError();
      }
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

    for (const toolCall of completedToolCalls) {
      yield {
        ...envelope(invocation, "response.tool_call", sequence++),
        type: "response.tool_call",
        ...toolCall,
      };
    }
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
      ...envelope(invocation, "response.completed", sequence),
      type: "response.completed",
      outcome,
    };
    return {
      status: "completed",
      outcome,
      usage,
    } satisfies ProviderAdapterResult;
  }
}

export function createAnthropicProviderAdapter(
  options: AnthropicProviderAdapterOptions,
): AnthropicProviderAdapter {
  return new AnthropicProviderAdapter(options);
}
