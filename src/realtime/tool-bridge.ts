import type {
  ApprovalProposalStore,
} from "../conversation/approval-proposal-store.js";
import {
  ConversationEventStoreConflictError,
  type ConversationEventStore,
} from "../conversation/event-store.js";
import {
  CONVERSATION_EVENT_VERSION,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationApprovalProposalId,
  type ConversationApprovalReviewedArguments,
  type ConversationId,
  type ConversationTimestamp,
  type ConversationToolCallId,
  type ConversationTurnId,
} from "../conversation/events.js";
import { replayConversation } from "../conversation/replay.js";
import { originalApprovalEvidence } from "../conversation/approval-evidence.js";
import type { ConversationEventAttribution } from "../conversation/state.js";
import type { JsonObject, JsonValue, ToolDefinition, ToolResultContentPart } from "../protocol.js";
import type { ApprovalExecutionResume } from "../tools/approval-execution.js";
import {
  BoundedToolExecutor,
} from "../tools/executor.js";
import type { ToolDiscoveryQuery } from "../tools/registry.js";
import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceSafeError,
  type RealtimeVoiceServerToolCapabilityReference,
  type RealtimeVoiceSessionId,
} from "./types.js";
import {
  RealtimeVoiceValidationError,
  realtimeVoiceSafeError,
} from "./validation.js";

export const REALTIME_VOICE_TOOL_LIMITS = Object.freeze({
  argumentBytes: 32 * 1_024,
  argumentNodes: 1_024,
  argumentDepth: 12,
  argumentArrayLength: 128,
  argumentObjectKeys: 128,
  argumentKeyLength: 128,
  argumentStringLength: 8_192,
  trackedSessions: 256,
  trackedCallsPerSession: 256,
  trackedBindings: 4_096,
  approvalEventAppendAttempts: 4,
  approvalEventReadPageSize: 100,
  approvalEventReadPages: 50,
} as const);

declare const realtimeToolOpaque: unique symbol;
type RealtimeToolOpaqueString<Name extends string> = string & {
  readonly [realtimeToolOpaque]: Name;
};

export type RealtimeVoiceServerToolCallId =
  RealtimeToolOpaqueString<"RealtimeVoiceServerToolCallId">;
export type RealtimeVoiceServerToolName =
  RealtimeToolOpaqueString<"RealtimeVoiceServerToolName">;

/** Strict provider-neutral envelope accepted only by the trusted server bridge. */
export interface RealtimeVoiceServerToolCall {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly session_id: RealtimeVoiceSessionId;
  readonly capability_ref: RealtimeVoiceServerToolCapabilityReference;
  readonly call_id: RealtimeVoiceServerToolCallId;
  readonly idempotency_key: RealtimeVoiceIdempotencyKey;
  readonly name: RealtimeVoiceServerToolName;
  readonly arguments: JsonObject;
}

export interface RealtimeVoiceServerToolResult {
  readonly name: RealtimeVoiceServerToolName;
  readonly content: readonly ToolResultContentPart[];
  readonly is_error: boolean;
}

interface RealtimeVoiceServerToolOutcomeBase {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly session_id: RealtimeVoiceSessionId;
  readonly call_id: RealtimeVoiceServerToolCallId;
}

export type RealtimeVoiceServerToolOutcome =
  | (RealtimeVoiceServerToolOutcomeBase & {
      readonly status: "completed";
      readonly result: RealtimeVoiceServerToolResult;
    })
  | (RealtimeVoiceServerToolOutcomeBase & {
      readonly status: "approval_required";
      readonly name: RealtimeVoiceServerToolName;
      readonly proposal_id: ConversationApprovalProposalId;
    })
  | (RealtimeVoiceServerToolOutcomeBase & {
      readonly status: "failed";
      readonly error: RealtimeVoiceSafeError;
    });

export interface RealtimeVoiceToolCallBinding {
  readonly sessionId: RealtimeVoiceSessionId;
  readonly callId: RealtimeVoiceServerToolCallId;
  readonly idempotencyKey: RealtimeVoiceIdempotencyKey;
  /** SHA-256 of the canonical bounded envelope; it contains no raw arguments. */
  readonly fingerprint: string;
}

export type RealtimeVoiceToolCallBindingResult = "created" | "matched" | "conflict";

/** Host-replaceable durable boundary for exact retry/tamper binding. */
export interface RealtimeVoiceToolCallBindingStore {
  bind(binding: RealtimeVoiceToolCallBinding): Promise<RealtimeVoiceToolCallBindingResult>;
}

export interface InMemoryRealtimeVoiceToolCallBindingStoreOptions {
  readonly maximumBindings?: number;
}

