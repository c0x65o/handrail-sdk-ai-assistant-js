import {
  ApprovalProposalStoreError,
  type ApprovalProposalStore,
} from "../conversation/approval-proposal-store.js";
import {
  ConversationEventStoreConflictError,
  type ConversationEventStore,
} from "../conversation/event-store.js";
import {
  CONVERSATION_EVENT_LIMITS,
  CONVERSATION_EVENT_VERSION,
  type ConversationApprovalArgumentReference,
  type ConversationApprovalProposalId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationRevision,
  type ConversationToolCallId,
  type ConversationTurnId,
} from "../conversation/events.js";
import type {
  ConversationApprovalProposalRecord,
  ConversationEventAttribution,
  ConversationStateApprovalReviewedArguments,
} from "../conversation/state.js";
import type { JsonObject, ToolDefinition } from "../protocol.js";
import { originalApprovalEvidence } from "../conversation/approval-evidence.js";

export const APPROVAL_EXECUTION_COORDINATOR_LIMITS = Object.freeze({
  eventAppendAttempts: 4,
  reconciliationPageSize: 100,
  reconciliationPages: 50,
} as const);

export interface ApprovalExecutionCoordinatorLimits {
  readonly maxEventAppendAttempts: number;
  readonly reconciliationPageSize: number;
  readonly maxReconciliationPages: number;
}

export type ApprovalExecutionArgumentBinding =
  | {
      readonly type: "reviewed_arguments_digest";
      /** Opaque host-generated digest; the SDK never derives it from sensitive arguments. */
      readonly digest: string;
    }
  | {
      readonly type: "opaque_reference";
      readonly argumentReference: ConversationApprovalArgumentReference;
    };

export interface ApprovalExecutionResume<TPermissionContext = unknown> {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  /** The exact confirmed proposal version authorized by the reviewer. */
  readonly expectedProposalVersion: number;
  /** Stable host-generated identity for this execution across retries and restarts. */
  readonly executionId: string;
  readonly argumentBinding: ApprovalExecutionArgumentBinding;
  /** Host system attribution for executing/executed/failed audit records. */
  readonly attribution: ConversationEventAttribution;
}

export interface ApprovalExecutionPermissionRequest<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly proposalId: ConversationApprovalProposalId;
  readonly expectedProposalVersion: number;
  readonly executionId: string;
  readonly turnId: ConversationTurnId;
  readonly toolCallId: ConversationToolCallId;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

export type ApprovalExecutionPermissionCheck<TPermissionContext> = (
  request: ApprovalExecutionPermissionRequest<TPermissionContext>,
) => "allow" | "deny" | Promise<"allow" | "deny">;

export interface ApprovalExecutionArgumentVerificationRequest<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  readonly binding: ApprovalExecutionArgumentBinding;
  readonly reviewedArguments: ConversationStateApprovalReviewedArguments;
  readonly arguments: JsonObject;
  /** Current registration already proven present in this call's discovery result. */
  readonly definition: ToolDefinition;
  readonly signal: AbortSignal;
}

/**
 * Trusted host boundary for binding the current sensitive arguments to the
 * digest/reference that a human reviewed. Callers must not log either input.
 */
export type ApprovalExecutionArgumentVerifier<TPermissionContext> = (
  request: ApprovalExecutionArgumentVerificationRequest<TPermissionContext>,
) => "match" | "mismatch" | Promise<"match" | "mismatch">;

export interface ApprovalExecutionClaimRequest<TPermissionContext>
  extends ApprovalExecutionResume<TPermissionContext> {
  readonly conversationId: ConversationId;
  readonly turnId: ConversationTurnId;
  readonly toolCallId: ConversationToolCallId;
  readonly toolName: string;
  readonly arguments: JsonObject;
  readonly definition: ToolDefinition;
  readonly signal: AbortSignal;
}

