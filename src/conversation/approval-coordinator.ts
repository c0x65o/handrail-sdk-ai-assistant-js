import {
  ApprovalProposalStoreError,
  type ApprovalProposalStore,
} from "./approval-proposal-store.js";
import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  type ConversationEventStore,
} from "./event-store.js";
import {
  CONVERSATION_EVENT_LIMITS,
  CONVERSATION_EVENT_VERSION,
  type ConversationApprovalGroupId,
  type ConversationApprovalProposalId,
  type ConversationApprovalProposalStatus,
  type ConversationApprovalProposalTransitionStatus,
  type ConversationClientMutationId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationRevision,
} from "./events.js";
import type {
  ConversationApprovalProposalRecord,
  ConversationEventAttribution,
} from "./state.js";

export const APPROVAL_COORDINATOR_LIMITS = Object.freeze({
  groupSize: 25,
  eventAppendAttempts: 4,
  reconciliationPageSize: 100,
  reconciliationPages: 50,
} as const);

export interface ApprovalCoordinatorLimits {
  readonly maxGroupSize: number;
  readonly maxEventAppendAttempts: number;
  readonly reconciliationPageSize: number;
  readonly maxReconciliationPages: number;
}

export const DEFAULT_APPROVAL_COORDINATOR_LIMITS: Readonly<ApprovalCoordinatorLimits> =
  Object.freeze({
    maxGroupSize: APPROVAL_COORDINATOR_LIMITS.groupSize,
    maxEventAppendAttempts: APPROVAL_COORDINATOR_LIMITS.eventAppendAttempts,
    reconciliationPageSize: APPROVAL_COORDINATOR_LIMITS.reconciliationPageSize,
    maxReconciliationPages: APPROVAL_COORDINATOR_LIMITS.reconciliationPages,
  });

export type ApprovalDecision = "confirm" | "reject" | "expire";

export interface ApprovalDecisionPermissionRequest<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly proposalId: ConversationApprovalProposalId;
  readonly expectedVersion: number;
  readonly decision: ApprovalDecision;
  readonly groupId?: ConversationApprovalGroupId;
  readonly signal: AbortSignal;
}

/**
 * Host-owned decision policy. The coordinator supplies identifiers and intent,
 * never reviewed arguments, tool inputs, or the persisted proposal record.
 */
export type ApprovalDecisionPermissionCheck<TPermissionContext> = (
  request: ApprovalDecisionPermissionRequest<TPermissionContext>,
) => "allow" | "deny" | Promise<"allow" | "deny">;

export interface ApprovalDecisionTarget {
  readonly proposalId: ConversationApprovalProposalId;
  readonly expectedVersion: number;
  /** Globally stable within the proposal store's idempotency retention window. */
  readonly idempotencyKey: string;
  /** Stable host-generated fingerprint of the complete logical decision. */
  readonly idempotencyFingerprint: string;
}

export interface DecideApprovalInput<TPermissionContext>
  extends ApprovalDecisionTarget {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly decision: ApprovalDecision;
  readonly attribution: ConversationEventAttribution;
  readonly decisionReason?: string;
  readonly signal: AbortSignal;
}

export interface DecideApprovalGroupInput<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly groupId: ConversationApprovalGroupId;
  /** Must name every proposal in the persisted group exactly once. */
  readonly targets: readonly ApprovalDecisionTarget[];
  readonly decision: ApprovalDecision;
  readonly attribution: ConversationEventAttribution;
  readonly decisionReason?: string;
  readonly signal: AbortSignal;
}

export interface AcceptedApprovalDecision {
  readonly outcome: "accepted";
  readonly decision: "confirmed" | "rejected" | "expired";
  readonly proposalId: ConversationApprovalProposalId;
  /** The exact persisted version authorized by this decision. */
  readonly authorizedVersion: number;
  readonly proposalVersion: number;
  readonly eventId: ConversationEventId;
  readonly eventRevision: ConversationRevision;
  readonly eventStatus: "appended" | "reconciled";
}

