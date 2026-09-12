import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  normalizeCitationRecords,
  type CitationRecordSet,
} from "../citations.js";
import {
  type ApplicationToolResult,
  type JsonObject,
  type JsonValue,
  type ToolDefinition,
  type ToolResultContentPart,
} from "../protocol.js";
import type {
  ApprovalExecutionCoordinator,
  ApprovalExecutionFailureReason,
  ApprovalExecutionResume,
  ClaimedApprovalExecution,
} from "./approval-execution.js";
import { ToolRegistry, type ToolRegistration } from "./registry.js";
import type { ToolDiscoveryQuery } from "./registry.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { ConversationActivityProgress } from "../conversation/activity.js";
import { runToolWithRecovery, ToolFailureError, ToolRecoveryError, type ToolRecoveryPolicy } from "./recovery.js";

export interface ApplicationToolCall {
  readonly tool_call_id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** Server-derived location, never taken from model arguments. Scope executionKey to this location. */
export interface ApplicationToolExecutionLocation {
  readonly conversationId: string;
  readonly turnId: string;
}

export interface ApplicationToolExecutorContext<TContext = unknown> {
  readonly applicationContext: TContext;
  readonly location?: ApplicationToolExecutionLocation;
  readonly definition: ToolDefinition;
  readonly signal: AbortSignal;
  readonly toolCallId: string;
  /** Stable, host-scoped idempotency identity; falls back to toolCallId for legacy callers. */
  readonly executionKey?: string;
  /** Publishes bounded, user-visible progress for the current long-running tool. */
  readonly reportActivity?: ApplicationToolActivityReporter;
}

export interface ApplicationToolActivityUpdate {
  readonly summary: string;
  readonly progress?: ConversationActivityProgress;
}

export type ApplicationToolActivityReporter = (
  update: ApplicationToolActivityUpdate,
) => void | Promise<void>;

export type ApplicationToolContentOutput =
  | JsonValue
  | ToolResultContentPart
  | readonly ToolResultContentPart[];

/** Explicit trusted-host envelope for tool content plus provider-neutral provenance. */
export interface ApplicationToolOutputProjection {
  readonly type: "handrail.application_tool_output";
  readonly content: ApplicationToolContentOutput;
  readonly citation_records: CitationRecordSet;
}

export type ApplicationToolOutput =
  | ApplicationToolContentOutput
  | ApplicationToolOutputProjection;

export type ApplicationToolExecutor<TContext = unknown> = (
  arguments_: JsonObject,
  context: ApplicationToolExecutorContext<TContext>,
) => ApplicationToolOutput | Promise<ApplicationToolOutput>;

export type ApplicationToolPolicyDecision =
  | { readonly outcome: "allow" }
  | { readonly outcome: "deny" }
  | { readonly outcome: "external_approval_required" };

export interface ApplicationToolPolicyInput<TContext = unknown> {
  readonly applicationContext: TContext;
  readonly location?: ApplicationToolExecutionLocation;
  readonly arguments: JsonObject;
  readonly definition: ToolDefinition;
  readonly signal: AbortSignal;
  readonly toolCallId: string;
}

/** The application policy is the sole authorization boundary for discovered, valid calls. */
export type ApplicationToolPolicy<TContext = unknown> = (
  input: ApplicationToolPolicyInput<TContext>,
) => ApplicationToolPolicyDecision | Promise<ApplicationToolPolicyDecision>;

export interface ToolExecutionLedger {
  /** Optional fast path used to avoid repeating validation/policy for completed calls. */
  get?(toolCallId: string, requestFingerprint?: string): Promise<ApplicationToolResult> | undefined;
  /** Read-only durable receipt lookup after an approved execution is already
   * claimed. Missing or uncertain results never authorize another dispatch. */
  lookup?(toolCallId: string, requestFingerprint?: string): Promise<ApplicationToolResult | undefined>;
  /** Atomically retain the first promise and immutable request fingerprint for a call ID.
   * Custom ledgers must reject reuse with a different or missing fingerprint.
   * Fingerprints supplied by the executor can contain private argument data;
   * persistent implementations should store a cryptographic digest, not log them.
   */
  getOrCreate(
    toolCallId: string,
    execute: () => Promise<ApplicationToolResult>,
    requestFingerprint?: string,
  ): Promise<ApplicationToolResult>;
}

export class ToolExecutionIdentityConflictError extends Error {
  readonly code = "tool_execution_identity_conflict" as const;
  constructor() {
    super("Tool call identity conflicts with its original request.");
    this.name = "ToolExecutionIdentityConflictError";
  }
}

export class InMemoryToolExecutionLedger implements ToolExecutionLedger {
  readonly #entries = new Map<string, { fingerprint: string | undefined; result: Promise<ApplicationToolResult> }>();