export interface ClaimedApprovalExecution {
  readonly outcome: "claimed";
  readonly proposalId: ConversationApprovalProposalId;
  readonly executingVersion: number;
  readonly executionId: string;
}

export type ApprovalExecutionClaimResult =
  | ClaimedApprovalExecution
  | {
      readonly outcome: "reuse";
      readonly proposalId: ConversationApprovalProposalId;
      readonly status: "executing" | "executed" | "failed";
      readonly proposalVersion: number;
    }
  | {
      readonly outcome: "approval_required" | "invalid" | "forbidden" | "cancelled" | "unavailable";
      readonly proposalId: ConversationApprovalProposalId;
    };

export type ApprovalExecutionFailureReason =
  | "execution_cancelled"
  | "execution_timed_out"
  | "execution_recording_failed"
  | "invalid_tool_output"
  | "tool_execution_failed";

export interface SettleApprovalExecutionRequest<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly proposalId: ConversationApprovalProposalId;
  readonly executingVersion: number;
  readonly executionId: string;
  readonly attribution: ConversationEventAttribution;
  readonly status: "executed" | "failed";
  readonly failureReason?: ApprovalExecutionFailureReason;
  readonly signal: AbortSignal;
}

export type ApprovalExecutionSettlementResult =
  | { readonly outcome: "recorded"; readonly proposalVersion: number }
  | { readonly outcome: "cancelled" | "invalid" | "forbidden" | "unavailable" };

/** Host-supplied boundary consumed by BoundedToolExecutor. */
export interface ApprovalExecutionCoordinator<TPermissionContext = unknown> {
  claim(
    request: ApprovalExecutionClaimRequest<TPermissionContext>,
  ): Promise<ApprovalExecutionClaimResult>;
  settle(
    request: SettleApprovalExecutionRequest<TPermissionContext>,
  ): Promise<ApprovalExecutionSettlementResult>;
}

export interface CreateApprovalExecutionCoordinatorOptions<TPermissionContext> {
  readonly proposalStore: ApprovalProposalStore<TPermissionContext>;
  readonly eventStore: ConversationEventStore;
  readonly authorize: ApprovalExecutionPermissionCheck<TPermissionContext>;
  readonly verifyArguments: ApprovalExecutionArgumentVerifier<TPermissionContext>;
  readonly limits?: Partial<ApprovalExecutionCoordinatorLimits>;
}

interface DurableProposalAudit {
  readonly created: ConversationEvent;
  readonly confirmed: ConversationEvent | null;
  readonly executing: ConversationEvent | null;
  readonly terminal: ConversationEvent | null;
}

const FAILURE_REASONS = new Set<ApprovalExecutionFailureReason>([
  "execution_cancelled",
  "execution_timed_out",
  "execution_recording_failed",
  "invalid_tool_output",
  "tool_execution_failed",
]);

/**
 * Reference coordinator backed by the existing proposal and conversation event
 * stores. It only claims exact confirmed proposals and never executes tools.
 */