export type ApprovalDecisionFailure =
  | {
      readonly outcome: "not_found";
      readonly proposalId: ConversationApprovalProposalId;
    }
  | {
      readonly outcome: "conflict";
      readonly proposalId: ConversationApprovalProposalId;
      readonly conflict: "version" | "idempotency" | "event_identity";
    }
  | {
      readonly outcome: "forbidden";
      readonly proposalId: ConversationApprovalProposalId;
    }
  | {
      readonly outcome: "expired";
      readonly proposalId: ConversationApprovalProposalId;
      readonly proposalVersion: number;
    }
  | {
      readonly outcome: "already_decided";
      readonly proposalId: ConversationApprovalProposalId;
      readonly proposalVersion: number;
      readonly currentStatus: Exclude<ConversationApprovalProposalStatus, "pending">;
    }
  | {
      readonly outcome: "cancelled";
      readonly proposalId: ConversationApprovalProposalId;
    }
  | {
      readonly outcome: "invalid_input";
      readonly proposalId: ConversationApprovalProposalId;
      readonly reason: "request" | "not_expired";
    }
  | {
      readonly outcome: "persistence_failure";
      readonly proposalId: ConversationApprovalProposalId;
      readonly retryable: true;
    };

export type ApprovalDecisionResult =
  | AcceptedApprovalDecision
  | ApprovalDecisionFailure;

export type ApprovalGroupDecisionResult =
  | {
      readonly outcome: "completed" | "partial";
      readonly groupId: ConversationApprovalGroupId;
      /** Deterministically ordered by proposal ID. */
      readonly results: readonly ApprovalDecisionResult[];
    }
  | {
      readonly outcome: "invalid_input";
      readonly groupId: ConversationApprovalGroupId;
      readonly reason: "request" | "group_bounds" | "group_membership";
    }
  | {
      readonly outcome: "forbidden" | "persistence_failure" | "cancelled";
      readonly groupId: ConversationApprovalGroupId;
      readonly retryable?: true;
    };

export interface CreateApprovalCoordinatorOptions<TPermissionContext> {
  readonly proposalStore: ApprovalProposalStore<TPermissionContext>;
  readonly eventStore: ConversationEventStore;
  readonly authorize: ApprovalDecisionPermissionCheck<TPermissionContext>;
  readonly limits?: Partial<ApprovalCoordinatorLimits>;
}

export interface ApprovalCoordinator<TPermissionContext = unknown> {
  decide(
    input: DecideApprovalInput<TPermissionContext>,
  ): Promise<ApprovalDecisionResult>;
  decideGroup(
    input: DecideApprovalGroupInput<TPermissionContext>,
  ): Promise<ApprovalGroupDecisionResult>;
}

interface DecisionSnapshot<TPermissionContext> extends ApprovalDecisionTarget {
  readonly permissionContext: TPermissionContext;
  readonly conversationId: ConversationId;
  readonly decision: ApprovalDecision;
  readonly attribution: ConversationEventAttribution;
  readonly decisionReason?: string;
  readonly signal: AbortSignal;
  readonly groupId?: ConversationApprovalGroupId;
}

type EventReconciliation =
  | { readonly status: "matching"; readonly event: ConversationEvent }
  | { readonly status: "conflicting" }
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

/**
 * Coordinates durable decisions only. Confirming authorizes the exact proposal
 * version; it deliberately does not resolve arguments or execute a tool.
 */