  get(toolCallId: string, requestFingerprint?: string): Promise<ApplicationToolResult> | undefined {
    const entry = this.#entries.get(toolCallId);
    if (entry && entry.fingerprint !== requestFingerprint) return Promise.reject(new ToolExecutionIdentityConflictError());
    return entry?.result;
  }

  getOrCreate(
    toolCallId: string,
    execute: () => Promise<ApplicationToolResult>,
    requestFingerprint?: string,
  ): Promise<ApplicationToolResult> {
    const existing = this.get(toolCallId, requestFingerprint);
    if (existing !== undefined) return existing;
    const pending = Promise.resolve().then(execute);
    this.#entries.set(toolCallId, { fingerprint: requestFingerprint, result: pending });
    return pending;
  }
}

function canonicalToolJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalToolJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalToolJson(value[key]!)}`).join(",")}}`;
}

function toolRequestFingerprint(toolCallId: string, name: string, arguments_: JsonObject): string {
  return canonicalToolJson({ toolCallId, name, arguments: arguments_ });
}

export interface BoundedToolExecutorLimits {
  readonly timeoutMs: number;
  readonly maxConcurrency: number;
  readonly maxResultBytes: number;
  readonly maxResultNodes: number;
  readonly maxResultDepth: number;
}

export const DEFAULT_BOUNDED_TOOL_EXECUTOR_LIMITS: Readonly<BoundedToolExecutorLimits> =
  Object.freeze({
    timeoutMs: 30_000,
    maxConcurrency: 4,
    maxResultBytes: 64 * 1_024,
    maxResultNodes: 2_000,
    maxResultDepth: 12,
  });

export interface BoundedToolExecutionRequest<
  TContext = unknown,
  TApprovalPermissionContext = unknown,
> {
  readonly call: ApplicationToolCall;
  /** Stable ledger identity for this intent, independent of provider-local call IDs. */
  readonly executionKey?: string;
  /** Must be the current array returned by ToolRegistry.discover(). */
  readonly discoveredTools: readonly ToolDefinition[];
  readonly applicationContext: TContext;
  readonly signal?: AbortSignal;
  /** Propagate caller cancellation to the executor, but retain its returned
   * outcome after dispatch until the existing tool deadline. This never grants
   * permission to start queued work after cancellation. Defaults to false. */
  readonly preserveDispatchedResultOnCancel?: boolean;
  /** Trusted host location. The host must bind executionKey to this scope; existing ledger identities are preserved. */
  readonly location?: ApplicationToolExecutionLocation;
  /** Trusted host evidence for resuming one exact persisted approval proposal. */
  readonly approval?: ApprovalExecutionResume<TApprovalPermissionContext> & {
    readonly conversationId: import("../conversation/events.js").ConversationId;
    readonly turnId: import("../conversation/events.js").ConversationTurnId;
  };
  /** Awaited after authorization and before a previously unseen side effect begins. */
  readonly onExecutionStarted?: () => void | Promise<void>;
  /** Trusted host bridge to the conversation's shared activity index. */
  readonly reportActivity?: ApplicationToolActivityReporter;
}

export type BoundedToolExecutionOutcome =
  | {
      readonly status: "completed";
      readonly result: ApplicationToolResult;
    }
  | {
      readonly status: "external_approval_required";
      readonly toolCallId: string;
      readonly name: string;
    };

export interface BoundedToolExecutorOptions<
  TContext = unknown,
  TDiscoveryContext = unknown,
  TApprovalPermissionContext = unknown,
> {
  readonly registry: ToolRegistry<ApplicationToolExecutor<TContext>, TDiscoveryContext>;
  readonly policy: ApplicationToolPolicy<TContext>;
  readonly ledger?: ToolExecutionLedger;
  readonly approvalCoordinator?: ApprovalExecutionCoordinator<TApprovalPermissionContext>;
  readonly limits?: Partial<BoundedToolExecutorLimits>;
  readonly diagnostics?: AiDiagnosticSink;
  readonly recovery?: ToolRecoveryPolicy<TContext, ApplicationToolOutput>;
}

class ExecutionCancelled extends Error {}
class InvalidArguments extends Error {}
class InvalidOutput extends Error {}
class InvalidPolicyDecision extends Error {}

type Release = () => void;

