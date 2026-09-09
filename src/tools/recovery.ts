import type { JsonObject, ToolDefinition } from "../protocol.js";

export type ToolFailureCategory = "transient" | "invalid_input" | "not_found" | "permission_denied"
  | "business_rule" | "cancelled" | "unknown_outcome" | "bug" | "missing_capability";

/** Trusted application classification. Messages must be static, public guidance, never raw exceptions. */
export interface ToolFailure {
  readonly category: ToolFailureCategory;
  readonly code: string;
  readonly message: string;
  readonly retryAfterMs?: number;
}

export class ToolFailureError extends Error {
  constructor(readonly failure: ToolFailure) {
    super(failure.message);
    this.name = "ToolFailureError";
  }
}

export interface ToolRecoverySummary {
  readonly type: "handrail.tool_recovery.v1";
  readonly status: "recovered" | "failed";
  readonly attempts: number;
  readonly failedAttempts: number;
  readonly category: ToolFailureCategory;
  readonly code: string;
  readonly reason: "completed" | "terminal" | "attempt_limit" | "no_progress" | "deadline" | "unknown_outcome";
}

export interface ToolRecoveryContext<TContext> {
  readonly applicationContext: TContext;
  readonly definition: ToolDefinition;
  readonly arguments: JsonObject;
  readonly toolCallId: string;
  readonly executionKey: string;
  readonly signal: AbortSignal;
}

export interface ToolRecoveryPolicy<TContext, TOutput> {
  /** Default is write/unknown: only the trusted host may declare a tool read-only. */
  readonly effect: (context: ToolRecoveryContext<TContext>) => "read" | "write";
  readonly classify?: (cause: unknown, context: ToolRecoveryContext<TContext>) => ToolFailure | undefined;
  /** Optional authorized lookup/replan. Only used for reads; candidates are revalidated and reauthorized. */
  readonly repairArguments?: (context: ToolRecoveryContext<TContext>, failure: ToolFailure) => Promise<JsonObject | null>;
  /** A write is retried only after authoritative proof it was not applied. Retain executionKey on every attempt. */
  readonly verifyWriteOutcome?: (context: ToolRecoveryContext<TContext>, failure: ToolFailure) => Promise<
    { readonly status: "completed"; readonly value: TOutput } | { readonly status: "not_applied" } | { readonly status: "unknown" }
  >;
  /** Additional attempts after the initial call. Default two (three executions total). */
  readonly maxRecoveryAttempts?: number;
  readonly maxElapsedMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly initialDelayMs?: number;
  /** Called once, also on recovered failures. Keep this sink local/durable; reporting runs separately. */
  readonly record?: (summary: ToolRecoverySummary, context: ToolRecoveryContext<TContext>) => void | Promise<void>;
}

export class ToolRecoveryError extends Error {
  constructor(readonly failure: ToolFailure, readonly summary: ToolRecoverySummary, readonly originalCause?: unknown) {
    super(failure.message);
    this.name = "ToolRecoveryError";
  }
}

const CATEGORIES = new Set<ToolFailureCategory>(["transient", "invalid_input", "not_found", "permission_denied",
  "business_rule", "cancelled", "unknown_outcome", "bug", "missing_capability"]);
const UNKNOWN: ToolFailure = { category: "bug", code: "unclassified_tool_failure",
  message: "The tool failed unexpectedly. Continue independent work and report the unresolved operation." };
const TIMEOUT: ToolFailure = { category: "transient", code: "tool_timeout", message: "The tool did not respond before its deadline." };
const CANCELLED: ToolFailure = { category: "cancelled", code: "tool_cancelled", message: "The operation was cancelled." };

