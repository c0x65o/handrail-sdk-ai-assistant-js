import {
  CONVERSATION_EVENT_LIMITS,
  isConversationApprovalReason,
  isConversationApprovalReviewedArguments,
  isLegalConversationApprovalProposalTransition,
  type ConversationApprovalGroupId,
  type ConversationApprovalProposalId,
  type ConversationApprovalProposalTransitionStatus,
  type ConversationApprovalReviewedArguments,
  type ConversationTimestamp,
  type ConversationToolCallId,
  type ConversationTurnId,
} from "./events.js";
import type {
  ConversationApprovalProposalRecord,
  ConversationEventAttribution,
  ConversationStateApprovalReviewedArguments,
  ConversationStateJsonObject,
  ConversationStateJsonValue,
} from "./state.js";

export const APPROVAL_PROPOSAL_STORE_LIMITS = Object.freeze({
  idempotencyKeyLength: 256,
  idempotencyFingerprintLength: 256,
  proposalCapacity: 1_000,
  idempotencyRecordCapacity: 2_000,
});

export interface ApprovalProposalStoreLimits {
  readonly maxProposals: number;
  readonly maxIdempotencyRecords: number;
  readonly maxIdempotencyKeyLength: number;
  readonly maxIdempotencyFingerprintLength: number;
}

export const DEFAULT_APPROVAL_PROPOSAL_STORE_LIMITS: Readonly<ApprovalProposalStoreLimits> =
  Object.freeze({
    maxProposals: APPROVAL_PROPOSAL_STORE_LIMITS.proposalCapacity,
    maxIdempotencyRecords:
      APPROVAL_PROPOSAL_STORE_LIMITS.idempotencyRecordCapacity,
    maxIdempotencyKeyLength:
      APPROVAL_PROPOSAL_STORE_LIMITS.idempotencyKeyLength,
    maxIdempotencyFingerprintLength:
      APPROVAL_PROPOSAL_STORE_LIMITS.idempotencyFingerprintLength,
  });

export type ApprovalProposalStoreOperation =
  | "create"
  | "get"
  | "list_group"
  | "transition";

export interface ApprovalProposalPermissionRequest<TPermissionContext> {
  readonly operation: ApprovalProposalStoreOperation;
  readonly permissionContext: TPermissionContext;
  readonly proposalId?: ConversationApprovalProposalId;
  readonly groupId?: ConversationApprovalGroupId;
  readonly targetStatus?: ConversationApprovalProposalTransitionStatus;
}

/**
 * Host-owned authorization boundary. It receives requested identifiers, never a
 * stored proposal, so adapters can authorize before looking up durable state.
 */
export type ApprovalProposalPermissionCheck<TPermissionContext> = (
  request: ApprovalProposalPermissionRequest<TPermissionContext>,
) => "allow" | "deny" | Promise<"allow" | "deny">;

export interface ApprovalProposalStoreClock {
  now(): ConversationTimestamp;
}

export interface ApprovalProposalIdempotencyInput {
  readonly idempotencyKey: string;
  /** Host-generated bounded fingerprint of the logical request. */
  readonly idempotencyFingerprint: string;
}

export interface CreateApprovalProposalInput<TPermissionContext>
  extends ApprovalProposalIdempotencyInput {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  readonly groupId?: ConversationApprovalGroupId;
  readonly turnId: ConversationTurnId;
  readonly toolCallId: ConversationToolCallId;
  readonly toolName: string;
  readonly reviewedArguments: ConversationApprovalReviewedArguments;
  /** @deprecated Approval deadlines are ignored. New proposals have no expiry. */
  readonly expiresAt?: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution;
}

export interface GetApprovalProposalInput<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
}

export interface ListApprovalProposalGroupInput<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly groupId: ConversationApprovalGroupId;
}

export interface TransitionApprovalProposalInput<TPermissionContext>
  extends ApprovalProposalIdempotencyInput {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  readonly expectedVersion: number;
  readonly status: ConversationApprovalProposalTransitionStatus;
  readonly attribution: ConversationEventAttribution;
  readonly decisionReason?: string;
  readonly failureReason?: string;
}

/**
 * Provider- and storage-neutral persistence boundary for approval proposals.
 *
 * Implementations must authorize before looking up or disclosing state, make
 * create/transition operations atomic, use optimistic proposal versions, and
 * retain immutable idempotency results for their documented retention window.
 * Production durability, identity, and policy remain host-owned.
 */