export class InMemoryRealtimeVoiceToolCallBindingStore
  implements RealtimeVoiceToolCallBindingStore {
  readonly #maximumBindings: number;
  readonly #calls = new Map<string, string>();
  readonly #idempotency = new Map<string, string>();

  constructor(options: InMemoryRealtimeVoiceToolCallBindingStoreOptions = {}) {
    this.#maximumBindings = positiveInteger(
      options.maximumBindings ?? REALTIME_VOICE_TOOL_LIMITS.trackedBindings,
      "maximumBindings",
    );
  }

  async bind(binding: RealtimeVoiceToolCallBinding): Promise<RealtimeVoiceToolCallBindingResult> {
    const callKey = `${binding.sessionId}\u0000${binding.callId}`;
    const identity = `${binding.sessionId}\u0000${binding.callId}`;
    const priorFingerprint = this.#calls.get(callKey);
    const priorIdentity = this.#idempotency.get(binding.idempotencyKey);
    if (
      (priorFingerprint !== undefined && priorFingerprint !== binding.fingerprint) ||
      (priorIdentity !== undefined && priorIdentity !== identity)
    ) return "conflict";
    if (priorFingerprint !== undefined) return "matched";
    if (this.#calls.size >= this.#maximumBindings) {
      throw new RealtimeVoiceToolBridgeError("capacity_exceeded");
    }
    this.#calls.set(callKey, binding.fingerprint);
    this.#idempotency.set(binding.idempotencyKey, identity);
    return "created";
  }
}

export class RealtimeVoiceToolBridgeError extends Error {
  readonly code: "capacity_exceeded" | "unavailable";

  constructor(code: "capacity_exceeded" | "unavailable") {
    super("The realtime tool bridge is unavailable.");
    this.name = "RealtimeVoiceToolBridgeError";
    this.code = code;
  }
}

export interface RealtimeVoiceToolApprovalReviewInput<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly sessionId: RealtimeVoiceSessionId;
  readonly callId: RealtimeVoiceServerToolCallId;
  readonly name: RealtimeVoiceServerToolName;
  readonly arguments: JsonObject;
  readonly definition: ToolDefinition;
  readonly signal: AbortSignal;
}

export interface RealtimeVoiceToolApprovalResumeInput<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly sessionId: RealtimeVoiceSessionId;
  readonly callId: RealtimeVoiceServerToolCallId;
  readonly name: RealtimeVoiceServerToolName;
  readonly proposalId: ConversationApprovalProposalId;
  readonly signal: AbortSignal;
}

export interface RealtimeVoiceToolApprovalWorkflow<TPermissionContext> {
  readonly proposalStore: ApprovalProposalStore<TPermissionContext>;
  readonly eventStore: ConversationEventStore;
  /** Host-owned redaction/reference boundary. Raw arguments must not be logged. */
  readonly reviewArguments: (
    input: RealtimeVoiceToolApprovalReviewInput<TPermissionContext>,
  ) => ConversationApprovalReviewedArguments |
    Promise<ConversationApprovalReviewedArguments>;
  /** @deprecated Approval requests do not expire; this callback is ignored. */
  readonly expiresAt?: (
    input: RealtimeVoiceToolApprovalReviewInput<TPermissionContext>,
  ) => ConversationTimestamp | Promise<ConversationTimestamp>;
  /** Returns exact confirmed evidence, or undefined while human review is pending. */
  readonly resolveExecution: (
    input: RealtimeVoiceToolApprovalResumeInput<TPermissionContext>,
  ) => ApprovalExecutionResume<TPermissionContext> | undefined |
    Promise<ApprovalExecutionResume<TPermissionContext> | undefined>;
}

export interface RealtimeVoiceToolSessionApprovalContext<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly turnId: ConversationTurnId;
  readonly attribution: ConversationEventAttribution;
}

export interface RealtimeVoiceToolSessionRegistration<
  TContext,
  TDiscoveryContext,
  TPermissionContext,
> {
  readonly session_id: RealtimeVoiceSessionId;
  readonly capability_ref: RealtimeVoiceServerToolCapabilityReference;
  readonly discovery: ToolDiscoveryQuery<TDiscoveryContext>;
  readonly applicationContext: TContext;
  readonly approval?: RealtimeVoiceToolSessionApprovalContext<TPermissionContext>;
}

export interface RealtimeVoiceToolSessionDescriptor {
  readonly session_id: RealtimeVoiceSessionId;
  readonly capability_ref: RealtimeVoiceServerToolCapabilityReference;
  readonly tools: readonly ToolDefinition[];
}

export interface RealtimeVoiceServerToolBridge {
  execute(
    call: unknown,
    operation: { readonly signal: AbortSignal },
  ): Promise<RealtimeVoiceServerToolOutcome>;
  terminateSession(sessionId: RealtimeVoiceSessionId): Promise<void>;
}

