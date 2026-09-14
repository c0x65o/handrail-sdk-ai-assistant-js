import {
  createContext,
  Fragment,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type LiHTMLAttributes,
  type ReactNode,
} from "react";

import type {
  ApprovalCoordinator,
  ApprovalDecision,
  ApprovalDecisionResult,
  DecideApprovalInput,
} from "../conversation/approval-coordinator.js";
import { APPROVAL_PROPOSAL_STORE_LIMITS } from "../conversation/approval-proposal-store.js";
import type {
  ConversationApprovalGroupId,
  ConversationApprovalProposalId,
  ConversationApprovalProposalStatus,
  ConversationId,
  ConversationTimestamp,
} from "../conversation/events.js";
import type {
  ConversationApprovalProposalRecord,
  ConversationEventAttribution,
} from "../conversation/state.js";
import type { PrimitiveRender } from "./primitives.js";
import { StructuredDetails, structuredDetailLabel } from "./structured-details.js";

export interface ApprovalReviewLoadInput<TPermissionContext> {
  readonly conversationId: ConversationId;
  readonly permissionContext: TPermissionContext;
  readonly signal: AbortSignal;
}

export type ApprovalReviewProposalLoader<TPermissionContext> = (
  input: ApprovalReviewLoadInput<TPermissionContext>,
) => Promise<readonly ConversationApprovalProposalRecord[]>;

export interface ApprovalReviewSubscriptionInput<TPermissionContext>
  extends ApprovalReviewLoadInput<TPermissionContext> {
  /** Signals that persisted proposals changed. The controller reloads them safely. */
  readonly refresh: () => void;
}

export type ApprovalReviewProposalSubscription<TPermissionContext> = (
  input: ApprovalReviewSubscriptionInput<TPermissionContext>,
) => void | (() => void);

export interface ApprovalReviewDecisionIdentityRequest {
  readonly conversationId: ConversationId;
  readonly proposalId: ConversationApprovalProposalId;
  readonly proposalVersion: number;
  readonly decision: Extract<ApprovalDecision, "confirm" | "reject">;
}

export interface ApprovalReviewDecisionIdentity {
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
}

export type ApprovalReviewDecisionIdentityFactory = (
  request: ApprovalReviewDecisionIdentityRequest,
) => ApprovalReviewDecisionIdentity;

export type ApprovalReviewDecisionHandler<TPermissionContext> = (
  input: DecideApprovalInput<TPermissionContext>,
) => Promise<ApprovalDecisionResult>;

export type ApprovalReviewTransitionHandler<TPermissionContext> = (
  input: DecideApprovalInput<TPermissionContext>,
) => Promise<ConversationApprovalProposalRecord>;

export type ApprovalReviewDecisionCode =
  | "idle"
  | "busy"
  | "accepted"
  | "version_stale"
  | "idempotency_conflict"
  | "conflict"
  | "forbidden"
  | "expired"
  | "already_decided"
  | "cancelled"
  | "invalid_input"
  | "not_found"
  | "persistence_failure";

/** Bounded UI state. It never exposes coordinator event IDs, causes, or host errors. */
export interface ApprovalReviewDecisionState {
  readonly code: ApprovalReviewDecisionCode;
  readonly decision?: "confirmed" | "rejected";
  readonly currentStatus?: Exclude<ConversationApprovalProposalStatus, "pending">;
  readonly retryable: boolean;
}

export interface ApprovalReviewLoadError {
  readonly code: "load_failed";
  readonly message: "Approval proposals could not be loaded.";
  readonly retryable: true;
}

export interface ApprovalReviewGroupModel {
  readonly key: string;
  readonly groupId: ConversationApprovalGroupId | null;
  readonly proposals: readonly ConversationApprovalProposalRecord[];
}

export interface UseApprovalReviewOptions<TPermissionContext> {
  readonly attribution: ConversationEventAttribution;
  readonly conversationId: ConversationId;
  /** Pass exactly one coordinator, decision handler, or gateway transition handler. */
  readonly coordinator?: Pick<ApprovalCoordinator<TPermissionContext>, "decide">;
  readonly createDecisionIdentity: ApprovalReviewDecisionIdentityFactory;
  readonly decisionHandler?: ApprovalReviewDecisionHandler<TPermissionContext>;
  /** Uses the protected proposal-store transition contract exposed by an application gateway. */
  readonly transitionHandler?: ApprovalReviewTransitionHandler<TPermissionContext>;
  /** Persisted rows used during SSR and before the first host refresh. */
  readonly initialProposals?: readonly ConversationApprovalProposalRecord[];
  readonly loadProposals: ApprovalReviewProposalLoader<TPermissionContext>;
  /** Injectable stable clock for SSR and expiry policy. */
  readonly now?: () => ConversationTimestamp;
  readonly onDecisionResult?: (
    proposal: ConversationApprovalProposalRecord,
    result: ApprovalReviewDecisionState,
  ) => void;
  readonly permissionContext: TPermissionContext;
  readonly subscribe?: ApprovalReviewProposalSubscription<TPermissionContext>;
}