interface Waiter {
  readonly resolve: (release: Release) => void;
  readonly reject: (error: ExecutionCancelled) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class ConcurrencyLimiter {
  readonly #maximum: number;
  readonly #waiters: Waiter[] = [];
  #active = 0;

  constructor(maximum: number) {
    this.#maximum = maximum;
  }

  acquire(signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(new ExecutionCancelled());
    if (this.#active < this.#maximum) {
      this.#active += 1;
      return Promise.resolve(this.#releaseFunction());
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new ExecutionCancelled());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releaseFunction(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#startNext();
    };
  }

  #startNext(): void {
    while (this.#active < this.#maximum) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new ExecutionCancelled());
        continue;
      }
      this.#active += 1;
      waiter.resolve(this.#releaseFunction());
    }
  }
}

const JSON_SCHEMA_VALIDATOR = new Ajv2020({
  allErrors: false,
  strict: false,
  validateFormats: false,
});
const COMPILED_SCHEMAS = new WeakMap<object, ValidateFunction>();
const UTF8_ENCODER = new TextEncoder();

const FORBIDDEN_OUTPUT_FIELDS = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "authorization",
  "bearertoken",
  "client",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "managedtoken",
  "nativeclient",
  "password",
  "passwd",
  "privatekey",
  "providerclient",
  "proxyauthorization",
  "refreshtoken",
  "sdkclient",
  "secret",
  "secretkey",
  "secrets",
  "setcookie",
  "signingkey",
]);

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function defineJsonProperty(object: JsonObject, key: string, value: JsonValue): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function resolvedLimits(overrides: Partial<BoundedToolExecutorLimits> | undefined) {
  const limits = { ...DEFAULT_BOUNDED_TOOL_EXECUTOR_LIMITS, ...overrides };
  return Object.freeze({
    timeoutMs: positiveInteger(limits.timeoutMs, "limits.timeoutMs"),
    maxConcurrency: positiveInteger(limits.maxConcurrency, "limits.maxConcurrency"),
    maxResultBytes: positiveInteger(limits.maxResultBytes, "limits.maxResultBytes"),
    maxResultNodes: positiveInteger(limits.maxResultNodes, "limits.maxResultNodes"),
    maxResultDepth: positiveInteger(limits.maxResultDepth, "limits.maxResultDepth"),
  });
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 256) : fallback;
}

function result(
  toolCallId: string,
  name: string,
  content: ToolResultContentPart[],
  isError: boolean,
  citationRecords?: CitationRecordSet,
): ApplicationToolResult {
  content.forEach(Object.freeze);
  Object.freeze(content);
  return Object.freeze({
    tool_call_id: toolCallId,
    name,
    content,
    is_error: isError,
    ...(citationRecords === undefined ? {} : { citation_records: citationRecords }),
  });
}

function errorResult(toolCallId: string, name: string, message: string): ApplicationToolResult {
  return result(toolCallId, name, [{ type: "text", text: message }], true);
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ExecutionCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ExecutionCancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cloneJson(value: unknown, limits: BoundedToolExecutorLimits): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, depth: number, inspectSensitiveData: boolean): JsonValue => {
    nodes += 1;
    if (nodes > limits.maxResultNodes || depth > limits.maxResultDepth) {
      throw new InvalidOutput();
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new InvalidOutput();
      return current;
    }
    if (typeof current === "string") {
      if (
        inspectSensitiveData &&
        CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(current))
      ) {
        throw new InvalidOutput();
      }
      return current;
    }
    if (typeof current !== "object") throw new InvalidOutput();
    if (ancestors.has(current)) throw new InvalidOutput();
    ancestors.add(current);

    let clone: JsonValue;
    if (Array.isArray(current)) {
      if (current.length > limits.maxResultNodes) throw new InvalidOutput();
      const keys = Reflect.ownKeys(current);
      if (
        keys.some(
          (key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, current.length)),
        )
      ) {
        throw new InvalidOutput();
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new InvalidOutput();
      }
      clone = current.map((item) => visit(item, depth + 1, inspectSensitiveData));
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new InvalidOutput();
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string")) throw new InvalidOutput();

      const objectClone: JsonObject = {};
      for (const key of ownKeys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new InvalidOutput();
        if (inspectSensitiveData && FORBIDDEN_OUTPUT_FIELDS.has(normalizedFieldName(key))) {
          throw new InvalidOutput();
        }
        defineJsonProperty(
          objectClone,
          key,
          visit(descriptor.value, depth + 1, inspectSensitiveData),
        );
      }
      clone = objectClone;
    }

    ancestors.delete(current);
    return clone;
  };

  const clone = visit(value, 0, true);
  if (UTF8_ENCODER.encode(JSON.stringify(clone)).byteLength > limits.maxResultBytes) {
    throw new InvalidOutput();
  }
  return clone;
}

