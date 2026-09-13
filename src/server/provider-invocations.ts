import { AI_RUNTIME_PROTOCOL_VERSION, parseStreamEvent, type StreamEvent } from "../protocol.js";
import type { ProviderAdapterInvocation, ProviderAdapterResult, ProviderAdapterStream, ProviderUsage } from "../providers/index.js";

/** Durable claim store. The caller supplies the authenticated owner scope and stable operation identity. */
export interface ProviderInvocationOperationStore {
  run<T>(input: { readonly operationId: string; readonly requestFingerprint: string;
    readonly execute: () => Promise<T>; readonly parseResult: (value: unknown) => T }): Promise<T>;
}
const MAX_EVENTS = 20_000, MAX_BYTES = 4 * 1024 * 1024;
type RetainedInvocation = { version: 1; events: StreamEvent[]; result: ProviderAdapterResult };

/** Retain one normalized SDK invocation before the SDK may dispatch its tools. */
export async function* retainProviderInvocation(input: {
  readonly store: ProviderInvocationOperationStore;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly invocation: ProviderAdapterInvocation;
  readonly invoke: () => ProviderAdapterStream;
  /** Display-safe branding only. Never pass provider errors or request contents. */
  readonly failureMessage?: string;
}): ProviderAdapterStream {
  const { invocation, store, operationId, requestFingerprint } = input;
  let stream: ProviderAdapterStream | undefined;
  const ready = deferred<void>(), consumed = deferred<RetainedInvocation>();
  // The SDK operation store either returns a verified completed result, or
  // commits the dispatch claim before handing this generator the live stream.
  const saved = store.run({ operationId, requestFingerprint,
    execute: () => { invocation.signal.throwIfAborted(); stream = input.invoke(); ready.resolve(); return consumed.promise; },
    parseResult: value => parseRetained(value, invocation.context.request_id) });
  void saved.then(() => ready.resolve(), () => ready.resolve());
  let forwarded = 0, finished = false;
  try {
    await ready.promise;
    if (!stream) {
      const retained = await saved;
      for (const event of retained.events) { invocation.signal.throwIfAborted(); forwarded++; yield event; }
      finished = true;
      return retained.result;
    }
    const events: StreamEvent[] = [];
    let bytes = 0;
    let step = await stream.next();
    while (!step.done) {
      const event = parseStreamEvent(step.value);
      if (event.request_id !== invocation.context.request_id || event.trace_id !== invocation.context.trace_id
        || event.sequence !== events.length || ["response.completed", "response.cancelled", "response.error"].includes(events.at(-1)?.type ?? "")) invalid();
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (events.length >= MAX_EVENTS || bytes > MAX_BYTES) throw new Error("Provider output exceeds its retention bound");
      events.push(event);
      if (!["response.completed", "response.cancelled", "response.error"].includes(event.type)) { forwarded++; yield event; }
      step = await stream.next();
    }
    consumed.resolve({ version: 1, events, result: step.value });
    // Completed tool-call identities become replayable before any execution.
    const retained = await saved;
    forwarded++; yield retained.events.at(-1)!;
    finished = true;
    return retained.result;
  } catch (cause) {
    consumed.reject(cause);
    await saved.catch(() => undefined);
    const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: invocation.context.request_id, trace_id: invocation.context.trace_id };
    if (forwarded === 0) yield parseStreamEvent({ ...envelope, sequence: forwarded++, type: "response.started",
      attribution: invocation.context.attribution });
    if (invocation.signal.aborted) {
      yield parseStreamEvent({ ...envelope, sequence: forwarded, type: "response.cancelled", reason: "runtime_shutdown" });
      return { status: "cancelled", reason: "runtime_shutdown", usage: null };
    }
    const message = input.failureMessage ?? "This request could not be resumed safely. Check its saved action results before starting a new request.";
    yield parseStreamEvent({ ...envelope, sequence: forwarded, type: "response.error",
      error: { category: "policy", code: "policy_denied", message, retryable: false } });
    return { status: "failed", error: { kind: "policy", code: "policy_denied", message, retryable: false }, usage: null };
  } finally {
    if (!finished && stream) {
      consumed.reject(new Error("Provider observation ended before durable completion"));
      try { await stream.return({ status: "cancelled", reason: "runtime_shutdown", usage: null }); }
      finally { await saved.catch(() => undefined); }
    }
  }
}