export function createApprovalExecutionCoordinator<TPermissionContext>(
  options: CreateApprovalExecutionCoordinatorOptions<TPermissionContext>,
): ApprovalExecutionCoordinator<TPermissionContext> {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.authorize !== "function" ||
    typeof options.verifyArguments !== "function" ||
    options.proposalStore === null ||
    typeof options.proposalStore !== "object" ||
    options.eventStore === null ||
    typeof options.eventStore !== "object"
  ) {
    throw new TypeError("Approval execution coordinator options are invalid.");
  }
  const limits = resolvedLimits(options.limits);

  return Object.freeze({
    async claim(
      input: ApprovalExecutionClaimRequest<TPermissionContext>,
    ): Promise<ApprovalExecutionClaimResult> {
      const proposalId = safeProposalId(input?.proposalId);
      if (!validClaimInput(input)) return frozen({ outcome: "invalid", proposalId });
      if (input.signal.aborted) return frozen({ outcome: "cancelled", proposalId });
      if (!await authorized(options.authorize, input)) {
        return frozen({
          outcome: input.signal.aborted ? "cancelled" : "forbidden",
          proposalId,
        });
      }

      let proposal: ConversationApprovalProposalRecord | null;
      try {
        proposal = await options.proposalStore.get({
          permissionContext: input.permissionContext,
          proposalId,
        });
      } catch (error) {
        return frozen({
          outcome: error instanceof ApprovalProposalStoreError &&
              error.code === "permission_denied"
            ? "forbidden"
            : "unavailable",
          proposalId,
        });
      }
      if (input.signal.aborted) return frozen({ outcome: "cancelled", proposalId });
      if (proposal === null) return frozen({ outcome: "invalid", proposalId });

      const audit = await readProposalAudit(
        options.eventStore,
        input.conversationId,
        proposalId,
        input.executionId,
        limits,
      );
      if (audit === null || !matchesProposalIdentity(proposal, audit.created, input)) {
        return frozen({ outcome: "invalid", proposalId });
      }
      if (!hasExactConfirmation(proposal, audit, input.expectedProposalVersion)) {
        return frozen({
          outcome: proposal.status === "pending" ? "approval_required" : "invalid",
          proposalId,
        });
      }
      if (!await argumentsMatch(options.verifyArguments, input, proposal.reviewed_arguments)) {
        return frozen({
          outcome: input.signal.aborted ? "cancelled" : "invalid",
          proposalId,
        });
      }
      if (input.signal.aborted) return frozen({ outcome: "cancelled", proposalId });

      if (proposal.status !== "confirmed") {
        const repaired = await repairMissingLifecycleAudit(
          options.proposalStore,
          options.eventStore,
          input,
          proposal,
          audit,
          limits,
        );
        if (repaired !== null) return repaired;
        const expectedStatus = proposal.status === "executing" ||
            proposal.status === "executed" || proposal.status === "failed"
          ? proposal.status
          : null;
        if (
          expectedStatus === null ||
          !matchesExistingExecution(proposal, audit, input.expectedProposalVersion)
        ) {
          return frozen({ outcome: "invalid", proposalId });
        }
        return frozen({
          outcome: "reuse",
          proposalId,
          status: expectedStatus,
          proposalVersion: proposal.proposal_version,
        });
      }

      let executing: ConversationApprovalProposalRecord;
      try {
        executing = await options.proposalStore.transition({
          permissionContext: input.permissionContext,
          proposalId,
          expectedVersion: input.expectedProposalVersion,
          status: "executing",
          attribution: input.attribution,
          idempotencyKey: transitionKey(input.executionId, "executing"),
          idempotencyFingerprint: transitionKey(input.executionId, "executing"),
        });
      } catch (error) {
        return mapStoreFailure(error, proposalId);
      }
      const appended = await appendLifecycleEvent(
        options.eventStore,
        input.conversationId,
        executing,
        input.executionId,
        limits,
      );
      if (!appended) return frozen({ outcome: "unavailable", proposalId });
      return frozen({
        outcome: "claimed",
        proposalId,
        executingVersion: executing.proposal_version,
        executionId: input.executionId,
      });
    },

    async settle(
      input: SettleApprovalExecutionRequest<TPermissionContext>,
    ): Promise<ApprovalExecutionSettlementResult> {
      if (!validSettlementInput(input)) return frozen({ outcome: "invalid" });
      // A claimed execution must be allowed to record its terminal audit fact even
      // when the caller aborts after the side effect has started.
      let transitioned: ConversationApprovalProposalRecord;
      try {
        transitioned = await options.proposalStore.transition({
          permissionContext: input.permissionContext,
          proposalId: input.proposalId,
          expectedVersion: input.executingVersion,
          status: input.status,
          attribution: input.attribution,
          idempotencyKey: transitionKey(input.executionId, input.status),
          idempotencyFingerprint: transitionKey(input.executionId, input.status),
          ...(input.status === "failed"
            ? { failureReason: input.failureReason! }
            : {}),
        });
      } catch (error) {
        if (
          error instanceof ApprovalProposalStoreError &&
          error.code === "permission_denied"
        ) return frozen({ outcome: "forbidden" });
        return frozen({ outcome: "unavailable" });
      }
      const appended = await appendLifecycleEvent(
        options.eventStore,
        input.conversationId,
        transitioned,
        input.executionId,
        limits,
      );
      return appended
        ? frozen({ outcome: "recorded", proposalVersion: transitioned.proposal_version })
        : frozen({ outcome: "unavailable" });
    },
  });
}

