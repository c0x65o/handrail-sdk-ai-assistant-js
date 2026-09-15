import type { ConversationToolCallRecord } from "../conversation/state.js";
import type {
  ConversationId,
  ConversationToolCallId,
  ConversationTurnId,
} from "../conversation/events.js";
import { CONVERSATION_CITATION_RECORDS_VERSION } from "../conversation/events.js";
import type { CitationRecordSet } from "../citations.js";
import {
  parseChatRequest,
  type ApplicationToolResult,
  type ChatRequest,
  type JsonValue,
  type ToolDefinition,
} from "../protocol.js";
import type {
  ConversationRuntime,
  ConversationRuntimeTurnResult,
} from "../runtime.js";
import type { NormalizedUsageReceipt } from "../usage.js";
import { BoundedToolExecutor } from "./executor.js";
import type { ApprovalExecutionResume } from "./approval-execution.js";
import type { ApplicationToolActivityReporter } from "./executor.js";

export interface ToolLoopLimits {
  readonly maxIterations: number;
  readonly maxTotalToolCalls: number;
  readonly maxElapsedMs: number;
  /** Loop fan-out. The executor's independently configured cap remains authoritative. */
  readonly parallelism: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: Readonly<ToolLoopLimits> = Object.freeze({
  maxIterations: 160,
  maxTotalToolCalls: 150,
  maxElapsedMs: 600_000,
  parallelism: 1,
});

export interface ToolLoopProviderCapabilities {
  readonly parallelToolCalls: boolean;
}

export interface ToolLoopProgress {
  readonly iterations: number;
  readonly totalToolCalls: number;
  readonly startedAtMs: number;
  readonly usageReceipts?: readonly NormalizedUsageReceipt[];
}

export interface ApprovalResumeResolverInput {
  readonly conversationId: ConversationId;
  readonly turnId: ConversationTurnId;
  readonly toolCallId: ConversationToolCallId;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

export type ApprovalResumeResolver<TPermissionContext> = (
  input: ApprovalResumeResolverInput,
) => ApprovalExecutionResume<TPermissionContext> | undefined |
  Promise<ApprovalExecutionResume<TPermissionContext> | undefined>;

export interface RunToolLoopOptions<
  TContext = unknown,
  TDiscoveryContext = unknown,
  TApprovalPermissionContext = unknown,
> {
  readonly runtime: ConversationRuntime<ChatRequest>;
  /** The initial or approval-resume turn observation to inspect. */
  readonly initialTurn: ConversationRuntimeTurnResult | Promise<ConversationRuntimeTurnResult>;
  /** Exact request used for initialTurn. It is the immutable base for continuations. */
  readonly request: ChatRequest;
  readonly discoveredTools: readonly ToolDefinition[];
  readonly executor: BoundedToolExecutor<
    TContext,
    TDiscoveryContext,
    TApprovalPermissionContext
  >;
  readonly applicationContext: TContext;
  readonly limits?: Partial<ToolLoopLimits>;
  readonly providerCapabilities?: ToolLoopProviderCapabilities;
  readonly signal?: AbortSignal;
  /** Trusted host lookup for exact confirmed proposal evidence on a resumed call. */
  readonly resolveApprovalResume?: ApprovalResumeResolver<TApprovalPermissionContext>;
  readonly progress?: ToolLoopProgress;
  readonly now?: () => number;
  /** May return cumulative observations; receipt identity removes duplicates. */
  readonly collectUsageReceipts?: (
    result: ConversationRuntimeTurnResult,
  ) => readonly NormalizedUsageReceipt[] | Promise<readonly NormalizedUsageReceipt[]>;
  /** Shared status sink used by tools that report progress during this run. */
  readonly reportActivity?: ApplicationToolActivityReporter;
}

interface ToolLoopResultBase {
  readonly turn: ConversationRuntimeTurnResult;
  readonly request: ChatRequest;
  readonly iterations: number;
  readonly totalToolCalls: number;
  readonly usageReceipts: readonly NormalizedUsageReceipt[];
  /** Feed this back to runToolLoop when resuming an approval pause. */
  readonly progress: ToolLoopProgress;
}

export type ToolLoopResult =
  | (ToolLoopResultBase & {
      readonly status: "completed";
      readonly outcome: "stop" | "length";
    })
  | (ToolLoopResultBase & { readonly status: "cancelled" })
  | (ToolLoopResultBase & {
      readonly status: "failed";
      readonly error: ConversationRuntimeTurnResult["error"];
    })
  | (ToolLoopResultBase & {
      readonly status: "external_approval_required";
      readonly pendingToolCallIds: readonly string[];
    })
  | (ToolLoopResultBase & {
      readonly status: "budget_exhausted";
      readonly budget: "iterations" | "total_tool_calls" | "wall_clock";
      readonly limit: number;
    });

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function limits(overrides: Partial<ToolLoopLimits> | undefined): Readonly<ToolLoopLimits> {
  const merged = { ...DEFAULT_TOOL_LOOP_LIMITS, ...overrides };
  return Object.freeze({
    maxIterations: positiveInteger(merged.maxIterations, "limits.maxIterations"),
    maxTotalToolCalls: positiveInteger(
      merged.maxTotalToolCalls,
      "limits.maxTotalToolCalls",
    ),
    maxElapsedMs: positiveInteger(merged.maxElapsedMs, "limits.maxElapsedMs"),
    parallelism: positiveInteger(merged.parallelism, "limits.parallelism"),
  });
}

function resultFromDurableCall(call: ConversationToolCallRecord): ApplicationToolResult | null {
  if (call.name === null || call.result === null) return null;
  return {
    tool_call_id: call.tool_call_id,
    name: call.name,
    content: call.result.content.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "json", value: cloneProtocolJson(part.value) }),
    is_error: call.result.is_error,
    ...(call.result.citation_records === undefined
      ? {}
      : { citation_records: call.result.citation_records }),
  };
}