export interface ApprovalProposalStore<TPermissionContext = unknown> {
  create(
    input: CreateApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord>;
  get(
    input: GetApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord | null>;
  listGroup(
    input: ListApprovalProposalGroupInput<TPermissionContext>,
  ): Promise<readonly ConversationApprovalProposalRecord[]>;
  transition(
    input: TransitionApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord>;
}

export type ApprovalProposalStoreErrorCode =
  | "permission_denied"
  | "invalid_input"
  | "not_found"
  | "capacity_exceeded"
  | "idempotency_conflict"
  | "version_conflict"
  | "invalid_transition"
  | "not_expired"
  | "unavailable";

/** A normalized error that never includes proposal contents or host errors. */
export class ApprovalProposalStoreError extends Error {
  readonly code: ApprovalProposalStoreErrorCode;
  readonly operation: ApprovalProposalStoreOperation;
  readonly retryable: boolean;

  constructor(
    code: ApprovalProposalStoreErrorCode,
    operation: ApprovalProposalStoreOperation,
  ) {
    super(errorMessage(code));
    this.name = "ApprovalProposalStoreError";
    this.code = code;
    this.operation = operation;
    this.retryable = code === "unavailable" || code === "version_conflict";
  }
}

export interface InMemoryApprovalProposalStoreOptions<TPermissionContext> {
  readonly authorize: ApprovalProposalPermissionCheck<TPermissionContext>;
  readonly clock?: ApprovalProposalStoreClock;
  readonly limits?: Partial<ApprovalProposalStoreLimits>;
  /** @deprecated Reads no longer expire proposals. Ignored. */
  readonly expiryAttribution?: ConversationEventAttribution;
}

interface IdempotencyRecord {
  readonly operation: "create" | "transition";
  readonly fingerprint: string;
  readonly requestSignature: string;
  readonly result: ConversationApprovalProposalRecord;
}

interface CreateApprovalProposalSnapshot<TPermissionContext> {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  readonly groupId: ConversationApprovalGroupId | null;
  readonly turnId: ConversationTurnId;
  readonly toolCallId: ConversationToolCallId;
  readonly toolName: string;
  readonly reviewedArguments: ConversationStateApprovalReviewedArguments;
  readonly expiresAt: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
}

interface TransitionApprovalProposalSnapshot<TPermissionContext>
  extends ProposalTransitionData {
  readonly permissionContext: TPermissionContext;
  readonly proposalId: ConversationApprovalProposalId;
  readonly expectedVersion: number;
  readonly attribution: ConversationEventAttribution;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
}

interface ProposalTransitionData {
  readonly status: ConversationApprovalProposalTransitionStatus;
  readonly decisionReason?: string;
  readonly failureReason?: string;
}

/**
 * Bounded process-local reference adapter for tests and development.
 *
 * This is intentionally not production persistence. All retained state is lost
 * with the instance or process.
 */
export class InMemoryApprovalProposalStore<TPermissionContext = unknown>
  implements ApprovalProposalStore<TPermissionContext>
{
  readonly #authorizeCheck: ApprovalProposalPermissionCheck<TPermissionContext>;
  readonly #clock: ApprovalProposalStoreClock;
  readonly #limits: Readonly<ApprovalProposalStoreLimits>;
  readonly #proposals = new Map<string, ConversationApprovalProposalRecord>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: InMemoryApprovalProposalStoreOptions<TPermissionContext>) {
    if (typeof options?.authorize !== "function") {
      throw new TypeError("options.authorize must be a function");
    }
    this.#authorizeCheck = options.authorize;
    this.#clock = options.clock ?? {
      now: () => new Date().toISOString() as ConversationTimestamp,
    };
    if (typeof this.#clock.now !== "function") {
      throw new TypeError("options.clock.now must be a function");
    }
    this.#limits = resolveLimits(options.limits);
  }

  async create(
    input: CreateApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord> {
    validateCreateInput(input, this.#limits);
    const snapshot = snapshotCreateInput(input);
    await this.#authorize({
      operation: "create",
      permissionContext: snapshot.permissionContext,
      proposalId: snapshot.proposalId,
      ...(snapshot.groupId === null ? {} : { groupId: snapshot.groupId }),
    });

    return this.#serialize(() => {
      const signature = createRequestSignature(snapshot);
      const retry = this.#idempotentResult(
        "create",
        snapshot.idempotencyKey,
        snapshot.idempotencyFingerprint,
        signature,
      );
      if (retry !== null) return cloneProposal(retry);

      if (this.#proposals.has(snapshot.proposalId)) {
        throw storeError("idempotency_conflict", "create");
      }
      if (this.#proposals.size >= this.#limits.maxProposals) {
        throw storeError("capacity_exceeded", "create");
      }

      const now = this.#now("create");
      if (snapshot.attribution.actor.type !== "system") {
        throw storeError("invalid_input", "create");
      }
      const proposal = deepFreeze({
        proposal_id: snapshot.proposalId,
        group_id: snapshot.groupId,
        turn_id: snapshot.turnId,
        tool_call_id: snapshot.toolCallId,
        tool_name: snapshot.toolName,
        reviewed_arguments: snapshot.reviewedArguments,
        status: "pending",
        proposal_version: 1,
        expires_at: null,
        created_at: now,
        updated_at: now,
        created_attribution: snapshot.attribution,
        latest_attribution: snapshot.attribution,
        decision_at: null,
        decision_attribution: null,
        decision_reason: null,
        failure_reason: null,
      } satisfies ConversationApprovalProposalRecord);

      this.#proposals.set(proposal.proposal_id, proposal);
      this.#retainIdempotency(snapshot.idempotencyKey, {
        operation: "create",
        fingerprint: snapshot.idempotencyFingerprint,
        requestSignature: signature,
        result: cloneProposal(proposal),
      });
      return cloneProposal(proposal);
    });
  }

  async get(
    input: GetApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord | null> {
    validateIdentifier(input.proposalId, "get");
    await this.#authorize({
      operation: "get",
      permissionContext: input.permissionContext,
      proposalId: input.proposalId,
    });

    return this.#serialize(() => {
      const proposal = this.#proposals.get(input.proposalId);
      if (proposal === undefined) return null;
      return cloneProposal(proposal);
    });
  }

  async listGroup(
    input: ListApprovalProposalGroupInput<TPermissionContext>,
  ): Promise<readonly ConversationApprovalProposalRecord[]> {
    validateIdentifier(input.groupId, "list_group");
    await this.#authorize({
      operation: "list_group",
      permissionContext: input.permissionContext,
      groupId: input.groupId,
    });

    return this.#serialize(() => {
      const proposals: ConversationApprovalProposalRecord[] = [];
      for (const proposal of this.#proposals.values()) {
        if (proposal.group_id !== input.groupId) continue;
        proposals.push(cloneProposal(proposal));
      }
      proposals.sort(compareProposals);
      return Object.freeze(proposals);
    });
  }

  async transition(
    input: TransitionApprovalProposalInput<TPermissionContext>,
  ): Promise<ConversationApprovalProposalRecord> {
    validateTransitionInput(input, this.#limits);
    const snapshot = snapshotTransitionInput(input);
    await this.#authorize({
      operation: "transition",
      permissionContext: snapshot.permissionContext,
      proposalId: snapshot.proposalId,
      targetStatus: snapshot.status,
    });

    return this.#serialize(() => {
      const signature = transitionRequestSignature(snapshot);
      const retry = this.#idempotentResult(
        "transition",
        snapshot.idempotencyKey,
        snapshot.idempotencyFingerprint,
        signature,
      );
      if (retry !== null) return cloneProposal(retry);

      const current = this.#proposals.get(snapshot.proposalId);
      if (current === undefined) throw storeError("not_found", "transition");
      if (current.proposal_version !== snapshot.expectedVersion) {
        throw storeError("version_conflict", "transition");
      }

      const now = this.#now("transition");
      if (Date.parse(now) < Date.parse(current.updated_at)) {
        throw storeError("unavailable", "transition");
      }
      // Retain historical expired receipts, but never create a new expiry.
      if (snapshot.status === "expired") throw storeError("invalid_transition", "transition");
      if (
        !isLegalConversationApprovalProposalTransition(current.status, snapshot.status)
      ) {
        throw storeError("invalid_transition", "transition");
      }

      if (
        ["expired", "executing", "executed", "failed"].includes(
          snapshot.status,
        ) && snapshot.attribution.actor.type !== "system"
      ) {
        throw storeError("invalid_input", "transition");
      }
      if (
        ["confirmed", "rejected"].includes(snapshot.status) &&
        !["user", "system"].includes(snapshot.attribution.actor.type)
      ) {
        throw storeError("invalid_input", "transition");
      }

      const next = transitionProposal(current, snapshot, now, snapshot.attribution);
      this.#proposals.set(next.proposal_id, next);
      this.#retainIdempotency(snapshot.idempotencyKey, {
        operation: "transition",
        fingerprint: snapshot.idempotencyFingerprint,
        requestSignature: signature,
        result: cloneProposal(next),
      });
      return cloneProposal(next);
    });
  }

  async #authorize(
    request: ApprovalProposalPermissionRequest<TPermissionContext>,
  ): Promise<void> {
    try {
      if ((await this.#authorizeCheck(request)) === "allow") return;
    } catch {
      // Authorization failures are deliberately indistinguishable from denial.
    }
    throw storeError("permission_denied", request.operation);
  }

  #serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #now(operation: ApprovalProposalStoreOperation): ConversationTimestamp {
    let value: ConversationTimestamp;
    try {
      value = this.#clock.now();
    } catch {
      throw storeError("unavailable", operation);
    }
    if (!isTimestamp(value)) throw storeError("unavailable", operation);
    return value;
  }

  #idempotentResult(
    operation: IdempotencyRecord["operation"],
    key: string,
    fingerprint: string,
    requestSignature: string,
  ): ConversationApprovalProposalRecord | null {
    const retained = this.#idempotency.get(key);
    if (retained === undefined) return null;
    if (
      retained.operation !== operation ||
      retained.fingerprint !== fingerprint ||
      retained.requestSignature !== requestSignature
    ) {
      throw storeError("idempotency_conflict", operation);
    }
    return retained.result;
  }

  #retainIdempotency(key: string, record: IdempotencyRecord): void {
    while (this.#idempotency.size >= this.#limits.maxIdempotencyRecords) {
      const oldest = this.#idempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#idempotency.delete(oldest);
    }
    this.#idempotency.set(key, deepFreeze(record));
  }
}

