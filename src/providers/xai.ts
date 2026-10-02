import { signalCancellationReason as cancellationReason } from "../cancellation.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type ApplicationToolResult,
  type AttachmentReference,
  type ChatMessage,
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

export interface XAIImageSource {
  readonly url: string;
  readonly detail?: "auto" | "low" | "high";
}

export interface XAITextContentPart {
  readonly type: "text";
  readonly text: string;
}

export interface XAIImageContentPart {
  readonly type: "image_url";
  readonly image_url: XAIImageSource;
}

export interface XAIMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly (XAITextContentPart | XAIImageContentPart)[];
}

export interface XAIAssistantToolCallMessage {
  readonly role: "assistant";
  readonly content: null;
  readonly tool_calls: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: "{}" };
  }[];
}

export interface XAIToolResultMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export interface XAITool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}

/** SDK-independent xAI streaming request boundary for an already-configured host. */
export interface XAIChatRequest {
  readonly model: string;
  readonly messages: readonly (XAIMessage | XAIAssistantToolCallMessage | XAIToolResultMessage)[];
  readonly tools?: readonly XAITool[];
  readonly parallel_tool_calls?: false;
  readonly max_tokens: number;
  readonly temperature: number;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
}

export interface XAIRequestOptions {
  readonly signal: AbortSignal;
}

export type XAIRequestFunction = (
  request: XAIChatRequest,
  options: XAIRequestOptions,
) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

export type XAIImageReferenceResolver = (
  attachment: AttachmentReference,
) => XAIImageSource | Promise<XAIImageSource>;

export interface XAIProviderAdapterOptions {
  readonly model: string;
  readonly request: XAIRequestFunction;
  readonly resolve_image_reference?: XAIImageReferenceResolver;
  readonly supports_images?: boolean;
  readonly supports_tool_calls?: boolean;
  readonly supports_reasoning?: boolean;
  readonly context_window_tokens?: number | null;
  readonly max_output_tokens?: number | null;
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
  usage: ProviderUsage;
}

class XAIPreflightError extends Error {}
class XAIMalformedStreamError extends Error {}
class XAIAbortMarker extends Error {}

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
  if (parsed === null) throw new XAIMalformedStreamError();
  return parsed;
}

function optionalInteger(value: unknown): number {
  return value === undefined ? 0 : requiredInteger(value);
}

function setStableFragment(
  assembly: ToolCallAssembly,
  key: "id" | "name",
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new XAIMalformedStreamError();
  }
  if (assembly[key] !== undefined && assembly[key] !== value) {
    throw new XAIMalformedStreamError();
  }
  assembly[key] = value;
}

function parseCost(value: unknown): ProviderUsage["provider_cost"] {
  if (value === undefined || value === null) return { known: false };
  const ticks = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string" && /^\d+$/.test(value)
      ? value.replace(/^0+(?=\d)/, "")
      : null;
  if (ticks === null) throw new XAIMalformedStreamError();

  const whole = ticks.length > 10 ? ticks.slice(0, -10) : "0";
  const fraction = ticks.padStart(10, "0").slice(-10).replace(/0+$/, "");
  return {
    known: true,
    amount: fraction.length === 0 ? whole : `${whole}.${fraction}`,
    currency: "USD",
  };
}

function parseUsage(value: unknown, supportsReasoning: boolean): ProviderUsage {
  const usage = record(value);
  if (!usage) throw new XAIMalformedStreamError();
  const inputTokens = requiredInteger(usage.prompt_tokens);
  const completionTokens = requiredInteger(usage.completion_tokens);
  const totalTokens = requiredInteger(usage.total_tokens);
  const promptDetails = usage.prompt_tokens_details === undefined
    ? null
    : record(usage.prompt_tokens_details);
  const completionDetails = usage.completion_tokens_details === undefined
    ? null
    : record(usage.completion_tokens_details);
  if (
    (usage.prompt_tokens_details !== undefined && !promptDetails) ||
    (usage.completion_tokens_details !== undefined && !completionDetails)
  ) {
    throw new XAIMalformedStreamError();
  }
  const cachedTokens = optionalInteger(promptDetails?.cached_tokens);
  const reasoningTokens = optionalInteger(completionDetails?.reasoning_tokens);
  const totalWithoutSeparateReasoning = inputTokens + completionTokens;
  const totalWithSeparateReasoning = totalWithoutSeparateReasoning + reasoningTokens;
  const outputTokens = totalTokens - inputTokens;
  if (
    !Number.isSafeInteger(totalWithoutSeparateReasoning) ||
    !Number.isSafeInteger(totalWithSeparateReasoning) ||
    outputTokens < 0 ||
    (totalTokens !== totalWithoutSeparateReasoning &&
      totalTokens !== totalWithSeparateReasoning) ||
    cachedTokens > inputTokens ||
    reasoningTokens > outputTokens ||
    (!supportsReasoning && reasoningTokens !== 0)
  ) {
    throw new XAIMalformedStreamError();
  }
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    provider_cost: parseCost(usage.cost_in_usd_ticks),
  };
}

