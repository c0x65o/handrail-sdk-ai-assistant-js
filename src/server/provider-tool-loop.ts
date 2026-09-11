import { createActiveExecutionBudget } from "../tools/active-budget.js";
import { AI_RUNTIME_PROTOCOL_VERSION, parseChatRequest, type ApplicationToolResult,
  type ChatRequest, type ResponseToolCallEvent, type StreamEvent } from "../protocol.js";
import type { ProviderAdapter, ProviderAdapterError, ProviderAdapterResult, ProviderDocumentReferenceResolver,
  ProviderRequestContext, ProviderUsage } from "../providers/index.js";
import type { ToolLoopLimits } from "../tools/loop.js";
import { createApplicationTurnTransport } from "../transports/application-turn.js";
import type { ConversationTransport, TurnObservationResult } from "../transports/types.js";
import type { NormalizedUsageReceipt } from "../usage.js";
import { projectProviderUsageToReceipt } from "../usage.js";

export interface ProviderToolLoopExecutionResult {
  readonly status: "completed";
  readonly result: ApplicationToolResult;
}

export interface ProviderToolLoopApprovalResult {
  readonly status: "external_approval_required";
  readonly toolCallId: string;
  readonly name: string;
}

/** A host-validated failure before dispatch; no execution or approval is implied. */
export interface ProviderToolLoopFailureResult {
  readonly status: "failed";
  /** Only sanitized, display-safe host messages may cross this boundary. */
  readonly error: ProviderAdapterError;
}

export interface ProviderToolLoopTransportOptions {
  readonly adapter: ProviderAdapter;
  readonly tools: ChatRequest["tools"];
  readonly limits: Readonly<ToolLoopLimits>;
  readonly createContext: (input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly mutationId: string;
    readonly iteration: number;
  }) => ProviderRequestContext | Promise<ProviderRequestContext>;
  readonly executeTool: (input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
    readonly signal: AbortSignal;
  }) => ProviderToolLoopExecutionResult | ProviderToolLoopApprovalResult | ProviderToolLoopFailureResult |
    Promise<ProviderToolLoopExecutionResult | ProviderToolLoopApprovalResult | ProviderToolLoopFailureResult>;
  /** SDK-owned durable approval wait/resume boundary. The callback must not execute before confirmation. */
  readonly awaitApproval?: (input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
    readonly signal: AbortSignal;
  }) => Promise<ProviderToolLoopExecutionResult>;
  /** Called after every provider invocation; production callers durably capture before resolving. */
  readonly captureUsage?: (receipt: NormalizedUsageReceipt) => void | Promise<void>;
  readonly resolveDocumentReference?: (input: {
    readonly conversationId: string;
    readonly reference: Parameters<ProviderDocumentReferenceResolver>[0];
    readonly signal: AbortSignal;
  }) => ReturnType<ProviderDocumentReferenceResolver>;
}

function totals(values: readonly ProviderUsage[]): ProviderUsage {
  const sum = (key: "input_tokens" | "cached_input_tokens" | "output_tokens" | "reasoning_tokens" | "total_tokens") =>
    values.reduce((total, usage) => total + usage[key], 0);
  const cacheWrites = values.map((usage) => usage.cache_write_input_tokens);
  const costs = values.map((usage) => usage.provider_cost);
  const known = costs.every((cost) => cost.known) && new Set(costs.flatMap((cost) => cost.known ? [cost.currency] : [])).size === 1;
  const providerCost: ProviderUsage["provider_cost"] = known
    ? { known: true, amount: costs.reduce((total, cost) => total + Number(cost.known ? cost.amount : 0), 0).toString(),
        currency: costs[0]!.known ? costs[0]!.currency : "USD" }
    : { known: false };
  return Object.freeze({
    input_tokens: sum("input_tokens"), cached_input_tokens: sum("cached_input_tokens"),
    ...(cacheWrites.every((value) => value !== undefined)
      ? { cache_write_input_tokens: cacheWrites.reduce((total, value) => total + value!, 0) } : {}),
    output_tokens: sum("output_tokens"), reasoning_tokens: sum("reasoning_tokens"), total_tokens: sum("total_tokens"),
    provider_cost: providerCost,
  });
}