function resolveLimits(
  overrides: Partial<ApprovalProposalStoreLimits> | undefined,
): Readonly<ApprovalProposalStoreLimits> {
  const limits = { ...DEFAULT_APPROVAL_PROPOSAL_STORE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`limits.${name} must be a positive safe integer`);
    }
  }
  if (limits.maxIdempotencyKeyLength > CONVERSATION_EVENT_LIMITS.textLength) {
    throw new TypeError("limits.maxIdempotencyKeyLength is unreasonably large");
  }
  if (
    limits.maxIdempotencyFingerprintLength > CONVERSATION_EVENT_LIMITS.textLength
  ) {
    throw new TypeError("limits.maxIdempotencyFingerprintLength is unreasonably large");
  }
  return Object.freeze(limits);
}

function snapshotCreateInput<TPermissionContext>(
  input: CreateApprovalProposalInput<TPermissionContext>,
): CreateApprovalProposalSnapshot<TPermissionContext> {
  return Object.freeze({
    permissionContext: input.permissionContext,
    proposalId: input.proposalId,
    groupId: input.groupId ?? null,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    reviewedArguments: cloneReviewedArguments(input.reviewedArguments),
    expiresAt: input.expiresAt ?? null,
    attribution: cloneAttribution(input.attribution, "invalid_input", "create"),
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
  });
}