export interface CreateRealtimeVoiceServerToolBridgeOptions<
  TContext,
  TDiscoveryContext,
  TPermissionContext,
> {
  readonly executor: BoundedToolExecutor<TContext, TDiscoveryContext, TPermissionContext>;
  readonly bindingStore?: RealtimeVoiceToolCallBindingStore;
  readonly approvalWorkflow?: RealtimeVoiceToolApprovalWorkflow<TPermissionContext>;
  readonly maximumTrackedSessions?: number;
  readonly maximumTrackedCallsPerSession?: number;
}

interface SessionRecord<TContext, TPermissionContext> {
  readonly sessionId: RealtimeVoiceSessionId;
  readonly capabilityRef: RealtimeVoiceServerToolCapabilityReference;
  readonly discoveredTools: readonly ToolDefinition[];
  readonly applicationContext: TContext;
  readonly approval?: RealtimeVoiceToolSessionApprovalContext<TPermissionContext>;
  readonly controller: AbortController;
  readonly calls: Set<string>;
  readonly operations: Set<Promise<RealtimeVoiceServerToolOutcome>>;
  terminal: boolean;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CAPABILITY_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._~+:/=-]*$/;
const UTF8_ENCODER = new TextEncoder();

export function parseRealtimeVoiceServerToolCall(value: unknown): RealtimeVoiceServerToolCall {
  const path = "$server_tool_call";
  const source = plainRecord(value, path);
  exactFields(source, [
    "version",
    "session_id",
    "capability_ref",
    "call_id",
    "idempotency_key",
    "name",
    "arguments",
  ], path);
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    fail(`${path}.version`, `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`);
  }
  const sessionId = boundedIdentifier<RealtimeVoiceSessionId>(
    source.session_id,
    `${path}.session_id`,
  );
  const capabilityRef = boundedString(
    source.capability_ref,
    `${path}.capability_ref`,
    REALTIME_VOICE_LIMITS.capabilityReferenceLength,
  );
  if (!CAPABILITY_REFERENCE.test(capabilityRef)) {
    fail(`${path}.capability_ref`, "must be a bounded opaque reference");
  }
  const callId = boundedIdentifier<RealtimeVoiceServerToolCallId>(
    source.call_id,
    `${path}.call_id`,
  );
  const idempotencyKey = boundedString(
    source.idempotency_key,
    `${path}.idempotency_key`,
    REALTIME_VOICE_LIMITS.idempotencyKeyLength,
  );
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    fail(`${path}.idempotency_key`, "must be a bounded idempotency key");
  }
  const name = boundedIdentifier<RealtimeVoiceServerToolName>(
    source.name,
    `${path}.name`,
  );
  const arguments_ = cloneArguments(source.arguments, `${path}.arguments`);
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: sessionId,
    capability_ref: capabilityRef as RealtimeVoiceServerToolCapabilityReference,
    call_id: callId,
    idempotency_key: idempotencyKey as RealtimeVoiceIdempotencyKey,
    name,
    arguments: arguments_,
  });
}

class RealtimeVoiceServerToolBridgeImpl<
  TContext,
  TDiscoveryContext,
  TPermissionContext,