function checkedFailure(value: ToolFailure | undefined): ToolFailure {
  if (!value || !CATEGORIES.has(value.category) || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(value.code)
    || typeof value.message !== "string" || value.message.length < 1 || value.message.length > 1_000
    || /\bbearer\s|\bsk-[a-z0-9_-]{8,}|-----BEGIN .*PRIVATE KEY/i.test(value.message)) return UNKNOWN;
  return Object.freeze({ category: value.category, code: value.code, message: value.message,
    ...(Number.isFinite(value.retryAfterMs) && value.retryAfterMs! >= 0 ? { retryAfterMs: value.retryAfterMs } : {}) });
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid ${name}`);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
}

/** Abort-aware bounded invocation; a late result can never start a retry or change the recorded outcome. */
async function bounded<T>(parent: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent.aborted) throw new ToolFailureError(CANCELLED);
  if (timeoutMs <= 0) throw new ToolFailureError(TIMEOUT);
  const controller = new AbortController();
  let rejectAbort: (cause: unknown) => void = () => undefined;
  const abort = (failure: ToolFailure) => { controller.abort(); rejectAbort(new ToolFailureError(failure)); };
  const onAbort = () => abort(CANCELLED);
  const stopped = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  parent.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort(TIMEOUT), timeoutMs);
  try { return await Promise.race([Promise.resolve().then(() => run(controller.signal)), stopped]); }
  finally { clearTimeout(timer); parent.removeEventListener("abort", onAbort); }
}

/** Runs within the caller's existing authorization and execution ledger. Never retries an unverified write. */
export async function runToolWithRecovery<TContext, TOutput>(input: {
  readonly context: ToolRecoveryContext<TContext>;
  readonly policy: ToolRecoveryPolicy<TContext, TOutput>;
  readonly execute: (context: ToolRecoveryContext<TContext>) => Promise<TOutput>;
  readonly validateAndAuthorize: (context: ToolRecoveryContext<TContext>) => Promise<void>;
}): Promise<{ readonly value: TOutput; readonly recovery?: ToolRecoverySummary }> {
  const { policy } = input;
  const maximum = 1 + integer(policy.maxRecoveryAttempts ?? 2, "maxRecoveryAttempts", 0, 2);
  const elapsed = integer(policy.maxElapsedMs ?? 30_000, "maxElapsedMs", 1, 600_000);
  const attemptTimeout = integer(policy.attemptTimeoutMs ?? 8_000, "attemptTimeoutMs", 1, 600_000);
  const initialDelay = integer(policy.initialDelayMs ?? 250, "initialDelayMs", 0, 30_000);
  const deadline = Date.now() + elapsed;
  const effect = policy.effect(input.context);
  let context = { ...input.context, arguments: structuredClone(input.context.arguments) };
  const seen = new Set([canonical(context.arguments)]);
  let attempts = 0;
  let cycles = 0;
  let failures = 0;
  let failure = UNKNOWN;
  let cause: unknown;
  const remaining = () => Math.max(0, deadline - Date.now());
  const summary = (status: ToolRecoverySummary["status"], reason: ToolRecoverySummary["reason"]): ToolRecoverySummary =>
    Object.freeze({ type: "handrail.tool_recovery.v1", status, attempts, failedAttempts: failures,
      category: failure.category, code: failure.code, reason });
  const record = async (value: ToolRecoverySummary) => {
    // A broken incident sink must not replace a successful business result or recurse into recovery.
    try { await bounded(new AbortController().signal, 1_000, async () => policy.record?.(value, input.context)); }
    catch { /* The host's diagnostic sink/outbox is independent of execution. */ }
  };
  const fail = async (reason: ToolRecoverySummary["reason"]): Promise<never> => {
    if (reason === "unknown_outcome" && effect !== "read") failure = { ...failure,
      message: "The write outcome could not be verified. Do not repeat this operation; inspect its authoritative receipt before taking further action." };
    const value = summary("failed", reason);
    await record(value);
    throw new ToolRecoveryError(failure, value, cause);
  };
  while (cycles < maximum) {
    cycles += 1;
    if (input.context.signal.aborted) { failure = CANCELLED; return fail("terminal"); }
    if (!remaining()) return fail("deadline");
    try {
      if (attempts > 0) await bounded(input.context.signal, remaining(), async (signal) => input.validateAndAuthorize({ ...context, signal }));
      attempts += 1;
      const value = await bounded(input.context.signal, Math.min(attemptTimeout, remaining()),
        (signal) => input.execute({ ...context, arguments: structuredClone(context.arguments), signal }));
      if (!failures) return { value };
      const recovered = summary("recovered", "completed");
      await record(recovered);
      return { value, recovery: recovered };
    } catch (error) {
      cause = error;
      failures += 1;
      try { failure = checkedFailure(error instanceof ToolFailureError ? error.failure : policy.classify?.(error, context)); }
      catch { failure = UNKNOWN; }
    }
    if (input.context.signal.aborted) { failure = CANCELLED; return fail("terminal"); }
    if (["permission_denied", "business_rule", "cancelled", "missing_capability"].includes(failure.category)
      || effect === "read" && failure.category === "bug") return fail("terminal");
    if (effect !== "read") {
      if (!policy.verifyWriteOutcome || !remaining()) return fail("unknown_outcome");
      try {
        const verified = await bounded(input.context.signal, remaining(), (signal) => policy.verifyWriteOutcome!({ ...context, signal }, failure));
        if (verified.status === "completed") {
          const recovered = summary("recovered", "completed");
          await record(recovered);
          return { value: verified.value, recovery: recovered };
        }
        if (verified.status !== "not_applied") return fail("unknown_outcome");
      } catch { return fail("unknown_outcome"); }
      // Changing an approved write's arguments requires a new authorization, never an automatic repair.
      if (failure.category !== "transient") return fail("terminal");
    }
    if (cycles >= maximum) return fail("attempt_limit");
    if (!remaining()) return fail("deadline");
    if (failure.category === "invalid_input" || failure.category === "not_found") {
      if (effect !== "read" || !policy.repairArguments) return fail("terminal");
      try {
        const candidate = await bounded(input.context.signal, remaining(), (signal) => policy.repairArguments!({ ...context, signal }, failure));
        if (!candidate || seen.has(canonical(candidate))) return fail("no_progress");
        seen.add(canonical(candidate));
        context = { ...context, arguments: structuredClone(candidate) };
      } catch (error) {
        if (error instanceof ToolRecoveryError) throw error;
        return fail("no_progress");
      }
    } else if (failure.category === "transient") {
      const delay = Math.max(failure.retryAfterMs ?? 0, initialDelay * 2 ** (cycles - 1));
      if (delay >= remaining()) return fail("deadline");
      if (delay) {
        try { await bounded(input.context.signal, remaining(), async (signal) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, delay);
          const aborted = () => { clearTimeout(timer); reject(new ToolFailureError(CANCELLED)); };
          signal.addEventListener("abort", aborted, { once: true });
        })); } catch { failure = input.context.signal.aborted ? CANCELLED : TIMEOUT; return fail("deadline"); }
      }
    } else return fail("unknown_outcome");
  }
  return fail("attempt_limit");
}

/** Parses only the bounded public receipt, never tool arguments/results or exception text. */
export function parseToolRecoverySummary(value: unknown): ToolRecoverySummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as ToolRecoverySummary;
  if (row.type !== "handrail.tool_recovery.v1" || !["recovered", "failed"].includes(row.status)
    || !Number.isInteger(row.attempts) || row.attempts < 0 || row.attempts > 3
    || !Number.isInteger(row.failedAttempts) || row.failedAttempts < 0 || row.failedAttempts > 3
    || row.failedAttempts === 0 && (row.attempts !== 0 || row.status !== "failed")
    || row.status === "recovered" && (row.attempts === 0 || row.reason !== "completed")
    || row.status === "failed" && row.reason === "completed"
    || !CATEGORIES.has(row.category) || typeof row.code !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(row.code)
    || !["completed", "terminal", "attempt_limit", "no_progress", "deadline", "unknown_outcome"].includes(row.reason)) return null;
  return { type: row.type, status: row.status, attempts: row.attempts, failedAttempts: row.failedAttempts,
    category: row.category, code: row.code, reason: row.reason };
}