function snapshotTransitionInput<TPermissionContext>(
  input: TransitionApprovalProposalInput<TPermissionContext>,
): TransitionApprovalProposalSnapshot<TPermissionContext> {
  return Object.freeze({
    permissionContext: input.permissionContext,
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    status: input.status,
    attribution: cloneAttribution(
      input.attribution,
      "invalid_input",
      "transition",
    ),
    idempotencyKey: input.idempotencyKey,
    idempotencyFingerprint: input.idempotencyFingerprint,
    ...(input.decisionReason === undefined
      ? {}
      : { decisionReason: input.decisionReason }),
    ...(input.failureReason === undefined
      ? {}
      : { failureReason: input.failureReason }),
  });
}

function validateCreateInput<TPermissionContext>(
  input: CreateApprovalProposalInput<TPermissionContext>,
  limits: ApprovalProposalStoreLimits,
): void {
  validateIdentifier(input.proposalId, "create");
  if (input.groupId !== undefined) validateIdentifier(input.groupId, "create");
  validateIdentifier(input.turnId, "create");
  validateIdentifier(input.toolCallId, "create");
  validateIdentifier(input.toolName, "create");
  validateIdempotency(input, limits, "create");
  if (input.expiresAt != null && !isTimestamp(input.expiresAt)) throw storeError("invalid_input", "create");
  if (!isConversationApprovalReviewedArguments(input.reviewedArguments)) {
    throw storeError("invalid_input", "create");
  }
  cloneAttribution(input.attribution, "invalid_input", "create");
}