export function createApprovalCoordinator<TPermissionContext>(
  options: CreateApprovalCoordinatorOptions<TPermissionContext>,
): ApprovalCoordinator<TPermissionContext> {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.authorize !== "function" ||
    options.proposalStore === null ||
    typeof options.proposalStore !== "object" ||
    options.eventStore === null ||
    typeof options.eventStore !== "object"
  ) {
    throw new TypeError("Approval coordinator options are invalid.");
  }
  const limits = resolveLimits(options.limits);

  const decideSnapshot = async (
    snapshot: DecisionSnapshot<TPermissionContext>,
  ): Promise<ApprovalDecisionResult> => {
    const proposalId = snapshot.proposalId;
    if (snapshot.signal.aborted) return frozen({ outcome: "cancelled", proposalId });

    const permission = await authorizeDecision(options.authorize, snapshot);
    if (permission === "cancelled") {
      return frozen({ outcome: "cancelled", proposalId });
    }
    if (permission === "deny") return frozen({ outcome: "forbidden", proposalId });

    let transitioned: ConversationApprovalProposalRecord;
    try {
      transitioned = await options.proposalStore.transition({
        permissionContext: snapshot.permissionContext,
        proposalId,
        expectedVersion: snapshot.expectedVersion,
        status: transitionStatus(snapshot.decision),
        attribution: snapshot.attribution,
        idempotencyKey: snapshot.idempotencyKey,
        idempotencyFingerprint: snapshot.idempotencyFingerprint,
        ...(snapshot.decisionReason === undefined
          ? {}
          : { decisionReason: snapshot.decisionReason }),
      });
    } catch (error) {
      return mapTransitionFailure(error, snapshot, options.proposalStore);
    }

    // A host-owned approval authority may also execute the approved action
    // before returning. Its execution state is authoritative, but it is not a
    // new confirmation decision event. The host retains its execution history.
    if (transitioned.status === "executing" || transitioned.status === "executed" || transitioned.status === "failed") {
      return frozen({ outcome: "already_decided", proposalId,
        proposalVersion: transitioned.proposal_version,
        currentStatus: transitioned.status });
    }

    return appendDecisionEvent(
      options.eventStore,
      snapshot,
      transitioned,
      limits,
    );
  };

  return Object.freeze({
    async decide(
      input: DecideApprovalInput<TPermissionContext>,
    ): Promise<ApprovalDecisionResult> {
      const snapshot = snapshotDecision(input);
      if (snapshot === null) return invalidSingleResult(input);
      return decideSnapshot(snapshot);
    },

    async decideGroup(
      input: DecideApprovalGroupInput<TPermissionContext>,
    ): Promise<ApprovalGroupDecisionResult> {
      const group = snapshotGroup(input, limits);
      if ("outcome" in group) return group;
      if (group.signal.aborted) {
        return frozen({ outcome: "cancelled", groupId: group.groupId });
      }

      let persisted: readonly ConversationApprovalProposalRecord[];
      try {
        persisted = await options.proposalStore.listGroup({
          permissionContext: group.permissionContext,
          groupId: group.groupId,
        });
      } catch (error) {
        if (
          error instanceof ApprovalProposalStoreError &&
          error.code === "permission_denied"
        ) {
          return frozen({ outcome: "forbidden", groupId: group.groupId });
        }
        return frozen({
          outcome: "persistence_failure",
          groupId: group.groupId,
          retryable: true,
        });
      }

      if (persisted.length > limits.maxGroupSize) {
        return frozen({
          outcome: "invalid_input",
          groupId: group.groupId,
          reason: "group_bounds",
        });
      }
      const persistedIds = persisted.map(({ proposal_id }) => proposal_id).sort();
      const targetIds = group.targets.map(({ proposalId }) => proposalId);
      if (
        persistedIds.length !== targetIds.length ||
        persistedIds.some((proposalId, index) => proposalId !== targetIds[index])
      ) {
        return frozen({
          outcome: "invalid_input",
          groupId: group.groupId,
          reason: "group_membership",
        });
      }

      const results: ApprovalDecisionResult[] = [];
      for (const target of group.targets) {
        if (group.signal.aborted) {
          results.push(frozen({ outcome: "cancelled", proposalId: target.proposalId }));
          continue;
        }
        results.push(await decideSnapshot({ ...group, ...target }));
      }
      const complete = results.every(({ outcome }) => outcome === "accepted");
      return frozen({
        outcome: complete ? "completed" : "partial",
        groupId: group.groupId,
        results: Object.freeze(results),
      });
    },
  });
}

async function authorizeDecision<TPermissionContext>(
  authorize: ApprovalDecisionPermissionCheck<TPermissionContext>,
  input: DecisionSnapshot<TPermissionContext>,
): Promise<"allow" | "deny" | "cancelled"> {
  try {
    const result = await raceWithAbort(
      Promise.resolve(
        authorize({
          permissionContext: input.permissionContext,
          conversationId: input.conversationId,
          proposalId: input.proposalId,
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
          signal: input.signal,
        }),
      ),
      input.signal,
    );
    return result === "allow" ? "allow" : "deny";
  } catch {
    return input.signal.aborted ? "cancelled" : "deny";
  }
}