function providerToolResult(result: ApplicationToolResult): ApplicationToolResult {
  return {
    tool_call_id: result.tool_call_id,
    name: result.name,
    content: result.content,
    is_error: result.is_error,
  };
}

function citationRecordsAreLinked(
  records: CitationRecordSet,
  snapshot: ReturnType<ConversationRuntime<ChatRequest>["getSnapshot"]>,
): boolean {
  return records.sources.every((source) => snapshot.citation_sources.some(
    (candidate) => candidate.source_id === source.source_id &&
      JSON.stringify(candidate) === JSON.stringify(source),
  )) && records.citations.every((citation) => snapshot.citations.some(
    (candidate) => candidate.citation_id === citation.citation_id &&
      JSON.stringify(candidate) === JSON.stringify(citation),
  ));
}

function cloneProtocolJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(cloneProtocolJson);
  const clone: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = cloneProtocolJson(item);
  }
  return clone;
}

function frozenProgress(
  iterations: number,
  totalToolCalls: number,
  startedAtMs: number,
  usageReceipts: readonly NormalizedUsageReceipt[],
): ToolLoopProgress {
  return Object.freeze({
    iterations,
    totalToolCalls,
    startedAtMs,
    usageReceipts: Object.freeze([...usageReceipts]),
  });
}

/**
 * Runs provider tool continuations without owning transport details. Every
 * side-effect decision is durably recorded by ConversationRuntime before the
 * next protocol request is submitted.
 */
export async function runToolLoop<
  TContext = unknown,
  TDiscoveryContext = unknown,
  TApprovalPermissionContext = unknown,