function toolResultContent(result: ApplicationToolResult): string {
  const content = result.content
    .map((part) => part.type === "text" ? part.text : JSON.stringify(part.value))
    .join("\n");
  return result.is_error ? `[tool error]\n${content}` : content;
}

function validImageSource(value: XAIImageSource): boolean {
  const source = record(value);
  return Boolean(
    source &&
    typeof source.url === "string" &&
    source.url.length > 0 &&
    (source.detail === undefined || ["auto", "low", "high"].includes(source.detail as string)),
  );
}

async function mapMessage(
  message: ChatMessage,
  supportsImages: boolean,
  resolveImageReference: XAIImageReferenceResolver | undefined,
): Promise<XAIMessage> {
  if (message.content.length === 0) throw new XAIPreflightError();
  if (message.content.every((part) => part.type === "text")) {
    return { role: message.role, content: message.content.map((part) => part.text).join("") };
  }
  if (message.role !== "user" || !supportsImages || !resolveImageReference) {
    throw new XAIPreflightError();
  }
  const content: (XAITextContentPart | XAIImageContentPart)[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else {
      const source = await resolveImageReference(part.attachment);
      if (!validImageSource(source)) throw new XAIPreflightError();
      content.push({ type: "image_url", image_url: source });
    }
  }
  return { role: message.role, content };
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof XAIAbortMarker || safeProperty(error, "name") === "AbortError";
}

function errorStatus(error: unknown): number | null {
  const status = safeProperty(error, "status");
  if (Number.isInteger(status)) return status as number;
  const statusCode = safeProperty(error, "statusCode");
  return Number.isInteger(statusCode) ? (statusCode as number) : null;
}

function normalizeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof XAIPreflightError) {
    return { kind: "client", retryable: false, code: "invalid_request", message: "The request uses a capability not configured for this adapter." };
  }
  if (error instanceof XAIMalformedStreamError) {
    return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider returned malformed streaming data." };
  }
  const status = errorStatus(error);
  if (status === 429) {
    return { kind: "provider", retryable: true, code: "rate_limited", message: "The provider rate limit was reached." };
  }
  if (status === 408 || status === 504) {
    return { kind: "provider", retryable: true, code: "deadline_exceeded", message: "The provider request timed out." };
  }
  if (status !== null && status >= 500) {
    return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider is temporarily unavailable." };
  }
  const clientError = (code: ClientRequestError["code"], message: string): ClientRequestError => ({
    kind: "client", retryable: false, code, message,
  });
  if (status === 401) return clientError("unauthenticated", "Provider authentication failed.");
  if (status === 403) return clientError("forbidden", "The provider denied the request.");
  if (status === 409) return clientError("idempotency_conflict", "The provider rejected a conflicting request.");
  if (status !== null && status >= 400 && status < 500) {
    return clientError("invalid_request", "The provider rejected the request as invalid.");
  }
  return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider request failed." };
}

function publicError(error: ProviderAdapterError) {
  if (error.kind === "policy") {
    return { category: "policy" as const, code: error.code, message: error.message, retryable: false };
  }
  if (error.kind === "provider") {
    return { category: "upstream" as const, code: error.code, message: error.message, retryable: true };
  }
  return {
    category: error.code === "unauthenticated"
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
    ...(invocation.context.metadata === undefined ? {} : { metadata: invocation.context.metadata }),
  };
}

