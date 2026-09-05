import {
  CONVERSATION_CITATION_RECORDS_VERSION,
  CONVERSATION_EVENT_VERSION,
  parseConversationEvent,
  type ConversationAttachmentReference,
  type ConversationClientId,
  type ConversationClientMutationId,
  type ConversationDeviceId,
  type ConversationEvent,
  type ConversationEventActor,
  type ConversationEventId,
  type ConversationEventMetadata,
  type ConversationEventPayload,
  type ConversationEventSource,
  type ConversationId,
  type ConversationMessageContentPart,
  type ConversationMessageId,
  type ConversationRevision,
  type ConversationTimestamp,
  type ConversationToolCallId,
  type ConversationTurnCancellationReason,
  type ConversationTurnId,
} from "./conversation/events.js";
import {
  normalizeCitationRecords,
  type Citation,
  type CitationRecordSet,
  type CitationSource,
} from "./citations.js";
import {
  ConversationEventStoreConflictError,
  type ConversationEventCursor,
  type ConversationEventStore,
} from "./conversation/event-store.js";
import {
  ConversationReplayFailure,
  replayConversation,
} from "./conversation/replay.js";
import type { ConversationState } from "./conversation/state.js";
import type { ConversationStore } from "./conversation/store.js";
import {
  parseStreamEvent,
  type ResponseCitationBatchEvent,
  type StreamEvent,
  type TerminalStreamEvent,
} from "./protocol.js";
import {
  createRetryPolicy,
  executeWithRetry,
  type RetryFailure,
  type RetryOperationResult,
  type RetryPolicy,
  type RetryReasonCategory,
} from "./retry.js";
import type {
  ConversationTransport,
  TransportError,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "./transports/types.js";
import {
  parseNormalizedUsageReceipt,
  type NormalizedUsageReceipt,
} from "./usage.js";
import {
  assessProviderContextCheckpoint,
  createProviderContextFingerprint,
  normalizeProviderContextError,
  parseProviderContextCompactionResult,
  parseProviderContextIdempotencyKey,
  parseProviderContextMeasurementResult,
  type ProviderContextCapability,
  type ProviderContextCheckpoint,
  type ProviderContextFingerprint,
  type ProviderContextFingerprintInput,
  type ProviderContextHistoryPosition,
  type ProviderContextIdempotencyKey,
} from "./provider-context.js";
import {
  ProviderContextCheckpointStoreError,
  type ProviderContextCheckpointRecord,
  type ProviderContextCheckpointStore,
} from "./provider-context-checkpoint-store.js";

/*
 * Runtime append retries are deliberately separate from provider retries. A
 * revision race can be rebased without restarting transport, but a constantly
 * changing canonical log must still reject in bounded time.
 */
const MAX_RUNTIME_APPEND_REVISION_RETRIES = 2;
const MAX_PROVIDER_CONTEXT_RETRY_ATTEMPTS = 10;

const RUNTIME_METADATA_KEY = "handrail_runtime";

export type ConversationRuntimeIdKind =
  | "message"
  | "assistant_message"
  | "turn"
  | "mutation"
  | "event"
  | "idempotency";

export interface ConversationRuntimeProviderContextThresholdPolicy {
  /** Compact when the measured provider input reaches this many tokens. */
  readonly compactAtInputTokens: number;
  /** Ask the provider capability to compact to no more than this many tokens. */
  readonly targetInputTokens: number;
  /** Bounded attempts for explicitly retryable capability/store failures. Defaults to 3. */
  readonly maximumAttempts?: number;
}

export interface ConversationRuntimeProviderContextProjectionInput<TRequest> {
  readonly request: TRequest;
  readonly state: ConversationState;
  readonly checkpoint: ProviderContextCheckpoint | null;
}

export interface ConversationRuntimeProviderContextProjection<TRequest, TProviderInput> {
  /** Ephemeral input passed only to the provider-context capability. */
  readonly input: TProviderInput;
  /** Transport request with the supplied checkpoint applied, or the canonical request. */
  readonly request: TRequest;
}

/**
 * Optional provider-neutral acceleration for initial turn starts. Canonical
 * conversation events remain authoritative and are never stored here.
 */
export interface ConversationRuntimeProviderContextOptions<TRequest, TProviderInput = unknown> {
  readonly capability: ProviderContextCapability<TProviderInput>;
  readonly checkpointStore: ProviderContextCheckpointStore;
  readonly threshold: ConversationRuntimeProviderContextThresholdPolicy;
  readonly fingerprintInput:
    | ProviderContextFingerprintInput
    | ((input: Readonly<{ request: TRequest; state: ConversationState }>) =>
        ProviderContextFingerprintInput | Promise<ProviderContextFingerprintInput>);
  readonly project: (
    input: ConversationRuntimeProviderContextProjectionInput<TRequest>,
  ) => ConversationRuntimeProviderContextProjection<TRequest, TProviderInput> |
    Promise<ConversationRuntimeProviderContextProjection<TRequest, TProviderInput>>;
}

export interface ConversationRuntimeOptions<TRequest> {
  readonly conversationId: ConversationId;
  readonly clientId: ConversationClientId;
  readonly deviceId?: ConversationDeviceId;
  readonly transport: ConversationTransport<unknown, TRequest>;
  readonly eventStore: ConversationEventStore;
  /** Deterministic identity source for tests or host-controlled identities. */
  readonly createId?: (kind: ConversationRuntimeIdKind) => string;
  /** RFC 3339 UTC string or Date. Defaults to the current wall-clock time. */
  readonly now?: () => string | Date;
  readonly replayBatchSize?: number;
  /** Poll canonical events independently of provider frames. Omitted disables polling. */
  readonly synchronizationIntervalMilliseconds?: number;
  readonly onSynchronizationError?: (cause: unknown) => void;
  /** Bounded retry behavior. Defaults to createRetryPolicy(). */
  readonly retryPolicy?: RetryPolicy;
  /** Optional provider-context acceleration. Unsupported capabilities are a no-op. */
  readonly providerContext?: ConversationRuntimeProviderContextOptions<TRequest, unknown>;
  /**
   * Trusted host boundary for durably capturing normalized provider receipts.
   * The sink is invoked before the receipt is linked into the conversation log;
   * rejecting capture fails the observation so usage cannot be silently lost.
   */
  readonly usageReceiptSink?: {
    capture(receipt: NormalizedUsageReceipt): Promise<void>;
  };
}

export interface ConversationRuntimeSendMessageInput<TRequest> {
  readonly content: string | readonly ConversationMessageContentPart[];
  readonly attachments?: readonly ConversationAttachmentReference[];
  readonly request: TRequest;
}

export type ConversationRuntimeTurnStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "disconnected"
  | "interrupted";

export interface ConversationRuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface ConversationRuntimeTurnResult {
  readonly turnId: ConversationTurnId;
  readonly status: ConversationRuntimeTurnStatus;
  /** Provider/runtime protocol identity for the observed invocation. */
  readonly requestId: string | null;
  readonly traceId: string | null;
  /** Present when status is completed. */
  readonly outcome: "stop" | "length" | "tool_calls" | null;
  /** The latest transport frame whose effects are durably represented. */
  readonly checkpoint: TurnResumePoint;
  /** Validated usage receipts observed for this durable turn, deduplicated by receipt ID. */
  readonly usageReceipts: readonly NormalizedUsageReceipt[];
  readonly error?: ConversationRuntimeError;
}

export interface ConversationRuntimeContinueTurnInput<TRequest> {
  /** The completed tool-call turn whose protocol request is being continued. */
  readonly precedingTurnId: ConversationTurnId;
  readonly request: TRequest;
}

export type ConversationRuntimeToolLoopEvent = Extract<
  ConversationEventPayload,
  { readonly type:
    | "citation.records_linked"
    | "tool_call.discovered"
    | "tool_call.started"
    | "tool_call.approval_required"
    | "tool_call.result_recorded"
    | "tool_loop.budget_exhausted" }
>;

export type ConversationRuntimeCancellationStatus =
  | "cancellation_requested"
  | "unsupported"
  | "already_terminal"
  | "failed";

export interface ConversationRuntimeCancellationResult {
  readonly turnId: ConversationTurnId;
  readonly status: ConversationRuntimeCancellationStatus;
  readonly reason: ConversationTurnCancellationReason;
  readonly remoteMayStillBeRunning: boolean;
  readonly error?: ConversationRuntimeError;
}

export type ConversationRuntimeObserver = (snapshot: ConversationState) => void;

export interface ConversationRuntime<TRequest> {
  readonly store: ConversationStore;
  getSnapshot(): ConversationState;
  observe(observer: ConversationRuntimeObserver): () => void;
  /** Pull canonical events through the same mutation boundary as stream writes. */
  synchronize?(): Promise<void>;
  sendMessage(
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult>;
  /** Starts a message-free protocol continuation while retaining logical input messages. */
  continueTurn?(
    input: ConversationRuntimeContinueTurnInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult>;
  /** Atomically persists public tool-loop lifecycle evidence. */
  recordToolLoopEvents?(events: readonly ConversationRuntimeToolLoopEvent[]): Promise<void>;
  resumeTurn(turnId: ConversationTurnId): Promise<ConversationRuntimeTurnResult>;
  /** Interrupt only this runtime's current observation; durable history is unchanged. */
  stopObserving(turnId: ConversationTurnId): boolean;
  /** Request authoritative cancellation when the negotiated transport supports it. */
  cancelTurn(
    turnId: ConversationTurnId,
    reason: ConversationTurnCancellationReason,
  ): Promise<ConversationRuntimeCancellationResult>;
  restoreActiveTurn(): Promise<ConversationRuntimeTurnResult | null>;
  destroy(): void;
}

export class ConversationRuntimeDestroyedError extends Error {
  constructor() {
    super("The conversation runtime has been destroyed");
    this.name = "ConversationRuntimeDestroyedError";
  }
}

export class ConversationRuntimeBusyError extends Error {
  constructor() {
    super("The conversation already has an active turn");
    this.name = "ConversationRuntimeBusyError";
  }
}

interface RuntimeMetadata {
  readonly turnId?: ConversationTurnId;
  readonly transportTurnId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sequence?: number;
  readonly frameType?: StreamEvent["type"];
  readonly frameFingerprint?: string;
  readonly citationTargetFingerprint?: string;
  readonly resumeSafe?: boolean;
  readonly checkpoint?: TurnResumePoint;
}

interface TurnProtocolState {
  transportTurnId: string | null;
  requestId: string | null;
  traceId: string | null;
  safeSequence: number | null;
  citationTargetFingerprint: string | null;
  checkpoint: TurnResumePoint;
}

interface EventDraft {
  readonly actor: ConversationEventActor;
  readonly source: ConversationEventSource;
  readonly mutationId?: ConversationClientMutationId;
  readonly metadata?: ConversationEventMetadata;
  readonly payload: ConversationEventPayload;
}

interface FrameState {
  readonly turnId: ConversationTurnId;
  readonly protocol: TurnProtocolState;
  expectedSequence: number;
  assistantMessageId: ConversationMessageId | null;
  citationTargetFingerprint: string | null;
  citationRecords: CitationRecordSet;
  citationSourceFingerprints: Map<string, string>;
  citationFingerprints: Map<string, string>;
  pendingCitationFrames: ResponseCitationBatchEvent[];
  nextCitationOrder: number;
  hasUnsafeFrame: boolean;
  terminal: TerminalStreamEvent | null;
  lastWasTerminal: boolean;
  failure: ConversationRuntimeError | null;
}

type RetryOperationKind = "start" | "resume";

interface RuntimeRetryFailure extends RetryFailure {
  readonly phase: "start" | "observation";
  readonly outcome: ConversationRuntimeTurnResult;
}

class LocalObservationStoppedError extends Error {
  constructor() {
    super("The local turn observation was stopped");
    this.name = "LocalObservationStoppedError";
  }
}

class CancellationRequestedError extends Error {
  constructor() {
    super("Authoritative turn cancellation was requested");
    this.name = "CancellationRequestedError";
  }
}

class ProviderContextPreflightCancelledError extends Error {
  constructor() {
    super("The provider-context operation was cancelled.");
    this.name = "ProviderContextPreflightCancelledError";
  }
}

const EMPTY_CHECKPOINT: TurnResumePoint = Object.freeze({
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
});

/**
 * Hydrate and compose the durable event log, headless projection, and transport.
 * No network observation begins until sendMessage/resumeTurn is called.
 */
export async function createConversationRuntime<TRequest>(
  options: ConversationRuntimeOptions<TRequest>,
): Promise<ConversationRuntime<TRequest>> {
  const replay = await replayConversation({
    conversationId: options.conversationId,
    eventStore: options.eventStore,
    ...(options.replayBatchSize === undefined
      ? {}
      : { readBatchSize: options.replayBatchSize }),
  });
  const store = replay.store;
  const createId = options.createId ?? defaultId;
  const now = options.now ?? (() => new Date());
  const retryPolicy = options.retryPolicy ?? createRetryPolicy();
  const catchUpBatchSize = options.replayBatchSize ?? 500;
  const synchronizationInterval = options.synchronizationIntervalMilliseconds;
  if (synchronizationInterval !== undefined &&
      (!Number.isSafeInteger(synchronizationInterval) || synchronizationInterval < 100 || synchronizationInterval > 300_000)) {
    throw new TypeError("synchronizationIntervalMilliseconds must be between 100 and 300000");
  }
  let synchronizationTimer: ReturnType<typeof setTimeout> | undefined;
  const protocolByTurn = new Map<string, TurnProtocolState>();
  const usageReceiptsByTurn = new Map<
    string,
    Map<string, NormalizedUsageReceipt>
  >();
  const durableFrameKeys = new Set<string>();
  const durableFrameFingerprints = new Map<string, string>();
  const activeObservations = new Map<string, TurnObservation<unknown>>();
  const runningTurns = new Map<string, Promise<ConversationRuntimeTurnResult>>();
  const retryControllers = new Map<string, AbortController>();
  const locallyStoppedTurns = new Set<string>();
  const cancellationRequestedTurns = new Set<string>();
  const requestedCancellationReasons = new Map<string, ConversationTurnCancellationReason>();
  const cancellationOperations = new Map<
    string,
    Promise<ConversationRuntimeCancellationResult>
  >();
  const cancellationControllers = new Map<string, AbortController>();
  let destroyed = false;
  let mutationBoundary: Promise<void> = Promise.resolve();
  let turnAdmissionPending = false;

  await hydrateRuntimeMetadata(
    options.conversationId,
    options.eventStore,
    protocolByTurn,
    durableFrameKeys,
    durableFrameFingerprints,
  );

  const assertUsable = (): void => {
    if (destroyed) throw new ConversationRuntimeDestroyedError();
  };

  const timestamp = (): ConversationTimestamp => {
    const value = now();
    return (value instanceof Date ? value.toISOString() : value) as ConversationTimestamp;
  };

  const runtimeSource = (): ConversationEventSource => ({ type: "runtime" });
  const clientSource = (): ConversationEventSource => ({
    type: "client",
    client_id: options.clientId,
    ...(options.deviceId === undefined ? {} : { device_id: options.deviceId }),
  });

  const persistGenerated = async (
    generateDrafts: (
      durableRevision: ConversationRevision | null,
    ) => readonly EventDraft[],
    beforeGenerate?: () => Promise<void>,
  ): Promise<readonly ConversationEvent[]> => {
    assertUsable();
    let resolveBoundary!: () => void;
    const previousBoundary = mutationBoundary;
    mutationBoundary = new Promise<void>((resolve) => {
      resolveBoundary = resolve;
    });
    await previousBoundary;
    try {
      assertUsable();
      await beforeGenerate?.();
      assertUsable();
      let revisionConflictRetries = 0;
      for (;;) {
        const expectedRevision = store.getSnapshot().revision;
        const drafts = generateDrafts(expectedRevision);
        if (drafts.length === 0) return [];
        if (revisionConflictRetries > 0) {
          assertRebasedDraftsRemainCompatible(store.getSnapshot(), drafts);
        }
        const occurredAt = timestamp();
        const events = drafts.map((draft, index) =>
          parseConversationEvent({
            version: CONVERSATION_EVENT_VERSION,
            event_id: createId("event") as ConversationEventId,
            conversation_id: options.conversationId,
            revision: ((expectedRevision ?? 0) + index + 1) as ConversationRevision,
            occurred_at: occurredAt,
            actor: draft.actor,
            source: draft.source,
            ...(draft.mutationId === undefined
              ? {}
              : { mutation_id: draft.mutationId }),
            ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
            payload: draft.payload,
          }),
        );
        try {
          const appended = await options.eventStore.append({
            conversationId: options.conversationId,
            expectedRevision,
            events,
          });
          assertUsable();
          const storedEvents = appended.entries.map((entry) => entry.event);
          const nextState = await store.applyEvents(storedEvents);
          if (nextState.replay_error !== null) {
            throw new TypeError(
              "Persisted conversation events could not be projected contiguously",
            );
          }
          for (const event of storedEvents) rememberRuntimeMetadata(
            event,
            protocolByTurn,
            durableFrameKeys,
            durableFrameFingerprints,
          );
          return storedEvents;
        } catch (cause) {
          if (
            !(cause instanceof ConversationEventStoreConflictError) ||
            cause.code !== "revision_conflict" ||
            revisionConflictRetries >= MAX_RUNTIME_APPEND_REVISION_RETRIES
          ) {
            throw cause;
          }
          revisionConflictRetries += 1;
          await catchUpRuntimeStore(
            options.conversationId,
            options.eventStore,
            store,
            protocolByTurn,
            durableFrameKeys,
            durableFrameFingerprints,
            catchUpBatchSize,
          );
          assertUsable();
        }
      }
    } finally {
      resolveBoundary();
    }
  };

  const persist = (
    drafts: readonly EventDraft[],
  ): Promise<readonly ConversationEvent[]> => drafts.length === 0
    ? Promise.resolve([])
    : persistGenerated(() => drafts);

  const persistFrameDrafts = (
    drafts: readonly EventDraft[],
  ): Promise<readonly ConversationEvent[]> => drafts.length === 0
    ? Promise.resolve([])
    : persistGenerated(() => drafts.filter((draft) => {
        const runtime = runtimeMetadata(draft.metadata);
        if (
          runtime?.requestId !== undefined &&
          runtime.sequence !== undefined &&
          durableFrameKeys.has(frameKey(runtime.requestId, runtime.sequence))
        ) {
          return false;
        }
        return draft.payload.type !== "citation.records_linked" ||
          !toolLoopEventAlreadyRecorded(store.getSnapshot(), draft.payload);
      }));

  const persistAdmittedTurn = async (
    drafts: readonly EventDraft[],
  ): Promise<readonly ConversationEvent[]> => {
    assertUsable();
    if (
      turnAdmissionPending ||
      store.getSnapshot().active_turn_id !== null
    ) {
      throw new ConversationRuntimeBusyError();
    }
    turnAdmissionPending = true;
    try {
      return await persistGenerated(() => {
        if (store.getSnapshot().active_turn_id !== null) {
          throw new ConversationRuntimeBusyError();
        }
        return drafts;
      }, () => catchUpRuntimeStore(
        options.conversationId,
        options.eventStore,
        store,
        protocolByTurn,
        durableFrameKeys,
        durableFrameFingerprints,
        catchUpBatchSize,
      ));
    } finally {
      turnAdmissionPending = false;
    }
  };

  const result = (
    turnId: ConversationTurnId,
    status: ConversationRuntimeTurnStatus,
    error?: ConversationRuntimeError,
  ): ConversationRuntimeTurnResult => {
    const protocol = protocolByTurn.get(turnId);
    const turn = store.getSnapshot().turns.find((candidate) => candidate.turn_id === turnId);
    return Object.freeze({
      turnId,
      status,
      requestId: protocol?.requestId ?? null,
      traceId: protocol?.traceId ?? null,
      outcome: turn?.outcome ?? null,
      checkpoint: checkpointFor(protocol),
      usageReceipts: Object.freeze([
        ...(usageReceiptsByTurn.get(turnId)?.values() ?? []),
      ]),
      ...(error === undefined
        ? {}
        : {
            error: Object.freeze({
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: error.retryAfterMs }),
            }),
          }),
    });
  };

  const captureUsageReceipt = async (
    turnId: ConversationTurnId,
    transportResult: TurnObservationResult,
  ): Promise<void> => {
    if (
      transportResult.status === "disconnected" ||
      transportResult.usageReceipt === undefined ||
      transportResult.usageReceipt === null
    ) {
      return Promise.resolve();
    }
    let receipt: NormalizedUsageReceipt;
    try {
      receipt = parseNormalizedUsageReceipt(transportResult.usageReceipt);
    } catch {
      // Observation receipts are untrusted transport output. Invalid values are omitted.
      return Promise.resolve();
    }
    if (receipt.conversation_id !== options.conversationId || receipt.turn_id !== turnId) return;
    let receipts = usageReceiptsByTurn.get(turnId);
    if (receipts === undefined) {
      receipts = new Map<string, NormalizedUsageReceipt>();
      usageReceiptsByTurn.set(turnId, receipts);
    }
    if (!receipts.has(receipt.usage_receipt_id)) {
      await options.usageReceiptSink?.capture(receipt);
      receipts.set(receipt.usage_receipt_id, receipt);
    }
    if (store.getSnapshot().usage_receipt_links.some((link) => link.usage_receipt_id === receipt.usage_receipt_id)) return;
    await persist([{
      actor: { type: "assistant" }, source: runtimeSource(),
      payload: { type: "usage.receipt_linked", turn_id: turnId, usage_receipt_id: receipt.usage_receipt_id },
    }]);
  };

  const canonicalTerminalResult = (turnId: ConversationTurnId): ConversationRuntimeTurnResult | null => {
    const turn = store.getSnapshot().turns.find((candidate) => candidate.turn_id === turnId);
    return turn && (turn.status === "completed" || turn.status === "cancelled" || turn.status === "failed")
      ? result(turnId, turn.status, turn.error ?? undefined) : null;
  };

  const refreshCanonicalTerminalResult = async (turnId: ConversationTurnId): Promise<ConversationRuntimeTurnResult | null> => {
    // A projector can finish while our write or acknowledgement fails. Only
    // authoritative history can settle that send; never infer success from text.
    try {
      await persistGenerated(() => [], () => catchUpRuntimeStore(
        options.conversationId, options.eventStore, store, protocolByTurn,
        durableFrameKeys, durableFrameFingerprints, catchUpBatchSize,
      ));
    } catch (cause) {
      if (cause instanceof ConversationRuntimeDestroyedError) throw cause;
      return null;
    }
    return canonicalTerminalResult(turnId);
  };

  const observeTransport = async (
    turnId: ConversationTurnId,
    observation: TurnObservation<unknown>,
  ): Promise<ConversationRuntimeTurnResult> => {
    const protocol = protocolState(protocolByTurn, turnId);
    const assistantMessageId = streamedAssistantMessageId(store.getSnapshot(), turnId);
    const durableCitations = runtimeCitationRecords(
      store.getSnapshot(),
      assistantMessageId,
    );
    const frameState: FrameState = {
      turnId,
      protocol,
      expectedSequence: (protocol.safeSequence ?? -1) + 1,
      assistantMessageId,
      citationTargetFingerprint: protocol.citationTargetFingerprint,
      citationRecords: durableCitations,
      citationSourceFingerprints: new Map(store.getSnapshot().citation_sources.map(
        (source) => [source.source_id, stableRuntimeJson(source)],
      )),
      citationFingerprints: new Map(store.getSnapshot().citations.map(
        (citation) => [citation.citation_id, stableRuntimeJson(citation)],
      )),
      pendingCitationFrames: [],
      nextCitationOrder: nextCitationOrder(durableCitations.citations),
      hasUnsafeFrame: false,
      terminal: null,
      lastWasTerminal: false,
      failure: null,
    };
    // Durable request/sequence keys suppress replayed effects across retries
    // and runtime reconstruction; this map additionally detects conflicts
    // and duplicates received before the current observation ends.
    const liveFrameFingerprints = new Map<string, string>();
    activeObservations.set(turnId, observation);
    let transportResult: TurnObservationResult | null = null;

    try {
      try {
        for await (const rawFrame of observation.events) {
          assertUsable();
          const frame = parseStreamEvent(rawFrame);
          const disposition = acceptFrame(
            frameState,
            frame,
            durableFrameKeys,
            durableFrameFingerprints,
            liveFrameFingerprints,
          );
          if (disposition === "duplicate") continue;

          const drafts = draftsForNonterminalFrame(
            frameState,
            frame,
            createId,
            runtimeSource(),
          );
          if (drafts.length > 0) {
            await persistFrameDrafts(drafts);
            // Another projector can win this frame's append with its own message ID.
            frameState.assistantMessageId = streamedAssistantMessageId(store.getSnapshot(), turnId) ?? frameState.assistantMessageId;
            if (drafts.some((draft) => runtimeMetadata(draft.metadata)?.resumeSafe)) {
              protocol.safeSequence = frame.sequence;
            }
          }
        }
      } catch (cause) {
        if (cause instanceof ConversationRuntimeDestroyedError) throw cause;
        frameState.failure = runtimeFailure(cause);
        observation.disconnect();
      }

      try {
        transportResult = await observation.result;
      } catch (cause) {
        frameState.failure ??= runtimeFailure(cause);
      }
      if (transportResult !== null) {
        await captureUsageReceipt(turnId, transportResult);
      }
      if (frameState.failure !== null) await refreshCanonicalTerminalResult(turnId);
      const alreadyTerminal = canonicalTerminalResult(turnId);
      if (alreadyTerminal) return alreadyTerminal;

      if (
        frameState.failure === null &&
        frameState.pendingCitationFrames.length > 0 &&
        frameState.terminal?.type === "response.completed"
      ) {
        frameState.failure = runtimeFailure(new TypeError(
          "Citation batches require a durable assistant text message target",
        ));
      }

      if (destroyed) throw new ConversationRuntimeDestroyedError();
      if (frameState.failure !== null) {
        return result(turnId, "interrupted", frameState.failure);
      }
      if (frameState.terminal === null || !frameState.lastWasTerminal) {
        const disconnected = transportResult?.status === "disconnected";
        const observationError = transportResult?.status === "failed"
          ? transportResult.error
          : undefined;
        if (transportResult?.status === "disconnected") {
          const disconnectedResult = transportResult;
          let validationFailure: unknown = null;
          await persistGenerated((durableRevision) => {
            if (frameState.pendingCitationFrames.length > 0) return [];
            let checkpoint: TurnResumePoint | null;
            try {
              checkpoint = validatedObservationCheckpoint(
                disconnectedResult.checkpoint,
                protocol.checkpoint,
                durableRevision,
              );
            } catch (cause) {
              validationFailure = cause;
              return [];
            }
            if (checkpoint === null || checkpointsEqual(checkpoint, protocol.checkpoint)) {
              return [];
            }
            const turn = store.getSnapshot().turns.find(
              (candidate) => candidate.turn_id === turnId,
            );
            const status = turn?.status;
            if (
              status !== "queued" && status !== "running" &&
              status !== "waiting_for_tool_result"
            ) {
              validationFailure = new TypeError(
                "A transport checkpoint cannot be applied to a terminal turn",
              );
              return [];
            }
            return [{
              actor: { type: "assistant" },
              source: runtimeSource(),
              metadata: metadataFor({ checkpoint }),
              payload: { type: "turn.status_changed", turn_id: turnId, status },
            }];
          });
          if (validationFailure !== null) {
            return result(turnId, "interrupted", runtimeFailure(validationFailure));
          }
        }
        return result(
          turnId,
          disconnected ? "disconnected" : "interrupted",
          disconnected
            ? undefined
            : observationError ?? {
                code: "missing_terminal",
                message: "The transport observation ended without one terminal response frame",
                retryable: true,
              },
        );
      }
      if (
        transportResult === null ||
        !terminalMatchesResult(frameState.terminal, transportResult)
      ) {
        return result(turnId, "interrupted", {
          code: "terminal_result_conflict",
          message: "The terminal response frame conflicts with the transport result",
          retryable: false,
        });
      }

      const terminal = frameState.terminal;
      const terminalResult = transportResult;
      let validationFailure: unknown = null;
      await persistGenerated((durableRevision) => {
        if (canonicalTerminalResult(turnId)) return [];
        frameState.assistantMessageId = streamedAssistantMessageId(store.getSnapshot(), turnId) ?? frameState.assistantMessageId;
        const terminalDrafts = draftsForTerminal(
          frameState,
          terminal,
          runtimeSource(),
          requestedCancellationReasons.get(turnId) ?? store.getSnapshot().turns.find((turn) => turn.turn_id === turnId)?.cancellation_requested_reason ?? undefined,
        );
        const postPersistenceRevision = (
          (durableRevision ?? 0) + terminalDrafts.length
        ) as ConversationRevision;
        let checkpoint: TurnResumePoint | null;
        try {
          checkpoint = validatedObservationCheckpoint(
            terminalResult.checkpoint,
            protocol.checkpoint,
            postPersistenceRevision,
          );
        } catch (cause) {
          validationFailure = cause;
          return [];
        }
        return checkpoint !== null && !checkpointsEqual(checkpoint, protocol.checkpoint)
          ? draftsForTerminal(
              frameState,
              terminal,
              runtimeSource(),
              requestedCancellationReasons.get(turnId) ?? store.getSnapshot().turns.find((turn) => turn.turn_id === turnId)?.cancellation_requested_reason ?? undefined,
              checkpoint,
            )
          : terminalDrafts;
      });
      if (validationFailure !== null) {
        return result(turnId, "interrupted", runtimeFailure(validationFailure));
      }
      protocol.safeSequence = frameState.terminal.sequence;
      const finalized = canonicalTerminalResult(turnId);
      if (finalized) return finalized;
      switch (frameState.terminal.type) {
        case "response.completed":
          return result(turnId, "completed");
        case "response.cancelled":
          return result(turnId, "cancelled");
        case "response.error":
          return result(turnId, "failed", {
            code: frameState.terminal.error.code,
            message: frameState.terminal.error.message,
            retryable: frameState.terminal.error.retryable,
          });
      }
    } finally {
      if (activeObservations.get(turnId) === observation) {
        activeObservations.delete(turnId);
      }
    }
  };

  const runTurnWithRetry = (
    turnId: ConversationTurnId,
    operationKind: RetryOperationKind,
    attemptOperation: (signal: AbortSignal) => Promise<RetryOperationResult<
      ConversationRuntimeTurnResult,
      RuntimeRetryFailure
    >>,
  ): Promise<ConversationRuntimeTurnResult> => {
    const existing = runningTurns.get(turnId);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    retryControllers.set(turnId, controller);
    const operation = (async () => {
      try {
        const execution = await executeWithRetry(
          () => attemptOperation(controller.signal),
          {
          policy: retryPolicy,
          signal: controller.signal,
          hooks: {
            onAttemptStarted: async ({ attempt }) => {
              const currentOperation =
                protocolByTurn.get(turnId)?.transportTurnId == null
                  ? operationKind
                  : "resume";
              await persist([retryAttemptStartedDraft(
                turnId,
                attempt,
                currentOperation,
                runtimeSource(),
              )]);
            },
            onRetryScheduled: async ({ attempt, reasonCategory, delayMs }) => {
              await persist([retryScheduledDraft(
                turnId,
                attempt,
                reasonCategory,
                delayMs,
                runtimeSource(),
              )]);
            },
            onRetryExhausted: async ({
              attempt,
              reasonCategory,
              exhaustionReason,
            }) => {
              await persist([retryExhaustedDraft(
                turnId,
                attempt,
                reasonCategory,
                exhaustionReason,
                runtimeSource(),
              )]);
            },
          },
          },
        );
        if (execution.ok) return execution.value;
        if (execution.failure.phase === "start") {
          const error = execution.failure.outcome.error ?? {
            code: "internal_error",
            message: "The transport could not start the turn",
            retryable: false,
          };
          await persist([failedTurnDraft(turnId, error, runtimeSource())]);
          return result(turnId, "failed", error);
        }
        return execution.failure.outcome;
      } catch (cause) {
        if (cause instanceof LocalObservationStoppedError) {
          return result(turnId, "disconnected");
        }
        if (cause instanceof CancellationRequestedError) {
          const turn = store.getSnapshot().turns.find(
            (candidate) => candidate.turn_id === turnId,
          );
          if (turn?.status === "cancelled") return result(turnId, "cancelled");
          return result(turnId, "interrupted", {
            code: "cancellation_requested",
            message: "Authoritative cancellation was requested while retrying",
            retryable: false,
          });
        }
        if (cause instanceof ProviderContextPreflightCancelledError) {
          return result(turnId, "interrupted", {
            code: "cancelled",
            message: "The provider-context operation was cancelled.",
            retryable: false,
          });
        }
        // Terminal writes and start-handle acknowledgements can fail outside
        // the frame loop too. Preserve the original error unless this exact
        // admitted turn has an authoritative terminal outcome.
        const settled = await refreshCanonicalTerminalResult(turnId);
        if (settled) return settled;
        throw cause;
      }
    })();
    runningTurns.set(turnId, operation);
    void operation.finally(() => {
      if (runningTurns.get(turnId) === operation) runningTurns.delete(turnId);
      if (retryControllers.get(turnId) === controller) {
        retryControllers.delete(turnId);
      }
    }).catch(() => undefined);
    return operation;
  };

  const resumeTurn = (
    turnId: ConversationTurnId,
  ): Promise<ConversationRuntimeTurnResult> => {
    assertUsable();
    const turn = store.getSnapshot().turns.find((candidate) => candidate.turn_id === turnId);
    if (turn === undefined) throw new TypeError("The requested turn is not durable history");
    if (isTerminalTurnStatus(turn.status)) {
      throw new TypeError("A terminal turn cannot be resumed");
    }
    const protocol = protocolByTurn.get(turnId);
    if (protocol?.transportTurnId === null || protocol?.transportTurnId === undefined) {
      throw new TypeError("The active turn has no durable transport identity");
    }
    locallyStoppedTurns.delete(turnId);
    return runTurnWithRetry(turnId, "resume", async () => {
      const resumed = await options.transport.resumeTurn({
        conversationId: options.conversationId,
        turnId: protocol.transportTurnId!,
        resumeFrom: checkpointFor(protocol),
      });
      if (!resumed.ok) {
        const outcome = result(turnId, "interrupted", resumed.error);
        return {
          ok: false,
          failure: runtimeRetryFailure(resumed.error, "observation", outcome),
        };
      }
      return retryResultForObservation(
        await observeTransport(turnId, resumed.value),
        locallyStoppedTurns.has(turnId) || cancellationRequestedTurns.has(turnId),
      );
    });
  };

  const sendMessage = async (
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult> => {
    assertUsable();
    const content = normalizeMessageContent(input.content);
    const attachments = input.attachments ?? [];
    const messageId = createId("message") as ConversationMessageId;
    const turnId = createId("turn") as ConversationTurnId;
    const startMutationId = createId("mutation") as ConversationClientMutationId;
    const idempotencyKey = createId("idempotency");
    const initialDrafts: EventDraft[] = [
      {
        actor: { type: "user" },
        source: clientSource(),
        mutationId: startMutationId,
        payload: {
          type: "message.created",
          message_id: messageId,
          role: "user",
          content,
        },
      },
      ...attachments.map((attachment): EventDraft => ({
        actor: { type: "user" },
        source: clientSource(),
        mutationId: createId("mutation") as ConversationClientMutationId,
        payload: {
          type: "message.attachment_referenced",
          message_id: messageId,
          attachment: { ...attachment },
        },
      })),
      {
        actor: { type: "assistant" },
        source: runtimeSource(),
        payload: {
          type: "turn.started",
          turn_id: turnId,
          input_message_ids: [messageId],
        },
      },
    ];
    await persistAdmittedTurn(initialDrafts);

    return startPersistedTurn(turnId, startMutationId, idempotencyKey, input.request);
  };

  const prepareProviderContextRequest = async (
    request: TRequest,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<TRequest> => {
    const configuration = options.providerContext;
    if (configuration === undefined || !configuration.capability.supported) {
      return request;
    }
    const capability = configuration.capability;
    try {
      const threshold = validateProviderContextThreshold(configuration.threshold);
      throwIfRuntimeAborted(signal);
      const state = store.getSnapshot();
      const fingerprintInput = typeof configuration.fingerprintInput === "function"
        ? await configuration.fingerprintInput({ request, state })
        : configuration.fingerprintInput;
      throwIfRuntimeAborted(signal);
      const contextFingerprint = createProviderContextFingerprint(fingerprintInput);
      const historyPosition: ProviderContextHistoryPosition = Object.freeze({
        conversation_id: options.conversationId,
        revision: state.revision ?? 0,
        event_id: state.last_event_id,
      });
      const load = () => configuration.checkpointStore.load({
        conversation_id: options.conversationId,
        context_fingerprint: contextFingerprint,
        signal,
      });
      let record = await retryCheckpointStoreOperation(
        load,
        threshold.maximumAttempts,
        signal,
      ).catch((cause) => providerContextFallback(cause, signal, null));
      let checkpoint: ProviderContextCheckpoint | null = null;
      if (record !== null) {
        const assessment = assessProviderContextCheckpoint(record.checkpoint, {
          provider_id: fingerprintInput.model.provider_id,
          context_fingerprint: contextFingerprint,
          history_position: historyPosition,
        });
        if (
          assessment.valid &&
          validCheckpointRecordVersion(record.store_version) &&
          record.conversation_id === options.conversationId &&
          record.context_fingerprint === contextFingerprint
        ) {
          checkpoint = assessment.checkpoint;
        } else {
          const expectedVersion = validCheckpointRecordVersion(record.store_version)
            ? record.store_version
            : null;
          await invalidateProviderContextCheckpoint(
            configuration.checkpointStore,
            options.conversationId,
            contextFingerprint,
            expectedVersion,
            providerContextIdempotencyKey(idempotencyKey, "invalidate"),
            threshold.maximumAttempts,
            signal,
          );
          record = null;
        }
      }

      const projected = await configuration.project({ request, state, checkpoint });
      throwIfRuntimeAborted(signal);
      const measurement = parseProviderContextMeasurementResult(
        await retryProviderContextOperation(
          () => capability.measure({
            input: projected.input,
            context_fingerprint: contextFingerprint,
            history_position: historyPosition,
            checkpoint,
            signal,
          }),
          threshold.maximumAttempts,
          signal,
        ),
      );
      if (!providerContextPositionMatches(
        measurement.context_fingerprint,
        measurement.history_position,
        contextFingerprint,
        historyPosition,
      )) {
        return request;
      }
      if (measurement.input_tokens < threshold.compactAtInputTokens) {
        return projected.request;
      }

      const compactionKey = providerContextIdempotencyKey(idempotencyKey, "compact");
      const compacted = parseProviderContextCompactionResult(
        await retryProviderContextOperation(
          () => capability.compact({
            input: projected.input,
            context_fingerprint: contextFingerprint,
            history_position: historyPosition,
            checkpoint,
            signal,
            idempotency_key: compactionKey,
            target_input_tokens: threshold.targetInputTokens,
          }),
          threshold.maximumAttempts,
          signal,
        ),
      );
      if (compacted.status === "invalidated") {
        if (checkpoint !== null) {
          await invalidateProviderContextCheckpoint(
            configuration.checkpointStore,
            options.conversationId,
            contextFingerprint,
            record?.store_version ?? null,
            providerContextIdempotencyKey(idempotencyKey, "invalidate-result"),
            threshold.maximumAttempts,
            signal,
          );
        }
        return request;
      }
      if (!providerContextPositionMatches(
        compacted.measurement.context_fingerprint,
        compacted.measurement.history_position,
        contextFingerprint,
        historyPosition,
      )) {
        return request;
      }

      let effectiveCheckpoint = compacted.checkpoint;
      if (compacted.status === "compacted" && effectiveCheckpoint !== null) {
        effectiveCheckpoint = await saveProviderContextCheckpoint(
          configuration.checkpointStore,
          effectiveCheckpoint,
          fingerprintInput.model.provider_id,
          record,
          providerContextIdempotencyKey(idempotencyKey, "save"),
          threshold.maximumAttempts,
          signal,
        );
      }
      throwIfRuntimeAborted(signal);
      return (await configuration.project({
        request,
        state,
        checkpoint: effectiveCheckpoint,
      })).request;
    } catch (cause) {
      return providerContextFallback(cause, signal, request);
    }
  };

  const startPersistedTurn = (
    turnId: ConversationTurnId,
    startMutationId: ConversationClientMutationId,
    idempotencyKey: string,
    request: TRequest,
  ): Promise<ConversationRuntimeTurnResult> => {
    const protocol = protocolState(protocolByTurn, turnId);
    let preparedStartInput: Promise<Parameters<
      typeof options.transport.startTurn
    >[0]> | null = null;
    return runTurnWithRetry(turnId, "start", async (signal) => {
      if (protocol.transportTurnId !== null) {
        const resumed = await options.transport.resumeTurn({
          conversationId: options.conversationId,
          turnId: protocol.transportTurnId,
          resumeFrom: checkpointFor(protocol),
        });
        if (!resumed.ok) {
          const outcome = result(turnId, "interrupted", resumed.error);
          return {
            ok: false,
            failure: runtimeRetryFailure(
              resumed.error,
              "observation",
              outcome,
            ),
          };
        }
        return retryResultForObservation(
          await observeTransport(turnId, resumed.value),
          locallyStoppedTurns.has(turnId) || cancellationRequestedTurns.has(turnId),
        );
      }

      preparedStartInput ??= prepareProviderContextRequest(
        request,
        idempotencyKey,
        signal,
      ).then((projectedRequest) => Object.freeze({
        conversationId: options.conversationId,
        conversationTurnId: turnId,
        mutationId: startMutationId,
        idempotencyKey,
        request: projectedRequest,
      }));
      const startInput = await preparedStartInput;
      throwIfRuntimeAborted(signal);
      const started = await options.transport.startTurn(startInput);
      if (!started.ok) {
        const outcome = result(turnId, "failed", started.error);
        return {
          ok: false,
          failure: runtimeRetryFailure(started.error, "start", outcome),
        };
      }
      if (
        started.value.conversationId !== options.conversationId ||
        started.value.mutationId !== startMutationId ||
        started.value.turnId.length === 0
      ) {
        started.value.observation.disconnect();
        const error = {
          code: "invalid_transport_handle",
          message: "The transport returned a handle with conflicting identities",
          retryable: false,
        };
        await persist([failedTurnDraft(turnId, error, runtimeSource())]);
        return { ok: true, value: result(turnId, "failed", error) };
      }

      protocol.transportTurnId = started.value.turnId;
      await persistGenerated(() => canonicalTerminalResult(turnId) ? [] : [{
        actor: { type: "assistant" },
        source: runtimeSource(),
        metadata: metadataFor({ transportTurnId: started.value.turnId }),
        payload: { type: "turn.status_changed", turn_id: turnId, status: "queued" },
      }]);
      return retryResultForObservation(
        await observeTransport(turnId, started.value.observation),
        locallyStoppedTurns.has(turnId) || cancellationRequestedTurns.has(turnId),
      );
    });
  };

  const continueTurn = async (
    input: ConversationRuntimeContinueTurnInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult> => {
    assertUsable();
    const existing = store.getSnapshot().turns.find(
      (turn) => turn.continuation_of_turn_id === input.precedingTurnId,
    );
    if (existing !== undefined) {
      if (!isTerminalTurnStatus(existing.status)) return resumeTurn(existing.turn_id);
      return result(
        existing.turn_id,
        existing.status === "completed"
          ? "completed"
          : existing.status === "cancelled"
            ? "cancelled"
            : "failed",
        existing.error === null ? undefined : existing.error,
      );
    }
    const preceding = store.getSnapshot().turns.find(
      (turn) => turn.turn_id === input.precedingTurnId,
    );
    if (
      preceding === undefined ||
      preceding.status !== "completed" ||
      preceding.outcome !== "tool_calls"
    ) {
      throw new TypeError("A continuation requires a durable completed tool-call turn");
    }
    if (preceding.input_message_ids.length === 0) {
      throw new TypeError("The preceding turn has no durable logical input messages");
    }
    const turnId = createId("turn") as ConversationTurnId;
    const mutationId = createId("mutation") as ConversationClientMutationId;
    const idempotencyKey = createId("idempotency");
    await persistAdmittedTurn([{
      actor: { type: "assistant" },
      source: clientSource(),
      mutationId,
      payload: {
        type: "turn.started",
        turn_id: turnId,
        input_message_ids: [...preceding.input_message_ids],
        continuation_of_turn_id: input.precedingTurnId,
      },
    }]);
    return startPersistedTurn(turnId, mutationId, idempotencyKey, input.request);
  };

  const recordToolLoopEvents = async (
    events: readonly ConversationRuntimeToolLoopEvent[],
  ): Promise<void> => {
    assertUsable();
    await persistGenerated(() => events
      .filter((payload) => !toolLoopEventAlreadyRecorded(store.getSnapshot(), payload))
      .map((payload): EventDraft => ({
        actor: {
          type: payload.type === "tool_loop.budget_exhausted" ? "system" : "tool",
        },
        source: runtimeSource(),
        payload,
      })));
  };

  const stopObserving = (turnId: ConversationTurnId): boolean => {
    assertUsable();
    const observation = activeObservations.get(turnId);
    const retryController = retryControllers.get(turnId);
    if (observation === undefined && retryController === undefined) return false;
    locallyStoppedTurns.add(turnId);
    observation?.disconnect();
    retryController?.abort(new LocalObservationStoppedError());
    return true;
  };

  const waitForTransportTurnId = (
    turnId: ConversationTurnId,
    signal: AbortSignal,
  ): Promise<string | null> => new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => undefined;
    const finish = (value: string | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const aborted = (): void => finish(null, signal.reason ?? new ConversationRuntimeDestroyedError());
    const inspect = (): void => {
      const transportTurnId = protocolByTurn.get(turnId)?.transportTurnId;
      if (transportTurnId !== null && transportTurnId !== undefined) {
        finish(transportTurnId);
        return;
      }
      const turn = store.getSnapshot().turns.find((candidate) => candidate.turn_id === turnId);
      if (turn === undefined || isTerminalTurnStatus(turn.status)) finish(null);
    };
    if (signal.aborted) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    const stopSubscription = store.subscribe(inspect);
    unsubscribe = stopSubscription;
    if (settled) stopSubscription();
    inspect();
  });

  const cancelTurn = (
    turnId: ConversationTurnId,
    reason: ConversationTurnCancellationReason,
  ): Promise<ConversationRuntimeCancellationResult> => {
    assertUsable();
    assertCancellationReason(reason);
    const existing = cancellationOperations.get(turnId);
    if (existing !== undefined) return existing;

    const mutationId = createId("mutation") as ConversationClientMutationId;
    const idempotencyKey = createId("idempotency");
    const controller = new AbortController();
    cancellationControllers.set(turnId, controller);
    const operation = (async (): Promise<ConversationRuntimeCancellationResult> => {
      const turn = store.getSnapshot().turns.find(
        (candidate) => candidate.turn_id === turnId,
      );
      if (turn === undefined) {
        throw new TypeError("The requested turn is not durable history");
      }
      if (isTerminalTurnStatus(turn.status)) {
        return cancellationResult(turnId, reason, "already_terminal", false);
      }

      const protocol = protocolByTurn.get(turnId);
      if (protocol?.transportTurnId === null || protocol?.transportTurnId === undefined) {
        const preflightController = retryControllers.get(turnId);
        if (
          preflightController !== undefined &&
          options.providerContext?.capability.supported === true
        ) {
          cancellationRequestedTurns.add(turnId);
          requestedCancellationReasons.set(turnId, reason);
          preflightController.abort(new CancellationRequestedError());
          await persist([
            cancellationDraft(
              "turn.cancellation_requested",
              turnId,
              reason,
              mutationId,
              clientSource(),
            ),
            {
              actor: { type: "assistant" },
              source: runtimeSource(),
              payload: { type: "turn.cancelled", turn_id: turnId, reason },
            },
          ]);
          return cancellationResult(
            turnId,
            reason,
            "cancellation_requested",
            false,
          );
        }
      }

      const capability = options.transport.capabilities.authoritativeCancellation;
      if (!capability.supported) {
        await persist([cancellationDraft(
          "turn.cancellation_unsupported",
          turnId,
          reason,
          mutationId,
          clientSource(),
        )]);
        stopObserving(turnId);
        return cancellationResult(turnId, reason, "unsupported", true);
      }

      cancellationRequestedTurns.add(turnId);
      requestedCancellationReasons.set(turnId, reason);
      await persist([cancellationDraft(
        "turn.cancellation_requested",
        turnId,
        reason,
        mutationId,
        clientSource(),
      )]);
      let transportTurnId = protocol?.transportTurnId;
      if (transportTurnId === null || transportTurnId === undefined) {
        transportTurnId = await waitForTransportTurnId(turnId, controller.signal);
        if (transportTurnId === null) {
          return cancellationResult(turnId, reason, "already_terminal", false);
        }
      }

      let cancelled;
      try {
        cancelled = await raceWithAbort(
          capability.capability.cancelTurn({
            conversationId: options.conversationId,
            turnId: transportTurnId,
            mutationId,
            idempotencyKey,
            reason,
          }),
          controller.signal,
        );
      } catch (cause) {
        if (cause instanceof ConversationRuntimeDestroyedError) throw cause;
        return cancellationResult(turnId, reason, "failed", true, {
          code: "cancellation_failed",
          message: cause instanceof Error
            ? cause.message
            : "The authoritative cancellation request failed",
          retryable: false,
        });
      }
      if (!cancelled.ok) {
        return cancellationResult(turnId, reason, "failed", true, cancelled.error);
      }
      return cancellationResult(
        turnId,
        reason,
        cancelled.value.status,
        cancelled.value.status === "cancellation_requested",
      );
    })();
    cancellationOperations.set(turnId, operation);
    void operation.finally(() => {
      if (cancellationControllers.get(turnId) === controller) {
        cancellationControllers.delete(turnId);
      }
    }).catch(() => undefined);
    return operation;
  };

  const restoreActiveTurn = (): Promise<ConversationRuntimeTurnResult | null> => {
    assertUsable();
    const activeTurnId = store.getSnapshot().active_turn_id;
    return activeTurnId === null
      ? Promise.resolve(null)
      : resumeTurn(activeTurnId);
  };

  const observe = (observer: ConversationRuntimeObserver): (() => void) => {
    assertUsable();
    return store.subscribe(() => observer(store.getSnapshot()));
  };

  const synchronize = async (): Promise<void> => {
    await persistGenerated(() => [], () => catchUpRuntimeStore(
      options.conversationId, options.eventStore, store, protocolByTurn,
      durableFrameKeys, durableFrameFingerprints, catchUpBatchSize,
    ));
    // A lost stream completion must not keep sendMessage (and the composer)
    // pending after canonical synchronization proves the turn has finished.
    // This detaches observation only; the durable outcome remains authoritative.
    const state = store.getSnapshot();
    for (const [turnId, observation] of activeObservations) {
      const turn = state.turns.find((candidate) => candidate.turn_id === turnId);
      if (turn && isTerminalTurnStatus(turn.status)) observation.disconnect();
    }
  };

  const scheduleSynchronization = (): void => {
    if (destroyed || synchronizationInterval === undefined) return;
    synchronizationTimer = setTimeout(() => {
      void synchronize().catch((cause: unknown) => {
        if (!destroyed) {
          try { options.onSynchronizationError?.(cause); } catch { /* Diagnostics cannot stop polling. */ }
        }
      }).finally(scheduleSynchronization);
    }, synchronizationInterval);
    synchronizationTimer.unref?.();
  };
  scheduleSynchronization();

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(synchronizationTimer);
    for (const controller of retryControllers.values()) {
      controller.abort(new ConversationRuntimeDestroyedError());
    }
    retryControllers.clear();
    for (const controller of cancellationControllers.values()) {
      controller.abort(new ConversationRuntimeDestroyedError());
    }
    cancellationControllers.clear();
    for (const observation of activeObservations.values()) observation.disconnect();
    activeObservations.clear();
    store.destroy();
  };

  return Object.freeze({
    store,
    getSnapshot: () => store.getSnapshot(),
    observe,
    synchronize,
    sendMessage,
    continueTurn,
    recordToolLoopEvents,
    resumeTurn,
    stopObserving,
    cancelTurn,
    restoreActiveTurn,
    destroy,
  });
}

function validateProviderContextThreshold(
  value: ConversationRuntimeProviderContextThresholdPolicy,
): Required<ConversationRuntimeProviderContextThresholdPolicy> {
  const maximumAttempts = value.maximumAttempts ?? 3;
  if (
    !Number.isSafeInteger(value.compactAtInputTokens) ||
    value.compactAtInputTokens <= 0 ||
    !Number.isSafeInteger(value.targetInputTokens) ||
    value.targetInputTokens <= 0 ||
    value.targetInputTokens > value.compactAtInputTokens ||
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts <= 0 ||
    maximumAttempts > MAX_PROVIDER_CONTEXT_RETRY_ATTEMPTS
  ) {
    throw new TypeError("The provider-context threshold policy is invalid");
  }
  return Object.freeze({
    compactAtInputTokens: value.compactAtInputTokens,
    targetInputTokens: value.targetInputTokens,
    maximumAttempts,
  });
}

function throwIfRuntimeAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new ProviderContextPreflightCancelledError();
}

function providerContextFallback<T>(
  cause: unknown,
  signal: AbortSignal,
  fallback: T,
): T {
  throwIfRuntimeAborted(signal);
  if (normalizeProviderContextError(cause, signal).code === "cancelled") {
    throw new ProviderContextPreflightCancelledError();
  }
  return fallback;
}

async function retryProviderContextOperation<T>(
  operation: () => Promise<T>,
  maximumAttempts: number,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    throwIfRuntimeAborted(signal);
    try {
      return await operation();
    } catch (cause) {
      throwIfRuntimeAborted(signal);
      const safe = normalizeProviderContextError(cause, signal);
      if (!safe.retryable || attempt >= maximumAttempts) throw safe;
    }
  }
}