> implements RealtimeVoiceServerToolBridge {
  readonly #executor: BoundedToolExecutor<TContext, TDiscoveryContext, TPermissionContext>;
  readonly #bindingStore: RealtimeVoiceToolCallBindingStore;
  readonly #approvalWorkflow:
    | RealtimeVoiceToolApprovalWorkflow<TPermissionContext>
    | undefined;
  readonly #maximumTrackedSessions: number;
  readonly #maximumTrackedCallsPerSession: number;
  readonly #sessions = new Map<string, SessionRecord<TContext, TPermissionContext>>();
  readonly #terminalSessions = new Set<string>();
  readonly #terminations = new Map<string, Promise<void>>();
  readonly #callOperations = new Map<string, Promise<RealtimeVoiceServerToolOutcome>>();

  constructor(options: CreateRealtimeVoiceServerToolBridgeOptions<
    TContext,
    TDiscoveryContext,
    TPermissionContext
  >) {
    if (options?.executor === null || typeof options?.executor !== "object") {
      throw new TypeError("options.executor must be a BoundedToolExecutor");
    }
    this.#executor = options.executor;
    this.#bindingStore = options.bindingStore ??
      new InMemoryRealtimeVoiceToolCallBindingStore();
    this.#approvalWorkflow = options.approvalWorkflow;
    this.#maximumTrackedSessions = positiveInteger(
      options.maximumTrackedSessions ?? REALTIME_VOICE_TOOL_LIMITS.trackedSessions,
      "maximumTrackedSessions",
    );
    this.#maximumTrackedCallsPerSession = positiveInteger(
      options.maximumTrackedCallsPerSession ??
        REALTIME_VOICE_TOOL_LIMITS.trackedCallsPerSession,
      "maximumTrackedCallsPerSession",
    );
  }

  registerSession(
    registration: RealtimeVoiceToolSessionRegistration<
      TContext,
      TDiscoveryContext,
      TPermissionContext
    >,
  ): RealtimeVoiceToolSessionDescriptor {
    const sessionId = boundedIdentifier<RealtimeVoiceSessionId>(
      registration?.session_id,
      "$tool_session.session_id",
    );
    const capabilityRef = boundedString(
      registration?.capability_ref,
      "$tool_session.capability_ref",
      REALTIME_VOICE_LIMITS.capabilityReferenceLength,
    );
    if (!CAPABILITY_REFERENCE.test(capabilityRef)) {
      fail("$tool_session.capability_ref", "must be a bounded opaque reference");
    }
    if (this.#terminalSessions.has(sessionId)) {
      throw new RealtimeVoiceValidationError(
        "$tool_session.session_id",
        "belongs to a terminal session",
      );
    }
    if (this.#sessions.has(sessionId)) {
      throw new RealtimeVoiceValidationError(
        "$tool_session.session_id",
        "is already registered",
      );
    }
    if (this.#sessions.size >= this.#maximumTrackedSessions) {
      throw new RealtimeVoiceToolBridgeError("capacity_exceeded");
    }
    const discoveredTools = this.#executor.discoverTools(registration.discovery);
    const record: SessionRecord<TContext, TPermissionContext> = {
      sessionId,
      capabilityRef: capabilityRef as RealtimeVoiceServerToolCapabilityReference,
      discoveredTools,
      applicationContext: registration.applicationContext,
      ...(registration.approval === undefined
        ? {}
        : { approval: registration.approval }),
      controller: new AbortController(),
      calls: new Set(),
      operations: new Set(),
      terminal: false,
    };
    this.#sessions.set(sessionId, record);
    return Object.freeze({
      session_id: record.sessionId,
      capability_ref: record.capabilityRef,
      tools: record.discoveredTools,
    });
  }

  async execute(
    value: unknown,
    operation: { readonly signal: AbortSignal },
  ): Promise<RealtimeVoiceServerToolOutcome> {
    const call = parseRealtimeVoiceServerToolCall(value);
    if (!(operation?.signal instanceof AbortSignal)) {
      throw new RealtimeVoiceValidationError(
        "$server_tool_operation.signal",
        "must be an AbortSignal",
      );
    }
    const session = this.#sessions.get(call.session_id);
    if (session === undefined || session.terminal) {
      return failedOutcome(call, "invalid_state");
    }
    if (session.capabilityRef !== call.capability_ref) {
      return failedOutcome(call, "unsupported_capability");
    }
    if (!session.calls.has(call.call_id)) {
      if (session.calls.size >= this.#maximumTrackedCallsPerSession) {
        return failedOutcome(call, "temporarily_unavailable");
      }
      session.calls.add(call.call_id);
    }
    const fingerprint = await envelopeFingerprint(call);
    let binding: RealtimeVoiceToolCallBindingResult;
    try {
      binding = await this.#bindingStore.bind(Object.freeze({
        sessionId: call.session_id,
        callId: call.call_id,
        idempotencyKey: call.idempotency_key,
        fingerprint,
      }));
    } catch {
      return failedOutcome(call, "temporarily_unavailable");
    }
    if (binding === "conflict") return failedOutcome(call, "idempotency_conflict");
    if (session.terminal) return failedOutcome(call, "invalid_state");
    const operationKey = `${call.session_id}\u0000${call.call_id}`;
    const existing = this.#callOperations.get(operationKey);
    if (existing !== undefined) return existing;
    const pending = this.#executeOnce(session, call, operation.signal, fingerprint);
    this.#callOperations.set(operationKey, pending);
    session.operations.add(pending);
    void pending.finally(() => {
      if (this.#callOperations.get(operationKey) === pending) {
        this.#callOperations.delete(operationKey);
      }
      session.operations.delete(pending);
    }).catch(() => undefined);
    return pending;
  }

  terminateSession(sessionId: RealtimeVoiceSessionId): Promise<void> {
    const parsed = boundedIdentifier<RealtimeVoiceSessionId>(
      sessionId,
      "$terminal_session.session_id",
    );
    const existing = this.#terminations.get(parsed);
    if (existing !== undefined) return existing;
    const session = this.#sessions.get(parsed);
    if (session !== undefined) {
      session.terminal = true;
      session.controller.abort();
    }
    this.#rememberTerminal(parsed);
    const operation = (async () => {
      if (session !== undefined) {
        await Promise.allSettled([...session.operations]);
        this.#sessions.delete(parsed);
      }
    })();
    this.#terminations.set(parsed, operation);
    void operation.finally(() => this.#terminations.delete(parsed)).catch(() => undefined);
    return operation;
  }

  async #executeOnce(
    session: SessionRecord<TContext, TPermissionContext>,
    call: RealtimeVoiceServerToolCall,
    callerSignal: AbortSignal,
    fingerprint: string,
  ): Promise<RealtimeVoiceServerToolOutcome> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (callerSignal.aborted || session.controller.signal.aborted) controller.abort();
    else {
      callerSignal.addEventListener("abort", abort, { once: true });
      session.controller.signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const scopedCallId = await scopedIdentity("call", call.session_id, call.call_id);
      const proposalId = await proposalIdentity(fingerprint);
      const approval = await this.#resolveApproval(session, call, proposalId, controller.signal);
      const outcome = await this.#executor.executeDetailed({
        call: {
          tool_call_id: scopedCallId,
          name: call.name,
          arguments: call.arguments,
        },
        discoveredTools: session.discoveredTools,
        applicationContext: session.applicationContext,
        signal: controller.signal,
        ...(approval === undefined || session.approval === undefined
          ? {}
          : { approval: {
              ...approval,
              conversationId: session.approval.conversationId,
              turnId: session.approval.turnId,
            } }),
      });
      if (outcome.status === "completed") {
        return completedOutcome(call, outcome.result.content, outcome.result.is_error);
      }
      return this.#approvalRequired(
        session,
        call,
        proposalId,
        fingerprint,
        controller.signal,
      );
    } catch {
      return completedErrorOutcome(call, "Tool approval or execution is temporarily unavailable.");
    } finally {
      callerSignal.removeEventListener("abort", abort);
      session.controller.signal.removeEventListener("abort", abort);
    }
  }

  async #resolveApproval(
    session: SessionRecord<TContext, TPermissionContext>,
    call: RealtimeVoiceServerToolCall,
    proposalId: ConversationApprovalProposalId,
    signal: AbortSignal,
  ): Promise<ApprovalExecutionResume<TPermissionContext> | undefined> {
    if (session.approval === undefined || this.#approvalWorkflow === undefined) {
      return undefined;
    }
    try {
      const approval = await this.#approvalWorkflow.resolveExecution({
        permissionContext: session.approval.permissionContext,
        sessionId: session.sessionId,
        callId: call.call_id,
        name: call.name,
        proposalId,
        signal,
      });
      if (approval?.proposalId !== proposalId) return undefined;
      const proposal = await this.#approvalWorkflow.proposalStore.get({
        permissionContext: session.approval.permissionContext, proposalId,
      });
      if (proposal === null || proposal.turn_id !== session.approval.turnId || proposal.tool_name !== call.name) {
        throw new RealtimeVoiceToolBridgeError("unavailable");
      }
      await recordProposalEvent(this.#approvalWorkflow.eventStore, session.approval.conversationId,
        proposal, await scopedIdentity("call", call.session_id, call.call_id) as ConversationToolCallId);
      return approval;
    } catch {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
  }

  async #approvalRequired(
    session: SessionRecord<TContext, TPermissionContext>,
    call: RealtimeVoiceServerToolCall,
    proposalId: ConversationApprovalProposalId,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<RealtimeVoiceServerToolOutcome> {
    const approval = session.approval;
    const workflow = this.#approvalWorkflow;
    if (approval === undefined || workflow === undefined || signal.aborted) {
      return completedErrorOutcome(
        call,
        signal.aborted
          ? "Tool execution was cancelled."
          : "Tool approval is unavailable.",
      );
    }
    const definition = session.discoveredTools.find((item) => item.name === call.name);
    if (definition === undefined) {
      return completedErrorOutcome(call, "Tool is unavailable for this call.");
    }
    const reviewInput: RealtimeVoiceToolApprovalReviewInput<TPermissionContext> = {
      permissionContext: approval.permissionContext,
      sessionId: session.sessionId,
      callId: call.call_id,
      name: call.name,
      arguments: call.arguments,
      definition,
      signal,
    };
    try {
      const reviewedArguments = await workflow.reviewArguments(reviewInput);
      const scopedCallId = await scopedIdentity("call", call.session_id, call.call_id);
      const created = await workflow.proposalStore.create({
        permissionContext: approval.permissionContext,
        proposalId,
        turnId: approval.turnId,
        toolCallId: scopedCallId as ConversationToolCallId,
        toolName: call.name,
        reviewedArguments,
        expiresAt: null,
        attribution: approval.attribution,
        idempotencyKey: `realtime-proposal:${fingerprint}`,
        idempotencyFingerprint: `realtime-proposal:${fingerprint}`,
      });
      // Idempotent creation may return the original pending snapshot after a
      // later decision. Publish only the current durable proposal state.
      const proposal = await workflow.proposalStore.get({
        permissionContext: approval.permissionContext, proposalId: created.proposal_id,
      });
      if (proposal === null || proposal.status !== "pending") {
        throw new RealtimeVoiceToolBridgeError("unavailable");
      }
      await recordProposalEvent(
        workflow.eventStore,
        approval.conversationId,
        proposal,
        scopedCallId as ConversationToolCallId,
      );
      return Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: call.session_id,
        call_id: call.call_id,
        status: "approval_required" as const,
        name: call.name,
        proposal_id: proposal.proposal_id,
      });
    } catch {
      return completedErrorOutcome(call, "Tool approval is temporarily unavailable.");
    }
  }

  #rememberTerminal(sessionId: RealtimeVoiceSessionId): void {
    this.#terminalSessions.add(sessionId);
    while (this.#terminalSessions.size > this.#maximumTrackedSessions) {
      const oldest = this.#terminalSessions.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalSessions.delete(oldest);
    }
  }
}