function parseRetained(value: unknown, requestId: string): RetainedInvocation {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid();
  const record = exact(value, ["version", "events", "result"]);
  if (record.version !== 1 || !Array.isArray(record.events) || record.events.length < 1 || record.events.length > MAX_EVENTS) invalid();
  const events = record.events.map(parseStreamEvent);
  if (events.some((event, index) => event.request_id !== requestId || event.sequence !== index)
    || events[0]?.type !== "response.started"
    || events.slice(0, -1).some(event => ["response.completed", "response.cancelled", "response.error"].includes(event.type))) invalid();
  const terminal = events.at(-1)!;
  let result: ProviderAdapterResult;
  if (terminal.type === "response.completed") {
    const row = exact(record.result, ["status", "outcome", "usage"]);
    if (row.status !== "completed" || row.outcome !== terminal.outcome || row.usage === null) invalid();
    result = { status: "completed", outcome: terminal.outcome, usage: parseUsage(row.usage) };
  } else if (terminal.type === "response.cancelled") {
    const row = exact(record.result, ["status", "reason", "usage"]);
    if (row.status !== "cancelled" || row.reason !== terminal.reason) invalid();
    result = { status: "cancelled", reason: terminal.reason, usage: row.usage === null ? null : parseUsage(row.usage) };
  } else if (terminal.type === "response.error") {
    const row = exact(record.result, ["status", "error", "usage"]);
    const error = exact(row.error, ["kind", "retryable", "code", "message"]);
    const allowed = error.kind === "provider" && error.retryable === true &&
      ["rate_limited", "deadline_exceeded", "upstream_unavailable"].includes(String(error.code))
      || error.kind === "client" && error.retryable === false &&
      ["invalid_request", "unauthenticated", "forbidden", "idempotency_conflict"].includes(String(error.code))
      || error.kind === "policy" && error.retryable === false && error.code === "policy_denied";
    // Preserve the normalized result only when it agrees with the validated terminal event.
    if (row.status !== "failed" || !allowed || error.code !== terminal.error.code
      || error.retryable !== terminal.error.retryable || error.message !== terminal.error.message) invalid();
    result = { status: "failed", error: { kind: error.kind, code: error.code, retryable: error.retryable,
      message: error.message } as Extract<ProviderAdapterResult, { status: "failed" }>["error"], usage: row.usage === null ? null : parseUsage(row.usage) };
  } else invalid();
  return { version: 1, events, result };
}
function parseUsage(value: unknown): ProviderUsage {
  const row = exact(value, ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "total_tokens", "provider_cost"], ["cache_write_input_tokens"]);
  const count = (key: string) => {
    const value = row[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) invalid();
    return Number(value);
  };
  const cost = row.provider_cost && typeof row.provider_cost === "object" && "known" in row.provider_cost && row.provider_cost.known === true
    ? exact(row.provider_cost, ["known", "amount", "currency"]) : exact(row.provider_cost, ["known"]);
  if (cost.known !== false && (cost.known !== true || typeof cost.amount !== "string" || typeof cost.currency !== "string")) invalid();
  return { input_tokens: count("input_tokens"), cached_input_tokens: count("cached_input_tokens"),
    ...(row.cache_write_input_tokens === undefined ? {} : { cache_write_input_tokens: count("cache_write_input_tokens") }),
    output_tokens: count("output_tokens"), reasoning_tokens: count("reasoning_tokens"), total_tokens: count("total_tokens"),
    provider_cost: cost.known === true ? { known: true, amount: cost.amount as string, currency: cost.currency as string } : { known: false } };
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return row;
}
function invalid(): never { throw new TypeError("The saved provider output is invalid."); }
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation can settle a consumer before the store invokes execute.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