async function mapTransitionFailure<TPermissionContext>(
  error: unknown,
  input: DecisionSnapshot<TPermissionContext>,
  store: ApprovalProposalStore<TPermissionContext>,
): Promise<ApprovalDecisionResult> {
  const proposalId = input.proposalId;
  if (!(error instanceof ApprovalProposalStoreError)) {
    return frozen({ outcome: "persistence_failure", proposalId, retryable: true });
  }
  switch (error.code) {
    case "permission_denied":
      return frozen({ outcome: "forbidden", proposalId });
    case "invalid_input":
      return frozen({ outcome: "invalid_input", proposalId, reason: "request" });
    case "not_found":
      return frozen({ outcome: "not_found", proposalId });
    case "idempotency_conflict":
      return frozen({ outcome: "conflict", proposalId, conflict: "idempotency" });
    case "not_expired":
      return frozen({ outcome: "invalid_input", proposalId, reason: "not_expired" });
    case "version_conflict":
    case "invalid_transition":
      return classifyCurrentProposal(input, store);
    case "capacity_exceeded":
    case "unavailable":
      return frozen({ outcome: "persistence_failure", proposalId, retryable: true });
  }
}

async function classifyCurrentProposal<TPermissionContext>(
  input: DecisionSnapshot<TPermissionContext>,
  store: ApprovalProposalStore<TPermissionContext>,
): Promise<ApprovalDecisionResult> {
  const proposalId = input.proposalId;
  let current: ConversationApprovalProposalRecord | null;
  try {
    current = await store.get({
      permissionContext: input.permissionContext,
      proposalId,
    });
  } catch (error) {
    if (
      error instanceof ApprovalProposalStoreError &&
      error.code === "permission_denied"
    ) {
      return frozen({ outcome: "forbidden", proposalId });
    }
    return frozen({ outcome: "persistence_failure", proposalId, retryable: true });
  }
  if (current === null) return frozen({ outcome: "not_found", proposalId });
  if (current.status === "expired") {
    return frozen({
      outcome: "expired",
      proposalId,
      proposalVersion: current.proposal_version,
    });
  }
  if (current.status !== "pending") {
    return frozen({
      outcome: "already_decided",
      proposalId,
      proposalVersion: current.proposal_version,
      currentStatus: current.status,
    });
  }
  return frozen({ outcome: "conflict", proposalId, conflict: "version" });
}

async function appendDecisionEvent<TPermissionContext>(
  eventStore: ConversationEventStore,
  input: DecisionSnapshot<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
  limits: ApprovalCoordinatorLimits,
): Promise<ApprovalDecisionResult> {
  const eventId = decisionEventId(input.idempotencyKey);
  for (let attempt = 0; attempt < limits.maxEventAppendAttempts; attempt += 1) {
    try {
      const latest = await eventStore.getLatestRevision(input.conversationId);
      const event = decisionEvent(input, proposal, eventId, nextRevision(latest));
      const appended = await eventStore.append({
        conversationId: input.conversationId,
        expectedRevision: latest,
        events: [event],
      });
      return acceptedResult(input, proposal, appended.entries[0]!.event, "appended");
    } catch (error) {
      if (
        error instanceof ConversationEventStoreConflictError &&
        error.code === "revision_conflict"
      ) {
        continue;
      }
      if (
        error instanceof ConversationEventStoreConflictError &&
        error.code === "idempotency_conflict"
      ) {
        const reconciliation = await reconcileEvent(
          eventStore,
          input,
          proposal,
          eventId,
          limits,
        );
        if (reconciliation.status === "matching") {
          return acceptedResult(
            input,
            proposal,
            reconciliation.event,
            "reconciled",
          );
        }
        if (reconciliation.status === "conflicting") {
          return frozen({
            outcome: "conflict",
            proposalId: input.proposalId,
            conflict: "event_identity",
          });
        }
        return frozen({
          outcome: "persistence_failure",
          proposalId: input.proposalId,
          retryable: true,
        });
      }
      if (error instanceof ConversationEventStoreUnavailableError) {
        return frozen({
          outcome: "persistence_failure",
          proposalId: input.proposalId,
          retryable: true,
        });
      }
      return frozen({
        outcome: "persistence_failure",
        proposalId: input.proposalId,
        retryable: true,
      });
    }
  }
  return frozen({
    outcome: "persistence_failure",
    proposalId: input.proposalId,
    retryable: true,
  });
}