async function authorized<TPermissionContext>(
  check: ApprovalExecutionPermissionCheck<TPermissionContext>,
  input: ApprovalExecutionClaimRequest<TPermissionContext>,
): Promise<boolean> {
  try {
    return await raceWithAbort(Promise.resolve(check({
      permissionContext: input.permissionContext,
      conversationId: input.conversationId,
      proposalId: input.proposalId,
      expectedProposalVersion: input.expectedProposalVersion,
      executionId: input.executionId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      signal: input.signal,
    })), input.signal) === "allow";
  } catch {
    return false;
  }
}

async function argumentsMatch<TPermissionContext>(
  verify: ApprovalExecutionArgumentVerifier<TPermissionContext>,
  input: ApprovalExecutionClaimRequest<TPermissionContext>,
  reviewedArguments: ConversationStateApprovalReviewedArguments,
): Promise<boolean> {
  if (
    input.argumentBinding.type === "opaque_reference" &&
    (reviewedArguments.type !== "opaque_reference" ||
      reviewedArguments.argument_ref !== input.argumentBinding.argumentReference)
  ) return false;
  if (
    input.argumentBinding.type === "reviewed_arguments_digest" &&
    reviewedArguments.type !== "redacted_json"
  ) return false;
  try {
    return await raceWithAbort(Promise.resolve(verify({
      permissionContext: input.permissionContext,
      proposalId: input.proposalId,
      binding: input.argumentBinding,
      reviewedArguments,
      arguments: input.arguments,
      definition: input.definition,
      signal: input.signal,
    })), input.signal) === "match";
  } catch {
    return false;
  }
}

async function repairMissingLifecycleAudit<TPermissionContext>(
  proposalStore: ApprovalProposalStore<TPermissionContext>,
  eventStore: ConversationEventStore,
  input: ApprovalExecutionClaimRequest<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
  audit: DurableProposalAudit,
  limits: ApprovalExecutionCoordinatorLimits,
): Promise<ApprovalExecutionClaimResult | null> {
  const missingExecuting = proposal.status === "executing" && audit.executing === null;
  const missingTerminal = (proposal.status === "executed" || proposal.status === "failed") &&
    audit.terminal === null;
  if (!missingExecuting && !missingTerminal) return null;
  const status = missingExecuting ? "executing" : proposal.status as "executed" | "failed";
  try {
    const replayed = await proposalStore.transition({
      permissionContext: input.permissionContext,
      proposalId: input.proposalId,
      expectedVersion: status === "executing"
        ? input.expectedProposalVersion
        : input.expectedProposalVersion + 1,
      status,
      attribution: input.attribution,
      idempotencyKey: transitionKey(input.executionId, status),
      idempotencyFingerprint: transitionKey(input.executionId, status),
      ...(status === "failed" ? { failureReason: proposal.failure_reason! } : {}),
    });
    if (!await appendLifecycleEvent(
      eventStore,
      input.conversationId,
      replayed,
      input.executionId,
      limits,
    )) return frozen({ outcome: "unavailable", proposalId: input.proposalId });
    return status === "executing"
      ? frozen({
          outcome: "claimed",
          proposalId: input.proposalId,
          executingVersion: replayed.proposal_version,
          executionId: input.executionId,
        })
      : frozen({
          outcome: "reuse",
          proposalId: input.proposalId,
          status,
          proposalVersion: replayed.proposal_version,
        });
  } catch (error) {
    return mapStoreFailure(error, input.proposalId);
  }
}