function cloneArguments(value: unknown): JsonObject {
  // Arguments receive a generous structural bound before schema validation. Output-sensitive
  // field filtering is intentionally not used: the application policy owns authorization.
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > 10_000 || depth > 20) throw new InvalidArguments();
    if (current === null || typeof current === "boolean" || typeof current === "string") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new InvalidArguments();
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) throw new InvalidArguments();
    ancestors.add(current);

    let clone: JsonValue;
    if (Array.isArray(current)) {
      if (current.length > 10_000) throw new InvalidArguments();
      const keys = Reflect.ownKeys(current);
      if (
        keys.some(
          (key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, current.length)),
        )
      ) {
        throw new InvalidArguments();
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new InvalidArguments();
      }
      clone = current.map((item) => visit(item, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new InvalidArguments();
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string")) throw new InvalidArguments();
      const objectClone: JsonObject = {};
      for (const key of ownKeys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new InvalidArguments();
        defineJsonProperty(objectClone, key, visit(descriptor.value, depth + 1));
      }
      clone = objectClone;
    }
    ancestors.delete(current);
    return clone;
  };

  const clone = visit(value, 0);
  if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
    throw new InvalidArguments();
  }
  return clone;
}

function validateArguments(definition: ToolDefinition, arguments_: JsonObject): void {
  let validate = COMPILED_SCHEMAS.get(definition.input_schema);
  if (validate === undefined) {
    let compiled: ValidateFunction;
    try {
      compiled = JSON_SCHEMA_VALIDATOR.compile(definition.input_schema);
    } catch {
      throw new InvalidArguments();
    }
    COMPILED_SCHEMAS.set(definition.input_schema, compiled);
    validate = compiled;
  }
  if (!validate(arguments_)) throw new InvalidArguments();
}

function resemblesContentPart(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = Object.getOwnPropertyDescriptor(value, "type");
  return type !== undefined && "value" in type && (type.value === "text" || type.value === "json");
}

interface NormalizedApplicationToolOutput {
  readonly content: ToolResultContentPart[];
  readonly citationRecords?: CitationRecordSet;
}

function outputProjection(value: unknown): {
  readonly content: unknown;
  readonly citationRecords: unknown;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const type = Object.getOwnPropertyDescriptor(value, "type");
  if (
    type === undefined ||
    !("value" in type) ||
    type.value !== "handrail.application_tool_output"
  ) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new InvalidOutput();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3 ||
    keys.some((key) => typeof key !== "string") ||
    !keys.includes("content") ||
    !keys.includes("citation_records")
  ) throw new InvalidOutput();
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new InvalidOutput();
    }
  }
  return {
    content: (value as { content: unknown }).content,
    citationRecords: (value as { citation_records: unknown }).citation_records,
  };
}

function normalizeContentOutput(
  output: ApplicationToolContentOutput,
  limits: BoundedToolExecutorLimits,
): ToolResultContentPart[] {
  try {
    let candidate: unknown;
    if (typeof output === "string") {
      candidate = [{ type: "text", text: output }];
    } else if (resemblesContentPart(output)) {
      candidate = [output];
    } else if (Array.isArray(output) && output.length > 0 && output.every(resemblesContentPart)) {
      candidate = output;
    } else {
      candidate = [{ type: "json", value: output }];
    }

    const cloned = cloneJson(candidate, limits);
    if (!Array.isArray(cloned) || cloned.length === 0) throw new InvalidOutput();

    return cloned.map((part) => {
      if (part === null || typeof part !== "object" || Array.isArray(part)) {
        throw new InvalidOutput();
      }
      const keys = Object.keys(part);
      if (part.type === "text") {
        if (keys.length !== 2 || !keys.includes("text") || typeof part.text !== "string") {
          throw new InvalidOutput();
        }
        return { type: "text", text: part.text };
      }
      if (part.type === "json") {
        if (keys.length !== 2 || !keys.includes("value") || !("value" in part)) {
          throw new InvalidOutput();
        }
        return { type: "json", value: part.value };
      }
      throw new InvalidOutput();
    });
  } catch {
    throw new InvalidOutput();
  }
}

function normalizeOutput(
  output: ApplicationToolOutput,
  limits: BoundedToolExecutorLimits,
  toolCallId: string,
): NormalizedApplicationToolOutput {
  try {
    const projection = outputProjection(output);
    const content = normalizeContentOutput(
      (projection?.content ?? output) as ApplicationToolContentOutput,
      limits,
    );
    if (projection === null) return { content };

    const citationRecords = normalizeCitationRecords(projection.citationRecords);
    if (citationRecords.citations.length === 0) throw new InvalidOutput();
    for (const citation of citationRecords.citations) {
      if (
        citation.target.type !== "tool_result" ||
        citation.target.tool_call_id !== toolCallId
      ) throw new InvalidOutput();
    }
    return { content, citationRecords };
  } catch {
    throw new InvalidOutput();
  }
}

