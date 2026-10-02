import { signalCancellationReason as cancellationReason } from "../cancellation.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type ApplicationToolResult,
  type AttachmentReference,
  type ChatMessage,
  type ImageMimeType,
  type JsonObject,
  type JsonValue,
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

export interface GeminiInlineImageData {
  readonly inlineData: {
    readonly mimeType: ImageMimeType;
    readonly data: string;
  };
}

export interface GeminiFileImageData {
  readonly fileData: {
    readonly mimeType: ImageMimeType;
    readonly fileUri: string;
  };
}

export type GeminiImageData = GeminiInlineImageData | GeminiFileImageData;

export interface GeminiTextPart {
  readonly text: string;
}

export interface GeminiFunctionCallPart {
  readonly functionCall: {
    readonly id: string;
    readonly name: string;
    readonly args: JsonObject;
  };
}

export interface GeminiFunctionResponsePart {
  readonly functionResponse: {
    readonly id: string;
    readonly name: string;
    readonly response: JsonObject;
  };
}

export type GeminiContentPart =
  | GeminiTextPart
  | GeminiImageData
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiContentPart[];
}

export interface GeminiFunctionDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/**
 * The SDK-independent subset accepted by Gemini's streaming generate-content
 * boundary. Hosts adapt this to an already-configured BYOK client or request.
 */
export interface GeminiGenerateContentRequest {
  readonly model: string;
  readonly contents: readonly GeminiContent[];
  readonly tools?: readonly [{
    readonly functionDeclarations: readonly GeminiFunctionDeclaration[];
  }];
  readonly toolConfig?: {
    readonly functionCallingConfig: {
      readonly mode: "AUTO";
    };
  };
  readonly generationConfig: {
    readonly maxOutputTokens: number;
    readonly temperature: number;
  };
}

export interface GeminiRequestOptions {
  readonly signal: AbortSignal;
}

export type GeminiGenerateContentRequestFunction = (
  request: GeminiGenerateContentRequest,
  options: GeminiRequestOptions,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export type GeminiImageReferenceResolver = (
  attachment: AttachmentReference,
) => GeminiImageData | Promise<GeminiImageData>;

export interface GeminiProviderAdapterOptions {
  readonly model: string;
  readonly request: GeminiGenerateContentRequestFunction;
  readonly resolve_image_reference?: GeminiImageReferenceResolver;
  readonly context_window_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly supports_tool_calls?: boolean;
  readonly supports_reasoning?: boolean;
}

type UnknownRecord = Record<string, unknown>;

interface ParsedFunctionCall {
  readonly tool_call_id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

class GeminiPreflightError extends Error {}
class GeminiMalformedStreamError extends Error {}
class GeminiPolicyDeniedError extends Error {
  constructor(readonly usage: ProviderUsage | null) {
    super();
  }
}
class GeminiAbortMarker extends Error {}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeProperty(value: unknown, key: string): unknown {
  try {
    return record(value)?.[key];
  } catch {
    return undefined;
  }
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function requiredInteger(value: unknown): number {
  const parsed = safeInteger(value);
  if (parsed === null) throw new GeminiMalformedStreamError();
  return parsed;
}

function optionalInteger(value: unknown): number {
  return value === undefined ? 0 : requiredInteger(value);
}

function addSafe(...values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new GeminiMalformedStreamError();
  return total;
}

function cloneJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => cloneJsonValue(item));
  const object = record(value);
  if (!object) throw new GeminiMalformedStreamError();
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(object)) {
    output[key] = cloneJsonValue(item);
  }
  return output;
}

function cloneJsonObject(value: unknown): JsonObject {
  const cloned = cloneJsonValue(value);
  if (!record(cloned)) throw new GeminiMalformedStreamError();
  return cloned as JsonObject;
}

function parseUsage(value: unknown): ProviderUsage {
  const usage = record(value);
  if (!usage) throw new GeminiMalformedStreamError();

  const promptTokens = requiredInteger(usage.promptTokenCount);
  const toolPromptTokens = optionalInteger(usage.toolUsePromptTokenCount);
  const candidateTokens = requiredInteger(usage.candidatesTokenCount);
  const cachedTokens = optionalInteger(usage.cachedContentTokenCount);
  const reasoningTokens = optionalInteger(usage.thoughtsTokenCount);
  const reportedTotal = requiredInteger(usage.totalTokenCount);
  const inputTokens = promptTokens;
  const outputTokens = addSafe(candidateTokens, reasoningTokens);
  const totalTokens = addSafe(inputTokens, outputTokens);

  if (
    cachedTokens > inputTokens ||
    toolPromptTokens > inputTokens ||
    reasoningTokens > outputTokens ||
    reportedTotal !== totalTokens
  ) {
    throw new GeminiMalformedStreamError();
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    provider_cost: { known: false },
  };
}