async function retryCheckpointStoreOperation<T>(
  operation: () => Promise<T>,
  maximumAttempts: number,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    throwIfRuntimeAborted(signal);
    try {
      return await operation();
    } catch (cause) {
      throwIfRuntimeAborted(signal);
      if (
        !(cause instanceof ProviderContextCheckpointStoreError) ||
        !cause.retryable ||
        attempt >= maximumAttempts
      ) {
        throw cause;
      }
    }
  }
}

async function invalidateProviderContextCheckpoint(
  store: ProviderContextCheckpointStore,
  conversationId: string,
  contextFingerprint: ProviderContextFingerprint,
  expectedVersion: number | null,
  idempotencyKey: ProviderContextIdempotencyKey,
  maximumAttempts: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    await retryCheckpointStoreOperation(
      () => store.invalidate({
        conversation_id: conversationId,
        context_fingerprint: contextFingerprint,
        expected_version: expectedVersion,
        idempotency_key: idempotencyKey,
        signal,
      }),
      maximumAttempts,
      signal,
    );
  } catch (cause) {
    providerContextFallback(cause, signal, undefined);
  }
}

async function saveProviderContextCheckpoint(
  store: ProviderContextCheckpointStore,
  checkpoint: ProviderContextCheckpoint,
  providerId: string,
  initialRecord: ProviderContextCheckpointRecord | null,
  idempotencyKey: ProviderContextIdempotencyKey,
  maximumAttempts: number,
  signal: AbortSignal,
): Promise<ProviderContextCheckpoint> {
  let expectedVersion = initialRecord?.store_version ?? null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    throwIfRuntimeAborted(signal);
    try {
      const saved = await store.save({
        conversation_id: checkpoint.history_position.conversation_id,
        context_fingerprint: checkpoint.context_fingerprint,
        checkpoint,
        expected_version: expectedVersion,
        idempotency_key: idempotencyKey,
        signal,
      });
      return saved.checkpoint;
    } catch (cause) {
      throwIfRuntimeAborted(signal);
      if (
        cause instanceof ProviderContextCheckpointStoreError &&
        cause.code === "version_conflict"
      ) {
        let current: ProviderContextCheckpointRecord | null;
        try {
          current = await retryCheckpointStoreOperation(
            () => store.load({
              conversation_id: checkpoint.history_position.conversation_id,
              context_fingerprint: checkpoint.context_fingerprint,
              signal,
            }),
            maximumAttempts,
            signal,
          );
        } catch (loadCause) {
          return providerContextFallback(loadCause, signal, checkpoint);
        }
        if (current !== null) {
          const assessment = assessProviderContextCheckpoint(current.checkpoint, {
            provider_id: providerId,
            context_fingerprint: checkpoint.context_fingerprint,
            history_position: checkpoint.history_position,
          });
          if (
            assessment.valid &&
            assessment.checkpoint.history_position.revision ===
              checkpoint.history_position.revision &&
            assessment.checkpoint.history_position.event_id ===
              checkpoint.history_position.event_id
          ) {
            return assessment.checkpoint;
          }
          expectedVersion = validCheckpointRecordVersion(current.store_version)
            ? current.store_version
            : null;
          continue;
        }
        expectedVersion = null;
        continue;
      }
      if (
        cause instanceof ProviderContextCheckpointStoreError &&
        cause.retryable &&
        attempt < maximumAttempts
      ) {
        continue;
      }
      return providerContextFallback(cause, signal, checkpoint);
    }
  }
  return checkpoint;
}

function validCheckpointRecordVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function providerContextPositionMatches(
  actualFingerprint: ProviderContextFingerprint,
  actualPosition: ProviderContextHistoryPosition,
  expectedFingerprint: ProviderContextFingerprint,
  expectedPosition: ProviderContextHistoryPosition,
): boolean {
  return actualFingerprint === expectedFingerprint &&
    actualPosition.conversation_id === expectedPosition.conversation_id &&
    actualPosition.revision === expectedPosition.revision &&
    actualPosition.event_id === expectedPosition.event_id;
}

function providerContextIdempotencyKey(
  identity: string,
  operation: string,
): ProviderContextIdempotencyKey {
  let hash = 2_166_136_261;
  const value = `${identity}\u0000${operation}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return parseProviderContextIdempotencyKey(
    `provider-context:${operation}:${(hash >>> 0).toString(16).padStart(8, "0")}`,
  );
}

function assertRebasedDraftsRemainCompatible(
  state: ConversationState,
  drafts: readonly EventDraft[],
): void {
  for (const { payload } of drafts) {
    if (isPostTurnRuntimeEvidence(payload)) continue;
    if (!("turn_id" in payload) || payload.type === "turn.started") continue;
    const turn = state.turns.find((candidate) => candidate.turn_id === payload.turn_id);
    if (turn === undefined) {
      throw new TypeError("The canonical conversation no longer has the expected active turn");
    }
    if (isTerminalTurnStatus(turn.status)) {
      throw new TypeError("The canonical conversation turn became terminal during append rebase");
    }
    if (state.active_turn_id !== payload.turn_id) {
      throw new TypeError("The canonical conversation no longer has the expected active turn");
    }
  }
}

function isPostTurnRuntimeEvidence(payload: ConversationEventPayload): boolean {
  return payload.type === "citation.records_linked" ||
    payload.type === "tool_call.discovered" ||
    payload.type === "tool_call.started" ||
    payload.type === "tool_call.approval_required" ||
    payload.type === "tool_call.result_recorded" ||
    payload.type === "tool_loop.budget_exhausted";
}

function toolLoopEventAlreadyRecorded(
  state: ConversationState,
  payload: ConversationRuntimeToolLoopEvent,
): boolean {
  if (payload.type === "tool_call.result_recorded") {
    const result = state.tool_calls.find(
      (call) => call.turn_id === payload.turn_id &&
        call.tool_call_id === payload.tool_call_id,
    )?.result;
    if (result === null || result === undefined) return false;
    const expected = {
      content: payload.content,
      is_error: payload.is_error,
      ...(payload.citation_records === undefined
        ? {}
        : { citation_records: payload.citation_records }),
    };
    const actual = {
      content: result.content,
      is_error: result.is_error,
      ...(result.citation_records === undefined
        ? {}
        : { citation_records: result.citation_records }),
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new TypeError("A durable tool result conflicts with a retry");
    }
    return true;
  }
  if (payload.type === "citation.records_linked") {
    for (const source of payload.sources) {
      const existing = state.citation_sources.find(
        (candidate) => candidate.source_id === source.source_id,
      );
      if (existing === undefined) return false;
      if (JSON.stringify(existing) !== JSON.stringify(source)) {
        throw new TypeError("A durable citation source conflicts with a retry");
      }
    }
    for (const citation of payload.citations) {
      const existing = state.citations.find(
        (candidate) => candidate.citation_id === citation.citation_id,
      );
      if (existing === undefined) return false;
      if (JSON.stringify(existing) !== JSON.stringify(citation)) {
        throw new TypeError("A durable citation link conflicts with a retry");
      }
    }
    return true;
  }
  return false;
}

function normalizeMessageContent(
  content: string | readonly ConversationMessageContentPart[],
): ConversationMessageContentPart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((part) => ({ ...part }));
}

function streamedAssistantMessageId(
  state: ConversationState,
  turnId: ConversationTurnId,
): ConversationMessageId | null {
  const matches = state.messages.filter(
    (message) => message.role === "assistant" && message.turn_id === turnId,
  );
  if (matches.length > 1) {
    throw new TypeError("A turn cannot contain multiple streamed assistant messages");
  }
  return matches[0]?.message_id ?? null;
}

function runtimeCitationRecords(
  state: ConversationState,
  assistantMessageId: ConversationMessageId | null,
): CitationRecordSet {
  if (assistantMessageId === null) {
    return normalizeCitationRecords({ sources: [], citations: [] });
  }
  const citations = state.citations.filter(
    (citation) => citation.target.type === "assistant_message" &&
      (citation.target.message_id as string) === (assistantMessageId as string),
  );
  const sourceIds = new Set(citations.map((citation) => citation.source_id));
  return normalizeCitationRecords({
    sources: state.citation_sources.filter((source) => sourceIds.has(source.source_id)),
    citations,
  });
}

function nextCitationOrder(citations: readonly Citation[]): number {
  for (const [index, citation] of citations.entries()) {
    if (citation.order !== index) {
      throw new TypeError("Durable assistant citations do not have contiguous order");
    }
  }
  return citations.length;
}

function stableRuntimeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableRuntimeJson(entry)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableRuntimeJson(object[key])}`
  ).join(",")}}`;
}

function stableRuntimeFingerprint(value: unknown): string {
  const serialized = stableRuntimeJson(value);
  let first = 2_166_136_261;
  let second = 2_166_136_261 ^ serialized.length;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ (code + index), 16_777_619);
  }
  return `${serialized.length.toString(36)}:${(first >>> 0).toString(16).padStart(8, "0")}${
    (second >>> 0).toString(16).padStart(8, "0")
  }`;
}

function frameFingerprint(frame: StreamEvent): string {
  return stableRuntimeFingerprint(frame);
}

function providerCitationTargetFingerprint(frame: ResponseCitationBatchEvent): string {
  return stableRuntimeFingerprint([frame.target.type, frame.target.message_id]);
}

function rememberCitationFrame(
  state: FrameState,
  frame: ResponseCitationBatchEvent,
): void {
  const targetFingerprint = providerCitationTargetFingerprint(frame);
  if (
    state.citationTargetFingerprint !== null &&
    state.citationTargetFingerprint !== targetFingerprint
  ) {
    throw new TypeError("Citation batches must use one assistant output target");
  }
  const firstOrder = frame.citations[0]?.order;
  if (firstOrder !== state.nextCitationOrder) {
    throw new TypeError("Citation order must be contiguous across batches");
  }

  for (const source of frame.sources) {
    const fingerprint = stableRuntimeJson(source);
    const existing = state.citationSourceFingerprints.get(source.source_id);
    if (existing !== undefined && existing !== fingerprint) {
      throw new TypeError("A citation source identity conflicts with durable history");
    }
  }
  for (const citation of frame.citations) {
    if (state.citationFingerprints.has(citation.citation_id)) {
      throw new TypeError("Citation identities must be unique across batches");
    }
  }

  const combined = normalizeCitationRecords({
    sources: [...state.citationRecords.sources, ...frame.sources],
    citations: [...state.citationRecords.citations, ...frame.citations],
  });
  state.citationTargetFingerprint = targetFingerprint;
  state.protocol.citationTargetFingerprint = targetFingerprint;
  state.citationRecords = combined;
  state.nextCitationOrder += frame.citations.length;
  for (const source of frame.sources) {
    state.citationSourceFingerprints.set(source.source_id, stableRuntimeJson(source));
  }
  for (const citation of frame.citations) {
    state.citationFingerprints.set(citation.citation_id, stableRuntimeJson(citation));
  }
}

function citationDraft(
  state: FrameState,
  frame: ResponseCitationBatchEvent,
  source: ConversationEventSource,
  resumeSafe: boolean,
): EventDraft {
  if (state.assistantMessageId === null) {
    throw new TypeError("A citation batch has no canonical assistant message target");
  }
  const messageId = state.assistantMessageId;
  return {
    actor: { type: "assistant" },
    source,
    metadata: metadataFor({
      turnId: state.turnId,
      ...(state.protocol.transportTurnId === null
        ? {}
        : { transportTurnId: state.protocol.transportTurnId }),
      requestId: frame.request_id,
      traceId: frame.trace_id,
      sequence: frame.sequence,
      frameType: frame.type,
      frameFingerprint: frameFingerprint(frame),
      citationTargetFingerprint: providerCitationTargetFingerprint(frame),
      resumeSafe,
    }),
    payload: {
      type: "citation.records_linked",
      citation_records_version: CONVERSATION_CITATION_RECORDS_VERSION,
      target: { type: "assistant_message", message_id: messageId },
      sources: frame.sources.map((sourceRecord): CitationSource => ({
        source_id: sourceRecord.source_id,
        type: sourceRecord.type,
        label: sourceRecord.label,
        ...(sourceRecord.locator === undefined
          ? {}
          : { locator: sourceRecord.locator }),
      })),
      citations: frame.citations.map((citation): Citation => ({
        citation_id: citation.citation_id,
        source_id: citation.source_id,
        order: citation.order,
        target: {
          type: "assistant_message",
          message_id: messageId as never,
        },
      })),
    },
  };
}

function draftsForNonterminalFrame(
  state: FrameState,
  frame: StreamEvent,
  createId: (kind: ConversationRuntimeIdKind) => string,
  source: ConversationEventSource,
): EventDraft[] {
  const metadata = (resumeSafe: boolean): ConversationEventMetadata =>
    metadataFor({
      turnId: state.turnId,
      ...(state.protocol.transportTurnId === null
        ? {}
        : { transportTurnId: state.protocol.transportTurnId }),
      requestId: frame.request_id,
      traceId: frame.trace_id,
      sequence: frame.sequence,
      frameType: frame.type,
      frameFingerprint: frameFingerprint(frame),
      resumeSafe,
    });

  switch (frame.type) {
    case "response.started": {
      const safe = !state.hasUnsafeFrame;
      return [{
        actor: { type: "assistant" },
        source,
        metadata: metadata(safe),
        payload: { type: "turn.status_changed", turn_id: state.turnId, status: "running" },
      }];
    }
    case "response.text.delta": {
      if (frame.delta.length === 0) return [];
      const assistantMessageId = state.assistantMessageId ??
        createId("assistant_message") as ConversationMessageId;
      state.assistantMessageId = assistantMessageId;
      const textDraft: EventDraft = {
        actor: { type: "assistant" },
        source,
        metadata: metadata(!state.hasUnsafeFrame),
        payload: {
          type: "message.text_appended",
          turn_id: state.turnId,
          message_id: assistantMessageId,
          text: frame.delta,
        },
      };
      const pendingCitations = state.pendingCitationFrames.splice(0).map(
        (citationFrame) => citationDraft(state, citationFrame, source, false),
      );
      return [textDraft, ...pendingCitations];
    }
    case "response.tool_call": {
      const safe = !state.hasUnsafeFrame;
      return [{
        actor: { type: "assistant" },
        source,
        metadata: metadata(safe),
        payload: {
          type: "tool_call.requested",
          turn_id: state.turnId,
          tool_call_id: frame.tool_call_id as ConversationToolCallId,
          name: frame.name,
          arguments: frame.arguments,
        },
      }];
    }
    case "response.citation_batch": {
      rememberCitationFrame(state, frame);
      if (state.assistantMessageId === null) {
        state.pendingCitationFrames.push(frame);
        return [];
      }
      return [citationDraft(state, frame, source, !state.hasUnsafeFrame)];
    }
    case "response.usage":
      state.hasUnsafeFrame = true;
      return [];
    case "response.completed":
      return [];
    case "response.cancelled":
    case "response.error":
      state.pendingCitationFrames.length = 0;
      return [];
  }
}

function draftsForTerminal(
  state: FrameState,
  terminal: TerminalStreamEvent,
  source: ConversationEventSource,
  requestedCancellationReason?: ConversationTurnCancellationReason,
  checkpoint?: TurnResumePoint,
): EventDraft[] {
  const metadata = metadataFor({
    turnId: state.turnId,
    ...(state.protocol.transportTurnId === null
      ? {}
      : { transportTurnId: state.protocol.transportTurnId }),
    requestId: terminal.request_id,
    traceId: terminal.trace_id,
    sequence: terminal.sequence,
    frameType: terminal.type,
    frameFingerprint: frameFingerprint(terminal),
    resumeSafe: true,
    ...(checkpoint === undefined ? {} : { checkpoint }),
  });
  if (terminal.type === "response.completed") {
    return [{
      actor: { type: "assistant" },
      source,
      metadata,
      payload: {
        type: "turn.completed",
        turn_id: state.turnId,
        outcome: terminal.outcome,
        output_message_ids:
          state.assistantMessageId === null ? [] : [state.assistantMessageId],
      },
    }];
  }
  if (terminal.type === "response.cancelled") {
    return [{
      actor: { type: "assistant" },
      source,
      metadata,
      payload: {
        type: "turn.cancelled",
        turn_id: state.turnId,
        reason: requestedCancellationReason ?? cancellationReason(terminal.reason),
      },
    }];
  }
  return [{
    actor: { type: "assistant" },
    source,
    metadata,
    payload: {
      type: "turn.failed",
      turn_id: state.turnId,
      error: {
        code: terminal.error.code,
        message: terminal.error.message,
        retryable: terminal.error.retryable,
      },
    },
  }];
}

function acceptFrame(
  state: FrameState,
  frame: StreamEvent,
  durableFrameKeys: ReadonlySet<string>,
  durableFingerprints: ReadonlyMap<string, string>,
  liveFingerprints: Map<string, string>,
): "accepted" | "duplicate" {
  const key = frameKey(frame.request_id, frame.sequence);
  const fingerprint = frameFingerprint(frame);
  const existingFingerprint = liveFingerprints.get(key);
  if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
    throw new TypeError("A replayed request_id and sequence contained conflicting data");
  }
  const durableFingerprint = durableFingerprints.get(key);
  if (durableFingerprint !== undefined && durableFingerprint !== fingerprint) {
    throw new TypeError("A durable request_id and sequence contained conflicting data");
  }
  const known = durableFrameKeys.has(key) || existingFingerprint !== undefined;
  if (frame.sequence < state.expectedSequence) {
    if (!known) throw new TypeError("The transport replayed an unknown stale sequence");
    return "duplicate";
  }
  if (frame.sequence !== state.expectedSequence) {
    throw new TypeError("Transport frame sequences must be contiguous");
  }
  if (state.lastWasTerminal) {
    throw new TypeError("A response frame followed the terminal response frame");
  }
  if (known) {
    liveFingerprints.set(key, fingerprint);
    state.expectedSequence += 1;
    return "duplicate";
  }
  if (state.protocol.requestId === null) {
    if (frame.type !== "response.started" || frame.sequence !== 0) {
      throw new TypeError("The first response frame must be response.started at sequence zero");
    }
    state.protocol.requestId = frame.request_id;
    state.protocol.traceId = frame.trace_id;
  } else if (
    frame.request_id !== state.protocol.requestId ||
    (state.protocol.traceId !== null && frame.trace_id !== state.protocol.traceId)
  ) {
    throw new TypeError("Transport frame stream identities must remain stable");
  }
  if (frame.type === "response.started" && frame.sequence !== 0) {
    throw new TypeError("response.started may appear only once");
  }
  liveFingerprints.set(key, fingerprint);
  state.expectedSequence += 1;
  state.lastWasTerminal = isTerminalFrame(frame);
  if (state.lastWasTerminal) state.terminal = frame as TerminalStreamEvent;
  return "accepted";
}

function terminalMatchesResult(
  terminal: TerminalStreamEvent,
  result: TurnObservationResult | null,
): boolean {
  if (result === null) return false;
  return (
    (terminal.type === "response.completed" && result.status === "completed") ||
    (terminal.type === "response.cancelled" && result.status === "cancelled") ||
    (terminal.type === "response.error" && result.status === "failed")
  );
}

function isTerminalFrame(frame: StreamEvent): frame is TerminalStreamEvent {
  return frame.type === "response.completed" ||
    frame.type === "response.cancelled" ||
    frame.type === "response.error";
}

function failedTurnDraft(
  turnId: ConversationTurnId,
  error: TransportError | ConversationRuntimeError,
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "assistant" },
    source,
    payload: {
      type: "turn.failed",
      turn_id: turnId,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    },
  };
}

function retryAttemptStartedDraft(
  turnId: ConversationTurnId,
  attempt: number,
  operation: RetryOperationKind,
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "assistant" },
    source,
    payload: {
      type: "turn.attempt_started",
      turn_id: turnId,
      attempt,
      operation,
    },
  };
}

function retryScheduledDraft(
  turnId: ConversationTurnId,
  attempt: number,
  reasonCategory: RetryReasonCategory,
  delayMs: number,
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "assistant" },
    source,
    payload: {
      type: "turn.retry_scheduled",
      turn_id: turnId,
      attempt,
      reason_category: reasonCategory,
      delay_ms: delayMs,
    },
  };
}

function retryExhaustedDraft(
  turnId: ConversationTurnId,
  attempt: number,
  reasonCategory: RetryReasonCategory,
  exhaustionReason: "maximum_attempts" | "maximum_elapsed_time",
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "assistant" },
    source,
    payload: {
      type: "turn.retry_exhausted",
      turn_id: turnId,
      attempt,
      reason_category: reasonCategory,
      exhaustion_reason: exhaustionReason,
    },
  };
}

function cancellationDraft(
  type: "turn.cancellation_requested" | "turn.cancellation_unsupported",
  turnId: ConversationTurnId,
  reason: ConversationTurnCancellationReason,
  mutationId: ConversationClientMutationId,
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "user" },
    source,
    mutationId,
    payload: { type, turn_id: turnId, reason },
  };
}

function cancellationResult(
  turnId: ConversationTurnId,
  reason: ConversationTurnCancellationReason,
  status: ConversationRuntimeCancellationStatus,
  remoteMayStillBeRunning: boolean,
  error?: ConversationRuntimeError,
): ConversationRuntimeCancellationResult {
  return Object.freeze({
    turnId,
    status,
    reason,
    remoteMayStillBeRunning,
    ...(error === undefined ? {} : { error: Object.freeze({ ...error }) }),
  });
}

function assertCancellationReason(
  reason: string,
): asserts reason is ConversationTurnCancellationReason {
  if (
    reason !== "user" &&
    reason !== "timeout" &&
    reason !== "superseded" &&
    reason !== "runtime_shutdown"
  ) {
    throw new TypeError("The cancellation reason is not supported");
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", aborted);
    };
    const aborted = (): void => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

function retryResultForObservation(
  outcome: ConversationRuntimeTurnResult,
  suppressRetry = false,
): RetryOperationResult<ConversationRuntimeTurnResult, RuntimeRetryFailure> {
  if (
    suppressRetry ||
    outcome.status === "completed" ||
    outcome.status === "cancelled" ||
    outcome.status === "failed"
  ) {
    return { ok: true, value: outcome };
  }
  const error = outcome.error ?? {
    code: "disconnected",
    message: "The transport observation disconnected before a terminal frame",
    retryable: true,
  };
  return {
    ok: false,
    failure: runtimeRetryFailure(
      error,
      "observation",
      outcome,
      outcome.status === "disconnected" ? "disconnected" : undefined,
    ),
  };
}

function runtimeRetryFailure(
  error: TransportError | ConversationRuntimeError,
  phase: RuntimeRetryFailure["phase"],
  outcome: ConversationRuntimeTurnResult,
  reasonCategory?: RetryReasonCategory,
): RuntimeRetryFailure {
  return Object.freeze({
    retryable: error.retryable,
    reasonCategory: reasonCategory ?? retryReasonCategory(error.code),
    ...("retryAfterMs" in error && error.retryAfterMs !== undefined
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
    phase,
    outcome,
  });
}

function retryReasonCategory(code: string): RetryReasonCategory {
  switch (code) {
    case "rate_limited": return "rate_limit";
    case "timeout": return "timeout";
    case "unavailable": return "unavailable";
    case "internal_error": return "internal";
    default: return "interrupted";
  }
}

function cancellationReason(reason: string): ConversationTurnCancellationReason {
  switch (reason) {
    case "deadline_exceeded": return "timeout";
    case "policy_revoked": return "superseded";
    default: return "runtime_shutdown";
  }
}

function runtimeFailure(cause: unknown): ConversationRuntimeError {
  return {
    code: "invalid_protocol",
    message: cause instanceof Error ? cause.message : "The transport observation failed",
    retryable: false,
  };
}

function metadataFor(metadata: RuntimeMetadata): ConversationEventMetadata {
  const runtime: ConversationEventMetadata = {};
  if (metadata.turnId !== undefined) runtime.turn_id = metadata.turnId;
  if (metadata.transportTurnId !== undefined) runtime.transport_turn_id = metadata.transportTurnId;
  if (metadata.requestId !== undefined) runtime.request_id = metadata.requestId;
  if (metadata.traceId !== undefined) runtime.trace_id = metadata.traceId;
  if (metadata.sequence !== undefined) runtime.sequence = metadata.sequence;
  if (metadata.frameType !== undefined) runtime.frame_type = metadata.frameType;
  if (metadata.frameFingerprint !== undefined) {
    runtime.frame_fingerprint = metadata.frameFingerprint;
  }
  if (metadata.citationTargetFingerprint !== undefined) {
    runtime.citation_target_fingerprint = metadata.citationTargetFingerprint;
  }
  if (metadata.resumeSafe !== undefined) runtime.resume_safe = metadata.resumeSafe;
  if (metadata.checkpoint !== undefined) {
    runtime.checkpoint = {
      last_applied_event_id: metadata.checkpoint.lastAppliedEventId,
      last_applied_cursor: metadata.checkpoint.lastAppliedCursor,
      last_applied_revision: metadata.checkpoint.lastAppliedRevision,
    };
  }
  return { [RUNTIME_METADATA_KEY]: runtime };
}

function runtimeMetadata(metadata: ConversationEventMetadata | undefined): RuntimeMetadata | null {
  if (metadata === undefined) return null;
  const raw = metadata[RUNTIME_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const checkpoint = runtimeCheckpoint(value.checkpoint);
  return {
    ...(typeof value.turn_id === "string"
      ? { turnId: value.turn_id as ConversationTurnId }
      : {}),
    ...(typeof value.transport_turn_id === "string"
      ? { transportTurnId: value.transport_turn_id }
      : {}),
    ...(typeof value.request_id === "string" ? { requestId: value.request_id } : {}),
    ...(typeof value.trace_id === "string" ? { traceId: value.trace_id } : {}),
    ...(Number.isSafeInteger(value.sequence) ? { sequence: value.sequence as number } : {}),
    ...(typeof value.frame_type === "string"
      ? { frameType: value.frame_type as StreamEvent["type"] }
      : {}),
    ...(typeof value.frame_fingerprint === "string"
      ? { frameFingerprint: value.frame_fingerprint }
      : {}),
    ...(typeof value.citation_target_fingerprint === "string"
      ? { citationTargetFingerprint: value.citation_target_fingerprint }
      : {}),
    ...(typeof value.resume_safe === "boolean" ? { resumeSafe: value.resume_safe } : {}),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

function turnIdForEvent(
  event: ConversationEvent,
  metadata: RuntimeMetadata | null,
): ConversationTurnId | null {
  return "turn_id" in event.payload
    ? event.payload.turn_id
    : metadata?.turnId ?? null;
}

function rememberRuntimeMetadata(
  event: ConversationEvent,
  protocolByTurn: Map<string, TurnProtocolState>,
  durableFrameKeys: Set<string>,
  durableFrameFingerprints: Map<string, string>,
): void {
  const metadata = runtimeMetadata(event.metadata);
  const turnId = turnIdForEvent(event, metadata);
  if (metadata === null || turnId === null) return;
  const protocol = protocolState(protocolByTurn, turnId);
  if (metadata.transportTurnId !== undefined) protocol.transportTurnId = metadata.transportTurnId;
  if (metadata.requestId !== undefined) protocol.requestId = metadata.requestId;
  if (metadata.traceId !== undefined) protocol.traceId = metadata.traceId;
  if (metadata.checkpoint !== undefined) protocol.checkpoint = metadata.checkpoint;
  if (metadata.citationTargetFingerprint !== undefined) {
    if (
      protocol.citationTargetFingerprint !== null &&
      protocol.citationTargetFingerprint !== metadata.citationTargetFingerprint
    ) {
      throw new TypeError("Durable citation metadata contains conflicting targets");
    }
    protocol.citationTargetFingerprint = metadata.citationTargetFingerprint;
  }
  if (metadata.requestId !== undefined && metadata.sequence !== undefined) {
    const key = frameKey(metadata.requestId, metadata.sequence);
    durableFrameKeys.add(key);
    if (metadata.frameFingerprint !== undefined) {
      const existing = durableFrameFingerprints.get(key);
      if (existing !== undefined && existing !== metadata.frameFingerprint) {
        throw new TypeError("Durable runtime metadata contains conflicting frames");
      }
      durableFrameFingerprints.set(key, metadata.frameFingerprint);
    }
    if (metadata.resumeSafe === true) {
      protocol.safeSequence = Math.max(protocol.safeSequence ?? -1, metadata.sequence);
    }
  }
}

async function hydrateRuntimeMetadata(
  conversationId: ConversationId,
  eventStore: ConversationEventStore,
  protocolByTurn: Map<string, TurnProtocolState>,
  durableFrameKeys: Set<string>,
  durableFrameFingerprints: Map<string, string>,
): Promise<void> {
  let cursor: ConversationEventCursor | null = null;
  for (;;) {
    const page = await eventStore.read({
      conversationId,
      ...(cursor === null ? {} : { after: { cursor } }),
      limit: 500,
    });
    for (const entry of page.entries) {
      rememberRuntimeMetadata(
        entry.event,
        protocolByTurn,
        durableFrameKeys,
        durableFrameFingerprints,
      );
      cursor = entry.cursor;
    }
    if (!page.hasMore) return;
    if (page.nextCursor === null || (page.entries.length === 0 && page.nextCursor === cursor)) {
      throw new TypeError("The event store returned a non-advancing runtime hydration page");
    }
    cursor = page.nextCursor;
  }
}

async function catchUpRuntimeStore(
  conversationId: ConversationId,
  eventStore: ConversationEventStore,
  store: ConversationStore,
  protocolByTurn: Map<string, TurnProtocolState>,
  durableFrameKeys: Set<string>,
  durableFrameFingerprints: Map<string, string>,
  readBatchSize: number,
): Promise<void> {
  let lastSafeRevision = store.getSnapshot().revision;
  let lastSafeCursor: ConversationEventCursor | null = null;
  let readCursor: ConversationEventCursor | null = null;

  for (;;) {
    const page = await eventStore.read({
      conversationId,
      ...(readCursor !== null
        ? { after: { cursor: readCursor } }
        : lastSafeRevision === null
          ? {}
          : { after: { revision: lastSafeRevision } }),
      limit: readBatchSize,
    });
    const events: ConversationEvent[] = [];
    let pageRevision = lastSafeRevision;
    let pageCursor: ConversationEventCursor | null = lastSafeCursor;

    for (const entry of page.entries) {
      let event: ConversationEvent;
      try {
        event = parseConversationEvent(entry.event);
      } catch (cause) {
        throw runtimeCatchUpFailure("corrupt_event", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: entry.cursor,
          cause,
        });
      }
      if (event.conversation_id !== conversationId) {
        throw runtimeCatchUpFailure("corrupt_event", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: entry.cursor,
          cause: new TypeError("Stored event belongs to another conversation"),
        });
      }
      const expectedRevision = (pageRevision ?? 0) + 1;
      if (event.revision !== expectedRevision) {
        throw runtimeCatchUpFailure("revision_gap", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: entry.cursor,
          expectedRevision,
          receivedRevision: event.revision,
        });
      }
      events.push(event);
      pageRevision = event.revision;
      pageCursor = entry.cursor;
    }

    if (events.length > 0) {
      const nextState = await store.applyEvents(events);
      if (nextState.replay_error !== null || nextState.revision !== pageRevision) {
        throw runtimeCatchUpFailure("corrupt_event", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: pageCursor,
          cause: nextState.replay_error ?? new TypeError(
            "Canonical conversation events could not be projected contiguously",
          ),
        });
      }
      for (const event of events) {
        rememberRuntimeMetadata(
          event,
          protocolByTurn,
          durableFrameKeys,
          durableFrameFingerprints,
        );
      }
      lastSafeRevision = pageRevision;
      lastSafeCursor = pageCursor;
    }

    if (!page.hasMore) {
      if (page.latestRevision !== lastSafeRevision) {
        throw runtimeCatchUpFailure("revision_gap", conversationId, {
          lastSafeCursor,
          lastSafeRevision,
          eventCursor: null,
          expectedRevision: (lastSafeRevision ?? 0) + 1,
          ...(page.latestRevision === null
            ? {}
            : { receivedRevision: page.latestRevision }),
        });
      }
      return;
    }
    if (
      page.entries.length === 0 ||
      page.nextCursor === null ||
      page.nextCursor !== pageCursor
    ) {
      throw runtimeCatchUpFailure("corrupt_event", conversationId, {
        lastSafeCursor,
        lastSafeRevision,
        eventCursor: null,
        cause: new TypeError("Event store returned a non-advancing runtime catch-up page"),
      });
    }
    readCursor = page.nextCursor;
  }
}

function runtimeCatchUpFailure(
  code: "corrupt_event" | "revision_gap",
  conversationId: ConversationId,
  details: Omit<ConstructorParameters<typeof ConversationReplayFailure>[1],
    "code" | "conversationId">,
): ConversationReplayFailure {
  return new ConversationReplayFailure(
    code === "corrupt_event"
      ? "The canonical conversation event log is corrupt"
      : "The canonical conversation event log is not contiguous",
    { code, conversationId, ...details },
  );
}

function protocolState(
  states: Map<string, TurnProtocolState>,
  turnId: string,
): TurnProtocolState {
  const existing = states.get(turnId);
  if (existing !== undefined) return existing;
  const created: TurnProtocolState = {
    transportTurnId: null,
    requestId: null,
    traceId: null,
    safeSequence: null,
    citationTargetFingerprint: null,
    checkpoint: EMPTY_CHECKPOINT,
  };
  states.set(turnId, created);
  return created;
}

function checkpointFor(protocol: TurnProtocolState | undefined): TurnResumePoint {
  return protocol?.checkpoint ?? EMPTY_CHECKPOINT;
}

function validatedObservationCheckpoint(
  raw: unknown,
  current: TurnResumePoint,
  maximumDurableRevision: number | null,
): TurnResumePoint | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("The transport returned an invalid checkpoint");
  }
  const value = raw as Record<string, unknown>;
  const expectedKeys = [
    "lastAppliedEventId",
    "lastAppliedCursor",
    "lastAppliedRevision",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("The transport checkpoint must contain exactly one complete resume point");
  }
  const eventId = value.lastAppliedEventId;
  const cursor = value.lastAppliedCursor;
  const revision = value.lastAppliedRevision;
  if (eventId === null && cursor === null && revision === null) return null;
  if (
    typeof eventId !== "string" || eventId.length === 0 || eventId.length > 4_096 ||
    typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096 ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
  ) {
    throw new TypeError("The transport checkpoint fields are invalid or incomplete");
  }
  if (maximumDurableRevision === null || revision > maximumDurableRevision) {
    throw new TypeError("The transport checkpoint exceeds durably applied observation effects");
  }
  const durableRevision = maximumDurableRevision;
  if (
    current.lastAppliedRevision !== null &&
    (durableRevision < current.lastAppliedRevision ||
      (durableRevision === current.lastAppliedRevision &&
        (eventId !== current.lastAppliedEventId || cursor !== current.lastAppliedCursor)))
  ) {
    throw new TypeError("The transport checkpoint conflicts with the prior durable point");
  }
  return Object.freeze({
    lastAppliedEventId: eventId,
    lastAppliedCursor: cursor,
    lastAppliedRevision: durableRevision,
  });
}

function runtimeCheckpoint(raw: unknown): TurnResumePoint | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const eventId = value.last_applied_event_id;
  const cursor = value.last_applied_cursor;
  const revision = value.last_applied_revision;
  if (
    typeof eventId !== "string" || eventId.length === 0 ||
    typeof cursor !== "string" || cursor.length === 0 ||
    typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    lastAppliedEventId: eventId,
    lastAppliedCursor: cursor,
    lastAppliedRevision: revision as number,
  });
}

function checkpointsEqual(left: TurnResumePoint, right: TurnResumePoint): boolean {
  return left.lastAppliedEventId === right.lastAppliedEventId &&
    left.lastAppliedCursor === right.lastAppliedCursor &&
    left.lastAppliedRevision === right.lastAppliedRevision;
}

function frameKey(requestId: string, sequence: number): string {
  return `${requestId}:${sequence}`;
}

function isTerminalTurnStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

let fallbackIdCounter = 0;
function defaultId(kind: ConversationRuntimeIdKind): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${kind}_${uuid}`;
  fallbackIdCounter += 1;
  return `${kind}_${Date.now().toString(36)}_${fallbackIdCounter.toString(36)}`;
}