async function readProposalAudit(
  store: ConversationEventStore,
  conversationId: ConversationId,
  proposalId: ConversationApprovalProposalId,
  executionId: string,
  limits: ApprovalExecutionCoordinatorLimits,
): Promise<DurableProposalAudit | null> {
  let cursor: Awaited<ReturnType<ConversationEventStore["read"]>>["nextCursor"] = null;
  let matching: ConversationEvent[] = [];
  try {
    for (let page = 0; page < limits.maxReconciliationPages; page += 1) {
      const read = await store.read({
        conversationId,
        ...(cursor === null ? {} : { after: { cursor } }),
        limit: limits.reconciliationPageSize,
      });
      matching.push(...read.entries.map(({ event }) => event).filter((event) =>
        (event.payload.type === "approval.proposal_created" ||
          event.payload.type === "approval.proposal_status_changed") &&
        event.payload.proposal_id === proposalId));
      if (!read.hasMore) break;
      cursor = read.nextCursor;
      if (cursor === null) return null;
      if (page === limits.maxReconciliationPages - 1) return null;
    }
    matching = originalApprovalEvidence(matching);
  } catch {
    return null;
  }
  const created = matching.filter(({ payload }) =>
    payload.type === "approval.proposal_created");
  if (created.length !== 1) return null;
  return {
    created: created[0]!,
    confirmed: matching.find(({ payload }) =>
      payload.type === "approval.proposal_status_changed" &&
      payload.status === "confirmed") ?? null,
    executing: matching.find(({ event_id, payload }) =>
      event_id === lifecycleEventId(executionId, "executing") &&
      payload.type === "approval.proposal_status_changed" &&
      payload.status === "executing") ?? null,
    terminal: matching.find(({ event_id, payload }) =>
      (event_id === lifecycleEventId(executionId, "executed") ||
        event_id === lifecycleEventId(executionId, "failed")) &&
      payload.type === "approval.proposal_status_changed" &&
      (payload.status === "executed" || payload.status === "failed")) ?? null,
  };
}

function matchesProposalIdentity<TPermissionContext>(
  proposal: ConversationApprovalProposalRecord,
  created: ConversationEvent,
  input: ApprovalExecutionClaimRequest<TPermissionContext>,
): boolean {
  if (created.payload.type !== "approval.proposal_created") return false;
  const payload = created.payload;
  return created.conversation_id === input.conversationId &&
    proposal.proposal_id === input.proposalId &&
    proposal.turn_id === input.turnId &&
    proposal.tool_call_id === input.toolCallId &&
    proposal.tool_name === input.toolName &&
    proposal.tool_name === input.definition.name &&
    payload.proposal_id === proposal.proposal_id &&
    payload.turn_id === proposal.turn_id &&
    payload.tool_call_id === proposal.tool_call_id &&
    payload.tool_name === proposal.tool_name &&
    payload.proposal_version === 1 &&
    payload.expires_at === proposal.expires_at &&
    JSON.stringify(payload.reviewed_arguments) === JSON.stringify(proposal.reviewed_arguments);
}

function hasExactConfirmation(
  proposal: ConversationApprovalProposalRecord,
  audit: DurableProposalAudit,
  expectedVersion: number,
): boolean {
  if (proposal.status === "pending" || proposal.status === "rejected" || proposal.status === "expired") {
    return false;
  }
  const payload = audit.confirmed?.payload;
  return payload?.type === "approval.proposal_status_changed" &&
    payload.status === "confirmed" &&
    payload.proposal_version === expectedVersion &&
    expectedVersion >= 2;
}