function validateTransitionInput<TPermissionContext>(
  input: TransitionApprovalProposalInput<TPermissionContext>,
  limits: ApprovalProposalStoreLimits,
): void {
  validateIdentifier(input.proposalId, "transition");
  validateIdempotency(input, limits, "transition");
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
    throw storeError("invalid_input", "transition");
  }
  if (
    !["confirmed", "rejected", "expired", "executing", "executed", "failed"].includes(
      input.status,
    )
  ) {
    throw storeError("invalid_input", "transition");
  }
  const decisionStatus = ["confirmed", "rejected", "expired"].includes(
    input.status,
  );
  if (
    input.decisionReason !== undefined &&
    (!decisionStatus || !isConversationApprovalReason(input.decisionReason))
  ) {
    throw storeError("invalid_input", "transition");
  }
  if (
    input.status === "failed"
      ? !isConversationApprovalReason(input.failureReason)
      : input.failureReason !== undefined
  ) {
    throw storeError("invalid_input", "transition");
  }
  cloneAttribution(input.attribution, "invalid_input", "transition");
}

function validateIdempotency(
  input: ApprovalProposalIdempotencyInput,
  limits: ApprovalProposalStoreLimits,
  operation: "create" | "transition",
): void {
  if (!isBoundedOpaqueValue(input.idempotencyKey, limits.maxIdempotencyKeyLength)) {
    throw storeError("invalid_input", operation);
  }
  if (
    !isBoundedOpaqueValue(
      input.idempotencyFingerprint,
      limits.maxIdempotencyFingerprintLength,
    )
  ) {
    throw storeError("invalid_input", operation);
  }
}

function validateIdentifier(
  value: unknown,
  operation: ApprovalProposalStoreOperation,
): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONVERSATION_EVENT_LIMITS.identifierLength
  ) {
    throw storeError("invalid_input", operation);
  }
}

function isBoundedOpaqueValue(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[a-z0-9][a-z0-9._:/-]*$/iu.test(value) &&
    !value.includes("://")
  );
}

function isTimestamp(value: unknown): value is ConversationTimestamp {
  if (typeof value !== "string" || value.length > 64) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      value,
    );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  return (
    year !== 0 &&
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function cloneAttribution(
  value: unknown,
  code: ApprovalProposalStoreErrorCode,
  operation: ApprovalProposalStoreOperation,
): ConversationEventAttribution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw storeError(code, operation);
  }
  const input = value as Record<string, unknown>;
  const actor = input.actor;
  const source = input.source;
  if (
    actor === null ||
    typeof actor !== "object" ||
    Array.isArray(actor) ||
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) {
    throw storeError(code, operation);
  }
  const actorRecord = actor as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;
  if (
    !["user", "assistant", "tool", "system"].includes(String(actorRecord.type)) ||
    (actorRecord.id !== undefined &&
      (typeof actorRecord.id !== "string" ||
        actorRecord.id.length === 0 ||
        actorRecord.id.length > CONVERSATION_EVENT_LIMITS.identifierLength)) ||
    !["client", "runtime", "sync", "import"].includes(String(sourceRecord.type))
  ) {
    throw storeError(code, operation);
  }
  if (
    sourceRecord.type === "client" &&
    (typeof sourceRecord.client_id !== "string" ||
      sourceRecord.client_id.length === 0 ||
      sourceRecord.client_id.length > CONVERSATION_EVENT_LIMITS.identifierLength ||
      (sourceRecord.device_id !== undefined &&
        (typeof sourceRecord.device_id !== "string" ||
          sourceRecord.device_id.length === 0 ||
          sourceRecord.device_id.length >
            CONVERSATION_EVENT_LIMITS.identifierLength)))
  ) {
    throw storeError(code, operation);
  }

  const clonedActor = {
    type: actorRecord.type,
    ...(actorRecord.id === undefined ? {} : { id: actorRecord.id }),
  } as ConversationEventAttribution["actor"];
  let clonedSource: ConversationEventAttribution["source"];
  if (sourceRecord.type === "client") {
    clonedSource = {
      type: "client",
      client_id: sourceRecord.client_id,
      ...(sourceRecord.device_id === undefined
        ? {}
        : { device_id: sourceRecord.device_id }),
    } as ConversationEventAttribution["source"];
  } else {
    clonedSource = { type: sourceRecord.type } as ConversationEventAttribution["source"];
  }
  return deepFreeze({ actor: clonedActor, source: clonedSource });
}