export interface RegisteredRealtimeVoiceServerToolBridge<
  TContext,
  TDiscoveryContext,
  TPermissionContext,
> extends RealtimeVoiceServerToolBridge {
  registerSession(
    registration: RealtimeVoiceToolSessionRegistration<
      TContext,
      TDiscoveryContext,
      TPermissionContext
    >,
  ): RealtimeVoiceToolSessionDescriptor;
}

export function createRealtimeVoiceServerToolBridge<
  TContext = unknown,
  TDiscoveryContext = unknown,
  TPermissionContext = unknown,
>(
  options: CreateRealtimeVoiceServerToolBridgeOptions<
    TContext,
    TDiscoveryContext,
    TPermissionContext
  >,
): RegisteredRealtimeVoiceServerToolBridge<
  TContext,
  TDiscoveryContext,
  TPermissionContext
> {
  return new RealtimeVoiceServerToolBridgeImpl(options);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) fail(path, "must be a plain JSON object");
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable data field");
    }
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    fail(path, `must contain 1-${maximum} characters`);
  }
  if ([...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  })) fail(path, "must not contain control characters");
  return value;
}

function boundedIdentifier<T extends string>(value: unknown, path: string): T {
  const parsed = boundedString(value, path, REALTIME_VOICE_LIMITS.identifierLength);
  if (!IDENTIFIER.test(parsed)) fail(path, "must be a bounded opaque identifier");
  return parsed as T;
}