async function reconcileEvent<TPermissionContext>(
  eventStore: ConversationEventStore,
  input: DecisionSnapshot<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
  eventId: ConversationEventId,
  limits: ApprovalCoordinatorLimits,
): Promise<EventReconciliation> {
  let cursor: Awaited<ReturnType<ConversationEventStore["read"]>>["nextCursor"] = null;
  for (let page = 0; page < limits.maxReconciliationPages; page += 1) {
    let read: Awaited<ReturnType<ConversationEventStore["read"]>>;
    try {
      read = await eventStore.read({
        conversationId: input.conversationId,
        ...(cursor === null || cursor === undefined ? {} : { after: { cursor } }),
        limit: limits.reconciliationPageSize,
      });
    } catch {
      return { status: "unavailable" };
    }
    const matched = read.entries.find(({ event }) => event.event_id === eventId);
    if (matched !== undefined) {
      return eventMatchesDecision(matched.event, input, proposal)
        ? { status: "matching", event: matched.event }
        : { status: "conflicting" };
    }
    if (!read.hasMore) return { status: "absent" };
    cursor = read.nextCursor;
    if (cursor === null) return { status: "unavailable" };
  }
  return { status: "unavailable" };
}

function eventMatchesDecision<TPermissionContext>(
  event: ConversationEvent,
  input: DecisionSnapshot<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
): boolean {
  const expected = decisionEvent(input, proposal, event.event_id, event.revision);
  // JSONB and other durable stores may reorder object keys. Identity depends
  // on the complete event values, including array order, not key insertion order.
  const canonical = (value: unknown) => JSON.stringify(value, (_key, current) =>
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : current);
  return canonical(event) === canonical(expected);
}

function decisionEvent<TPermissionContext>(
  input: DecisionSnapshot<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
  eventId: ConversationEventId,
  revision: ConversationRevision,
): ConversationEvent {
  const mutationId = eventId as string as ConversationClientMutationId;
  return {
    version: CONVERSATION_EVENT_VERSION,
    event_id: eventId,
    conversation_id: input.conversationId,
    revision,
    occurred_at: proposal.updated_at,
    actor: proposal.latest_attribution.actor,
    source: proposal.latest_attribution.source,
    ...(proposal.latest_attribution.source.type === "client"
      ? { mutation_id: mutationId }
      : {}),
    payload: {
      type: "approval.proposal_status_changed",
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      status: proposal.status as "confirmed" | "rejected" | "expired",
      ...(proposal.decision_reason === null
        ? {}
        : { decision_reason: proposal.decision_reason }),
    },
  };
}

function acceptedResult<TPermissionContext>(
  input: DecisionSnapshot<TPermissionContext>,
  proposal: ConversationApprovalProposalRecord,
  event: ConversationEvent,
  eventStatus: AcceptedApprovalDecision["eventStatus"],
): AcceptedApprovalDecision {
  return frozen({
    outcome: "accepted",
    decision: proposal.status as AcceptedApprovalDecision["decision"],
    proposalId: proposal.proposal_id,
    authorizedVersion: input.expectedVersion,
    proposalVersion: proposal.proposal_version,
    eventId: event.event_id,
    eventRevision: event.revision,
    eventStatus,
  });
}

function snapshotDecision<TPermissionContext>(
  input: DecideApprovalInput<TPermissionContext>,
): DecisionSnapshot<TPermissionContext> | null {
  if (!isDecisionInput(input)) return null;
  return frozen({
    permissionContext: input.permissionContext,
    conversationId: input.conversationId,
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    decision: input.decision,
    attribution: cloneAttribution(input.attribution),
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    ...(input.decisionReason === undefined
      ? {}
      : { decisionReason: input.decisionReason }),
    signal: input.signal,
  });
}