function terminal(result: ProviderAdapterResult, checkpoint: { readonly requestId: string; readonly sequence: number }): TurnObservationResult {
  const point = { lastAppliedEventId: `${checkpoint.requestId}:${checkpoint.sequence}`,
    lastAppliedCursor: `${checkpoint.requestId}:${checkpoint.sequence}`, lastAppliedRevision: checkpoint.sequence };
  if (result.status === "completed") return { status: "completed", checkpoint: point };
  if (result.status === "cancelled") return { status: "cancelled", checkpoint: point };
  return { status: "failed", checkpoint: point, error: {
    code: result.error.code === "policy_denied" ? "forbidden" : result.error.code === "upstream_unavailable"
      ? "unavailable" : result.error.code === "deadline_exceeded" ? "timeout"
        : result.error.code === "idempotency_conflict" ? "conflict" : result.error.code,
    message: result.error.message, retryable: result.error.retryable,
  } };
}

/** Provider-neutral bounded continuation loop presented as one valid normalized stream. */
export function createProviderToolLoopTransport(
  options: ProviderToolLoopTransportOptions,
): ConversationTransport<StreamEvent, ChatRequest> {
  for (const [name, value] of Object.entries(options.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  return createApplicationTurnTransport<StreamEvent, ChatRequest>({
    async execute(value, turn) {
      const budget = createActiveExecutionBudget(turn.signal, options.limits.maxElapsedMs);
      try {
        let request = parseChatRequest(value), sequence = 0, calls = 0;
        const usages: ProviderUsage[] = [];
        let rootRequestId = "", traceId = "", finalResult: ProviderAdapterResult | null = null;
        for (let iteration = 0; iteration < options.limits.maxIterations; iteration += 1) {
          if (turn.signal.aborted) return { status: "cancelled", checkpoint: {
            lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null } };
          if (budget.signal.aborted) {
            finalResult = limitFailure("The execution time limit was reached. Completed tool results are retained; review them before continuing.");
            break;
          }
          const context = await options.createContext({ conversationId: turn.conversationId, turnId: turn.turnId,
            mutationId: turn.mutationId, iteration });
          rootRequestId ||= context.request_id; traceId ||= context.trace_id;
          const discovered: ResponseToolCallEvent[] = [];
          const stream = options.adapter.invoke({
            continuation_of: request.continuation_of,
            messages: request.messages,
            tools: options.tools,
            tool_results: request.tool_results,
            generation: request.generation,
            signal: budget.signal,
            context,
            ...(options.resolveDocumentReference === undefined ? {} : {
              resolve_document_reference: (reference: Parameters<ProviderDocumentReferenceResolver>[0],
                resolution: Parameters<ProviderDocumentReferenceResolver>[1]) => options.resolveDocumentReference!({
                  conversationId: turn.conversationId, reference, signal: resolution.signal,
                }),
            }),
          });
          let step = await stream.next();
          while (!step.done) {
            const event = step.value;
            if (event.type === "response.tool_call") discovered.push(event);
            if (event.type === "response.started" && sequence === 0) {
              await turn.emit({ ...event, request_id: rootRequestId, trace_id: traceId, sequence: sequence++ });
            } else if (event.type !== "response.started" && event.type !== "response.usage" &&
              event.type !== "response.completed" && event.type !== "response.cancelled" && event.type !== "response.error") {
              await turn.emit({ ...event, request_id: rootRequestId, trace_id: traceId, sequence: sequence++ });
            }
            step = await stream.next();
          }
          finalResult = step.value;
          if (finalResult.usage) {
            usages.push(finalResult.usage);
            await options.captureUsage?.(projectProviderUsageToReceipt(finalResult.usage, {
              usage_receipt_id: `${rootRequestId}:usage:${iteration}`,
              conversation_id: turn.conversationId, turn_id: turn.turnId,
              logical_request_id: rootRequestId, trace_id: traceId,
              attempt: { id: `${rootRequestId}:attempt`, index: 0 },
              continuation: { id: `${rootRequestId}:continuation`, index: iteration },
              provider_id: options.adapter.metadata.provider_id, model_id: options.adapter.metadata.model_id,
              attribution: context.attribution, source: "provider", quality: "reported",
              terminal_status: finalResult.status === "completed" ? "completed" : finalResult.status,
            }));
          }
          if (finalResult.status !== "completed" || finalResult.outcome !== "tool_calls") break;
          calls += discovered.length;
          if (discovered.length === 0 || calls > options.limits.maxTotalToolCalls) {
            finalResult = limitFailure("The tool call limit was reached. Review completed results before continuing.");
            break;
          }
          const results: ApplicationToolResult[] = [];
          for (let offset = 0; offset < discovered.length; offset += options.limits.parallelism) {
            budget.signal.throwIfAborted();
            const batch = discovered.slice(offset, offset + options.limits.parallelism);
            const outcomes = await Promise.all(batch.map((call) => options.executeTool({
              conversationId: turn.conversationId, turnId: turn.turnId, call, signal: budget.signal,
            })));
            const failed = outcomes.find((outcome) => outcome.status === "failed");
            if (failed) {
              finalResult = turn.signal.aborted
                ? { status: "cancelled", reason: "runtime_shutdown", usage: null }
                : { status: "failed", error: failed.error, usage: null };
              break;
            }
            for (let index = 0; index < outcomes.length; index += 1) {
              const outcome = outcomes[index]!;
              if (outcome.status === "failed") continue;
              if (outcome.status === "completed") {
                results.push(outcome.result);
                continue;
              }
              if (options.awaitApproval === undefined) {
                const failure = { kind: "policy" as const, retryable: false as const, code: "policy_denied" as const,
                  message: "Tool execution requires external approval." };
                finalResult = { status: "failed", error: failure, usage: null };
                break;
              }
              const approved = await budget.withApprovalWait(() => options.awaitApproval!({ conversationId: turn.conversationId,
                turnId: turn.turnId, call: batch[index]!, signal: budget.signal }));
              results.push(approved.result);
            }
            if (finalResult.status !== "completed") break;
          }
          if (finalResult.status !== "completed") break;
          request = parseChatRequest({ ...request, protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
            continuation_of: context.request_id, tools: options.tools, tool_results: results });
        }
        if (!finalResult) throw new Error("Provider loop did not run");
        if (finalResult.status === "completed" && finalResult.outcome === "tool_calls") {
          finalResult = limitFailure("The iteration limit was reached before the request finished. Review completed results before continuing.");
        }
        if (usages.length > 0) {
          const usage = totals(usages);
          await turn.emit({ type: "response.usage", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
            request_id: rootRequestId, trace_id: traceId, sequence: sequence++, usage: {
              input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
            } });
        }
        const result = finalResult;
        if (result.status === "completed") await turn.emit({ type: "response.completed", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
          request_id: rootRequestId, trace_id: traceId, sequence: sequence++, outcome: result.outcome === "tool_calls" ? "length" : result.outcome });
        else if (result.status === "cancelled") await turn.emit({ type: "response.cancelled", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
          request_id: rootRequestId, trace_id: traceId, sequence: sequence++, reason: result.reason });
        else await turn.emit({ type: "response.error", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
          request_id: rootRequestId, trace_id: traceId, sequence: sequence++, error: {
            category: result.error.kind === "policy" ? "policy" : result.error.kind === "client" ? "request" : "upstream",
            code: result.error.code, message: result.error.message, retryable: result.error.retryable,
          } });
        return terminal(result, { requestId: rootRequestId, sequence: sequence - 1 });
      } finally { budget.dispose(); }
    },
  });
}

function limitFailure(message: string): ProviderAdapterResult {
  return { status: "failed", usage: null, error: { kind: "policy", code: "policy_denied", message, retryable: false } };
}