export interface ApprovalReviewController {
  readonly proposals: readonly ConversationApprovalProposalRecord[];
  readonly groups: readonly ApprovalReviewGroupModel[];
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: ApprovalReviewLoadError | null;
  refresh(): Promise<void>;
  confirm(proposal: ConversationApprovalProposalRecord): Promise<ApprovalReviewDecisionState>;
  reject(proposal: ConversationApprovalProposalRecord): Promise<ApprovalReviewDecisionState>;
  decisionState(proposal: ConversationApprovalProposalRecord): ApprovalReviewDecisionState;
  isExpired(proposal: ConversationApprovalProposalRecord): boolean;
  canDecide(proposal: ConversationApprovalProposalRecord): boolean;
  clearError(): void;
}

const IDLE_STATE: ApprovalReviewDecisionState = Object.freeze({
  code: "idle",
  retryable: false,
});
const LOAD_ERROR: ApprovalReviewLoadError = Object.freeze({
  code: "load_failed",
  message: "Approval proposals could not be loaded.",
  retryable: true,
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedProposals(
  rows: readonly ConversationApprovalProposalRecord[],
): readonly ConversationApprovalProposalRecord[] {
  const sorted = [...rows].sort((left, right) => {
    const leftGroup = left.group_id ?? `\uffff${left.proposal_id}`;
    const rightGroup = right.group_id ?? `\uffff${right.proposal_id}`;
    return compareText(leftGroup, rightGroup) ||
      compareText(left.proposal_id, right.proposal_id);
  });
  const ids = new Set<string>();
  return Object.freeze(sorted.filter((proposal) => {
    if (ids.has(proposal.proposal_id)) return false;
    ids.add(proposal.proposal_id);
    return true;
  }));
}

function groupedProposals(
  rows: readonly ConversationApprovalProposalRecord[],
): readonly ApprovalReviewGroupModel[] {
  const groups = new Map<string, {
    groupId: ConversationApprovalGroupId | null;
    proposals: ConversationApprovalProposalRecord[];
  }>();
  for (const proposal of rows) {
    const key = proposal.group_id === null
      ? `proposal:${proposal.proposal_id}`
      : `group:${proposal.group_id}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { groupId: proposal.group_id, proposals: [proposal] });
    } else {
      existing.proposals.push(proposal);
    }
  }
  return Object.freeze([...groups].map(([key, group]) => Object.freeze({
    key,
    groupId: group.groupId,
    proposals: Object.freeze(group.proposals),
  })));
}

function decisionKey(
  proposal: ConversationApprovalProposalRecord,
  decision: "confirm" | "reject",
): string {
  return `${proposal.proposal_id}\u0000${proposal.proposal_version}\u0000${decision}`;
}

function proposalKey(proposal: ConversationApprovalProposalRecord): string {
  return `${proposal.proposal_id}\u0000${proposal.proposal_version}`;
}

function validIdentity(value: ApprovalReviewDecisionIdentity): boolean {
  return value !== null && typeof value === "object" &&
    typeof value.idempotencyKey === "string" && value.idempotencyKey.length > 0 &&
    value.idempotencyKey.length <= APPROVAL_PROPOSAL_STORE_LIMITS.idempotencyKeyLength &&
    typeof value.idempotencyFingerprint === "string" &&
    value.idempotencyFingerprint.length > 0 &&
    value.idempotencyFingerprint.length <=
      APPROVAL_PROPOSAL_STORE_LIMITS.idempotencyFingerprintLength;
}

function safeResult(result: ApprovalDecisionResult): ApprovalReviewDecisionState {
  switch (result.outcome) {
    case "accepted":
      if (result.decision === "expired") {
        return Object.freeze({ code: "expired", retryable: false });
      }
      return Object.freeze({
        code: "accepted",
        decision: result.decision,
        retryable: false,
      });
    case "conflict":
      return Object.freeze({
        code: result.conflict === "version"
          ? "version_stale"
          : result.conflict === "idempotency" ? "idempotency_conflict" : "conflict",
        retryable: false,
      });
    case "already_decided":
      return Object.freeze({
        code: "already_decided",
        currentStatus: result.currentStatus,
        retryable: false,
      });
    case "persistence_failure":
      return Object.freeze({ code: "persistence_failure", retryable: true });
    case "cancelled":
      return Object.freeze({ code: "cancelled", retryable: true });
    case "forbidden":
    case "expired":
    case "invalid_input":
    case "not_found":
      return Object.freeze({ code: result.outcome, retryable: false });
  }
}

function currentTimestamp(now: (() => ConversationTimestamp) | undefined): number {
  const value = now?.() ?? new Date().toISOString() as ConversationTimestamp;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/** Host-loaded, provider-neutral approval review controller. */
export function useApprovalReview<TPermissionContext>(
  options: UseApprovalReviewOptions<TPermissionContext>,
): ApprovalReviewController {
  const decisionSourceCount = Number(options.coordinator !== undefined) +
    Number(options.decisionHandler !== undefined) + Number(options.transitionHandler !== undefined);
  if (decisionSourceCount !== 1) {
    throw new TypeError("Provide exactly one approval coordinator, decision handler, or transition handler.");
  }
  const initial = useMemo(
    () => normalizedProposals(options.initialProposals ?? []),
    [options.initialProposals],
  );
  const [proposals, setProposals] = useState(initial);
  const [isInitialLoading, setInitialLoading] = useState(
    options.initialProposals === undefined,
  );
  const [isRefreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApprovalReviewLoadError | null>(null);
  const [states, setStates] = useState<Readonly<Record<string, ApprovalReviewDecisionState>>>({});
  const [nowValue, setNowValue] = useState(() => currentTimestamp(options.now));
  const mounted = useRef(false);
  const generation = useRef(0);
  const loadRequest = useRef(0);
  const proposalsRef = useRef(proposals);
  const statesRef = useRef(states);
  const loadController = useRef<AbortController | null>(null);
  const decisions = useRef(new Map<string, AbortController>());
  const identities = useRef(new Map<string, ApprovalReviewDecisionIdentity>());
  const identityOwners = useRef(new Map<string, string>());
  const optionsRef = useRef(options);
  optionsRef.current = options;
  proposalsRef.current = proposals;
  statesRef.current = states;

  const publishStates = useCallback((next: Readonly<Record<string, ApprovalReviewDecisionState>>) => {
    statesRef.current = next;
    setStates(next);
  }, []);

  const applyProposals = useCallback((rows: readonly ConversationApprovalProposalRecord[]) => {
    const next = normalizedProposals(rows);
    proposalsRef.current = next;
    const live = new Set(next.map(proposalKey));
    for (const [key, controller] of decisions.current) {
      if (!live.has(key)) {
        controller.abort();
        decisions.current.delete(key);
      }
    }
    const retained: Record<string, ApprovalReviewDecisionState> = {};
    for (const proposal of next) {
      const key = proposalKey(proposal);
      const state = statesRef.current[key];
      if (state !== undefined) retained[key] = state;
    }
    publishStates(Object.freeze(retained));
    setProposals(next);
  }, [publishStates]);

  const refresh = useCallback(async (): Promise<void> => {
    const requestOptions = optionsRef.current;
    const requestGeneration = generation.current;
    const request = ++loadRequest.current;
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    if (proposalsRef.current.length === 0) setInitialLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const rows = await requestOptions.loadProposals(Object.freeze({
        conversationId: requestOptions.conversationId,
        permissionContext: requestOptions.permissionContext,
        signal: controller.signal,
      }));
      if (!mounted.current || controller.signal.aborted ||
        generation.current !== requestGeneration || loadRequest.current !== request) return;
      applyProposals(rows);
      setNowValue(currentTimestamp(requestOptions.now));
    } catch {
      if (!mounted.current || controller.signal.aborted ||
        generation.current !== requestGeneration || loadRequest.current !== request) return;
      setError(LOAD_ERROR);
    } finally {
      if (mounted.current && generation.current === requestGeneration &&
        loadRequest.current === request) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyProposals]);

  useEffect(() => {
    mounted.current = true;
    const requestGeneration = ++generation.current;
    loadRequest.current += 1;
    identities.current.clear();
    identityOwners.current.clear();
    applyProposals(initial);
    setError(null);
    setNowValue(currentTimestamp(options.now));
    void refresh();
    return () => {
      mounted.current = false;
      if (generation.current === requestGeneration) generation.current += 1;
      loadRequest.current += 1;
      loadController.current?.abort();
      loadController.current = null;
      for (const controller of decisions.current.values()) controller.abort();
      decisions.current.clear();
    };
  }, [
    applyProposals,
    initial,
    options.conversationId,
    options.loadProposals,
    options.permissionContext,
    refresh,
  ]);

  useEffect(() => {
    if (options.subscribe === undefined) return;
    const controller = new AbortController();
    const cleanup = options.subscribe(Object.freeze({
      conversationId: options.conversationId,
      permissionContext: options.permissionContext,
      signal: controller.signal,
      refresh: () => {
        if (!controller.signal.aborted) void refresh();
      },
    }));
    return () => {
      controller.abort();
      cleanup?.();
    };
  }, [options.conversationId, options.permissionContext, options.subscribe, refresh]);

  useEffect(() => {
    const expiries = proposals
      .filter((proposal) => proposal.status === "pending")
      .map((proposal) => Date.parse(proposal.expires_at))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > nowValue);
    const nextExpiry = Math.min(...expiries);
    if (!Number.isFinite(nextExpiry)) return;
    const timer = globalThis.setTimeout(() => {
      setNowValue(currentTimestamp(optionsRef.current.now));
    }, Math.min(Math.max(nextExpiry - nowValue, 0) + 1, 2_147_483_647));
    return () => globalThis.clearTimeout(timer);
  }, [nowValue, proposals]);

  const isExpired = useCallback((proposal: ConversationApprovalProposalRecord): boolean => {
    const expires = Date.parse(proposal.expires_at);
    return Number.isFinite(expires) && expires <= nowValue;
  }, [nowValue]);

  const stateFor = useCallback((proposal: ConversationApprovalProposalRecord) =>
    statesRef.current[proposalKey(proposal)] ?? IDLE_STATE, []);

  const canDecide = useCallback((proposal: ConversationApprovalProposalRecord): boolean => {
    if (proposal.status !== "pending" || isExpired(proposal)) return false;
    const code = stateFor(proposal).code;
    return code === "idle" || code === "cancelled" || code === "persistence_failure";
  }, [isExpired, stateFor]);

  const decide = useCallback(async (
    proposal: ConversationApprovalProposalRecord,
    decision: "confirm" | "reject",
  ): Promise<ApprovalReviewDecisionState> => {
    const current = proposalsRef.current.find((row) =>
      row.proposal_id === proposal.proposal_id &&
      row.proposal_version === proposal.proposal_version);
    if (current === undefined || !canDecide(current)) return stateFor(proposal);
    const key = proposalKey(proposal);
    if (decisions.current.has(key)) return statesRef.current[key] ?? IDLE_STATE;

    const requestOptions = optionsRef.current;
    const logicalKey = decisionKey(proposal, decision);
    let identity = identities.current.get(logicalKey);
    if (identity === undefined) {
      try {
        identity = requestOptions.createDecisionIdentity(Object.freeze({
          conversationId: requestOptions.conversationId,
          proposalId: proposal.proposal_id,
          proposalVersion: proposal.proposal_version,
          decision,
        }));
      } catch {
        identity = undefined;
      }
      if (identity === undefined || !validIdentity(identity) ||
        (identityOwners.current.get(identity.idempotencyKey) !== undefined &&
          identityOwners.current.get(identity.idempotencyKey) !== logicalKey)) {
        const invalid = Object.freeze({
          code: "invalid_input",
          retryable: false,
        }) satisfies ApprovalReviewDecisionState;
        publishStates(Object.freeze({ ...statesRef.current, [key]: invalid }));
        requestOptions.onDecisionResult?.(proposal, invalid);
        return invalid;
      }
      identity = Object.freeze({
        idempotencyKey: identity.idempotencyKey,
        idempotencyFingerprint: identity.idempotencyFingerprint,
      });
      identities.current.set(logicalKey, identity);
      identityOwners.current.set(identity.idempotencyKey, logicalKey);
    }

    const controller = new AbortController();
    decisions.current.set(key, controller);
    const busy = Object.freeze({ code: "busy", retryable: false }) satisfies
      ApprovalReviewDecisionState;
    publishStates(Object.freeze({ ...statesRef.current, [key]: busy }));
    let result: ApprovalReviewDecisionState;
    try {
      const decisionInput = Object.freeze({
        permissionContext: requestOptions.permissionContext,
        conversationId: requestOptions.conversationId,
        proposalId: proposal.proposal_id,
        expectedVersion: proposal.proposal_version,
        decision,
        attribution: requestOptions.attribution,
        idempotencyKey: identity.idempotencyKey,
        idempotencyFingerprint: identity.idempotencyFingerprint,
        signal: controller.signal,
      });
      if (requestOptions.transitionHandler !== undefined) {
        const transitioned = await requestOptions.transitionHandler(decisionInput);
        result = transitioned.status === (decision === "confirm" ? "confirmed" : "rejected")
          ? Object.freeze({ code: "accepted", decision: transitioned.status, retryable: false })
          : transitioned.status === "pending"
            ? Object.freeze({ code: "persistence_failure", retryable: true })
            : Object.freeze({ code: "already_decided", currentStatus: transitioned.status, retryable: false });
      } else {
        const handler = requestOptions.decisionHandler ??
          requestOptions.coordinator?.decide.bind(requestOptions.coordinator);
        if (handler === undefined) throw new TypeError("Decision handler is unavailable.");
        result = safeResult(await handler(decisionInput));
      }
    } catch {
      result = controller.signal.aborted
        ? Object.freeze({ code: "cancelled", retryable: true })
        : Object.freeze({ code: "persistence_failure", retryable: true });
    }
    if (decisions.current.get(key) !== controller) return result;
    decisions.current.delete(key);
    const stillCurrent = proposalsRef.current.some((row) =>
      row.proposal_id === proposal.proposal_id &&
      row.proposal_version === proposal.proposal_version);
    if (!mounted.current || controller.signal.aborted || !stillCurrent) return result;
    publishStates(Object.freeze({ ...statesRef.current, [key]: result }));
    requestOptions.onDecisionResult?.(proposal, result);
    return result;
  }, [canDecide, publishStates, stateFor]);

  const groups = useMemo(() => groupedProposals(proposals), [proposals]);
  return useMemo(() => ({
    proposals,
    groups,
    isInitialLoading,
    isRefreshing,
    error,
    refresh,
    confirm: (proposal: ConversationApprovalProposalRecord) => decide(proposal, "confirm"),
    reject: (proposal: ConversationApprovalProposalRecord) => decide(proposal, "reject"),
    decisionState: stateFor,
    isExpired,
    canDecide,
    clearError: () => setError(null),
  }), [
    canDecide,
    decide,
    error,
    groups,
    isExpired,
    isInitialLoading,
    isRefreshing,
    proposals,
    refresh,
    stateFor,
  ]);
}

const ApprovalReviewContext = createContext<ApprovalReviewController | null>(null);
const ApprovalReviewItemContext = createContext<ConversationApprovalProposalRecord | null>(null);

function useReview(explicit?: ApprovalReviewController): ApprovalReviewController {
  const context = useContext(ApprovalReviewContext);
  const review = explicit ?? context;
  if (review === null) throw new TypeError("An ApprovalReview controller is required.");
  return review;
}

function useProposal(
  explicit?: ConversationApprovalProposalRecord,
): ConversationApprovalProposalRecord {
  const context = useContext(ApprovalReviewItemContext);
  const proposal = explicit ?? context;
  if (proposal === null) throw new TypeError("An approval proposal is required.");
  return proposal;
}

function restoreApprovalFocus(element: HTMLButtonElement): void {
  globalThis.setTimeout(() => {
    if (element.isConnected && !element.disabled) {
      element.focus();
      return;
    }
    const root = element.closest<HTMLElement>("[data-approval-review-root]") ?? document.body;
    const next = root.querySelector<HTMLButtonElement>("button:not(:disabled)");
    (next ?? root.querySelector<HTMLElement>("[data-approval-review-list]"))?.focus();
  }, 0);
}

export interface ApprovalReviewRootNativeProps extends HTMLAttributes<HTMLDivElement> {
  "data-approval-review-root"?: string;
}

export interface ApprovalReviewRootProps extends ApprovalReviewRootNativeProps {
  readonly controller: ApprovalReviewController;
  readonly render?: PrimitiveRender<HTMLDivElement, ApprovalReviewRootNativeProps>;
}

export const ApprovalReviewRoot = forwardRef<HTMLDivElement, ApprovalReviewRootProps>(
  function ApprovalReviewRoot({ children, controller, render, ...props }, forwardedRef) {
    const nativeProps: ApprovalReviewRootNativeProps = {
      ...props,
      children: children ?? <>
        <ApprovalReviewLoading />
        <ApprovalReviewErrorMessage />
        <ApprovalReviewEmpty />
        <ApprovalReviewList />
      </>,
      "aria-busy": props["aria-busy"] ?? Boolean(
        controller.isInitialLoading || controller.isRefreshing ||
        controller.proposals.some((proposal) =>
          controller.decisionState(proposal).code === "busy"),
      ),
      "data-approval-review-root": "",
    };
    return (
      <ApprovalReviewContext.Provider value={controller}>
        {render
          ? render(nativeProps, forwardedRef)
          : <div {...nativeProps} ref={forwardedRef} />}
      </ApprovalReviewContext.Provider>
    );
  },
);

export type ApprovalReviewGroupRenderer = (
  group: ApprovalReviewGroupModel,
  index: number,
) => ReactNode;

export interface ApprovalReviewListNativeProps extends HTMLAttributes<HTMLDivElement> {
  "data-approval-review-list"?: string;
}

export interface ApprovalReviewListProps
  extends Omit<ApprovalReviewListNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: ApprovalReviewController;
  readonly render?: PrimitiveRender<HTMLDivElement, ApprovalReviewListNativeProps>;
  readonly renderGroup?: ApprovalReviewGroupRenderer;
}

export const ApprovalReviewList = forwardRef<HTMLDivElement, ApprovalReviewListProps>(
  function ApprovalReviewList(
    { children, controller: explicit, render, renderGroup, ...props },
    forwardedRef,
  ) {
    const controller = useReview(explicit);
    const content = children ?? controller.groups.map((group, index) => (
      <div key={group.key} role="listitem">
        {renderGroup?.(group, index) ?? <ApprovalReviewGroup group={group} />}
      </div>
    ));
    const nativeProps: ApprovalReviewListNativeProps = {
      ...props,
      children: content,
      role: props.role ?? "list",
      "aria-label": props["aria-label"] ?? "Approval proposals",
      "aria-busy": props["aria-busy"] ?? Boolean(
        controller.isInitialLoading || controller.isRefreshing),
      "data-approval-review-list": "",
      tabIndex: props.tabIndex ?? -1,
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <div {...nativeProps} ref={forwardedRef} />;
  },
);

export type ApprovalReviewItemRenderer = (
  proposal: ConversationApprovalProposalRecord,
  index: number,
) => ReactNode;

export interface ApprovalReviewGroupNativeProps extends HTMLAttributes<HTMLElement> {
  "data-approval-group-id"?: string;
}

export interface ApprovalReviewGroupProps
  extends Omit<ApprovalReviewGroupNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly group: ApprovalReviewGroupModel;
  readonly render?: PrimitiveRender<HTMLElement, ApprovalReviewGroupNativeProps>;
  readonly renderItem?: ApprovalReviewItemRenderer;
}

export const ApprovalReviewGroup = forwardRef<HTMLElement, ApprovalReviewGroupProps>(
  function ApprovalReviewGroup(
    { children, group, render, renderItem, ...props },
    forwardedRef,
  ) {
    const label = group.groupId === null
      ? `Approval ${group.proposals[0]?.proposal_id ?? "proposal"}`
      : `Approval group ${group.groupId}`;
    const content = children ?? <>
      <h3>{label}</h3>
      <ul aria-label={`${label} items`}>
        {group.proposals.map((proposal, index) => (
          <Fragment key={proposal.proposal_id}>
            {renderItem?.(proposal, index) ?? <ApprovalReviewItem proposal={proposal} />}
          </Fragment>
        ))}
      </ul>
    </>;
    const nativeProps: ApprovalReviewGroupNativeProps = {
      ...props,
      children: content,
      role: props.role ?? "group",
      "aria-label": props["aria-label"] ?? label,
      ...(group.groupId === null ? {} : { "data-approval-group-id": group.groupId }),
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <section {...nativeProps} ref={forwardedRef} />;
  },
);

export interface ApprovalReviewItemNativeProps extends LiHTMLAttributes<HTMLLIElement> {
  "data-approval-proposal-id"?: string;
  "data-approval-proposal-status"?: string;
  "data-approval-proposal-version"?: number;
}

export interface ApprovalReviewItemProps
  extends Omit<ApprovalReviewItemNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly proposal: ConversationApprovalProposalRecord;
  readonly render?: PrimitiveRender<HTMLLIElement, ApprovalReviewItemNativeProps>;
  readonly renderReviewedArguments?: (
    reviewedArguments: ConversationApprovalProposalRecord["reviewed_arguments"],
    proposal: ConversationApprovalProposalRecord,
  ) => ReactNode;
}

function defaultReviewedArguments(proposal: ConversationApprovalProposalRecord): ReactNode {
  const reviewed = proposal.reviewed_arguments;
  return reviewed.type === "redacted_json"
    ? <StructuredDetails aria-label={`Reviewed arguments for ${proposal.tool_name}`} value={reviewed.value}/>
    : <p>
      <span>Opaque argument reference: </span>
      <code>{reviewed.argument_ref}</code>
    </p>;
}

export const ApprovalReviewItem = forwardRef<HTMLLIElement, ApprovalReviewItemProps>(
  function ApprovalReviewItem(
    { children, proposal, render, renderReviewedArguments, ...props },
    forwardedRef,
  ) {
    const reviewedArguments = renderReviewedArguments?.(
      proposal.reviewed_arguments,
      proposal,
    ) ?? defaultReviewedArguments(proposal);
    const content = children ?? <>
      <h4>{structuredDetailLabel(proposal.tool_name)}</h4>
      <dl>
        <dt>Proposal</dt><dd>{proposal.proposal_id}</dd>
        {proposal.group_id === null ? null : <><dt>Group</dt><dd>{proposal.group_id}</dd></>}
        <dt>Version</dt><dd>{proposal.proposal_version}</dd>
        <dt>Expires</dt><dd>{proposal.expires_at}</dd>
        <dt>Created</dt><dd>{proposal.created_at}</dd>
        <dt>Updated</dt><dd>{proposal.updated_at}</dd>
        <dt>Created by</dt><dd>{proposal.created_attribution.actor.type}</dd>
        <dt>Created through</dt><dd>{proposal.created_attribution.source.type}</dd>
        <dt>Latest actor</dt><dd>{proposal.latest_attribution.actor.type}</dd>
        <dt>Latest source</dt><dd>{proposal.latest_attribution.source.type}</dd>
      </dl>
      {reviewedArguments}
      <ApprovalReviewStatus />
      <div>
        <ApprovalReviewConfirm />
        <ApprovalReviewReject />
      </div>
    </>;
    const nativeProps: ApprovalReviewItemNativeProps = {
      ...props,
      children: content,
      "aria-label": props["aria-label"] ?? `Approval for ${proposal.tool_name}`,
      "data-approval-proposal-id": proposal.proposal_id,
      "data-approval-proposal-status": proposal.status,
      "data-approval-proposal-version": proposal.proposal_version,
    };
    return (
      <ApprovalReviewItemContext.Provider value={proposal}>
        {render
          ? render(nativeProps, forwardedRef)
          : <li {...nativeProps} ref={forwardedRef} />}
      </ApprovalReviewItemContext.Provider>
    );
  },
);

function statusMessage(
  proposal: ConversationApprovalProposalRecord,
  state: ApprovalReviewDecisionState,
  expired: boolean,
): string {
  if (state.code === "accepted") return state.decision === "confirmed"
    ? "Confirmation accepted"
    : "Rejection accepted";
  if (state.code === "busy") return "Decision in progress";
  if (state.code === "version_stale") return "Proposal version is stale";
  if (state.code === "idempotency_conflict") return "Decision identity conflict";
  if (state.code === "conflict") return "Decision conflict";
  if (state.code === "forbidden") return "Decision forbidden";
  if (state.code === "expired" || expired) return "Expired";
  if (state.code === "already_decided") return `Already decided: ${state.currentStatus}`;
  if (state.code === "cancelled") return "Decision cancelled";
  if (state.code === "invalid_input") return "Invalid decision input";
  if (state.code === "not_found") return "Proposal not found";
  if (state.code === "persistence_failure") return "Decision could not be persisted; retry available";
  return proposal.status;
}

export interface ApprovalReviewStatusNativeProps extends HTMLAttributes<HTMLParagraphElement> {
  "data-approval-decision-state"?: ApprovalReviewDecisionCode;
}

export interface ApprovalReviewStatusProps
  extends Omit<ApprovalReviewStatusNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: ApprovalReviewController;
  readonly proposal?: ConversationApprovalProposalRecord;
  readonly render?: PrimitiveRender<HTMLParagraphElement, ApprovalReviewStatusNativeProps>;
}

export const ApprovalReviewStatus = forwardRef<HTMLParagraphElement, ApprovalReviewStatusProps>(
  function ApprovalReviewStatus(
    { children, controller: explicit, proposal: explicitProposal, render, ...props },
    forwardedRef,
  ) {
    const controller = useReview(explicit);
    const proposal = useProposal(explicitProposal);
    const state = controller.decisionState(proposal);
    const message = statusMessage(proposal, state, controller.isExpired(proposal));
    const nativeProps: ApprovalReviewStatusNativeProps = {
      ...props,
      children: children ?? message,
      role: props.role ?? "status",
      "aria-live": props["aria-live"] ?? "polite",
      "aria-label": props["aria-label"] ?? `Approval status for ${proposal.tool_name}: ${message}`,
      "data-approval-decision-state": state.code,
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <p {...nativeProps} ref={forwardedRef} />;
  },
);

export interface ApprovalReviewActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: ApprovalReviewController;
  readonly proposal?: ConversationApprovalProposalRecord;
  readonly render?: PrimitiveRender<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>;
}

function actionButton(
  action: "confirm" | "reject",
  props: ApprovalReviewActionProps,
  forwardedRef: ForwardedRef<HTMLButtonElement>,
): ReactNode {
  const {
    children,
    controller: explicit,
    proposal: explicitProposal,
    onClick,
    render,
    ...rest
  } = props;
  const controller = useReview(explicit);
  const proposal = useProposal(explicitProposal);
  const busy = controller.decisionState(proposal).code === "busy";
  const label = action === "confirm" ? "Confirm" : "Reject";
  const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...rest,
    type: rest.type ?? "button",
    children: children ?? label,
    "aria-label": rest["aria-label"] ?? `${label} ${proposal.tool_name}`,
    "aria-busy": rest["aria-busy"] ?? busy,
    disabled: rest.disabled ?? !controller.canDecide(proposal),
    onClick: (event) => {
      onClick?.(event);
      if (event.defaultPrevented || !controller.canDecide(proposal)) return;
      const element = event.currentTarget;
      const operation = action === "confirm"
        ? controller.confirm(proposal)
        : controller.reject(proposal);
      void operation.finally(() => restoreApprovalFocus(element));
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <button {...nativeProps} ref={forwardedRef} />;
}

export type ApprovalReviewConfirmProps = ApprovalReviewActionProps;

export const ApprovalReviewConfirm = forwardRef<HTMLButtonElement, ApprovalReviewConfirmProps>(
  function ApprovalReviewConfirm(props, forwardedRef) {
    return actionButton("confirm", props, forwardedRef);
  },
);

export type ApprovalReviewRejectProps = ApprovalReviewActionProps;

export const ApprovalReviewReject = forwardRef<HTMLButtonElement, ApprovalReviewRejectProps>(
  function ApprovalReviewReject(props, forwardedRef) {
    return actionButton("reject", props, forwardedRef);
  },
);

export interface ApprovalReviewConditionalProps extends HTMLAttributes<HTMLParagraphElement> {
  readonly controller?: ApprovalReviewController;
  readonly render?: PrimitiveRender<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>;
}

function conditionalParagraph(
  visible: boolean,
  defaultChildren: ReactNode,
  props: ApprovalReviewConditionalProps,
  forwardedRef: ForwardedRef<HTMLParagraphElement>,
): ReactNode {
  const { children, controller, render, ...rest } = props;
  void controller;
  if (!visible) return null;
  const nativeProps: HTMLAttributes<HTMLParagraphElement> = {
    ...rest,
    children: children ?? defaultChildren,
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <p {...nativeProps} ref={forwardedRef} />;
}

export const ApprovalReviewLoading = forwardRef<
  HTMLParagraphElement,
  ApprovalReviewConditionalProps
>(function ApprovalReviewLoading(props, forwardedRef) {
  const controller = useReview(props.controller);
  return conditionalParagraph(
    controller.isInitialLoading || controller.isRefreshing,
    controller.isInitialLoading ? "Loading approval proposals…" : "Refreshing approval proposals…",
    { role: "status", "aria-live": "polite", ...props },
    forwardedRef,
  );
});

export const ApprovalReviewErrorMessage = forwardRef<
  HTMLParagraphElement,
  ApprovalReviewConditionalProps
>(function ApprovalReviewErrorMessage(props, forwardedRef) {
  const controller = useReview(props.controller);
  return conditionalParagraph(
    controller.error !== null,
    controller.error?.message,
    { role: "alert", ...props },
    forwardedRef,
  );
});

export const ApprovalReviewEmpty = forwardRef<
  HTMLParagraphElement,
  ApprovalReviewConditionalProps
>(function ApprovalReviewEmpty(props, forwardedRef) {
  const controller = useReview(props.controller);
  return conditionalParagraph(
    !controller.isInitialLoading && !controller.isRefreshing &&
      controller.error === null && controller.proposals.length === 0,
    "No approval proposals.",
    { role: "status", ...props },
    forwardedRef,
  );
});
