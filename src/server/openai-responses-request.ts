import { createHash } from "node:crypto";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import { createRetryPolicy, executeWithRetry, type RetryFailure, type RetryPolicy } from "../retry.js";
import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from "../usage.js";
import type { AuthoritativeAttribution } from "../protocol.js";
import type { DurableTurnExecutionIdentity } from "../transports/types.js";
import type { OpenAIResponsesProviderOptions } from "../providers/openai-responses.js";

export interface OpenAIResponsesExecutionContext {
  readonly conversationId: string;
  readonly turnId: string;
  readonly mutationId: string;
  readonly iteration: number;
  readonly tenantId: string;
  readonly scopeId: string;
  readonly attribution: AuthoritativeAttribution;
  readonly durableExecution?: DurableTurnExecutionIdentity;
}
export interface TrackedOpenAIResponsesRequestOptions {
  readonly request: OpenAIResponsesProviderOptions["request"];
  readonly context: OpenAIResponsesExecutionContext;
  readonly capture?: (receipt: NormalizedUsageReceipt) => void | Promise<void>;
  readonly retryPolicy?: RetryPolicy;
  readonly diagnostics?: AiDiagnosticSink;
  /** Preserve an installed consumer's receipt namespace during migration. Defaults to handrail. */
  readonly receiptPrefix?: string;
}

/** Capture every physical request before the SDK may advance to another provider or tool. */
export function createTrackedOpenAIResponsesRequest(options: TrackedOpenAIResponsesRequestOptions): OpenAIResponsesProviderOptions["request"] {
  const { request: network, context: execution, capture, diagnostics } = options;
  const policy = options.retryPolicy ?? createRetryPolicy({ maximumAttempts: 2 });
  if (!execution.durableExecution || execution.durableExecution.conversationId !== execution.conversationId
    || execution.durableExecution.turnId !== execution.turnId || !Number.isSafeInteger(execution.durableExecution.attempt)
    || execution.durableExecution.attempt < 1 || !Number.isSafeInteger(execution.iteration) || execution.iteration < 0) {
    throw new TypeError("Provider work requires the matching durable execution claim.");
  }
  const prefix = options.receiptPrefix ?? "handrail";
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(prefix)) throw new TypeError("Provider receipt prefix is invalid.");
  return async (request, { signal }) => {
    const result = await executeWithRetry<AsyncIterable<unknown>, RetryFailure & { cause: unknown }>(async ({ attempt }) => {
      const occurredAt = new Date().toISOString();
      const save = (usage: unknown, status: "completed" | "failed" | "cancelled") => capture?.(
        physicalUsageReceipt(execution, request.model, attempt, occurredAt, usage, status, prefix));
      let source: AsyncIterable<unknown>;
      try { source = await network(request, { signal }); }
      catch (cause) {
        const status = cause && typeof cause === "object" && "status" in cause ? Number(cause.status) : 0;
        const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
        const parameter = cause && typeof cause === "object" && "param" in cause && typeof cause.param === "string" ? cause.param : "";
        // Only fixed provider categories and HTTP status leave this boundary.
        // Raw messages/parameters may include user input or tool arguments.
        const publicCodes = ["invalid_function_parameters", "invalid_request_error", "unsupported_parameter",
          "model_not_found", "insufficient_quota", "rate_limit_exceeded", "invalid_api_key", "context_length_exceeded"];
        emitAiDiagnostic(diagnostics, { domain: "provider", operation: "responses_request",
          phase: signal.aborted ? "cancelled" : "failed", conversationId: execution.conversationId,
          turnId: execution.turnId, providerId: "openai", modelId: request.model, attempt,
          code: publicCodes.includes(code) ? code : /^input(?:$|\.|\[)/u.test(parameter) ? "invalid_provider_input"
            : /^tools(?:$|\.|\[)/u.test(parameter) ? "invalid_tool_definition" : "provider_request_failed",
          ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { statusCode: status } : {}) });
        await save(null, signal.aborted ? "cancelled" : "failed");
        return { ok: false, failure: { cause, retryable: !signal.aborted && ([408, 429, 500, 502, 503, 504].includes(status)
          || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code)), reasonCategory: status === 429 ? "rate_limit" : "unavailable" } };
      }
      return { ok: true, value: (async function* () {
        let usage: unknown = null;
        let status: "completed" | "failed" | "cancelled" = "failed";
        try {
          for await (const item of source) {
            if (item && typeof item === "object" && "type" in item && "response" in item
              && item.response && typeof item.response === "object") {
              if ("usage" in item.response) usage = item.response.usage;
              if (item.type === "response.completed") status = "completed";
              else if (item.type === "response.failed" || item.type === "response.incomplete") status = "failed";
            }
            yield item;
          }
        } finally { await save(usage, signal.aborted ? "cancelled" : status); }
      })() };
    }, { policy, signal });
    if (!result.ok) throw result.failure.cause;
    return result.value;
  };
}

function physicalUsageReceipt(execution: OpenAIResponsesExecutionContext, model: string, attempt: number, occurredAt: string,
  usage: unknown, status: "completed" | "failed" | "cancelled", prefix: string) {
  if (!execution.durableExecution || execution.durableExecution.conversationId !== execution.conversationId
    || execution.durableExecution.turnId !== execution.turnId) throw new Error("Provider usage requires the matching durable execution claim");
  const attribution = execution.attribution;
  const key = createHash("sha256").update(JSON.stringify([attribution.organization.id, attribution.project.id,
    attribution.service_environment.id, execution.tenantId, execution.scopeId,
    execution.conversationId, execution.turnId, execution.durableExecution.attempt, execution.iteration, attempt])).digest("hex");
  const row = usage && typeof usage === "object" ? usage as Record<string, unknown> : {};
  const details = (key: string, field: string) => row[key] && typeof row[key] === "object"
    ? (row[key] as Record<string, unknown>)[field] : undefined;
  const quantity = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
    ? { status: "reported", value } : { status: "unavailable" };
  return parseNormalizedUsageReceipt({ version: 1, usage_receipt_id: `${prefix}:usage:${key}`, occurred_at: occurredAt,
    conversation_id: execution.conversationId, turn_id: execution.turnId, logical_request_id: execution.turnId, trace_id: execution.mutationId,
    attempt: { id: `${prefix}:attempt:${key}`, index: attempt - 1 },
    continuation: { id: `${prefix}:continuation:${key}`, index: execution.iteration },
    provider_id: "openai", model_id: model, attribution: execution.attribution, source: "provider", terminal_status: status,
    tokens: { input_tokens: quantity(row.input_tokens), cached_input_tokens: quantity(details("input_tokens_details", "cached_tokens")),
      output_tokens: quantity(row.output_tokens), reasoning_tokens: quantity(details("output_tokens_details", "reasoning_tokens")), total_tokens: quantity(row.total_tokens) },
    provider_cost: { status: "unavailable" } });
}