function usageDoesNotDecrease(
  left: ProviderUsage,
  right: ProviderUsage,
): boolean {
  return (
    left.input_tokens === right.input_tokens &&
    left.cached_input_tokens === right.cached_input_tokens &&
    left.output_tokens <= right.output_tokens &&
    left.reasoning_tokens <= right.reasoning_tokens &&
    left.total_tokens <= right.total_tokens
  );
}

function toolResultResponse(result: ApplicationToolResult): JsonObject {
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "json", value: part.value },
    ),
    is_error: result.is_error,
  };
}

function validImageData(
  value: GeminiImageData,
  attachment: AttachmentReference,
): boolean {
  const source = record(value);
  if (!source) return false;
  if ("inlineData" in source) {
    const inlineData = record(source.inlineData);
    return (
      inlineData?.mimeType === attachment.media_type &&
      typeof inlineData.data === "string" &&
      inlineData.data.length > 0
    );
  }
  if ("fileData" in source) {
    const fileData = record(source.fileData);
    return (
      fileData?.mimeType === attachment.media_type &&
      typeof fileData.fileUri === "string" &&
      fileData.fileUri.length > 0
    );
  }
  return false;
}

async function mapMessage(
  message: ChatMessage,
  resolveImageReference: GeminiImageReferenceResolver | undefined,
): Promise<GeminiContent> {
  const parts: GeminiContentPart[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      parts.push({ text: part.text });
      continue;
    }
    if (message.role !== "user" || !resolveImageReference) {
      throw new GeminiPreflightError();
    }
    const resolved = await resolveImageReference(part.attachment);
    if (!validImageData(resolved, part.attachment)) {
      throw new GeminiPreflightError();
    }
    parts.push(resolved);
  }
  if (parts.length === 0) throw new GeminiPreflightError();
  return { role: message.role === "assistant" ? "model" : "user", parts };
}

function coalesceContents(contents: readonly GeminiContent[]): GeminiContent[] {
  const output: GeminiContent[] = [];
  for (const content of contents) {
    const previous = output.at(-1);
    if (previous?.role === content.role) {
      output[output.length - 1] = {
        role: previous.role,
        parts: [...previous.parts, ...content.parts],
      };
    } else {
      output.push(content);
    }
  }
  return output;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || error instanceof GeminiAbortMarker) return true;
  return safeProperty(error, "name") === "AbortError";
}

function errorStatus(error: unknown): number | null {
  const status = safeProperty(error, "status");
  if (Number.isInteger(status)) return status as number;
  const code = safeProperty(error, "code");
  return Number.isInteger(code) ? (code as number) : null;
}

function errorMarker(error: unknown): string | null {
  const candidates = [
    safeProperty(error, "status"),
    safeProperty(error, "code"),
    safeProperty(safeProperty(error, "error"), "status"),
  ];
  return candidates.find((value): value is string => typeof value === "string") ?? null;
}

function normalizeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof GeminiPreflightError) {
    return {
      kind: "client",
      retryable: false,
      code: "invalid_request",
      message: "The request uses a capability not configured for this adapter.",
    };
  }
  if (error instanceof GeminiMalformedStreamError) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider returned malformed streaming data.",
    };
  }
  if (error instanceof GeminiPolicyDeniedError) {
    return {
      kind: "policy",
      retryable: false,
      code: "policy_denied",
      message: "The provider denied the request due to policy.",
    };
  }

  const status = errorStatus(error);
  const marker = errorMarker(error);
  if (status === 429 || marker === "RESOURCE_EXHAUSTED") {
    return {
      kind: "provider",
      retryable: true,
      code: "rate_limited",
      message: "The provider rate limit or capacity limit was reached.",
    };
  }
  const name = safeProperty(error, "name");
  const code = safeProperty(error, "code");
  if (
    status === 408 ||
    status === 504 ||
    marker === "DEADLINE_EXCEEDED" ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT"
  ) {
    return {
      kind: "provider",
      retryable: true,
      code: "deadline_exceeded",
      message: "The provider request timed out.",
    };
  }
  if (
    (status !== null && status >= 500) ||
    marker === "UNAVAILABLE" ||
    marker === "INTERNAL"
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
  if (status === 401 || marker === "UNAUTHENTICATED") {
    return clientError("unauthenticated", "Provider authentication failed.");
  }
  if (status === 403 || marker === "PERMISSION_DENIED") {
    return clientError("forbidden", "The provider denied the request.");
  }
  if (status === 409 || marker === "ABORTED" || marker === "ALREADY_EXISTS") {
    return clientError(
      "idempotency_conflict",
      "The provider rejected a conflicting request.",
    );
  }
  if (
    (status !== null && status >= 400 && status < 500) ||
    marker === "INVALID_ARGUMENT" ||
    marker === "FAILED_PRECONDITION" ||
    marker === "NOT_FOUND" ||
    marker === "OUT_OF_RANGE"
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

function isPolicyFinishReason(value: string): boolean {
  return [
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
    "IMAGE_PROHIBITED_CONTENT",
    "IMAGE_RECITATION",
    "ESCALATION",
  ].includes(value);
}

function promptWasBlocked(value: unknown): boolean {
  const feedback = record(value);
  if (!feedback) throw new GeminiMalformedStreamError();
  return (
    typeof feedback.blockReason === "string" &&
    feedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
  );
}

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context: ProviderContextCapability = PROVIDER_CONTEXT_NOT_SUPPORTED;
  private readonly request: GeminiGenerateContentRequestFunction;
  private readonly resolveImageReference: GeminiImageReferenceResolver | undefined;

  constructor(options: GeminiProviderAdapterOptions) {
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (typeof options.request !== "function") {
      throw new TypeError("request must be a function");
    }
    this.request = options.request;
    this.resolveImageReference = options.resolve_image_reference;
    this.metadata = {
      provider_id: "gemini",
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
  ): Promise<GeminiGenerateContentRequest> {
    if (
      invocation.messages.length === 0 ||
      !Number.isSafeInteger(invocation.generation.max_output_tokens) ||
      invocation.generation.max_output_tokens <= 0 ||
      !Number.isFinite(invocation.generation.temperature) ||
      invocation.generation.temperature < 0 ||
      invocation.generation.temperature > 1
    ) {
      throw new GeminiPreflightError();
    }
    if (
      !this.metadata.capabilities.tool_calls &&
      (invocation.tools.length > 0 || invocation.tool_results.length > 0)
    ) {
      throw new GeminiPreflightError();
    }
    if (invocation.tool_results.length > 1) {
      throw new GeminiPreflightError();
    }
    if (
      this.metadata.capabilities.max_output_tokens !== null &&
      invocation.generation.max_output_tokens >
        this.metadata.capabilities.max_output_tokens
    ) {
      throw new GeminiPreflightError();
    }
    if (
      invocation.messages.some((message) =>
        message.content.some((part) => part.type === "document"),
      )
    ) {
      throw new GeminiPreflightError();
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
      throw new GeminiPreflightError();
    }

    const mappedMessages = await Promise.all(
      invocation.messages.map((message) =>
        mapMessage(message, this.resolveImageReference),
      ),
    );
    if (mappedMessages[0]?.role !== "user") throw new GeminiPreflightError();

    const resultContext: GeminiContent[] = invocation.tool_results.flatMap(
      (result) => [
        {
          role: "model" as const,
          parts: [{
            functionCall: {
              id: result.tool_call_id,
              name: result.name,
              args: {},
            },
          }],
        },
        {
          role: "user" as const,
          parts: [{
            functionResponse: {
              id: result.tool_call_id,
              name: result.name,
              response: toolResultResponse(result),
            },
          }],
        },
      ],
    );
    const contents = coalesceContents([...mappedMessages, ...resultContext]);
    const declarations = invocation.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    }));

    return {
      model: this.metadata.model_id,
      contents,
      ...(declarations.length === 0
        ? {}
        : {
            tools: [{ functionDeclarations: declarations }] as const,
            toolConfig: {
              functionCallingConfig: { mode: "AUTO" as const },
            },
          }),
      generationConfig: {
        maxOutputTokens: invocation.generation.max_output_tokens,
        temperature: invocation.generation.temperature,
      },
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
    let functionCalls: ParsedFunctionCall[];
    try {
      const payload = await this.requestPayload(invocation);
      if (invocation.signal.aborted) throw new GeminiAbortMarker();
      const chunks = await this.request(payload, { signal: invocation.signal });
      if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
        throw new GeminiMalformedStreamError();
      }

      let finishReason: string | null = null;
      let parsedUsage: ProviderUsage | null = null;
      const parsedCalls: ParsedFunctionCall[] = [];
      let candidateSeen = false;

      for await (const chunkValue of chunks) {
        if (invocation.signal.aborted) throw new GeminiAbortMarker();
        const chunk = record(chunkValue);
        if (!chunk) throw new GeminiMalformedStreamError();

        if (chunk.usageMetadata !== undefined) {
          const nextUsage = parseUsage(chunk.usageMetadata);
          if (parsedUsage && !usageDoesNotDecrease(parsedUsage, nextUsage)) {
            throw new GeminiMalformedStreamError();
          }
          parsedUsage = nextUsage;
        }
        if (
          chunk.promptFeedback !== undefined &&
          promptWasBlocked(chunk.promptFeedback)
        ) {
          throw new GeminiPolicyDeniedError(parsedUsage);
        }
        if (!Array.isArray(chunk.candidates) || chunk.candidates.length > 1) {
          throw new GeminiMalformedStreamError();
        }
        if (chunk.candidates.length === 0) continue;

        const candidate = record(chunk.candidates[0]);
        if (!candidate) throw new GeminiMalformedStreamError();
        if (candidate.index !== undefined && candidate.index !== 0) {
          throw new GeminiMalformedStreamError();
        }
        candidateSeen = true;
        if (candidate.content !== undefined) {
          const content = record(candidate.content);
          if (
            !content ||
            (content.role !== undefined && content.role !== "model") ||
            !Array.isArray(content.parts)
          ) {
            throw new GeminiMalformedStreamError();
          }
          for (const partValue of content.parts) {
            const part = record(partValue);
            if (!part) throw new GeminiMalformedStreamError();
            if (part.thought === true) continue;
            if (part.text !== undefined) {
              if (typeof part.text !== "string") {
                throw new GeminiMalformedStreamError();
              }
              if (part.text.length > 0) {
                yield {
                  ...envelope(invocation, "response.text.delta", sequence++),
                  type: "response.text.delta",
                  delta: part.text,
                };
              }
              continue;
            }
            if (part.functionCall !== undefined) {
              const call = record(part.functionCall);
              if (
                !call ||
                typeof call.name !== "string" ||
                call.name.length === 0
              ) {
                throw new GeminiMalformedStreamError();
              }
              const id =
                typeof call.id === "string" && call.id.length > 0
                  ? call.id
                  : `${invocation.context.request_id}:gemini:${parsedCalls.length}`;
              parsedCalls.push({
                tool_call_id: id,
                name: call.name,
                arguments:
                  call.args === undefined ? {} : cloneJsonObject(call.args),
              });
              if (parsedCalls.length > 1) {
                throw new GeminiMalformedStreamError();
              }
              continue;
            }
            throw new GeminiMalformedStreamError();
          }
        }

        if (candidate.finishReason !== undefined) {
          if (
            typeof candidate.finishReason !== "string" ||
            (finishReason !== null && finishReason !== candidate.finishReason)
          ) {
            throw new GeminiMalformedStreamError();
          }
          finishReason = candidate.finishReason;
        }
      }

      if (!candidateSeen || !parsedUsage || finishReason === null) {
        throw new GeminiMalformedStreamError();
      }
      if (isPolicyFinishReason(finishReason)) {
        throw new GeminiPolicyDeniedError(parsedUsage);
      }
      if (finishReason === "STOP") {
        outcome = parsedCalls.length === 0 ? "stop" : "tool_calls";
      } else if (finishReason === "MAX_TOKENS") {
        if (parsedCalls.length > 0) throw new GeminiMalformedStreamError();
        outcome = "length";
      } else {
        throw new GeminiMalformedStreamError();
      }
      usage = parsedUsage;
      functionCalls = parsedCalls;
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
      const failureUsage =
        error instanceof GeminiPolicyDeniedError ? error.usage : null;
      if (failureUsage) {
        yield {
          ...envelope(invocation, "response.usage", sequence++),
          type: "response.usage",
          usage: {
            input_tokens: failureUsage.input_tokens,
            output_tokens: failureUsage.output_tokens,
            total_tokens: failureUsage.total_tokens,
          },
        };
      }
      yield {
        ...envelope(invocation, "response.error", sequence),
        type: "response.error",
        error: publicError(normalized),
      };
      return { status: "failed", error: normalized, usage: failureUsage };
    }

    for (const call of functionCalls) {
      yield {
        ...envelope(invocation, "response.tool_call", sequence++),
        type: "response.tool_call",
        ...call,
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

export function createGeminiProviderAdapter(
  options: GeminiProviderAdapterOptions,
): GeminiProviderAdapter {
  return new GeminiProviderAdapter(options);
}