>(
  options: RunToolLoopOptions<
    TContext,
    TDiscoveryContext,
    TApprovalPermissionContext
  >,
): Promise<ToolLoopResult> {
  const bounded = limits(options.limits);
  const recordEvents = options.runtime.recordToolLoopEvents;
  const continueTurn = options.runtime.continueTurn;
  if (recordEvents === undefined || continueTurn === undefined) {
    throw new TypeError("runToolLoop requires ConversationRuntime tool-loop integration hooks");
  }
  const now = options.now ?? (() => Date.now());
  let turn = await options.initialTurn;
  const initialSnapshot = options.runtime.getSnapshot();
  const initialTurnRecord = initialSnapshot.turns.find((item) => item.turn_id === turn.turnId);
  const sameLogicalInput = initialTurnRecord === undefined
    ? new Set<string>()
    : new Set(initialSnapshot.turns
        .filter((item) =>
          JSON.stringify(item.input_message_ids) === JSON.stringify(initialTurnRecord.input_message_ids))
        .map((item) => item.turn_id));
  const durableDiscovered = initialSnapshot.tool_calls.filter(
    (call) => sameLogicalInput.has(call.turn_id) && call.discovered_at !== null,
  );
  const firstDiscoveredAt = durableDiscovered
    .map((call) => Date.parse(call.discovered_at!))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const startedAtMs = options.progress?.startedAtMs ?? firstDiscoveredAt ?? now();
  let iterations = options.progress?.iterations ??
    new Set(durableDiscovered.map((call) => call.turn_id)).size;
  let totalToolCalls = options.progress?.totalToolCalls ?? durableDiscovered.length;
  let request = parseChatRequest(options.request);
  const receipts = new Map<string, NormalizedUsageReceipt>();
  for (const receipt of options.progress?.usageReceipts ?? []) {
    receipts.set(receipt.usage_receipt_id, receipt);
  }

  const collectUsage = async (): Promise<void> => {
    for (const receipt of turn.usageReceipts) {
      receipts.set(receipt.usage_receipt_id, receipt);
    }
    const observed = await options.collectUsageReceipts?.(turn) ?? [];
    for (const receipt of observed) receipts.set(receipt.usage_receipt_id, receipt);
  };
  const base = () => {
    const usageReceipts = Object.freeze([...receipts.values()]);
    return {
      turn,
      request,
      iterations,
      totalToolCalls,
      usageReceipts,
      progress: frozenProgress(iterations, totalToolCalls, startedAtMs, usageReceipts),
    };
  };
  const elapsed = () => Math.max(0, now() - startedAtMs);
  const aborted = () => options.signal?.aborted === true;

  const exhaust = async (
    budget: "iterations" | "total_tool_calls" | "wall_clock",
    limit: number,
  ): Promise<ToolLoopResult> => {
    const alreadyRecorded = options.runtime.getSnapshot().tool_loop_budget_exhaustions.some(
      (item) => item.turn_id === turn.turnId && item.budget === budget,
    );
    if (!alreadyRecorded) {
      await recordEvents([{
        type: "tool_loop.budget_exhausted",
        turn_id: turn.turnId,
        budget,
        limit,
      }]);
    }
    return Object.freeze({ ...base(), status: "budget_exhausted", budget, limit });
  };

  for (;;) {
    await collectUsage();
    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    if (elapsed() >= bounded.maxElapsedMs) {
      return exhaust("wall_clock", bounded.maxElapsedMs);
    }
    if (turn.status === "cancelled") {
      return Object.freeze({ ...base(), status: "cancelled" });
    }
    if (turn.status !== "completed") {
      return Object.freeze({ ...base(), status: "failed", error: turn.error });
    }
    if (turn.outcome === "stop" || turn.outcome === "length") {
      return Object.freeze({ ...base(), status: "completed", outcome: turn.outcome });
    }
    if (turn.outcome !== "tool_calls" || turn.requestId === null) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "invalid_tool_loop_terminal",
        message: "A tool-call completion lacked durable protocol identity",
        retryable: false,
      }) });
    }

    const snapshot = options.runtime.getSnapshot();
    const calls = snapshot.tool_calls.filter((call) => call.turn_id === turn.turnId);
    if (calls.length === 0) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "missing_tool_calls",
        message: "A tool-call completion contained no durable tool calls",
        retryable: false,
      }) });
    }
    const priorExhaustion = snapshot.tool_loop_budget_exhaustions.find(
      (item) => item.turn_id === turn.turnId,
    );
    if (priorExhaustion !== undefined) {
      return Object.freeze({
        ...base(),
        status: "budget_exhausted",
        budget: priorExhaustion.budget,
        limit: priorExhaustion.limit,
      });
    }
    const undiscovered = calls.filter((call) => call.discovered_at === null);
    if (undiscovered.length > 0) {
      await recordEvents(undiscovered.map((call) => ({
        type: "tool_call.discovered" as const,
        turn_id: turn.turnId,
        tool_call_id: call.tool_call_id,
      })));
    }

    const newlyCounted = calls.filter((call) => call.discovered_at === null).length;
    if (newlyCounted > 0 && iterations >= bounded.maxIterations) {
      return exhaust("iterations", bounded.maxIterations);
    }
    if (totalToolCalls + newlyCounted > bounded.maxTotalToolCalls) {
      return exhaust("total_tool_calls", bounded.maxTotalToolCalls);
    }
    totalToolCalls += newlyCounted;
    if (newlyCounted > 0) iterations += 1;

    const results = new Map<string, ApplicationToolResult>();
    for (const call of calls) {
      const durable = resultFromDurableCall(call);
      if (durable !== null) results.set(call.tool_call_id, durable);
    }
    const pending = calls.filter((call) => !results.has(call.tool_call_id));
    const approvals = new Set<string>();
    let wallClockExpired = false;
    let nextIndex = 0;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const remaining = Math.max(0, bounded.maxElapsedMs - elapsed());
    const timeout = setTimeout(() => {
      wallClockExpired = true;
      controller.abort();
    }, remaining);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted) return;
        const call = pending[nextIndex++];
        if (call === undefined || call.name === null || call.arguments === null) return;
        const conversationId = options.runtime.getSnapshot().conversation_id;
        let approval: ApprovalExecutionResume<TApprovalPermissionContext> | undefined;
        if (conversationId !== null && options.resolveApprovalResume !== undefined) {
          try {
            approval = await options.resolveApprovalResume({
              conversationId,
              turnId: call.turn_id,
              toolCallId: call.tool_call_id,
              toolName: call.name,
              signal: controller.signal,
            });
          } catch {
            // Resolver failures remain an approval pause and never disclose host details.
          }
        }
        if (controller.signal.aborted) return;
        const outcome = await options.executor.executeDetailed({
          call: {
            tool_call_id: call.tool_call_id,
            name: call.name,
            arguments: call.arguments,
          },
          discoveredTools: options.discoveredTools,
          applicationContext: options.applicationContext,
          signal: controller.signal,
          ...(options.reportActivity === undefined ? {} : { reportActivity: options.reportActivity }),
          ...(approval === undefined || conversationId === null
            ? {}
            : { approval: {
                ...approval,
                conversationId,
                turnId: call.turn_id,
              } }),
          ...(call.started_at === null
            ? { onExecutionStarted: async () => {
                await recordEvents([{
                  type: "tool_call.started",
                  turn_id: turn.turnId,
                  tool_call_id: call.tool_call_id,
                }]);
              } }
            : {}),
        });
        if (controller.signal.aborted) return;
        if (outcome.status === "external_approval_required") {
          approvals.add(call.tool_call_id);
        } else {
          results.set(call.tool_call_id, outcome.result);
        }
      }
    };

    const mayRunParallel =
      options.providerCapabilities?.parallelToolCalls === true && bounded.parallelism > 1;
    const workerCount = mayRunParallel
      ? Math.min(bounded.parallelism, Math.max(1, pending.length))
      : 1;
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    if (wallClockExpired || elapsed() >= bounded.maxElapsedMs) {
      return exhaust("wall_clock", bounded.maxElapsedMs);
    }

    const latest = options.runtime.getSnapshot();
    const resultEvents = calls
      .filter((call) => call.result === null)
      .map((call) => results.get(call.tool_call_id))
      .filter((result): result is ApplicationToolResult => result !== undefined)
      .map((result) => ({
        type: "tool_call.result_recorded" as const,
        turn_id: turn.turnId,
        tool_call_id: result.tool_call_id as never,
        content: result.content,
        is_error: result.is_error,
        ...(result.citation_records === undefined
          ? {}
          : { citation_records: result.citation_records }),
      }));
    const approvalEvents = [...approvals]
      .filter((id) => latest.tool_calls.find((call) => call.tool_call_id === id)
        ?.approval_required_at === null)
      .map((id) => ({
        type: "tool_call.approval_required" as const,
        turn_id: turn.turnId,
        tool_call_id: id as never,
      }));
    await recordEvents(resultEvents);

    const afterResults = options.runtime.getSnapshot();
    const citationEvents = calls
      .map((call) => afterResults.tool_calls.find(
        (candidate) => candidate.turn_id === turn.turnId &&
          candidate.tool_call_id === call.tool_call_id,
      ))
      .filter((call): call is ConversationToolCallRecord =>
        call?.result?.citation_records !== undefined)
      .filter((call) =>
        !citationRecordsAreLinked(call.result!.citation_records!, afterResults))
      .map((call) => ({
        type: "citation.records_linked" as const,
        citation_records_version: CONVERSATION_CITATION_RECORDS_VERSION,
        target: {
          type: "tool_result" as const,
          turn_id: turn.turnId,
          tool_call_id: call.tool_call_id,
        },
        sources: [...call.result!.citation_records!.sources],
        citations: [...call.result!.citation_records!.citations],
      }));
    await recordEvents(citationEvents);
    await recordEvents(approvalEvents);

    if (approvals.size > 0) {
      return Object.freeze({
        ...base(),
        status: "external_approval_required",
        pendingToolCallIds: Object.freeze([...approvals]),
      });
    }
    if (results.size !== calls.length) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "incomplete_tool_results",
        message: "Tool execution ended without a complete result set",
        retryable: true,
      }) });
    }

    const continuation = parseChatRequest({
      ...request,
      continuation_of: turn.requestId,
      tool_results: calls.map((call) => providerToolResult(results.get(call.tool_call_id)!)),
    });
    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    request = continuation;
    turn = await continueTurn({
      precedingTurnId: turn.turnId,
      request: continuation,
    });
  }
}