export class XAIProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context: ProviderContextCapability = PROVIDER_CONTEXT_NOT_SUPPORTED;
  private readonly request: XAIRequestFunction;
  private readonly resolveImageReference: XAIImageReferenceResolver | undefined;
  private readonly supportsImages: boolean;

  constructor(options: XAIProviderAdapterOptions) {
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (typeof options.request !== "function") throw new TypeError("request must be a function");
    this.request = options.request;
    this.resolveImageReference = options.resolve_image_reference;
    this.supportsImages = options.supports_images ?? false;
    this.metadata = {
      provider_id: "xai",
      model_id: options.model,
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: options.supports_tool_calls ?? false,
        parallel_tool_calls: false,
        reasoning: options.supports_reasoning ?? false,
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

  private async requestPayload(invocation: ProviderAdapterInvocation): Promise<XAIChatRequest> {
    if (
      invocation.messages.length === 0 ||
      !Number.isSafeInteger(invocation.generation.max_output_tokens) ||
      invocation.generation.max_output_tokens <= 0 ||
      !Number.isFinite(invocation.generation.temperature) ||
      invocation.generation.temperature < 0 ||
      invocation.generation.temperature > 2
    ) {
      throw new XAIPreflightError();
    }
    if (
      !this.metadata.capabilities.tool_calls &&
      (invocation.tools.length > 0 || invocation.tool_results.length > 0)
    ) {
      throw new XAIPreflightError();
    }
    if (
      this.metadata.capabilities.max_output_tokens !== null &&
      invocation.generation.max_output_tokens > this.metadata.capabilities.max_output_tokens
    ) {
      throw new XAIPreflightError();
    }
    if (
      invocation.messages.some((message) =>
        message.content.some((part) => part.type === "document"),
      )
    ) {
      throw new XAIPreflightError();
    }
    if (
      invocation.messages.some((message) => message.content.some((part) => part.type === "image")) &&
      (!this.supportsImages || !this.resolveImageReference)
    ) {
      throw new XAIPreflightError();
    }
    const messages = await Promise.all(invocation.messages.map((message) =>
      mapMessage(message, this.supportsImages, this.resolveImageReference),
    ));
    const toolContext: XAIAssistantToolCallMessage[] = invocation.tool_results.length === 0
      ? []
      : [{
          role: "assistant",
          content: null,
          tool_calls: invocation.tool_results.map((result) => ({
            id: result.tool_call_id,
            type: "function" as const,
            function: { name: result.name, arguments: "{}" as const },
          })),
        }];
    const toolResults: XAIToolResultMessage[] = invocation.tool_results.map((result) => ({
      role: "tool", tool_call_id: result.tool_call_id, content: toolResultContent(result),
    }));
    const tools: XAITool[] = invocation.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    }));
    return {
      model: this.metadata.model_id,
      messages: [...messages, ...toolContext, ...toolResults],
      ...(tools.length === 0 ? {} : { tools, parallel_tool_calls: false as const }),
      max_tokens: invocation.generation.max_output_tokens,
      temperature: invocation.generation.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  private async *stream(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    let sequence = 0;
    yield {
      ...envelope(invocation, "response.started", sequence++),
      type: "response.started",
      attribution: invocation.context.attribution,
    };
    if (invocation.signal.aborted) {
      const reason = cancellationReason(invocation.signal);
      yield { ...envelope(invocation, "response.cancelled", sequence), type: "response.cancelled", reason };
      return { status: "cancelled", reason, usage: null };
    }

    let parsed: ParsedCompletion;
    let observedUsage: ProviderUsage | null = null;
    try {
      const payload = await this.requestPayload(invocation);
      if (invocation.signal.aborted) throw new XAIAbortMarker();
      const stream = await this.request(payload, { signal: invocation.signal });
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
        throw new XAIMalformedStreamError();
      }
      const toolCalls = new Map<number, ToolCallAssembly>();
      let finishReason: string | null = null;
      for await (const chunkValue of stream) {
        if (invocation.signal.aborted) throw new XAIAbortMarker();
        const chunk = record(chunkValue);
        if (!chunk || !Array.isArray(chunk.choices) || chunk.choices.length > 1) {
          throw new XAIMalformedStreamError();
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (observedUsage !== null) throw new XAIMalformedStreamError();
          observedUsage = parseUsage(chunk.usage, this.metadata.capabilities.reasoning);
        }
        if (chunk.choices.length === 0) continue;
        const choice = record(chunk.choices[0]);
        if (!choice || (choice.index !== undefined && choice.index !== 0)) {
          throw new XAIMalformedStreamError();
        }
        const delta = choice.delta === undefined ? null : record(choice.delta);
        if (choice.delta !== undefined && !delta) throw new XAIMalformedStreamError();
        if (delta?.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") throw new XAIMalformedStreamError();
          if (delta.content.length > 0) {
            yield { ...envelope(invocation, "response.text.delta", sequence++), type: "response.text.delta", delta: delta.content };
          }
        }
        if (delta?.reasoning_content !== undefined && delta.reasoning_content !== null) {
          if (!this.metadata.capabilities.reasoning || typeof delta.reasoning_content !== "string") {
            throw new XAIMalformedStreamError();
          }
        }
        if (delta?.tool_calls !== undefined) {
          if (!this.metadata.capabilities.tool_calls || !Array.isArray(delta.tool_calls)) {
            throw new XAIMalformedStreamError();
          }
          for (const fragmentValue of delta.tool_calls) {
            const fragment = record(fragmentValue);
            const index = safeInteger(fragment?.index);
            if (!fragment || index === null) throw new XAIMalformedStreamError();
            const assembly = toolCalls.get(index) ?? { argumentsText: "" };
            setStableFragment(assembly, "id", fragment.id);
            const fn = fragment.function === undefined ? null : record(fragment.function);
            if (fragment.function !== undefined && !fn) throw new XAIMalformedStreamError();
            setStableFragment(assembly, "name", fn?.name);
            if (fn?.arguments !== undefined && fn.arguments !== null) {
              if (typeof fn.arguments !== "string") throw new XAIMalformedStreamError();
              assembly.argumentsText += fn.arguments;
            }
            toolCalls.set(index, assembly);
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== "string" || (finishReason !== null && finishReason !== choice.finish_reason)) {
            throw new XAIMalformedStreamError();
          }
          finishReason = choice.finish_reason;
        }
      }
      if (!observedUsage || finishReason === null) throw new XAIMalformedStreamError();
      if (finishReason === "content_filter") {
        const error: ProviderAdapterError = {
          kind: "policy", retryable: false, code: "policy_denied", message: "The provider stopped the response due to policy.",
        };
        yield {
          ...envelope(invocation, "response.usage", sequence++),
          type: "response.usage",
          usage: { input_tokens: observedUsage.input_tokens, output_tokens: observedUsage.output_tokens, total_tokens: observedUsage.total_tokens },
        };
        yield { ...envelope(invocation, "response.error", sequence), type: "response.error", error: publicError(error) };
        return { status: "failed", error, usage: observedUsage };
      }
      const outcome = finishReason === "stop"
        ? "stop"
        : finishReason === "length"
          ? "length"
          : finishReason === "tool_calls" || finishReason === "function_call"
            ? "tool_calls"
            : null;
      if (!outcome) throw new XAIMalformedStreamError();
      const completedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, assembly], position) => {
          if (index !== position || !assembly.id || !assembly.name) throw new XAIMalformedStreamError();
          let argumentsValue: unknown;
          try {
            argumentsValue = JSON.parse(assembly.argumentsText);
          } catch {
            throw new XAIMalformedStreamError();
          }
          if (!record(argumentsValue)) throw new XAIMalformedStreamError();
          return { tool_call_id: assembly.id, name: assembly.name, arguments: argumentsValue as JsonObject };
        });
      if (
        new Set(completedToolCalls.map((call) => call.tool_call_id)).size !== completedToolCalls.length ||
        (outcome === "tool_calls" && completedToolCalls.length === 0) ||
        (outcome !== "tool_calls" && completedToolCalls.length > 0)
      ) {
        throw new XAIMalformedStreamError();
      }
      parsed = { outcome, toolCalls: completedToolCalls, usage: observedUsage };
    } catch (error) {
      if (isAbortError(error, invocation.signal)) {
        const reason = cancellationReason(invocation.signal);
        yield { ...envelope(invocation, "response.cancelled", sequence), type: "response.cancelled", reason };
        return { status: "cancelled", reason, usage: observedUsage };
      }
      const normalized = normalizeFailure(error);
      yield { ...envelope(invocation, "response.error", sequence), type: "response.error", error: publicError(normalized) };
      return { status: "failed", error: normalized, usage: observedUsage };
    }

    for (const toolCall of parsed.toolCalls) {
      yield { ...envelope(invocation, "response.tool_call", sequence++), type: "response.tool_call", ...toolCall };
    }
    yield {
      ...envelope(invocation, "response.usage", sequence++),
      type: "response.usage",
      usage: { input_tokens: parsed.usage.input_tokens, output_tokens: parsed.usage.output_tokens, total_tokens: parsed.usage.total_tokens },
    };
    yield { ...envelope(invocation, "response.completed", sequence), type: "response.completed", outcome: parsed.outcome };
    return { status: "completed", outcome: parsed.outcome, usage: parsed.usage } satisfies ProviderAdapterResult;
  }
}

export function createXAIProviderAdapter(options: XAIProviderAdapterOptions): XAIProviderAdapter {
  return new XAIProviderAdapter(options);
}