function snapshotGroup<TPermissionContext>(
  input: DecideApprovalGroupInput<TPermissionContext>,
  limits: ApprovalCoordinatorLimits,
):
  | (Omit<DecisionSnapshot<TPermissionContext>, keyof ApprovalDecisionTarget> & {
      readonly groupId: ConversationApprovalGroupId;
      readonly targets: readonly ApprovalDecisionTarget[];
    })
  | ApprovalGroupDecisionResult {
  const groupId = validIdentifier(input?.groupId)
    ? input.groupId
    : ("invalid-group" as ConversationApprovalGroupId);
  if (
    input === null ||
    typeof input !== "object" ||
    !validIdentifier(input.conversationId) ||
    !validIdentifier(input.groupId) ||
    !isDecision(input.decision) ||
    !isAbortSignal(input.signal) ||
    !validAttribution(input.attribution) ||
    !validReason(input.decisionReason) ||
    !Array.isArray(input.targets)
  ) {
    return frozen({ outcome: "invalid_input", groupId, reason: "request" });
  }
  if (input.targets.length === 0 || input.targets.length > limits.maxGroupSize) {
    return frozen({ outcome: "invalid_input", groupId, reason: "group_bounds" });
  }
  if (!input.targets.every(isTarget)) {
    return frozen({ outcome: "invalid_input", groupId, reason: "request" });
  }
  const targets = input.targets
    .map((target) => frozen({ ...target }))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  if (new Set(targets.map(({ proposalId }) => proposalId)).size !== targets.length) {
    return frozen({ outcome: "invalid_input", groupId, reason: "request" });
  }
  return frozen({
    permissionContext: input.permissionContext,
    conversationId: input.conversationId,
    groupId: input.groupId,
    targets: Object.freeze(targets),
    decision: input.decision,
    attribution: cloneAttribution(input.attribution),
    ...(input.decisionReason === undefined
      ? {}
      : { decisionReason: input.decisionReason }),
    signal: input.signal,
  });
}

function invalidSingleResult<TPermissionContext>(
  input: DecideApprovalInput<TPermissionContext>,
): ApprovalDecisionFailure {
  const proposalId = validIdentifier(input?.proposalId)
    ? input.proposalId
    : ("invalid-proposal" as ConversationApprovalProposalId);
  return frozen({ outcome: "invalid_input", proposalId, reason: "request" });
}

function isDecisionInput<TPermissionContext>(
  input: DecideApprovalInput<TPermissionContext>,
): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    validIdentifier(input.conversationId) &&
    isTarget(input) &&
    isDecision(input.decision) &&
    isAbortSignal(input.signal) &&
    validAttribution(input.attribution) &&
    validReason(input.decisionReason)
  );
}

function isTarget(value: unknown): value is ApprovalDecisionTarget {
  if (value === null || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return (
    validIdentifier(input.proposalId) &&
    Number.isSafeInteger(input.expectedVersion) &&
    (input.expectedVersion as number) > 0 &&
    validOpaque(input.idempotencyKey, CONVERSATION_EVENT_LIMITS.identifierLength - 18) &&
    validOpaque(input.idempotencyFingerprint, CONVERSATION_EVENT_LIMITS.identifierLength)
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CONVERSATION_EVENT_LIMITS.identifierLength
  );
}

function validOpaque(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[a-z0-9][a-z0-9._:/-]*$/iu.test(value) &&
    !value.includes("://")
  );
}

function validReason(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= CONVERSATION_EVENT_LIMITS.approvalReasonLength)
  );
}

function validAttribution(value: unknown): value is ConversationEventAttribution {
  if (value === null || typeof value !== "object") return false;
  const attribution = value as Partial<ConversationEventAttribution>;
  return (
    attribution.actor !== null &&
    typeof attribution.actor === "object" &&
    attribution.source !== null &&
    typeof attribution.source === "object"
  );
}

function cloneAttribution(
  attribution: ConversationEventAttribution,
): ConversationEventAttribution {
  return frozen({
    actor: { ...attribution.actor },
    source: { ...attribution.source },
  });
}

function isDecision(value: unknown): value is ApprovalDecision {
  return value === "confirm" || value === "reject" || value === "expire";
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function"
  );
}

function transitionStatus(
  decision: ApprovalDecision,
): ConversationApprovalProposalTransitionStatus {
  switch (decision) {
    case "confirm":
      return "confirmed";
    case "reject":
      return "rejected";
    case "expire":
      return "expired";
  }
}

function decisionEventId(idempotencyKey: string): ConversationEventId {
  return `approval-decision:${idempotencyKey}` as ConversationEventId;
}

function nextRevision(
  revision: ConversationRevision | null,
): ConversationRevision {
  return ((revision ?? 0) + 1) as ConversationRevision;
}

function resolveLimits(
  overrides: Partial<ApprovalCoordinatorLimits> | undefined,
): Readonly<ApprovalCoordinatorLimits> {
  const limits = { ...DEFAULT_APPROVAL_COORDINATOR_LIMITS, ...overrides };
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
    const abort = (): void => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function frozen<const T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