export class BoundedToolExecutor<
  TContext = unknown,
  TDiscoveryContext = unknown,
  TApprovalPermissionContext = unknown,
> {
  readonly #registry: ToolRegistry<ApplicationToolExecutor<TContext>, TDiscoveryContext>;
  readonly #policy: ApplicationToolPolicy<TContext>;
  readonly #ledger: ToolExecutionLedger;
  readonly #approvalCoordinator:
    | ApprovalExecutionCoordinator<TApprovalPermissionContext>
    | undefined;
  readonly #limits: Readonly<BoundedToolExecutorLimits>;
  readonly #limiter: ConcurrencyLimiter;
  readonly #diagnostics: AiDiagnosticSink | undefined;
  readonly #recovery: ToolRecoveryPolicy<TContext, ApplicationToolOutput> | undefined;
  readonly #operations = new Map<string, { fingerprint: string; operation: Promise<BoundedToolExecutionOutcome> }>();

  constructor(
    options: BoundedToolExecutorOptions<
      TContext,
      TDiscoveryContext,
      TApprovalPermissionContext
    >,
  ) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#ledger = options.ledger ?? new InMemoryToolExecutionLedger();
    this.#approvalCoordinator = options.approvalCoordinator;
    this.#limits = resolvedLimits(options.limits);
    this.#diagnostics = options.diagnostics;
    this.#recovery = options.recovery;
    this.#limiter = new ConcurrencyLimiter(this.#limits.maxConcurrency);
  }

  /**
   * Discovers from the exact registry bound to this executor. Orchestration
   * layers must still pass this returned array back to `executeDetailed`; the
   * executor remains the authorization and registration boundary.
   */
  discoverTools(query: ToolDiscoveryQuery<TDiscoveryContext>): readonly ToolDefinition[] {
    return this.#registry.discover(query);
  }

  async execute(
    request: BoundedToolExecutionRequest<TContext, TApprovalPermissionContext>,
  ): Promise<ApplicationToolResult> {
    const outcome = await this.executeDetailed(request);
    return outcome.status === "completed"
      ? outcome.result
      : errorResult(
          outcome.toolCallId,
          outcome.name,
          "Tool execution requires external approval.",
        );
  }

  /**
   * Preserves the legacy result-only API while allowing orchestration layers to
   * pause before an externally approved side effect. Approval pauses are never
   * inserted into the execution ledger, so a later approved retry can proceed.
   */
  async executeDetailed(
    request: BoundedToolExecutionRequest<TContext, TApprovalPermissionContext>,
  ): Promise<BoundedToolExecutionOutcome> {
    const toolCallId = safeIdentifier(request.call.tool_call_id, "unknown_tool_call");
    const name = safeIdentifier(request.call.name, "unknown_tool");
    const executionKey = request.executionKey ?? toolCallId;
    if (toolCallId !== request.call.tool_call_id || name !== request.call.name ||
      executionKey !== safeIdentifier(executionKey, "invalid_execution_key")) {
      return { status: "completed", result: errorResult(toolCallId, name, "Tool call identifiers are invalid.") };
    }
    if (request.location !== undefined) {
      try {
        const { conversationId, turnId } = request.location;
        if (typeof conversationId !== "string" || !conversationId || conversationId.length > 256 ||
          typeof turnId !== "string" || !turnId || turnId.length > 256 ||
          request.approval && (request.approval.conversationId !== conversationId || request.approval.turnId !== turnId)) {
          throw new TypeError("Invalid execution location");
        }
        request = { ...request, location: Object.freeze({ conversationId, turnId }) };
      } catch {
        return { status: "completed", result: errorResult(toolCallId, name, "Tool execution location is invalid.") };
      }
    }
    let arguments_: JsonObject;
    try { arguments_ = cloneArguments(request.call.arguments); }
    catch {
      emitAiDiagnostic(this.#diagnostics, { domain: "validation", operation: "pre_execution", phase: "failed",
        toolName: name, toolCallId, code: "invalid_arguments", retryable: false });
      return { status: "completed", result: errorResult(toolCallId, name, "Tool arguments did not match the declared schema.") };
    }
    const fingerprint = toolRequestFingerprint(toolCallId, name, arguments_);
    // Snapshot arguments before any asynchronous boundary so the caller cannot
    // change the dispatched request after its retry identity has been checked.
    request = { ...request, call: { ...request.call, arguments: arguments_ } };
    try {
      const completed = request.approval === undefined
        ? this.#ledger.get?.(executionKey, fingerprint) : undefined;
      if (completed !== undefined) return Object.freeze({ status: "completed", result: await completed });
      const existing = request.approval === undefined ? this.#operations.get(executionKey) : undefined;
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new ToolExecutionIdentityConflictError();
        return existing.operation;
      }
    } catch (cause) {
      if (!(cause instanceof ToolExecutionIdentityConflictError)) throw cause;
      emitAiDiagnostic(this.#diagnostics, { domain: "tool", operation: "pre_execution", phase: "failed",
        toolName: name, toolCallId, code: cause.code, retryable: false });
      return Object.freeze({ status: "completed", result: errorResult(toolCallId, name, cause.message) });
    }
    const operation = this.#executeDetailedOnce(request, toolCallId, name);
    if (request.approval !== undefined) return operation;
    this.#operations.set(executionKey, { fingerprint, operation });
    void operation.finally(() => {
      if (this.#operations.get(executionKey)?.operation === operation) this.#operations.delete(executionKey);
    }).catch(() => undefined);
    return operation;
  }

  async #executeDetailedOnce(
    request: BoundedToolExecutionRequest<TContext, TApprovalPermissionContext>,
    toolCallId: string,
    name: string,
  ): Promise<BoundedToolExecutionOutcome> {
    const controller = new AbortController();
    const deadline = new AbortController();
    const completionSignal = request.preserveDispatchedResultOnCancel ? deadline.signal : controller.signal;
    let timedOut = false;
    let phase: "arguments" | "policy" | "approval" | "execution" = "arguments";
    const onCallerAbort = () => controller.abort();
    if (request.signal?.aborted) controller.abort();
    else request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      deadline.abort();
    }, this.#limits.timeoutMs);

    try {
      if (controller.signal.aborted) throw new ExecutionCancelled();
      const registration = this.#registry.get(name);
      if (
        registration === undefined ||
        !request.discoveredTools.includes(registration.definition)
      ) {
        emitAiDiagnostic(this.#diagnostics, {
          domain: "validation",
          operation: "tool_disclosure",
          phase: "failed",
          toolName: name,
          toolCallId,
          code: "tool_unavailable",
          retryable: false,
        });
        return { status: "completed", result: errorResult(
          toolCallId,
          name,
          "Tool is unavailable for this call.",
        ) };
      }

      const arguments_ = cloneArguments(request.call.arguments);
      validateArguments(registration.definition, arguments_);

      phase = "policy";
      const decision = await raceWithSignal(
        Promise.resolve().then(() => this.#policy({
          applicationContext: request.applicationContext,
          ...(request.location === undefined ? {} : { location: request.location }),
          arguments: arguments_,
          definition: registration.definition,
          signal: controller.signal,
          toolCallId,
        })),
        controller.signal,
      );
      if (decision?.outcome === "deny") {
        emitAiDiagnostic(this.#diagnostics, { domain: "policy", operation: "tool_authorization",
          phase: "failed", toolName: name, toolCallId, code: "policy_denied", retryable: false });
        return { status: "completed", result: errorResult(
          toolCallId,
          name,
          "Tool execution was denied by application policy.",
        ) };
      }
      if (decision?.outcome === "external_approval_required") {
        if (request.approval === undefined || this.#approvalCoordinator === undefined) {
          return Object.freeze({ status: "external_approval_required", toolCallId, name });
        }
        phase = "approval";
        const claim = await this.#approvalCoordinator.claim({
          ...request.approval,
          toolCallId: toolCallId as never,
          toolName: name,
          arguments: arguments_,
          definition: registration.definition,
          signal: controller.signal,
        });
        emitAiDiagnostic(this.#diagnostics, { domain: "approval", operation: "claim",
          phase: claim.outcome === "claimed" || claim.outcome === "reuse" ? "succeeded" :
            claim.outcome === "cancelled" ? "cancelled" : "failed", toolName: name,
          toolCallId, code: claim.outcome, retryable: claim.outcome === "unavailable" });
        if (claim.outcome === "approval_required") {
          return Object.freeze({ status: "external_approval_required", toolCallId, name });
        }
        if (claim.outcome === "reuse") {
          const key = request.executionKey ?? toolCallId;
          const fingerprint = toolRequestFingerprint(toolCallId, name, arguments_);
          const retained = this.#ledger.get?.(key, fingerprint) ?? this.#ledger.lookup?.(key, fingerprint);
          const result = retained === undefined ? undefined : await raceWithSignal(retained, controller.signal);
          if (result !== undefined) {
            return Object.freeze({
              status: "completed",
              result,
            });
          }
          return Object.freeze({
            status: "completed",
            result: errorResult(
              toolCallId,
              name,
              "Tool execution result is temporarily unavailable.",
            ),
          });
        }
        if (claim.outcome !== "claimed") {
          const message = claim.outcome === "cancelled"
            ? "Tool execution was cancelled."
            : claim.outcome === "unavailable"
              ? "Tool approval could not be checked right now."
              : "Tool approval could not be verified.";
          return Object.freeze({
            status: "completed",
            result: errorResult(toolCallId, name, message),
          });
        }
        phase = "execution";
        return Object.freeze({
          status: "completed",
          result: await this.#executeAuthorized(
            request,
            registration,
            arguments_,
            controller.signal,
            toolCallId,
            name,
            () => timedOut,
            completionSignal,
            claim,
          ),
        });
      }
      if (decision?.outcome !== "allow") throw new InvalidPolicyDecision();

      phase = "execution";
      const result = await this.#executeAuthorized(
        request,
        registration,
        arguments_,
        controller.signal,
        toolCallId,
        name,
        () => timedOut,
        completionSignal,
      );
      return Object.freeze({ status: "completed", result });
    } catch (error: unknown) {
      let message = "Tool execution could not be recorded.";
      if (controller.signal.aborted) {
        message = timedOut ? "Tool execution timed out." : "Tool execution was cancelled.";
      } else if (error instanceof ToolExecutionIdentityConflictError) {
        message = error.message;
      } else if (phase === "arguments") {
        message = "Tool arguments did not match the declared schema.";
      } else if (error instanceof InvalidPolicyDecision) {
        message = "Tool authorization returned an invalid decision.";
      } else if (phase === "approval") {
        message = "Tool approval could not be verified.";
      } else if (phase === "policy") {
        message = "Tool authorization could not be completed.";
      }
      emitAiDiagnostic(this.#diagnostics, { domain: phase === "arguments" ? "validation" : phase === "policy" ? "policy" :
        phase === "approval" ? "approval" : "tool", operation: "pre_execution", phase: "failed",
        toolName: name, toolCallId, code: controller.signal.aborted ? timedOut ? "timeout" : "cancelled" :
          phase === "arguments" ? "invalid_arguments" : phase === "policy" ? "policy_failed" : `${phase}_failed`,
        retryable: timedOut || phase === "approval", cause: error });
      return Object.freeze({
        status: "completed",
        result: errorResult(toolCallId, name, message),
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async #executeAuthorized(
    request: BoundedToolExecutionRequest<TContext, TApprovalPermissionContext>,
    registration: ToolRegistration<ApplicationToolExecutor<TContext>, TDiscoveryContext>,
    arguments_: JsonObject,
    signal: AbortSignal,
    toolCallId: string,
    name: string,
    timedOut: () => boolean,
    completionSignal: AbortSignal,
    approvalClaim?: ClaimedApprovalExecution,
  ): Promise<ApplicationToolResult> {
    return raceWithSignal(
      this.#ledger.getOrCreate(request.executionKey ?? toolCallId, async () => {
        const diagnosticStartedAt = Date.now();
        let executionResult: ApplicationToolResult;
        let failureReason: ApprovalExecutionFailureReason | undefined;
        let executionStartRecorded = request.onExecutionStarted === undefined;
        let activityActive = true;
        try {
          emitAiDiagnostic(this.#diagnostics, { domain: "tool", operation: "execute",
            phase: "started", toolName: name, toolCallId });
          await request.onExecutionStarted?.();
          executionStartRecorded = true;
          const release = await this.#limiter.acquire(signal);
          const invoke = (currentArguments: JsonObject, currentSignal: AbortSignal) => Promise.resolve()
            .then(() => {
              if (currentSignal.aborted) throw new ExecutionCancelled();
              return registration.executor(currentArguments, {
                applicationContext: request.applicationContext,
                ...(request.location === undefined ? {} : { location: request.location }),
                definition: registration.definition,
                signal: currentSignal,
                toolCallId,
                executionKey: request.executionKey ?? toolCallId,
                ...(request.reportActivity === undefined
                  ? {}
                  : { reportActivity: async (update: ApplicationToolActivityUpdate) => {
                      if (!activityActive || signal.aborted) return;
                      try {
                        await request.reportActivity!(update);
                      } catch (cause) {
                        emitAiDiagnostic(this.#diagnostics, { domain: "activity", operation: "tool_progress",
                          phase: "failed", toolName: name, toolCallId,
                          code: "activity_update_failed", retryable: true, cause });
                      }
                    } }),
              });
            });
          const invocation = this.#recovery
            ? runToolWithRecovery({
                context: { applicationContext: request.applicationContext, definition: registration.definition,
                  ...(request.location === undefined ? {} : { location: request.location }),
                  arguments: arguments_, signal, toolCallId, executionKey: request.executionKey ?? toolCallId },
                policy: this.#recovery,
                execute: (context) => invoke(context.arguments, context.signal),
                validateAndAuthorize: async (context) => {
                  validateArguments(registration.definition, cloneArguments(context.arguments));
                  const decision = await this.#policy({ applicationContext: request.applicationContext,
                    ...(request.location === undefined ? {} : { location: request.location }),
                    definition: registration.definition, arguments: context.arguments, signal: context.signal, toolCallId });
                  if (decision.outcome !== "allow" && !(decision.outcome === "external_approval_required" && approvalClaim)) {
                    throw new ToolFailureError({ category: "permission_denied", code: "recovery_authorization_required",
                      message: "The retry requires current application authorization." });
                  }
                },
              }).then(({ value, recovery }) => {
                const normalized = normalizeOutput(value, this.#limits, toolCallId);
                return { ...normalized, content: [...normalized.content,
                  ...(recovery ? [{ type: "json" as const, value: { ...recovery } }] : [])] };
              })
            : invoke(arguments_, signal).then((output) => normalizeOutput(output, this.#limits, toolCallId));
          void invocation.then(release, release);
          const normalized = await raceWithSignal(invocation, completionSignal);
          executionResult = resultForExecution(
            toolCallId,
            name,
            normalized.content,
            normalized.citationRecords,
          );
          emitAiDiagnostic(this.#diagnostics, { domain: "tool", operation: "execute",
            phase: "succeeded", toolName: name, toolCallId, durationMs: Date.now() - diagnosticStartedAt });
        } catch (error: unknown) {
          emitAiDiagnostic(this.#diagnostics, { domain: "tool", operation: "execute",
            phase: signal.aborted ? "cancelled" : "failed", toolName: name,
            toolCallId, retryable: timedOut(), durationMs: Date.now() - diagnosticStartedAt, cause: error });
          if (error instanceof ExecutionCancelled) {
            failureReason = timedOut() ? "execution_timed_out" : "execution_cancelled";
            executionResult = errorResult(
              toolCallId,
              name,
              timedOut() ? "Tool execution timed out." : "Tool execution was cancelled.",
            );
          } else if (error instanceof ToolRecoveryError) {
            failureReason = "tool_execution_failed";
            executionResult = result(toolCallId, name, [
              { type: "text", text: error.failure.message },
              { type: "json", value: { ...error.summary } },
            ], true);
          } else if (error instanceof InvalidOutput) {
            failureReason = "invalid_tool_output";
            executionResult = errorResult(
              toolCallId,
              name,
              "Tool returned an invalid or unsafe result.",
            );
          } else {
            failureReason = executionStartRecorded
              ? "tool_execution_failed"
              : "execution_recording_failed";
            executionResult = errorResult(toolCallId, name, "Tool execution failed.");
          }
        }

        activityActive = false;

        if (approvalClaim !== undefined && this.#approvalCoordinator !== undefined) {
          const settled = await this.#approvalCoordinator.settle({
            permissionContext: request.approval!.permissionContext,
            conversationId: request.approval!.conversationId,
            proposalId: approvalClaim.proposalId,
            executingVersion: approvalClaim.executingVersion,
            executionId: approvalClaim.executionId,
            attribution: request.approval!.attribution,
            status: failureReason === undefined ? "executed" : "failed",
            ...(failureReason === undefined ? {} : { failureReason }),
            signal: completionSignal,
          });
          emitAiDiagnostic(this.#diagnostics, { domain: "approval", operation: "settle",
            phase: settled.outcome === "recorded" ? "succeeded" : "failed", toolName: name,
            code: settled.outcome, retryable: settled.outcome === "unavailable" });
          if (settled.outcome !== "recorded") {
            return errorResult(
              toolCallId,
              name,
              "Tool execution result could not be recorded.",
            );
          }
        }
        return executionResult;
      }, toolRequestFingerprint(toolCallId, name, arguments_)),
      completionSignal,
    );
  }
}

function resultForExecution(
  toolCallId: string,
  name: string,
  content: ToolResultContentPart[],
  citationRecords?: CitationRecordSet,
): ApplicationToolResult {
  return result(toolCallId, name, content, false, citationRecords);
}