function matchesExistingExecution(
  proposal: ConversationApprovalProposalRecord,
  audit: DurableProposalAudit,
  confirmedVersion: number,
): boolean {
  const executing = audit.executing?.payload;
  if (
    executing?.type !== "approval.proposal_status_changed" ||
    executing.status !== "executing" ||
    executing.proposal_version !== confirmedVersion + 1
  ) return false;
  if (proposal.status === "executing") {
    return proposal.proposal_version === confirmedVersion + 1;
  }
  const terminal = audit.terminal?.payload;
  return terminal?.type === "approval.proposal_status_changed" &&
    terminal.status === proposal.status &&
    terminal.proposal_version === confirmedVersion + 2 &&
    proposal.proposal_version === confirmedVersion + 2;
}

async function appendLifecycleEvent(
  store: ConversationEventStore,
  conversationId: ConversationId,
  proposal: ConversationApprovalProposalRecord,
  executionId: string,
  limits: ApprovalExecutionCoordinatorLimits,
): Promise<boolean> {
  const status = proposal.status;
  if (status !== "executing" && status !== "executed" && status !== "failed") return false;
  const eventId = lifecycleEventId(executionId, status);
  for (let attempt = 0; attempt < limits.maxEventAppendAttempts; attempt += 1) {
    try {
      const latest = await store.getLatestRevision(conversationId);
      const event = lifecycleEvent(proposal, conversationId, eventId, nextRevision(latest));
      await store.append({ conversationId, expectedRevision: latest, events: [event] });
      return true;
    } catch (error) {
      if (
        error instanceof ConversationEventStoreConflictError &&
        error.code === "revision_conflict"
      ) continue;
      if (
        error instanceof ConversationEventStoreConflictError &&
        error.code === "idempotency_conflict"
      ) return eventExists(store, conversationId, eventId, proposal, limits);
      return false;
    }
  }
  return false;
}

async function eventExists(
  store: ConversationEventStore,
  conversationId: ConversationId,
  eventId: ConversationEventId,
  proposal: ConversationApprovalProposalRecord,
  limits: ApprovalExecutionCoordinatorLimits,
): Promise<boolean> {
  let cursor: Awaited<ReturnType<ConversationEventStore["read"]>>["nextCursor"] = null;
  try {
    for (let page = 0; page < limits.maxReconciliationPages; page += 1) {
      const read = await store.read({
        conversationId,
        ...(cursor === null ? {} : { after: { cursor } }),
        limit: limits.reconciliationPageSize,
      });
      const found = read.entries.find(({ event }) => event.event_id === eventId)?.event;
      if (found !== undefined) {
        return JSON.stringify(found.payload) ===
          JSON.stringify(lifecycleEvent(proposal, conversationId, eventId, found.revision).payload);
      }
      if (!read.hasMore) return false;
      cursor = read.nextCursor;
      if (cursor === null) return false;
    }
  } catch {
    return false;
  }
  return false;
}

function lifecycleEvent(
  proposal: ConversationApprovalProposalRecord,
  conversationId: ConversationId,
  eventId: ConversationEventId,
  revision: ConversationRevision,
): ConversationEvent {
  const status = proposal.status;
  if (status !== "executing" && status !== "executed" && status !== "failed") {
    throw new TypeError("Approval proposal is not in an execution lifecycle status.");
  }
  const payload: ConversationEvent["payload"] = status === "failed"
    ? {
        type: "approval.proposal_status_changed",
        proposal_id: proposal.proposal_id,
        proposal_version: proposal.proposal_version,
        status: "failed",
        failure_reason: proposal.failure_reason!,
      }
    : {
        type: "approval.proposal_status_changed",
        proposal_id: proposal.proposal_id,
        proposal_version: proposal.proposal_version,
        status,
      };
  return {
    version: CONVERSATION_EVENT_VERSION,
    event_id: eventId,
    conversation_id: conversationId,
    revision,
    occurred_at: proposal.updated_at,
    actor: proposal.latest_attribution.actor,
    source: proposal.latest_attribution.source,
    payload,
  };
}

