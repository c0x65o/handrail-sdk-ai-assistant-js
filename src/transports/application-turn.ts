import type { CancelTurnInput, ConversationTransport, DurableTurnExecutionIdentity, StartTurnInput, TransportResult, TurnHandle,
  TurnExecutionContext, TurnObservation, TurnObservationResult } from "./types.js";

export interface ApplicationTurnExecutionContext<TEvent> {
  readonly conversationId: string; readonly turnId: string; readonly mutationId: string;
  /** Immutable claim snapshot; absent for standalone non-durable execution. */
  readonly durableExecution?: DurableTurnExecutionIdentity;
  readonly signal: AbortSignal;
  emit(event: TEvent): void | Promise<void>;
}
export interface ApplicationTurnTransportOptions<TEvent, TRequest> {
  readonly execute: (request: TRequest, context: ApplicationTurnExecutionContext<TEvent>) =>
    TurnObservationResult | Promise<TurnObservationResult>;
  readonly maximumBufferedEvents?: number;
}

interface Queue<T> extends AsyncIterable<T> { push(value: T): void; close(): void; fail(error: unknown): void }
function queue<T>(maximum: number): Queue<T> {
  const values: T[] = [], waiters: Array<{ resolve(value: IteratorResult<T>): void; reject(error: unknown): void }> = [];
  let closed = false, failure: unknown;
  return { push(value) { if (closed) return; const waiter = waiters.shift();
      if (waiter) waiter.resolve({ done: false, value }); else { if (values.length >= maximum) throw new Error("Application turn event buffer exceeded"); values.push(value); } },
    close() { if (closed) return; closed = true; for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined }); },
    fail(error) { if (closed) return; failure = error; closed = true; for (const waiter of waiters.splice(0)) waiter.reject(error); },
    [Symbol.asyncIterator]() { return { next() { const value = values.shift(); if (value !== undefined) return Promise.resolve({ done: false as const, value });
      if (failure !== undefined) return Promise.reject(failure); if (closed) return Promise.resolve({ done: true as const, value: undefined });
      return new Promise<IteratorResult<T>>((resolve, reject) => waiters.push({ resolve, reject })); } }; } };
}

/** Non-durable application execution adapter intended to sit behind createDurableApplicationTransport. */
export function createApplicationTurnTransport<TEvent, TRequest>(
  options: ApplicationTurnTransportOptions<TEvent, TRequest>,
): ConversationTransport<TEvent, TRequest> {
  const maximum = options.maximumBufferedEvents ?? 1_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) throw new TypeError("maximumBufferedEvents is invalid");
  const active = new Map<string, AbortController>();
  const key = (conversationId: string, turnId: string) => `${conversationId.length}:${conversationId}${turnId}`;
  const transport: ConversationTransport<TEvent, TRequest> = { capabilities: { authoritativeCancellation: { supported: true, capability: {
      async cancelTurn(input: CancelTurnInput) { const controller = active.get(key(input.conversationId, input.turnId));
        if (!controller) return { ok: true, value: { status: "already_terminal" } };
        controller.abort(new DOMException("Application turn cancelled", "AbortError"));
        return { ok: true, value: { status: "cancellation_requested" } }; },
    } }, documentInput: { supported: false }, attachmentUpload: { supported: false }, presence: { supported: false },
    synchronization: { supported: false } },
    async startTurn(input: StartTurnInput<TRequest>, context?: TurnExecutionContext): Promise<TransportResult<TurnHandle<TEvent>>> {
      const operationKey = key(input.conversationId, input.conversationTurnId);
      if (active.has(operationKey)) return { ok: false, error: { code: "conflict", message: "The application turn is already running.", retryable: true } };
      const controller = new AbortController(), events = queue<TEvent>(maximum); active.set(operationKey, controller);
      let resolveResult!: (value: TurnObservationResult) => void;
      const result = new Promise<TurnObservationResult>((resolve) => { resolveResult = resolve; });
      void Promise.resolve(options.execute(input.request, { conversationId: input.conversationId,
        turnId: input.conversationTurnId, mutationId: input.mutationId, signal: controller.signal,
        ...(context?.durableExecution === undefined ? {} : {
          durableExecution: Object.freeze({ ...context.durableExecution }),
        }),
        emit: (event) => events.push(event) })).then((terminal) => { events.close(); resolveResult(terminal); },
        (error: unknown) => { events.fail(error); resolveResult({ status: controller.signal.aborted ? "cancelled" : "failed",
          checkpoint: { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null },
          ...(controller.signal.aborted ? {} : { error: { code: "unavailable", message: "The application turn failed.", retryable: true } }) } as TurnObservationResult); })
        .finally(() => { if (active.get(operationKey) === controller) active.delete(operationKey); });
      const observation: TurnObservation<TEvent> = { events, result, disconnect() { /* durable owner must keep executing */ } };
      return { ok: true, value: { conversationId: input.conversationId, turnId: input.conversationTurnId,
        mutationId: input.mutationId, observation } };
    },
    async resumeTurn() { return { ok: false, error: { code: "not_found", message: "Use the durable transport to resume a turn.", retryable: false } }; },
  };
  return Object.freeze(transport);
}