function cloneArguments(value: unknown, path: string): JsonObject {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, currentPath: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > REALTIME_VOICE_TOOL_LIMITS.argumentNodes) {
      fail(currentPath, "exceeds the argument node limit");
    }
    if (depth > REALTIME_VOICE_TOOL_LIMITS.argumentDepth) {
      fail(currentPath, "exceeds the argument depth limit");
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(currentPath, "must be a finite JSON number");
      return current;
    }
    if (typeof current === "string") {
      if (current.length > REALTIME_VOICE_TOOL_LIMITS.argumentStringLength) {
        fail(currentPath, "exceeds the argument string limit");
      }
      return current;
    }
    if (typeof current !== "object" || ancestors.has(current)) {
      fail(currentPath, "must be acyclic JSON data");
    }
    ancestors.add(current);
    let clone: JsonValue;
    if (Array.isArray(current)) {
      if (current.length > REALTIME_VOICE_TOOL_LIMITS.argumentArrayLength) {
        fail(currentPath, "exceeds the argument array limit");
      }
      const keys = Reflect.ownKeys(current);
      if (keys.some((key) => typeof key !== "string" ||
        (key !== "length" && !isArrayIndex(key, current.length)))) {
        fail(currentPath, "must contain only dense JSON array values");
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) fail(currentPath, "must be a dense JSON array");
      }
      clone = current.map((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1));
    } else {
      const source = plainRecord(current, currentPath);
      const keys = Object.keys(source);
      if (keys.length > REALTIME_VOICE_TOOL_LIMITS.argumentObjectKeys) {
        fail(currentPath, "exceeds the argument object-key limit");
      }
      const objectClone: JsonObject = {};
      for (const key of keys) {
        boundedString(key, `${currentPath} key`, REALTIME_VOICE_TOOL_LIMITS.argumentKeyLength);
        Object.defineProperty(objectClone, key, {
          enumerable: true,
          configurable: false,
          writable: false,
          value: visit(source[key], `${currentPath}.${key}`, depth + 1),
        });
      }
      clone = objectClone;
    }
    ancestors.delete(current);
    return deepFreezeJson(clone);
  };
  const clone = visit(value, path, 0);
  if (clone === null || typeof clone !== "object" || Array.isArray(clone)) {
    fail(path, "must be a JSON object");
  }
  if (UTF8_ENCODER.encode(JSON.stringify(clone)).byteLength >
    REALTIME_VOICE_TOOL_LIMITS.argumentBytes) {
    fail(path, "exceeds the serialized argument byte limit");
  }
  return clone;
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    if (Array.isArray(value)) value.forEach(deepFreezeJson);
    else Object.values(value).forEach(deepFreezeJson);
    Object.freeze(value);
  }
  return value;
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

