import type { AiDiagnosticSink } from "../diagnostics.js";
import { emitAiDiagnostic } from "../diagnostics.js";
import { jsonValuesEqual } from "../json-equality.js";
import type {
  AuthoritativeCancelTurnResult, CancelTurnInput, ConversationTransport,
  StartTurnInput, TransportError, TransportResult, TurnHandle, TurnObservation,
  TurnObservationResult, TurnResumePoint,
} from "./types.js";

export const DURABLE_APPLICATION_TURN_SCHEMA_VERSION = 1 as const;
export type DurableApplicationTurnStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface DurableApplicationTurnEvent<TEvent = unknown> {
  readonly sequence: number;
  readonly checkpoint: TurnResumePoint;
  readonly event: TEvent;
}
export interface DurableApplicationTurnLease { readonly ownerId: string; readonly expiresAt: string }
export interface DurableApplicationTurnCancellation {
  readonly mutationId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly reason: CancelTurnInput["reason"];
  readonly requestedAt: string;
}

/** TStoredRequest may be an opaque reference instead of prompt-bearing input. */
export interface DurableApplicationTurnRecord<TStoredRequest = unknown, TEvent = unknown> {
  readonly schemaVersion: typeof DURABLE_APPLICATION_TURN_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly turnId: string;
  readonly mutationId: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  /** Null only for a cancellation that atomically reserved the turn before start. */
  readonly request: TStoredRequest | null;
  readonly cancelledBeforeStart?: true;
  readonly delegateTurnId: string | null;
  readonly status: DurableApplicationTurnStatus;
  readonly attempt: number;
  readonly events: readonly DurableApplicationTurnEvent<TEvent>[];
  readonly terminal: TurnObservationResult | null;
  readonly cancellation: DurableApplicationTurnCancellation | null;
  readonly lease: DurableApplicationTurnLease | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface DurableApplicationTurnDocument<TStoredRequest = unknown, TEvent = unknown> {
  readonly version: number;
  readonly record: DurableApplicationTurnRecord<TStoredRequest, TEvent>;
}
export type DurableApplicationTurnCreateResult<TStoredRequest, TEvent> =
  | { readonly status: "created" | "idempotent"; readonly document: DurableApplicationTurnDocument<TStoredRequest, TEvent> }
  | { readonly status: "conflict"; readonly document: DurableApplicationTurnDocument<TStoredRequest, TEvent> | null };
export type DurableApplicationTurnWriteResult<TStoredRequest, TEvent> =
  | { readonly status: "updated"; readonly document: DurableApplicationTurnDocument<TStoredRequest, TEvent> }
  | { readonly status: "conflict"; readonly document: DurableApplicationTurnDocument<TStoredRequest, TEvent> | null };

export interface DurableApplicationTurnStore<TStoredRequest = unknown, TEvent = unknown> {
  load(conversationId: string, turnId: string): Promise<DurableApplicationTurnDocument<TStoredRequest, TEvent> | null>;
  create(record: DurableApplicationTurnRecord<TStoredRequest, TEvent>): Promise<DurableApplicationTurnCreateResult<TStoredRequest, TEvent>>;
  compareAndSet(input: { readonly conversationId: string; readonly turnId: string; readonly expectedVersion: number;
    readonly record: DurableApplicationTurnRecord<TStoredRequest, TEvent> }): Promise<DurableApplicationTurnWriteResult<TStoredRequest, TEvent>>;
  /** Bounded recovery scan. Production stores must never return terminal rows. */
  listRecoverable?(limit: number): Promise<readonly DurableApplicationTurnDocument<TStoredRequest, TEvent>[]>;
}
export interface DurableApplicationTurnRequestCodec<TRequest, TStoredRequest> {
  readonly encode: (request: TRequest) => TStoredRequest | Promise<TStoredRequest>;
  /** Abort host input lookups when preparation is cancelled or loses ownership. */
  readonly decode: (stored: TStoredRequest, context?: { readonly signal: AbortSignal }) => TRequest | Promise<TRequest>;
  readonly fingerprint: (request: TRequest) => string | Promise<string>;
}
export interface DurableApplicationTransportOptions<TEvent, TRequest, TStoredRequest> {
  readonly delegate: ConversationTransport<TEvent, TRequest>;
  readonly store: DurableApplicationTurnStore<TStoredRequest, TEvent>;
  readonly requestCodec: DurableApplicationTurnRequestCodec<TRequest, TStoredRequest>;
  readonly checkpointForEvent: (event: TEvent) => TurnResumePoint;
  readonly workerId: string;
  readonly leaseMilliseconds?: number;
  readonly pollMilliseconds?: number;
  readonly maximumAttempts?: number;
  readonly maximumCasAttempts?: number;
  readonly now?: () => number;
  readonly diagnostics?: AiDiagnosticSink;
  /** Published by the durable writer, even when no browser is observing the turn. */
  readonly onTurnStatusChanged?: (status: DurableApplicationTurnStatusUpdate) => void | Promise<void>;
}
export interface DurableApplicationTurnStatusUpdate {
  readonly conversationId: string;
  readonly turnId: string;
  readonly status: DurableApplicationTurnStatus;
  readonly updatedAt: string;
  readonly version: number;
}
export interface DurableApplicationTransport<TEvent, TRequest> extends ConversationTransport<TEvent, TRequest> {
  /** Trusted caller must first verify this turn was canonically admitted and authorized. */
  cancelTurnBeforeStart(input: CancelTurnInput): Promise<TransportResult<AuthoritativeCancelTurnResult>>;
  recoverTurn(conversationId: string, turnId: string): Promise<TransportResult<{ readonly status: "started" | "already_running" | "terminal" }>>;
  recoverPending(limit?: number): Promise<readonly { readonly conversationId: string; readonly turnId: string }[]>;
}

const EMPTY_CHECKPOINT: TurnResumePoint = Object.freeze({ lastAppliedEventId: null, lastAppliedCursor: null,
  lastAppliedRevision: null });
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function identifier(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}
function timestamp(value: number): string { return new Date(value).toISOString(); }
function terminalStatus(status: DurableApplicationTurnStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}
export function durableApplicationTurnStartMatches<TStoredRequest, TEvent>(current: DurableApplicationTurnRecord<TStoredRequest, TEvent>,
  proposed: DurableApplicationTurnRecord<TStoredRequest, TEvent>): boolean {
  return current.conversationId === proposed.conversationId && current.turnId === proposed.turnId &&
    current.mutationId === proposed.mutationId && current.idempotencyKey === proposed.idempotencyKey &&
    current.requestFingerprint === proposed.requestFingerprint && jsonValuesEqual(current.request, proposed.request);
}
function normalizeCheckpoint(value: TurnResumePoint): TurnResumePoint {
  const stringOrNull = (item: unknown) => item === null || typeof item === "string";
  if (!stringOrNull(value.lastAppliedEventId) || !stringOrNull(value.lastAppliedCursor) ||
    (value.lastAppliedRevision !== null && (!Number.isSafeInteger(value.lastAppliedRevision) || value.lastAppliedRevision < 0))) {
    throw new TypeError("Turn resume checkpoint is invalid");
  }
  return Object.freeze({ ...value });
}
function observationStart<TStoredRequest, TEvent>(record: DurableApplicationTurnRecord<TStoredRequest, TEvent>,
  checkpoint: TurnResumePoint): number {
  if (checkpoint.lastAppliedEventId === null && checkpoint.lastAppliedCursor === null && checkpoint.lastAppliedRevision === null) return 0;
  // The runtime stores the canonical conversation revision after applying each
  // frame. That revision includes user/tool events and differs from the worker's
  // frame sequence. Resolve a retained frame by its opaque identity/cursor; only
  // revision-only transports use the revision to locate it.
  const hasIdentity = checkpoint.lastAppliedEventId !== null || checkpoint.lastAppliedCursor !== null;
  const index = record.events.findIndex((entry) => entry.checkpoint.lastAppliedEventId === checkpoint.lastAppliedEventId &&
    entry.checkpoint.lastAppliedCursor === checkpoint.lastAppliedCursor &&
    (hasIdentity || entry.checkpoint.lastAppliedRevision === checkpoint.lastAppliedRevision));
  if (index < 0) throw new TypeError("Turn resume checkpoint was not found");
  return index + 1;
}
function safeFailure(code: TransportError["code"], message: string, retryable: boolean): TransportResult<never> {
  return { ok: false, error: { code, message, retryable } };
}
function cancellationFingerprint(input: CancelTurnInput): string {
  return JSON.stringify({ conversationId: input.conversationId, turnId: input.turnId, reason: input.reason });
}

/** Deterministic process-local store for tests and single-process development. */
export class InMemoryDurableApplicationTurnStore<TStoredRequest = unknown, TEvent = unknown>
implements DurableApplicationTurnStore<TStoredRequest, TEvent> {
  readonly #documents = new Map<string, DurableApplicationTurnDocument<TStoredRequest, TEvent>>();
  #key(conversationId: string, turnId: string): string { return `${conversationId.length}:${conversationId}${turnId}`; }
  async load(conversationId: string, turnId: string) {
    const document = this.#documents.get(this.#key(conversationId, turnId)); return document ? clone(document) : null;
  }
  async create(record: DurableApplicationTurnRecord<TStoredRequest, TEvent>): Promise<DurableApplicationTurnCreateResult<TStoredRequest, TEvent>> {
    const key = this.#key(record.conversationId, record.turnId), current = this.#documents.get(key);
    if (current) return { status: durableApplicationTurnStartMatches(current.record, record) ? "idempotent" : "conflict", document: clone(current) };
    const document = { version: 1, record: clone(record) }; this.#documents.set(key, document);
    return { status: "created", document: clone(document) };
  }
  async compareAndSet(input: { readonly conversationId: string; readonly turnId: string; readonly expectedVersion: number;
    readonly record: DurableApplicationTurnRecord<TStoredRequest, TEvent> }): Promise<DurableApplicationTurnWriteResult<TStoredRequest, TEvent>> {
    const key = this.#key(input.conversationId, input.turnId), current = this.#documents.get(key);
    if (!current || current.version !== input.expectedVersion) return { status: "conflict", document: current ? clone(current) : null };
    const document = { version: current.version + 1, record: clone(input.record) }; this.#documents.set(key, document);
    return { status: "updated", document: clone(document) };
  }
  async listRecoverable(limit: number) {
    return [...this.#documents.values()].filter((item) => !terminalStatus(item.record.status)).slice(0, limit).map(clone);
  }
}

class LeaseLostError extends Error {}
class PreparationCancelledError extends Error {}

/** Durable idempotency, replay, cross-process cancellation and lease recovery wrapper. */
export function createDurableApplicationTransport<TEvent, TRequest, TStoredRequest>(
  options: DurableApplicationTransportOptions<TEvent, TRequest, TStoredRequest>,
): DurableApplicationTransport<TEvent, TRequest> {
  const workerId = identifier(options.workerId, "workerId"), leaseMilliseconds = options.leaseMilliseconds ?? 15_000;
  const pollMilliseconds = options.pollMilliseconds ?? 250, maximumAttempts = options.maximumAttempts ?? 3;
  const maximumCasAttempts = options.maximumCasAttempts ?? 12, now = options.now ?? Date.now;
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000 || leaseMilliseconds > 300_000 ||
    !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 25 || pollMilliseconds > 30_000 ||
    !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 100 ||
    !Number.isSafeInteger(maximumCasAttempts) || maximumCasAttempts < 1 || maximumCasAttempts > 100) {
    throw new TypeError("Durable application transport limits are invalid");
  }
  const running = new Map<string, Promise<void>>();
  const publishStatus = async (document: DurableApplicationTurnDocument<TStoredRequest, TEvent>) => {
    if (!options.onTurnStatusChanged) return;
    const { conversationId, turnId, status, updatedAt } = document.record;
    try {
      await options.onTurnStatusChanged({ conversationId, turnId, status, updatedAt, version: document.version });
    } catch (cause) {
      emitAiDiagnostic(options.diagnostics, { domain: "activity", operation: "durable_turn_status",
        phase: "failed", conversationId, turnId, code: "activity_update_failed", retryable: true, cause });
    }
  };
  const key = (conversationId: string, turnId: string) => `${conversationId.length}:${conversationId}${turnId}`;
  const update = async (conversationId: string, turnId: string,
    mutate: (record: DurableApplicationTurnRecord<TStoredRequest, TEvent>) => DurableApplicationTurnRecord<TStoredRequest, TEvent> | null) => {
    for (let attempt = 0; attempt < maximumCasAttempts; attempt += 1) {
      const current = await options.store.load(conversationId, turnId); if (!current) return null;
      const next = mutate(current.record); if (next === null) return current;
      const result = await options.store.compareAndSet({ conversationId, turnId, expectedVersion: current.version, record: next });
      if (result.status === "updated") {
        if (current.record.status !== result.document.record.status) await publishStatus(result.document);
        return result.document;
      }
    }
    throw new Error("Durable turn state conflicted repeatedly");
  };
  const settle = async (conversationId: string, turnId: string, result: TurnObservationResult) =>
    update(conversationId, turnId, (record) => {
      if (terminalStatus(record.status)) return null;
      if (record.lease?.ownerId !== workerId) throw new LeaseLostError();
      const status = record.cancellation !== null || result.status === "cancelled" ? "cancelled" :
        result.status === "completed" ? "completed" : "failed";
      const checkpoint = record.events.at(-1)?.checkpoint ?? result.checkpoint ?? EMPTY_CHECKPOINT;
      const usage = result.status === "disconnected" ? {} : result.usageReceipt === undefined ? {} : { usageReceipt: result.usageReceipt };
      const terminal: TurnObservationResult = status === "cancelled" ? { status: "cancelled", checkpoint, ...usage } :
        status === "completed" ? { status: "completed", checkpoint, ...usage } : { status: "failed", checkpoint,
          error: result.status === "failed" ? result.error : { code: "unavailable",
            message: "The durable turn worker stopped before completion.", retryable: true }, ...usage };
      return { ...record, status, terminal, lease: null, updatedAt: timestamp(now()) };
    });

  const decodeRequest = async (conversationId: string, turnId: string,
    claimed: DurableApplicationTurnRecord<TStoredRequest, TEvent>): Promise<TRequest> => {
    const controller = new AbortController();
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
    let interrupt!: (cause: unknown) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject; });
    const monitor = (async () => {
      while (!stopped) {
        await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, pollMilliseconds); });
        if (stopped) return;
        const current = await options.store.load(conversationId, turnId);
        if (stopped) return;
        if (!current || terminalStatus(current.record.status) || current.record.lease?.ownerId !== workerId ||
          current.record.attempt !== claimed.attempt) throw new LeaseLostError();
        if (current.record.cancellation) throw new PreparationCancelledError();
        if (Date.parse(current.record.lease.expiresAt) - now() <= Math.max(pollMilliseconds * 2, leaseMilliseconds / 2)) {
          await update(conversationId, turnId, (record) => {
            if (stopped) return null;
            if (terminalStatus(record.status) || record.lease?.ownerId !== workerId ||
              record.attempt !== claimed.attempt) throw new LeaseLostError();
            if (record.cancellation) throw new PreparationCancelledError();
            const currentTime = now();
            return { ...record, lease: { ownerId: workerId, expiresAt: timestamp(currentTime + leaseMilliseconds) },
              updatedAt: timestamp(currentTime) };
          });
        }
      }
    })().catch((cause: unknown) => { interrupt(cause); controller.abort(); });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (claimed.cancelledBeforeStart) throw new PreparationCancelledError();
          // Normal codecs may themselves use null as an opaque stored value.
          return options.requestCodec.decode(claimed.request as TStoredRequest, { signal: controller.signal });
        }),
        interrupted,
      ]);
    } finally {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
      controller.abort();
      void monitor;
    }
  };

  const run = async (conversationId: string, turnId: string): Promise<void> => {
    let claimed: DurableApplicationTurnDocument<TStoredRequest, TEvent> | null;
    try {
      claimed = await update(conversationId, turnId, (record) => {
        if (terminalStatus(record.status)) return null;
        const currentTime = now();
        if (record.lease && record.lease.ownerId !== workerId && Date.parse(record.lease.expiresAt) > currentTime) return null;
        if (record.attempt >= maximumAttempts) {
          const checkpoint = record.events.at(-1)?.checkpoint ?? EMPTY_CHECKPOINT;
          return { ...record, status: "failed", lease: null, updatedAt: timestamp(currentTime), terminal: {
            status: "failed", checkpoint, error: { code: "unavailable",
              message: "The durable turn exhausted its recovery attempts.", retryable: false } } };
        }
        return { ...record, status: "running", attempt: record.attempt + 1,
          lease: { ownerId: workerId, expiresAt: timestamp(currentTime + leaseMilliseconds) }, updatedAt: timestamp(currentTime) };
      });
      if (!claimed || terminalStatus(claimed.record.status) || claimed.record.lease?.ownerId !== workerId) return;
      if (claimed.record.cancellation) {
        await settle(conversationId, turnId, { status: "cancelled",
          checkpoint: claimed.record.events.at(-1)?.checkpoint ?? EMPTY_CHECKPOINT }); return;
      }
      const request = await decodeRequest(conversationId, turnId, claimed.record);
      // Decoding may await application storage. Revalidate the attempt and
      // renew its lease with CAS before dispatch, so an old decoder cannot run
      // after cancellation or a takeover that occurred while it was suspended.
      const attempt = claimed.record.attempt;
      const ready = await update(conversationId, turnId, (record) => {
        if (terminalStatus(record.status) || record.lease?.ownerId !== workerId || record.attempt !== attempt) return null;
        const currentTime = now();
        return { ...record, lease: { ownerId: workerId, expiresAt: timestamp(currentTime + leaseMilliseconds) },
          updatedAt: timestamp(currentTime) };
      });
      if (!ready || terminalStatus(ready.record.status) || ready.record.lease?.ownerId !== workerId ||
        ready.record.attempt !== attempt) return;
      if (ready.record.cancellation) {
        await settle(conversationId, turnId, { status: "cancelled",
          checkpoint: ready.record.events.at(-1)?.checkpoint ?? EMPTY_CHECKPOINT }); return;
      }
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "durable_turn", phase: "started",
        conversationId, turnId, attempt: claimed.record.attempt });
      const started = await options.delegate.startTurn({ conversationId,
        conversationTurnId: turnId as StartTurnInput<TRequest>["conversationTurnId"], mutationId: claimed.record.mutationId,
        idempotencyKey: claimed.record.idempotencyKey, request }, Object.freeze({
        durableExecution: Object.freeze({ conversationId, turnId, attempt }),
      }));
      if (!started.ok) { await settle(conversationId, turnId, { status: "failed", checkpoint: EMPTY_CHECKPOINT,
        error: started.error }); return; }
      await update(conversationId, turnId, (record) => {
        if (record.lease?.ownerId !== workerId) throw new LeaseLostError();
        return { ...record, delegateTurnId: started.value.turnId, updatedAt: timestamp(now()) };
      });
      let stopped = false;
      const monitor = async () => {
        while (!stopped) {
          await new Promise<void>((resolve) => setTimeout(resolve, pollMilliseconds)); if (stopped) return;
          const current = await options.store.load(conversationId, turnId);
          if (!current || terminalStatus(current.record.status) || current.record.lease?.ownerId !== workerId) {
            started.value.observation.disconnect(); return;
          }
          if (current.record.cancellation) {
            const cancellation = options.delegate.capabilities.authoritativeCancellation;
            if (cancellation.supported) await cancellation.capability.cancelTurn({ conversationId, turnId: started.value.turnId,
              mutationId: current.record.cancellation.mutationId, idempotencyKey: current.record.cancellation.idempotencyKey,
              reason: current.record.cancellation.reason });
            else started.value.observation.disconnect();
            return;
          }
          if (Date.parse(current.record.lease.expiresAt) - now() <= Math.max(pollMilliseconds * 2, leaseMilliseconds / 2)) {
            await update(conversationId, turnId, (record) => {
              if (record.lease?.ownerId !== workerId) throw new LeaseLostError();
              const currentTime = now();
              return { ...record, lease: { ownerId: workerId, expiresAt: timestamp(currentTime + leaseMilliseconds) },
                updatedAt: timestamp(currentTime) };
            });
          }
        }
      };
      const monitoring = monitor();
      try {
        for await (const event of started.value.observation.events) {
          const eventCheckpoint = normalizeCheckpoint(options.checkpointForEvent(event));
          await update(conversationId, turnId, (record) => {
            if (record.lease?.ownerId !== workerId) throw new LeaseLostError();
            const currentTime = now();
            return { ...record, events: [...record.events, { sequence: record.events.length + 1,
              checkpoint: eventCheckpoint, event: clone(event) }],
              lease: { ownerId: workerId, expiresAt: timestamp(currentTime + leaseMilliseconds) }, updatedAt: timestamp(currentTime) };
          });
        }
        const result = await started.value.observation.result; await settle(conversationId, turnId, result);
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "durable_turn",
          phase: result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "cancelled" : "failed",
          conversationId, turnId, attempt: claimed.record.attempt,
          ...(result.status === "failed" ? { code: result.error.code, retryable: result.error.retryable } : {}) });
      } finally { stopped = true; void monitoring.catch(() => undefined); }
    } catch (cause) {
      if (cause instanceof PreparationCancelledError) {
        try { await settle(conversationId, turnId, { status: "cancelled", checkpoint: EMPTY_CHECKPOINT }); }
        catch { /* another worker owns settlement */ }
        return;
      }
      if (!(cause instanceof LeaseLostError)) {
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "durable_turn", phase: "failed",
          conversationId, turnId, code: cause instanceof Error ? cause.name : "unknown", retryable: true, cause });
        try { await settle(conversationId, turnId, { status: "failed", checkpoint: EMPTY_CHECKPOINT,
          error: { code: "unavailable", message: "The durable turn worker failed.", retryable: true } }); } catch { /* lease replaced */ }
      }
    }
  };
  const kick = (conversationId: string, turnId: string): boolean => {
    const operationKey = key(conversationId, turnId); if (running.has(operationKey)) return false;
    const operation = run(conversationId, turnId).finally(() => running.delete(operationKey)); running.set(operationKey, operation);
    void operation.catch(() => undefined); return true;
  };
  const observe = async (document: DurableApplicationTurnDocument<TStoredRequest, TEvent>, resumeFrom: TurnResumePoint): Promise<TurnObservation<TEvent>> => {
    let index = observationStart(document.record, normalizeCheckpoint(resumeFrom)), disconnected = false, checkpoint = resumeFrom;
    let resolveResult!: (result: TurnObservationResult) => void;
    const result = new Promise<TurnObservationResult>((resolve) => { resolveResult = resolve; });
    const events = (async function* () {
      for (;;) {
        if (disconnected) { resolveResult({ status: "disconnected", checkpoint }); return; }
        const current = await options.store.load(document.record.conversationId, document.record.turnId);
        if (!current) { resolveResult({ status: "failed", checkpoint, error: {
          code: "not_found", message: "The durable turn no longer exists.", retryable: false } }); return; }
        while (index < current.record.events.length) { const next = current.record.events[index++]!;
          checkpoint = next.checkpoint; yield clone(next.event); }
        if (current.record.terminal) { resolveResult(clone(current.record.terminal)); return; }
        await new Promise<void>((resolve) => setTimeout(resolve, pollMilliseconds));
      }
    })();
    return { events, result, disconnect() { disconnected = true; } };
  };
  const recoverTurn: DurableApplicationTransport<TEvent, TRequest>["recoverTurn"] = async (conversationId, turnId) => {
    try {
      identifier(conversationId, "conversationId"); identifier(turnId, "turnId");
      const current = await options.store.load(conversationId, turnId);
      if (!current) return safeFailure("not_found", "The durable turn was not found.", false);
      if (terminalStatus(current.record.status)) return { ok: true, value: { status: "terminal" } };
      const liveLease = current.record.lease && Date.parse(current.record.lease.expiresAt) > now();
      if (liveLease && current.record.lease!.ownerId !== workerId) return { ok: true, value: { status: "already_running" } };
      return { ok: true, value: { status: kick(conversationId, turnId) ? "started" : "already_running" } };
    } catch { return safeFailure("unavailable", "The durable turn could not be recovered.", true); }
  };
  const transport: DurableApplicationTransport<TEvent, TRequest> = {
    async cancelTurnBeforeStart(input) {
      try {
        const conversationId = identifier(input.conversationId, "conversationId");
        const turnId = identifier(input.turnId, "turnId");
        const mutationId = identifier(input.mutationId, "mutationId");
        const idempotencyKey = identifier(input.idempotencyKey, "idempotencyKey");
        const fingerprint = cancellationFingerprint(input);
        const requestedAt = timestamp(now());
        const result = await options.store.create({ schemaVersion: DURABLE_APPLICATION_TURN_SCHEMA_VERSION,
          conversationId, turnId, mutationId, idempotencyKey, requestFingerprint: fingerprint,
          request: null, cancelledBeforeStart: true, delegateTurnId: null, status: "cancelled", attempt: 0,
          events: [], terminal: { status: "cancelled", checkpoint: EMPTY_CHECKPOINT },
          cancellation: { mutationId, idempotencyKey, fingerprint, reason: input.reason, requestedAt },
          lease: null, createdAt: requestedAt, updatedAt: requestedAt });
        if (result.status !== "conflict") {
          await publishStatus(result.document);
          return { ok: true, value: { status: "already_terminal" } };
        }
        // Start won the same atomic create. It may already be running, so use
        // ordinary cancellation and let its worker publish terminal state.
        const cancellation = transport.capabilities.authoritativeCancellation;
        if (cancellation.supported) return cancellation.capability.cancelTurn(input);
        return safeFailure("unavailable", "Cancellation is unavailable.", true);
      } catch { return safeFailure("unavailable", "The durable cancellation could not be recorded.", true); }
    },
    capabilities: { ...options.delegate.capabilities, authoritativeCancellation: { supported: true, capability: {
      async cancelTurn(input: CancelTurnInput): Promise<TransportResult<AuthoritativeCancelTurnResult>> {
        try {
          const current = await options.store.load(input.conversationId, input.turnId);
          if (!current) return safeFailure("not_found", "The durable turn was not found.", false);
          if (terminalStatus(current.record.status)) return { ok: true, value: { status: "already_terminal" } };
          const fingerprint = cancellationFingerprint(input);
          if (current.record.cancellation && (current.record.cancellation.idempotencyKey !== input.idempotencyKey ||
            current.record.cancellation.fingerprint !== fingerprint)) return safeFailure("conflict",
              "The cancellation conflicts with the retained request.", false);
          if (!current.record.cancellation) await update(input.conversationId, input.turnId, (record) => ({ ...record,
            cancellation: { mutationId: input.mutationId, idempotencyKey: input.idempotencyKey, fingerprint,
              reason: input.reason, requestedAt: timestamp(now()) }, updatedAt: timestamp(now()) }));
          kick(input.conversationId, input.turnId);
          return { ok: true, value: { status: "cancellation_requested" } };
        } catch { return safeFailure("unavailable", "The durable cancellation could not be recorded.", true); }
      },
    } } },
    async startTurn(input: StartTurnInput<TRequest>): Promise<TransportResult<TurnHandle<TEvent>>> {
      try {
        const conversationId = identifier(input.conversationId, "conversationId");
        const turnId = identifier(input.conversationTurnId, "conversationTurnId");
        const storedRequest = await options.requestCodec.encode(input.request);
        const requestFingerprint = identifier(await options.requestCodec.fingerprint(input.request), "requestFingerprint");
        const currentTime = now();
        const created = await options.store.create({ schemaVersion: DURABLE_APPLICATION_TURN_SCHEMA_VERSION,
          conversationId, turnId, mutationId: identifier(input.mutationId, "mutationId"),
          idempotencyKey: identifier(input.idempotencyKey, "idempotencyKey"), requestFingerprint,
          request: clone(storedRequest), delegateTurnId: null, status: "pending", attempt: 0, events: [], terminal: null,
          cancellation: null, lease: null, createdAt: timestamp(currentTime), updatedAt: timestamp(currentTime) });
        if (created.status === "conflict") {
          const retained = created.document;
          if (retained?.record.cancelledBeforeStart === true && retained.record.status === "cancelled" &&
            retained.record.terminal?.status === "cancelled") {
            return { ok: true, value: { conversationId, turnId, mutationId: input.mutationId,
              observation: await observe(retained, EMPTY_CHECKPOINT) } };
          }
          return safeFailure("conflict", "The turn start conflicts with retained identity.", false);
        }
        if (created.status === "created") await publishStatus(created.document);
        kick(conversationId, turnId);
        return { ok: true, value: { conversationId, turnId, mutationId: input.mutationId,
          observation: await observe(created.document, EMPTY_CHECKPOINT) } };
      } catch (cause) { return safeFailure(cause instanceof TypeError ? "invalid_request" : "unavailable",
        cause instanceof TypeError ? cause.message : "The durable turn could not be started.", !(cause instanceof TypeError)); }
    },
    async resumeTurn(input) {
      try {
        const current = await options.store.load(identifier(input.conversationId, "conversationId"), identifier(input.turnId, "turnId"));
        if (!current) return safeFailure("not_found", "The durable turn was not found.", false);
        observationStart(current.record, normalizeCheckpoint(input.resumeFrom));
        if (!terminalStatus(current.record.status)) kick(input.conversationId, input.turnId);
        return { ok: true, value: await observe(current, input.resumeFrom) };
      } catch (cause) { return safeFailure(cause instanceof TypeError ? "invalid_request" : "unavailable",
        cause instanceof TypeError ? cause.message : "The durable turn could not be resumed.", !(cause instanceof TypeError)); }
    },
    recoverTurn,
    async recoverPending(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("Recovery limit is invalid");
      if (!options.store.listRecoverable) return [];
      const documents = await options.store.listRecoverable(limit), started: { conversationId: string; turnId: string }[] = [];
      for (const document of documents) { const result = await recoverTurn(document.record.conversationId, document.record.turnId);
        if (result.ok && result.value.status === "started") started.push({ conversationId: document.record.conversationId,
          turnId: document.record.turnId }); }
      return Object.freeze(started);
    },
  };
  return Object.freeze(transport);
}