function cloneReviewedArguments(
  value: ConversationApprovalReviewedArguments,
): ConversationStateApprovalReviewedArguments {
  if (value.type === "opaque_reference") {
    return deepFreeze({ type: value.type, argument_ref: value.argument_ref });
  }
  return deepFreeze({
    type: value.type,
    value: cloneJson(value.value) as ConversationStateJsonObject,
  });
}

function transitionProposal(
  current: ConversationApprovalProposalRecord,
  input: ProposalTransitionData,
  now: ConversationTimestamp,
  attribution: ConversationEventAttribution,
): ConversationApprovalProposalRecord {
  const isDecision = ["confirmed", "rejected", "expired"].includes(input.status);
  return deepFreeze({
    ...current,
    status: input.status,
    proposal_version: current.proposal_version + 1,
    updated_at: now,
    latest_attribution: cloneAttribution(
      attribution,
      "invalid_input",
      "transition",
    ),
    decision_at: isDecision ? now : current.decision_at,
    decision_attribution: isDecision
      ? cloneAttribution(attribution, "invalid_input", "transition")
      : current.decision_attribution,
    decision_reason: isDecision ? input.decisionReason ?? null : current.decision_reason,
    failure_reason:
      input.status === "failed"
        ? input.failureReason!
        : input.status === "executing"
          ? null
          : current.failure_reason,
  });
}

function cloneProposal(
  proposal: ConversationApprovalProposalRecord,
): ConversationApprovalProposalRecord {
  return deepFreeze({
    ...proposal,
    reviewed_arguments:
      proposal.reviewed_arguments.type === "opaque_reference"
        ? {
            type: "opaque_reference",
            argument_ref: proposal.reviewed_arguments.argument_ref,
          }
        : {
            type: "redacted_json",
            value: cloneJson(proposal.reviewed_arguments.value) as ConversationStateJsonObject,
          },
    created_attribution: cloneAttribution(
      proposal.created_attribution,
      "unavailable",
      "get",
    ),
    latest_attribution: cloneAttribution(
      proposal.latest_attribution,
      "unavailable",
      "get",
    ),
    decision_attribution:
      proposal.decision_attribution === null
        ? null
        : cloneAttribution(proposal.decision_attribution, "unavailable", "get"),
  });
}

function compareProposals(
  left: ConversationApprovalProposalRecord,
  right: ConversationApprovalProposalRecord,
): number {
  return Date.parse(left.created_at) - Date.parse(right.created_at) ||
    left.proposal_id.localeCompare(right.proposal_id);
}

function createRequestSignature<TPermissionContext>(
  input: CreateApprovalProposalSnapshot<TPermissionContext>,
): string {
  return stableStringify({
    operation: "create",
    proposalId: input.proposalId,
    groupId: input.groupId ?? null,
    turnId: input.turnId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    reviewedArguments: input.reviewedArguments,
    expiresAt: input.expiresAt ?? null,
    attribution: input.attribution,
  });
}

function transitionRequestSignature<TPermissionContext>(
  input: TransitionApprovalProposalSnapshot<TPermissionContext>,
): string {
  return stableStringify({
    operation: "transition",
    proposalId: input.proposalId,
    expectedVersion: input.expectedVersion,
    status: input.status,
    attribution: input.attribution,
    decisionReason: input.decisionReason ?? null,
    failureReason: input.failureReason ?? null,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify(
            (value as Record<string, unknown>)[key],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function cloneJson(value: ConversationStateJsonValue): ConversationStateJsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function storeError(
  code: ApprovalProposalStoreErrorCode,
  operation: ApprovalProposalStoreOperation,
): ApprovalProposalStoreError {
  return new ApprovalProposalStoreError(code, operation);
}

function errorMessage(code: ApprovalProposalStoreErrorCode): string {
  switch (code) {
    case "permission_denied":
      return "Approval proposal access is not permitted.";
    case "invalid_input":
      return "The approval proposal request is invalid.";
    case "not_found":
      return "The approval proposal was not found.";
    case "capacity_exceeded":
      return "The approval proposal store is at capacity.";
    case "idempotency_conflict":
      return "The idempotency key was already used for a different request.";
    case "version_conflict":
      return "The approval proposal version has changed.";
    case "invalid_transition":
      return "The approval proposal transition is not permitted.";
    case "not_expired":
      return "The approval proposal has not expired.";
    case "unavailable":
      return "The approval proposal store is temporarily unavailable.";
  }
}