async function envelopeFingerprint(call: RealtimeVoiceServerToolCall): Promise<string> {
  return sha256([
    call.version,
    call.session_id,
    call.capability_ref,
    call.call_id,
    call.idempotency_key,
    call.name,
    canonicalJson(call.arguments),
  ].join("\u001f"));
}

async function scopedIdentity(
  prefix: string,
  sessionId: RealtimeVoiceSessionId,
  callId: RealtimeVoiceServerToolCallId,
): Promise<string> {
  return `${prefix}-realtime-${(await sha256(`${sessionId}\u001f${callId}`)).slice(0, 48)}`;
}

async function proposalIdentity(fingerprint: string): Promise<ConversationApprovalProposalId> {
  return `proposal-realtime-${fingerprint.slice(0, 48)}` as ConversationApprovalProposalId;
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new RealtimeVoiceToolBridgeError("unavailable");
  const digest = await subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function recordProposalEvent(
  eventStore: ConversationEventStore,
  conversationId: ConversationId,
  proposal: Awaited<ReturnType<ApprovalProposalStore<unknown>["create"]>>,
  toolCallId: ConversationToolCallId,
): Promise<void> {
  if (proposal.tool_call_id !== toolCallId) throw new RealtimeVoiceToolBridgeError("unavailable");
  for (let attempt = 0; attempt < REALTIME_VOICE_TOOL_LIMITS.approvalEventAppendAttempts; attempt += 1) {
    let reads = 0;
    const boundedStore: ConversationEventStore = {
      getLatestRevision: (id) => eventStore.getLatestRevision(id),
      append: (input) => eventStore.append(input),
      read: (input) => {
        if (++reads > REALTIME_VOICE_TOOL_LIMITS.approvalEventReadPages) {
          throw new RealtimeVoiceToolBridgeError("unavailable");
        }
        return eventStore.read({ ...input, limit: REALTIME_VOICE_TOOL_LIMITS.approvalEventReadPageSize });
      },
      ...(eventStore.checkpoints ? { checkpoints: eventStore.checkpoints } : {}),
    };
    const replay = await replayConversation({ conversationId, eventStore: boundedStore, checkpointPolicy: false });
    const visible = replay.state.approval_proposals.find((item) => item.proposal_id === proposal.proposal_id);
    const tool = replay.state.tool_calls.find((item) => item.tool_call_id === toolCallId);
    const turn = replay.state.turns.find((item) => item.turn_id === proposal.turn_id);
    const terminalTurn = turn !== undefined && ["completed", "cancelled", "failed"].includes(turn.status);
    if (terminalTurn && proposal.status !== "executed" && proposal.status !== "failed") {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
    if (tool && (tool.turn_id !== proposal.turn_id || (tool.name !== null && tool.name !== proposal.tool_name))) {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
    if (visible) {
      if (visible.tool_call_id !== toolCallId || visible.turn_id !== proposal.turn_id || visible.tool_name !== proposal.tool_name) {
        throw new RealtimeVoiceToolBridgeError("unavailable");
      }
      return;
    }
    if (terminalTurn) throw new RealtimeVoiceToolBridgeError("unavailable");
    // Read retained evidence even if replay used a checkpoint that omitted an
    // orphaned approval. Missing lifecycle evidence must never be invented.
    const history = await readProposalEvents(eventStore, conversationId, proposal.proposal_id);
    const original = history.find((event) => event.payload.type === "approval.proposal_created");
    const attribution = proposal.created_attribution;
    const created = original ?? parseConversationEvent({
      version: CONVERSATION_EVENT_VERSION, event_id: `approval-created:${proposal.proposal_id}`,
      conversation_id: conversationId, revision: 1, occurred_at: proposal.created_at,
      actor: attribution.actor, source: attribution.source,
      payload: { type: "approval.proposal_created", proposal_id: proposal.proposal_id,
        ...(proposal.group_id === null ? {} : { group_id: proposal.group_id }),
        turn_id: proposal.turn_id, tool_call_id: toolCallId, tool_name: proposal.tool_name,
        status: "pending", proposal_version: 1, expires_at: proposal.expires_at,
        reviewed_arguments: proposal.reviewed_arguments },
    });
    if (created.payload.type !== "approval.proposal_created" || created.payload.tool_call_id !== toolCallId ||
      created.payload.turn_id !== proposal.turn_id || created.payload.tool_name !== proposal.tool_name ||
      canonicalJson(created.payload.reviewed_arguments as unknown as JsonValue) !==
        canonicalJson(proposal.reviewed_arguments as unknown as JsonValue)) {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
    const lifecycle = original ? history : [created];
    const versions = lifecycle.map((event) => event.payload.type === "approval.proposal_created" ||
      event.payload.type === "approval.proposal_status_changed" ? event.payload.proposal_version : 0);
    if (versions.some((version, index) => version !== index + 1) || versions.at(-1) !== proposal.proposal_version) {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
    const last = lifecycle.at(-1)!;
    if (!("status" in last.payload) || last.payload.status !== proposal.status) {
      throw new RealtimeVoiceToolBridgeError("unavailable");
    }
    let revision = Number(replay.lastRevision ?? 0);
    const events: ConversationEvent[] = [];
    if (!tool || tool.name === null) {
      // This is the host-approved display snapshot, never the raw provider args.
      // Reference-only or non-object reviews expose no inline argument fields.
      const reviewed = proposal.reviewed_arguments;
      const arguments_ = reviewed.type === "redacted_json" && reviewed.value !== null &&
        typeof reviewed.value === "object" && !Array.isArray(reviewed.value) ? reviewed.value : {};
      events.push(parseConversationEvent({ version: CONVERSATION_EVENT_VERSION,
        event_id: `realtime-approval-tool:${proposal.proposal_id}`, conversation_id: conversationId,
        revision: ++revision, occurred_at: created.occurred_at, actor: created.actor, source: created.source,
        payload: { type: "tool_call.requested", turn_id: proposal.turn_id, tool_call_id: toolCallId,
          name: proposal.tool_name, arguments: arguments_ },
      }));
    }
    for (const event of lifecycle) {
      // A repair is a projection of existing evidence, not another client
      // decision. Keep the original immutable event as its audit reference.
      const { mutation_id: originalMutation, ...evidence } = event;
      void originalMutation;
      events.push(parseConversationEvent({ ...(original ? evidence : event), revision: ++revision,
        event_id: original ? `realtime-approval-repair:${(await sha256(event.event_id)).slice(0, 48)}` : event.event_id,
        ...(original ? { metadata: { repair_of_event_id: event.event_id } } : {}),
      }));
    }
    try {
      await eventStore.append({ conversationId, expectedRevision: replay.lastRevision, events });
      return;
    } catch (error) {
      if (!(error instanceof ConversationEventStoreConflictError) || error.code !== "revision_conflict") throw error;
    }
  }
  throw new RealtimeVoiceToolBridgeError("unavailable");
}

async function readProposalEvents(
  eventStore: ConversationEventStore,
  conversationId: ConversationId,
  proposalId: ConversationApprovalProposalId,
): Promise<ConversationEvent[]> {
  let after: Parameters<ConversationEventStore["read"]>[0]["after"];
  const events: ConversationEvent[] = [];
  for (let page = 0; page < REALTIME_VOICE_TOOL_LIMITS.approvalEventReadPages; page += 1) {
    const result = await eventStore.read({ conversationId,
      ...(after === undefined ? {} : { after }), limit: REALTIME_VOICE_TOOL_LIMITS.approvalEventReadPageSize });
    events.push(...result.entries.map(({ event }) => event).filter((event) =>
      (event.payload.type === "approval.proposal_created" || event.payload.type === "approval.proposal_status_changed") &&
      event.payload.proposal_id === proposalId));
    if (!result.hasMore) return originalApprovalEvidence(events);
    if (result.nextCursor === null) throw new RealtimeVoiceToolBridgeError("unavailable");
    after = { cursor: result.nextCursor };
  }
  throw new RealtimeVoiceToolBridgeError("unavailable");
}

function completedOutcome(
  call: RealtimeVoiceServerToolCall,
  content: readonly ToolResultContentPart[],
  isError: boolean,
): RealtimeVoiceServerToolOutcome {
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: call.session_id,
    call_id: call.call_id,
    status: "completed" as const,
    result: Object.freeze({
      name: call.name,
      content: Object.freeze([...content]),
      is_error: isError,
    }),
  });
}

function completedErrorOutcome(
  call: RealtimeVoiceServerToolCall,
  message: string,
): RealtimeVoiceServerToolOutcome {
  return completedOutcome(
    call,
    Object.freeze([Object.freeze({ type: "text" as const, text: message })]),
    true,
  );
}

function failedOutcome(
  call: RealtimeVoiceServerToolCall,
  code: Parameters<typeof realtimeVoiceSafeError>[0],
): RealtimeVoiceServerToolOutcome {
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: call.session_id,
    call_id: call.call_id,
    status: "failed" as const,
    error: realtimeVoiceSafeError(code),
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function fail(path: string, message: string): never {
  throw new RealtimeVoiceValidationError(path, message);
}