function mapStoreFailure(
  error: unknown,
  proposalId: ConversationApprovalProposalId,
): ApprovalExecutionClaimResult {
  if (error instanceof ApprovalProposalStoreError) {
    if (error.code === "permission_denied") return frozen({ outcome: "forbidden", proposalId });
    if (["version_conflict", "invalid_transition", "not_found"].includes(error.code)) {
      return frozen({ outcome: "invalid", proposalId });
    }
  }
  return frozen({ outcome: "unavailable", proposalId });
}

function validClaimInput<TPermissionContext>(
  input: ApprovalExecutionClaimRequest<TPermissionContext>,
): boolean {
  return input !== null && typeof input === "object" &&
    validIdentifier(input.conversationId) && validIdentifier(input.proposalId) &&
    validIdentifier(input.turnId) && validIdentifier(input.toolCallId) &&
    validIdentifier(input.toolName) && input.definition?.name === input.toolName &&
    Number.isSafeInteger(input.expectedProposalVersion) && input.expectedProposalVersion > 0 &&
    validExecutionId(input.executionId) && validBinding(input.argumentBinding) &&
    input.attribution?.actor?.type === "system" &&
    input.attribution?.source?.type === "runtime" && isAbortSignal(input.signal);
}

function validSettlementInput<TPermissionContext>(
  input: SettleApprovalExecutionRequest<TPermissionContext>,
): boolean {
  return input !== null && typeof input === "object" &&
    validIdentifier(input.conversationId) && validIdentifier(input.proposalId) &&
    Number.isSafeInteger(input.executingVersion) && input.executingVersion > 0 &&
    validExecutionId(input.executionId) &&
    (input.status === "executed" || input.status === "failed") &&
    (input.status === "failed"
      ? input.failureReason !== undefined && FAILURE_REASONS.has(input.failureReason)
      : input.failureReason === undefined) &&
    input.attribution?.actor?.type === "system" &&
    input.attribution?.source?.type === "runtime" && isAbortSignal(input.signal);
}

function validBinding(value: ApprovalExecutionArgumentBinding): boolean {
  if (value === null || typeof value !== "object") return false;
  return value.type === "reviewed_arguments_digest"
    ? validOpaque(value.digest)
    : value.type === "opaque_reference" && validIdentifier(value.argumentReference);
}

function validExecutionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && validOpaque(value);
}

function validOpaque(value: unknown): value is string {
  return typeof value === "string" && value.length <= 256 &&
    /^[a-z0-9][a-z0-9._:/-]*$/iu.test(value) && !value.includes("://");
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= CONVERSATION_EVENT_LIMITS.identifierLength;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function";
}

function transitionKey(executionId: string, status: "executing" | "executed" | "failed"): string {
  return `approval-execution:${executionId}:${status}`;
}

function lifecycleEventId(
  executionId: string,
  status: "executing" | "executed" | "failed",
): ConversationEventId {
  return transitionKey(executionId, status) as ConversationEventId;
}

function nextRevision(revision: ConversationRevision | null): ConversationRevision {
  return ((revision ?? 0) + 1) as ConversationRevision;
}

function safeProposalId(value: unknown): ConversationApprovalProposalId {
  return (validIdentifier(value) ? value : "invalid-proposal") as ConversationApprovalProposalId;
}

function resolvedLimits(
  overrides: Partial<ApprovalExecutionCoordinatorLimits> | undefined,
): Readonly<ApprovalExecutionCoordinatorLimits> {
  const limits = {
    maxEventAppendAttempts: APPROVAL_EXECUTION_COORDINATOR_LIMITS.eventAppendAttempts,
    reconciliationPageSize: APPROVAL_EXECUTION_COORDINATOR_LIMITS.reconciliationPageSize,
    maxReconciliationPages: APPROVAL_EXECUTION_COORDINATOR_LIMITS.reconciliationPages,
    ...overrides,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`limits.${name} must be a positive safe integer`);
    }
  }
  return Object.freeze(limits);
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
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

function frozen<const T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
