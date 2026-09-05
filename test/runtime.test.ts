import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  CONVERSATION_EVENT_VERSION,
  ConversationEventStoreConflictError,
  ConversationRuntimeBusyError,
  InMemoryConversationEventStore,
  createRetryPolicy,
  createConversationRuntime,
  parseConversationEvent,
  parseNormalizedUsageReceipt,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type AuthoritativeAttribution,
  type ConversationClientId,
  type ConversationEvent,
  type ConversationEventMetadata,
  type ConversationEventStoreConflictCode,
  type ConversationEventStore,
  type ConversationId,
  type ConversationRevision,
  type ConversationTransport,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
  type ResumeTurnInput,
  type StartTurnInput,
  type StreamEvent,
  type TransportResult,
  type TransportError,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "../src/index.js";

interface FakeRequest {
  readonly prompt: string;
}

const conversationId = "conversation_runtime" as ConversationId;
const clientId = "client_runtime" as ConversationClientId;

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_runtime", source: "server_derived", trust: "authoritative" },
  project: { id: "project_runtime", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "test",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function usageReceipt(options: {
  readonly usageReceiptId?: string;
  readonly receiptConversationId?: string;
  readonly turnId?: string;
  readonly attemptIndex?: number;
  readonly terminalStatus?: "completed" | "cancelled" | "failed";
} = {}) {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: options.usageReceiptId ?? "usage_runtime_1",
    conversation_id: options.receiptConversationId ?? conversationId,
    turn_id: options.turnId ?? "turn_2",
    logical_request_id: "logical_runtime_1",
    trace_id: "trace-runtime-1",
    attempt: {
      id: `attempt_runtime_${options.attemptIndex ?? 0}`,
      index: options.attemptIndex ?? 0,
    },
    continuation: { id: "continuation_runtime_0", index: 0 },
    provider_id: "generic-direct",
    model_id: "generic-model-v1",
    attribution,
    source: "provider",
    terminal_status: options.terminalStatus ?? "completed",
    tokens: {
      input_tokens: { status: "reported", value: 4 },
      cached_input_tokens: { status: "reported", value: 1 },
      output_tokens: { status: "reported", value: 2 },
      reasoning_tokens: { status: "reported", value: 0 },
      total_tokens: { status: "reported", value: 6 },
    },
    provider_cost: { status: "unavailable" },
  });
}

function frame(
  type: StreamEvent["type"],
  sequence: number,
  fields: Record<string, unknown> = {},
): unknown {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "remote-turn-1",
    trace_id: "trace-runtime-1",
    sequence,
    ...fields,
  };
}

const startedFrame = () => frame("response.started", 0, { attribution });
const deltaFrame = (sequence: number, delta: string) =>
  frame("response.text.delta", sequence, { delta });
const completedFrame = (sequence: number, outcome = "stop") =>
  frame("response.completed", sequence, { outcome });
const cancelledFrame = (sequence: number) =>
  frame("response.cancelled", sequence, { reason: "runtime_shutdown" });
const failedFrame = (sequence: number) => frame("response.error", sequence, {
  error: {
    category: "upstream",
    code: "upstream_unavailable",
    message: "Unavailable",
    retryable: false,
  },
});

function checkpointFor(raw: unknown): TurnResumePoint {
  const event = raw as { request_id: string; sequence: number };
  const id = `${event.request_id}:${event.sequence}`;
  return {
    lastAppliedEventId: id,
    lastAppliedCursor: id,
    lastAppliedRevision: event.sequence,
  };
}

function opaqueCheckpoint(revision: number, label = `opaque-${revision}`): TurnResumePoint {
  return {
    lastAppliedEventId: `event/${label}`,
    lastAppliedCursor: `cursor:${label}:not-derived-from-the-request`,
    lastAppliedRevision: revision,
  };
}

function observation(
  frames: readonly unknown[],
  status: TurnObservationResult["status"],
  options: {
    readonly usageReceipt?: unknown;
    readonly error?: TransportError;
    readonly checkpoint?: unknown;
  } = {},
): TurnObservation<unknown> {
  let disconnected = false;
  let settled = false;
  let resolveResult!: (result: TurnObservationResult) => void;
  let checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  const settle = (next: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(next);
  };
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const value of frames) {
          if (disconnected) return;
          const candidate = value as { request_id?: unknown; sequence?: unknown };
          if (
            typeof candidate.request_id === "string" &&
            typeof candidate.sequence === "number"
          ) {
            checkpoint = checkpointFor(value);
          }
          yield value;
        }
        const resultCheckpoint = Object.hasOwn(options, "checkpoint")
          ? options.checkpoint
          : checkpoint;
        if (status === "failed") {
          settle({
            status: "failed",
            checkpoint: resultCheckpoint,
            error: options.error ?? {
              code: "internal_error",
              message: "failed",
              retryable: false,
            },
            ...(options.usageReceipt === undefined
              ? {}
              : { usageReceipt: options.usageReceipt }),
          } as TurnObservationResult);
        } else if (status === "disconnected") {
          settle({ status, checkpoint: resultCheckpoint } as TurnObservationResult);
        } else {
          settle({
            status,
            checkpoint: resultCheckpoint,
            ...(options.usageReceipt === undefined
              ? {}
              : { usageReceipt: options.usageReceipt }),
          } as TurnObservationResult);
        }
      },
    },
    result,
    disconnect() {
      disconnected = true;
      settle({ status: "disconnected", checkpoint });
    },
  };
}

function pausableObservation(
  framesBeforePause: readonly unknown[],
  framesAfterPause: readonly unknown[],
  status: TurnObservationResult["status"],
): {
  readonly observation: TurnObservation<unknown>;
  readonly paused: Promise<void>;
  readonly release: () => void;
} {
  let disconnected = false;
  let settled = false;
  let resolveResult!: (result: TurnObservationResult) => void;
  let markPaused!: () => void;
  let releasePause!: () => void;
  let checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const settle = (next: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(next);
  };
  const rememberCheckpoint = (value: unknown): void => {
    const candidate = value as { request_id?: unknown; sequence?: unknown };
    if (
      typeof candidate.request_id === "string" &&
      typeof candidate.sequence === "number"
    ) {
      checkpoint = checkpointFor(value);
    }
  };

  return {
    observation: {
      events: {
        async *[Symbol.asyncIterator]() {
          for (const value of framesBeforePause) {
            if (disconnected) return;
            rememberCheckpoint(value);
            yield value;
          }
          markPaused();
          await released;
          for (const value of framesAfterPause) {
            if (disconnected) return;
            rememberCheckpoint(value);
            yield value;
          }
          settle({ status, checkpoint } as TurnObservationResult);
        },
      },
      result,
      disconnect() {
        disconnected = true;
        releasePause();
        settle({ status: "disconnected", checkpoint });
      },
    },
    paused,
    release: releasePause,
  };
}

function pendingObservation(onDisconnect: () => void): TurnObservation<unknown> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveResult!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield startedFrame();
        await released;
      },
    },
    result,
    disconnect() {
      onDisconnect();
      release();
      resolveResult({
        status: "disconnected",
        checkpoint: checkpointFor(startedFrame()),
      });
    },
  };
}

class FakeTransport implements ConversationTransport<unknown, FakeRequest> {
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    documentInput: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  readonly starts: StartTurnInput<FakeRequest>[] = [];
  readonly resumes: ResumeTurnInput[] = [];
  readonly startObservations: TurnObservation<unknown>[] = [];
  readonly startFailures: TransportError[] = [];
  readonly resumeObservations: TurnObservation<unknown>[] = [];
  beforeStart: (() => void | Promise<void>) | null = null;

  async startTurn(
    input: StartTurnInput<FakeRequest>,
  ): Promise<TransportResult<TurnHandle<unknown>>> {
    this.starts.push(input);
    await this.beforeStart?.();
    const failure = this.startFailures.shift();
    if (failure !== undefined) return { ok: false, error: failure };
    const next = this.startObservations.shift();
    if (next === undefined) throw new Error("No fake start observation queued");
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "remote-turn-1",
        mutationId: input.mutationId,
        observation: next,
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<unknown>>> {
    this.resumes.push(input);
    const next = this.resumeObservations.shift();
    if (next === undefined) throw new Error("No fake resume observation queued");
    return { ok: true, value: next };
  }
}

class TrackingEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  readonly durableEventIds = new Set<string>();

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    const result = await this.inner.append(input);
    for (const entry of result.entries) this.durableEventIds.add(entry.event.event_id);
    return result;
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

class CheckpointFailingEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  failCheckpointWrites = false;

  append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (
      this.failCheckpointWrites &&
      input.events.some((event) => {
        const runtime = event.metadata?.handrail_runtime;
        return runtime !== null && typeof runtime === "object" &&
          !Array.isArray(runtime) && Object.hasOwn(runtime, "checkpoint");
      })
    ) {
      return Promise.reject(new Error("checkpoint persistence failed"));
    }
    return this.inner.append(input);
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

class AdmissionEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  initialAppendAttempts = 0;
  successfulInitialAppends = 0;
  failNextInitialAppend = false;

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    const isInitialAppend = input.events.some(
      (event) => event.payload.type === "turn.started",
    );
    if (isInitialAppend) {
      this.initialAppendAttempts += 1;
      if (this.failNextInitialAppend) {
        this.failNextInitialAppend = false;
        throw new Error("initial append failed");
      }
    }
    const result = await this.inner.append(input);
    if (isInitialAppend) this.successfulInitialAppends += 1;
    return result;
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

class RevisionConflictInjectingEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  targetedAppendAttempts = 0;
  injectionCount = 0;

  constructor(
    private readonly isTarget: (input: AppendConversationEventsInput) => boolean,
    private readonly maximumInjections = 1,
    private readonly createInjectedEvent: (
      revision: ConversationRevision,
      input: AppendConversationEventsInput,
    ) => ConversationEvent = (revision) => externalEvent(revision, {
      type: "conversation.metadata_updated",
      metadata: { injected_revision: revision },
    }),
  ) {}

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (this.isTarget(input)) {
      this.targetedAppendAttempts += 1;
      if (this.injectionCount < this.maximumInjections) {
        const currentRevision = await this.inner.getLatestRevision(input.conversationId);
        const injectedRevision = ((currentRevision ?? 0) + 1) as ConversationRevision;
        await this.inner.append({
          conversationId: input.conversationId,
          expectedRevision: currentRevision,
          events: [this.createInjectedEvent(injectedRevision, input)],
        });
        this.injectionCount += 1;
      }
    }
    return this.inner.append(input);
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

class ForcedAppendConflictEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  appendAttempts = 0;

  constructor(readonly code: ConversationEventStoreConflictCode) {}

  append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    this.appendAttempts += 1;
    return Promise.reject(new ConversationEventStoreConflictError(
      `Injected ${this.code}`,
      {
        code: this.code,
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        actualRevision: null,
        identifier: null,
      },
    ));
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}_${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-27T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

function externalEvent(
  revision: number,
  payload: Record<string, unknown>,
  metadata?: ConversationEventMetadata,
): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `event_external_${revision}`,
    conversation_id: conversationId,
    revision,
    occurred_at: `2026-08-27T13:00:${String(revision).padStart(2, "0")}.000Z`,
    actor: { type: payload.type === "message.created" ? "user" : "assistant" },
    source: payload.type === "message.created"
      ? { type: "client", client_id: "client_external" }
      : { type: "runtime" },
    ...(metadata === undefined ? {} : { metadata }),
    payload,
  });
}

describe("createConversationRuntime", () => {
  it("polls external tool activity without provider frames, retries failures, and stops on destroy", async () => {
    vi.useFakeTimers();
    const eventStore = new InMemoryConversationEventStore();
    const read = vi.spyOn(eventStore, "read");
    const onSynchronizationError = vi.fn();
    const transport = new FakeTransport();
    const runtime = await createConversationRuntime({ conversationId, clientId, transport, eventStore,
      synchronizationIntervalMilliseconds: 100, onSynchronizationError });
    try {
      await eventStore.append({ conversationId, expectedRevision: null, events: [
        externalEvent(1, { type: "turn.started", turn_id: "remote", input_message_ids: ["input"] }),
        externalEvent(2, { type: "tool_call.requested", turn_id: "remote", tool_call_id: "bulk", name: "update_products", arguments: {} }),
        externalEvent(3, { type: "tool_call.started", turn_id: "remote", tool_call_id: "bulk" }),
      ] });
      read.mockRejectedValueOnce(new Error("temporarily offline"));
      await vi.advanceTimersByTimeAsync(100);
      expect(onSynchronizationError).toHaveBeenCalledOnce();
      expect(runtime.getSnapshot().revision).toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.getSnapshot().revision).toBe(3);
      expect(runtime.getSnapshot().tool_calls[0]).toMatchObject({ tool_call_id: "bulk", started_at: "2026-08-27T13:00:03.000Z" });
      expect(transport.starts).toHaveLength(0);
      expect(transport.resumes).toHaveLength(0);
      await runtime.synchronize!();
      expect(runtime.getSnapshot().tool_calls).toHaveLength(1);
      runtime.destroy();
      const readsAtDestroy = read.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(readsAtDestroy);
    } finally { runtime.destroy(); vi.useRealTimers(); }
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles a hanging local send when synchronization receives canonical %s", async (status) => {
      const eventStore = new InMemoryConversationEventStore();
      const transport = new FakeTransport();
      const disconnected = vi.fn();
      transport.startObservations.push(pendingObservation(disconnected));
      const runtime = await createConversationRuntime({ conversationId, clientId, transport, eventStore });
      const sending = runtime.sendMessage({ content: "Work", request: { prompt: "Work" } });
      try {
        await vi.waitFor(() => expect(runtime.getSnapshot().turns.at(-1)?.status).toBe("running"));
        const turnId = runtime.getSnapshot().active_turn_id!;
        const revision = (await eventStore.getLatestRevision(conversationId))!;
        const payload = status === "completed" ? { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] }
          : status === "cancelled" ? { type: "turn.cancelled", turn_id: turnId, reason: "user" }
            : { type: "turn.failed", turn_id: turnId, error: { code: "worker_failed", message: "Worker failed", retryable: false } };
        await eventStore.append({ conversationId, expectedRevision: revision, events: [externalEvent(revision + 1, payload)] });
        await runtime.synchronize!();
        await expect(sending).resolves.toMatchObject({ status });
        expect(disconnected).toHaveBeenCalled();
        expect(runtime.getSnapshot().active_turn_id).toBeNull();
        expect(transport.starts).toHaveLength(1);
      } finally { runtime.destroy(); await sending.catch(() => undefined); }
    });

  it("catches up externally appended canonical events before the next send batch", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startObservations.push(observation([], "disconnected"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      replayBatchSize: 1,
      ...deterministicSources(),
    });
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events: [externalEvent(1, {
        type: "conversation.metadata_updated",
        metadata: { source: "external" },
      })],
    });

    await expect(runtime.sendMessage({
      content: "Catch up before sending",
      request: { prompt: "Catch up before sending" },
    })).resolves.toMatchObject({ status: "disconnected" });

    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(runtime.getSnapshot().metadata).toEqual({ source: "external" });
    expect(history.entries.filter(({ event }) =>
      event.payload.type === "message.created" || event.payload.type === "turn.started"
    ).map(({ event }) => event.revision)).toEqual([2, 3]);
    expect(transport.starts).toHaveLength(1);
  });

  it("rebases user admission once when a canonical event wins the append race", async () => {
    const eventStore = new RevisionConflictInjectingEventStore((input) =>
      input.events.some((event) => event.payload.type === "turn.started")
    );
    const transport = new FakeTransport();
    transport.startObservations.push(observation([], "disconnected"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    await expect(runtime.sendMessage({
      content: "Admit exactly once",
      request: { prompt: "Admit exactly once" },
    })).resolves.toMatchObject({ status: "disconnected" });

    const history = await eventStore.read({ conversationId, limit: 100 });
    const payloadTypes = history.entries.map(({ event }) => event.payload.type);
    expect(eventStore.targetedAppendAttempts).toBe(2);
    expect(eventStore.injectionCount).toBe(1);
    expect(payloadTypes.filter((type) => type === "message.created")).toHaveLength(1);
    expect(payloadTypes.filter((type) => type === "turn.started")).toHaveLength(1);
    expect(history.entries.map(({ event }) => event.revision)).toEqual(
      Array.from({ length: history.entries.length }, (_, index) => index + 1),
    );
    expect(history.entries.find(({ event }) => event.payload.type === "message.created")?.event)
      .toMatchObject({ revision: 2, mutation_id: expect.any(String) });
    expect(transport.starts).toHaveLength(1);
  });

  it("rebases a streamed delta without duplicating text or restarting transport", async () => {
    const eventStore = new RevisionConflictInjectingEventStore((input) =>
      input.events.some((event) => event.payload.type === "message.text_appended")
    );
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Streamed once"),
      completedFrame(2),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Keep the transport running",
      request: { prompt: "Keep the transport running" },
    });

    const history = await eventStore.read({ conversationId, limit: 100 });
    const deltaEvents = history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    );
    const assistantMessages = runtime.getSnapshot().messages.filter(
      (message) => message.role === "assistant",
    );
    expect(outcome.status).toBe("completed");
    expect(eventStore.targetedAppendAttempts).toBe(2);
    expect(eventStore.injectionCount).toBe(1);
    expect(deltaEvents).toHaveLength(1);
    expect(assistantMessages).toMatchObject([{
      content: [{ type: "text", text: "Streamed once" }],
    }]);
    expect(history.entries.map(({ event }) => event.revision)).toEqual(
      Array.from({ length: history.entries.length }, (_, index) => index + 1),
    );
    expect(outcome.checkpoint.lastAppliedRevision).toBe(history.latestRevision);
    expect(runtime.getSnapshot().revision).toBe(history.latestRevision);
    expect(transport.starts).toHaveLength(1);
  });

  it("does not retry a stream append after catch-up reveals a terminal turn", async () => {
    const eventStore = new RevisionConflictInjectingEventStore(
      (input) => input.events.some((event) => event.payload.type === "message.text_appended"),
      1,
      (revision, input) => {
        const delta = input.events.find(
          (event) => event.payload.type === "message.text_appended",
        );
        if (delta?.payload.type !== "message.text_appended") {
          throw new TypeError("Expected an injected streamed delta");
        }
        return externalEvent(revision, {
          type: "turn.cancelled",
          turn_id: delta.payload.turn_id,
          reason: "superseded",
        });
      },
    );
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Must not become durable"),
    ], "disconnected"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Respect the canonical terminal turn",
      request: { prompt: "Respect the canonical terminal turn" },
    });

    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(outcome.status).toBe("cancelled");
    expect(eventStore.targetedAppendAttempts).toBe(1);
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(0);
    expect(runtime.getSnapshot().turns[0]?.status).toBe("cancelled");
    expect(transport.starts).toHaveLength(1);
  });

  it.each(["idempotency_conflict", "invalid_append"] as const)(
    "does not retry an injected %s",
    async (code) => {
      const eventStore = new ForcedAppendConflictEventStore(code);
      const transport = new FakeTransport();
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        ...deterministicSources(),
      });

      await expect(runtime.sendMessage({
        content: "Do not retry",
        request: { prompt: "Do not retry" },
      })).rejects.toMatchObject({ code });
      expect(eventStore.appendAttempts).toBe(1);
      expect(transport.starts).toHaveLength(0);
    },
  );

  it("surfaces the final revision conflict after the bounded append ceiling", async () => {
    const eventStore = new RevisionConflictInjectingEventStore(
      (input) => input.events.some((event) => event.payload.type === "turn.started"),
      Number.POSITIVE_INFINITY,
    );
    const transport = new FakeTransport();
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });

    await expect(runtime.sendMessage({
      content: "Bound the canonical race",
      request: { prompt: "Bound the canonical race" },
    })).rejects.toMatchObject({ code: "revision_conflict" });

    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(eventStore.targetedAppendAttempts).toBe(3);
    expect(eventStore.injectionCount).toBe(3);
    expect(history.entries.map(({ event }) => event.revision)).toEqual([1, 2, 3]);
    expect(transport.starts).toHaveLength(0);
  });

  it("rejects send and continuation admission after catching up an external active turn", async () => {
    const cases = [
      {
        name: "send",
        initialEvents: [] as ConversationEvent[],
        externalEvents: [
          externalEvent(1, {
            type: "message.created",
            message_id: "message_external_send",
            role: "user",
            content: [{ type: "text", text: "Already active" }],
          }),
          externalEvent(2, {
            type: "turn.started",
            turn_id: "turn_external_send",
            input_message_ids: ["message_external_send"],
          }),
        ],
      },
      {
        name: "continuation",
        initialEvents: [
          externalEvent(1, {
            type: "message.created",
            message_id: "message_external",
            role: "user",
            content: [{ type: "text", text: "Use a tool" }],
          }),
          externalEvent(2, {
            type: "turn.started",
            turn_id: "turn_preceding",
            input_message_ids: ["message_external"],
          }),
          externalEvent(3, {
            type: "turn.completed",
            turn_id: "turn_preceding",
            outcome: "tool_calls",
            output_message_ids: [],
          }),
        ],
        externalEvents: [externalEvent(4, {
          type: "turn.started",
          turn_id: "turn_external_continuation",
          input_message_ids: ["message_external"],
        })],
      },
    ] as const;

    for (const current of cases) {
      const eventStore = new InMemoryConversationEventStore();
      if (current.initialEvents.length > 0) {
        await eventStore.append({
          conversationId,
          expectedRevision: null,
          events: current.initialEvents,
        });
      }
      const transport = new FakeTransport();
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        ...deterministicSources(),
      });
      await eventStore.append({
        conversationId,
        expectedRevision: current.initialEvents.length === 0
          ? null
          : current.initialEvents.at(-1)!.revision,
        events: current.externalEvents,
      });

      const admission = current.name === "send"
        ? runtime.sendMessage({
            content: "Must remain blocked",
            request: { prompt: "Must remain blocked" },
          })
        : runtime.continueTurn!({
            precedingTurnId: "turn_preceding" as never,
            request: { prompt: "Must remain blocked" },
          });
      await expect(admission).rejects.toBeInstanceOf(ConversationRuntimeBusyError);
      expect(runtime.getSnapshot().active_turn_id).toBe(`turn_external_${current.name}`);
      expect(transport.starts).toHaveLength(0);
      expect(transport.resumes).toHaveLength(0);
    }
  });

  it("hydrates caught-up checkpoints and durable frame keys for resumable deduplication", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      replayBatchSize: 1,
      ...deterministicSources(),
    });
    const checkpoint = opaqueCheckpoint(3, "external-catch-up");
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events: [
        externalEvent(1, {
          type: "message.created",
          message_id: "message_external_resume",
          role: "user",
          content: [{ type: "text", text: "Resume externally" }],
        }),
        externalEvent(2, {
          type: "turn.started",
          turn_id: "turn_external_resume",
          input_message_ids: ["message_external_resume"],
        }, {
          handrail_runtime: { transport_turn_id: "remote-turn-1" },
        }),
        externalEvent(3, {
          type: "turn.status_changed",
          turn_id: "turn_external_resume",
          status: "running",
        }, {
          handrail_runtime: {
            transport_turn_id: "remote-turn-1",
            request_id: "remote-turn-1",
            trace_id: "trace-runtime-1",
            sequence: 0,
            frame_type: "response.started",
            resume_safe: true,
            checkpoint: {
              last_applied_event_id: checkpoint.lastAppliedEventId,
              last_applied_cursor: checkpoint.lastAppliedCursor,
              last_applied_revision: checkpoint.lastAppliedRevision,
            },
          },
        }),
      ],
    });

    await expect(runtime.sendMessage({
      content: "Trigger catch-up",
      request: { prompt: "Trigger catch-up" },
    })).rejects.toBeInstanceOf(ConversationRuntimeBusyError);

    transport.resumeObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed"));
    await expect(runtime.restoreActiveTurn()).resolves.toMatchObject({ status: "completed" });
    expect(transport.resumes).toEqual([{
      conversationId,
      turnId: "remote-turn-1",
      resumeFrom: checkpoint,
    }]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(({ event }) => {
      const metadata = event.metadata?.handrail_runtime;
      return metadata !== null && typeof metadata === "object" &&
        !Array.isArray(metadata) && metadata.request_id === "remote-turn-1" &&
        metadata.sequence === 0;
    })).toHaveLength(1);
  });

  it("admits only one of two same-tick sends", async () => {
    const eventStore = new AdmissionEventStore();
    const transport = new FakeTransport();
    transport.startObservations.push(observation([], "disconnected"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    const [first, second] = await Promise.allSettled([
      runtime.sendMessage({
        content: "First",
        request: { prompt: "First" },
      }),
      runtime.sendMessage({
        content: "Second",
        request: { prompt: "Second" },
      }),
    ]);

    expect(first).toMatchObject({ value: { status: "disconnected" } });
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.any(ConversationRuntimeBusyError),
    });
    expect(eventStore.initialAppendAttempts).toBe(1);
    expect(eventStore.successfulInitialAppends).toBe(1);
    expect(transport.starts).toHaveLength(1);
  });

  it("admits only one of two same-tick continuations", async () => {
    const eventStore = new AdmissionEventStore();
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      frame("response.tool_call", 1, {
        tool_call_id: "call_same_tick",
        name: "same_tick_tool",
        arguments: {},
      }),
      completedFrame(2, "tool_calls"),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const preceding = await runtime.sendMessage({
      content: "Use a tool",
      request: { prompt: "Use a tool" },
    });
    transport.startObservations.push(observation([], "disconnected"));

    const [first, second] = await Promise.allSettled([
      runtime.continueTurn!({
        precedingTurnId: preceding.turnId,
        request: { prompt: "Continue first" },
      }),
      runtime.continueTurn!({
        precedingTurnId: preceding.turnId,
        request: { prompt: "Continue second" },
      }),
    ]);

    expect(first).toMatchObject({ value: { status: "disconnected" } });
    expect(second).toMatchObject({
      status: "rejected",
      reason: expect.any(ConversationRuntimeBusyError),
    });
    expect(eventStore.initialAppendAttempts).toBe(2);
    expect(eventStore.successfulInitialAppends).toBe(2);
    expect(transport.starts).toHaveLength(2);
  });

  it("releases turn admission when the initial append fails", async () => {
    const eventStore = new AdmissionEventStore();
    eventStore.failNextInitialAppend = true;
    const transport = new FakeTransport();
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    await expect(runtime.sendMessage({
      content: "Fail before transport",
      request: { prompt: "Fail before transport" },
    })).rejects.toThrow("initial append failed");
    expect(transport.starts).toHaveLength(0);

    transport.startObservations.push(observation([], "disconnected"));
    await expect(runtime.sendMessage({
      content: "Try again",
      request: { prompt: "Try again" },
    })).resolves.toMatchObject({ status: "disconnected" });
    expect(eventStore.initialAppendAttempts).toBe(2);
    expect(eventStore.successfulInitialAppends).toBe(1);
    expect(transport.starts).toHaveLength(1);
  });

  it("persists optimistic text and attachment facts before publishing, then durably finalizes streamed text", async () => {
    const eventStore = new TrackingEventStore();
    const transport = new FakeTransport();
    const controlled = pausableObservation(
      [startedFrame(), deltaFrame(1, "Hello ")],
      [deltaFrame(2, "there"), completedFrame(3)],
      "completed",
    );
    transport.startObservations.push(controlled.observation);
    transport.beforeStart = async () => {
      expect(await eventStore.getLatestRevision(conversationId)).toBe(4);
    };
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    const notifications: number[] = [];
    runtime.observe((snapshot) => {
      expect(snapshot.processed_event_ids.every((id) => eventStore.durableEventIds.has(id)))
        .toBe(true);
      notifications.push(snapshot.revision ?? 0);
    });

    const sending = runtime.sendMessage({
      content: "Describe this image",
      attachments: [{
        attachment_id: "att_runtime" as never,
        media_type: "image/png",
        filename: "runtime.png",
        size_bytes: 128,
      }],
      request: { prompt: "Describe this image" },
    });

    await controlled.paused;
    expect(runtime.getSnapshot().messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello " }],
    });
    expect(notifications.at(-1)).toBe(7);

    controlled.release();
    const outcome = await sending;

    expect(outcome).toMatchObject({ status: "completed", checkpoint: {
      lastAppliedEventId: "remote-turn-1:3",
      lastAppliedRevision: 9,
    } });
    expect(runtime.getSnapshot().messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Describe this image" }],
        attachments: [{ attachment_id: "att_runtime" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello there" }],
      },
    ]);
    const assistantMessageId = runtime.getSnapshot().messages[1]?.message_id;
    expect(assistantMessageId).toBeDefined();
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      outcome: "stop",
      output_message_ids: [assistantMessageId],
    });
    expect(notifications).toEqual([3, 4, 5, 6, 7, 8, 9]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(2);
    expect(history.entries.filter(
      ({ event }) =>
        event.payload.type === "message.created" && event.payload.role === "assistant",
    )).toHaveLength(0);
  });

  it("returns a validated generic observation receipt in a frozen result array", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const receipt = usageReceipt();
    const capture = vi.fn(async () => undefined);
    transport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed", { usageReceipt: receipt }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      usageReceiptSink: { capture },
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Measure this turn",
      request: { prompt: "Measure this turn" },
    });

    expect(outcome).toMatchObject({ status: "completed" });
    expect(outcome.usageReceipts).toEqual([receipt]);
    expect(capture).toHaveBeenCalledWith(receipt);
    expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    expect(runtime.getSnapshot().usage_receipt_links).toMatchObject([{
      turn_id: outcome.turnId,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const linkedEvents = history.entries.filter(
      ({ event }) => event.payload.type === "usage.receipt_linked",
    );
    expect(linkedEvents.map(({ event }) => event.payload)).toEqual([{
      type: "usage.receipt_linked",
      turn_id: outcome.turnId,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);
    const durableReceiptJson = JSON.stringify(linkedEvents);
    expect(durableReceiptJson).not.toContain("input_tokens");
    expect(durableReceiptJson).not.toContain("provider_cost");
    expect(durableReceiptJson).not.toContain("generic-direct");
    expect(durableReceiptJson).not.toContain("generic-model-v1");
    expect(durableReceiptJson).not.toContain("prompt_tokens");
  });

  it("deduplicates receipt IDs while retaining distinct receipts across observation retries", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const first = usageReceipt({
      usageReceiptId: "usage_retry_first",
      terminalStatus: "failed",
    });
    const repeated = usageReceipt({
      usageReceiptId: "usage_retry_first",
      attemptIndex: 1,
      terminalStatus: "failed",
    });
    const second = usageReceipt({
      usageReceiptId: "usage_retry_second",
      attemptIndex: 2,
    });
    const retryableError: TransportError = {
      code: "unavailable",
      message: "Retry observation",
      retryable: true,
    };
    transport.startObservations.push(observation([
      startedFrame(),
    ], "failed", { usageReceipt: first, error: retryableError }));
    transport.resumeObservations.push(
      observation([], "failed", {
        usageReceipt: repeated,
        error: retryableError,
      }),
      observation([completedFrame(1)], "completed", { usageReceipt: second }),
    );
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 3,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Retry with receipts",
      request: { prompt: "Retry with receipts" },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.usageReceipts).toEqual([first, second]);
    expect(outcome.usageReceipts.map((receipt) => receipt.usage_receipt_id)).toEqual([
      "usage_retry_first",
      "usage_retry_second",
    ]);
    expect(transport.resumes).toHaveLength(2);
    expect(runtime.getSnapshot().usage_receipt_links.map(
      (link) => link.usage_receipt_id,
    )).toEqual(["usage_retry_first", "usage_retry_second"]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) =>
        event.payload.type === "usage.receipt_linked" &&
        event.payload.usage_receipt_id === first.usage_receipt_id,
    )).toHaveLength(1);
  });

  it("replays a durable receipt link and does not append it when redelivered after restart", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const sources = deterministicSources();
    const receipt = usageReceipt({ usageReceiptId: "usage_restart" });
    transport.startObservations.push(observation([
      startedFrame(),
    ], "completed", { usageReceipt: receipt }));
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...sources,
    });

    const interrupted = await runtimeBeforeRestart.sendMessage({
      content: "Resume receipt link",
      request: { prompt: "Resume receipt link" },
    });
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.usageReceipts).toEqual([receipt]);
    expect(runtimeBeforeRestart.getSnapshot().usage_receipt_links).toHaveLength(1);
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      completedFrame(1),
    ], "completed", { usageReceipt: receipt }));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...sources,
    });
    expect(runtimeAfterRestart.getSnapshot().usage_receipt_links).toMatchObject([{
      turn_id: receipt.turn_id,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);

    const resumed = await runtimeAfterRestart.restoreActiveTurn();

    expect(resumed?.status).toBe("completed");
    expect(resumed?.usageReceipts).toEqual([receipt]);
    expect(runtimeAfterRestart.getSnapshot().usage_receipt_links).toHaveLength(1);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "usage.receipt_linked",
    )).toHaveLength(1);
  });

  it("omits malformed and conversation/turn-mismatched observation receipts", async () => {
    const valid = usageReceipt();
    const invalidReceipts: readonly unknown[] = [
      { ...valid, provider_native_usage: { prompt_tokens: 4 } },
      usageReceipt({ receiptConversationId: "conversation_other" }),
      usageReceipt({ turnId: "turn_other" }),
    ];

    for (const invalid of invalidReceipts) {
      const eventStore = new InMemoryConversationEventStore();
      const transport = new FakeTransport();
      transport.startObservations.push(observation([
        startedFrame(),
        completedFrame(1),
      ], "completed", { usageReceipt: invalid }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        ...deterministicSources(),
      });

      const outcome = await runtime.sendMessage({
        content: "Reject invalid receipt",
        request: { prompt: "Reject invalid receipt" },
      });

      expect(outcome.status).toBe("completed");
      expect(outcome.usageReceipts).toEqual([]);
      expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
      expect(runtime.getSnapshot().usage_receipt_links).toEqual([]);
      const history = await eventStore.read({ conversationId, limit: 100 });
      expect(history.entries.some(
        ({ event }) => event.payload.type === "usage.receipt_linked",
      )).toBe(false);
    }
  });

  it("retains valid receipts from cancelled and failed terminal observations", async () => {
    const cases = [
      {
        status: "cancelled" as const,
        terminal: cancelledFrame(1),
        receipt: usageReceipt({
          usageReceiptId: "usage_cancelled",
          terminalStatus: "cancelled",
        }),
      },
      {
        status: "failed" as const,
        terminal: failedFrame(1),
        receipt: usageReceipt({
          usageReceiptId: "usage_failed",
          terminalStatus: "failed",
        }),
      },
    ];

    for (const current of cases) {
      const transport = new FakeTransport();
      transport.startObservations.push(observation([
        startedFrame(),
        current.terminal,
      ], current.status, { usageReceipt: current.receipt }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore: new InMemoryConversationEventStore(),
        ...deterministicSources(),
      });

      const outcome = await runtime.sendMessage({
        content: `Observe ${current.status}`,
        request: { prompt: `Observe ${current.status}` },
      });

      expect(outcome.status).toBe(current.status);
      expect(outcome.usageReceipts).toEqual([current.receipt]);
      expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    }
  });

  it("retries a normalized pre-start failure with the exact logical identities", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startFailures.push({
      code: "unavailable",
      message: "Normalized upstream unavailability",
      retryable: true,
      retryAfterMs: 5,
      native_status: 503,
      raw_headers: { "retry-after": "provider-native" },
    } as TransportError);
    transport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Retry safely",
      request: { prompt: "Retry safely" },
    });

    expect(outcome.status).toBe("completed");
    expect(transport.starts).toHaveLength(2);
    expect(transport.starts[0]).toBe(transport.starts[1]);
    expect(transport.starts[0]).toMatchObject({
      conversationId,
      conversationTurnId: transport.starts[1]?.conversationTurnId,
      mutationId: transport.starts[1]?.mutationId,
      idempotencyKey: transport.starts[1]?.idempotencyKey,
    });
    expect(runtime.getSnapshot().turns).toHaveLength(1);
    expect(runtime.getSnapshot().messages).toHaveLength(1);
    expect(runtime.getSnapshot().turns[0]?.output_message_ids).toEqual([]);
    expect(runtime.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_scheduled",
        attempt: 1,
        reason_category: "unavailable",
        delay_ms: 5,
      },
      { type: "turn.attempt_started", attempt: 2, operation: "start" },
    ]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const durableTurnId = history.entries.flatMap(({ event }) =>
      event.payload.type === "turn.started" ? [event.payload.turn_id] : []
    )[0];
    expect(durableTurnId).toBeDefined();
    expect(transport.starts.map((input) => input.conversationTurnId)).toEqual([
      durableTurnId,
      durableTurnId,
    ]);
    expect(transport.starts[0]?.conversationTurnId).not.toBe("remote-turn-1");
    expect(outcome.turnId).toBe(durableTurnId);
    const durableJson = JSON.stringify(history.entries.map((entry) => entry.event));
    expect(durableJson).not.toContain("native_status");
    expect(durableJson).not.toContain("raw_headers");
    expect(durableJson).not.toContain("provider-native");
  });

  it("automatically resumes partial output from the safe cursor without duplicating effects", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const tool = frame("response.tool_call", 1, {
      tool_call_id: "call_resume",
      name: "lookup",
      arguments: { query: "safe" },
    });
    const usage = frame("response.usage", 3, {
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });
    transport.startObservations.push(observation([
      startedFrame(),
      tool,
      deltaFrame(2, "Recovered once"),
      usage,
    ], "disconnected", { checkpoint: checkpointFor(deltaFrame(2, "Recovered once")) }));
    transport.resumeObservations.push(observation([
      deltaFrame(2, "Recovered once"),
      structuredClone(usage),
      completedFrame(4),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Resume safely",
      request: { prompt: "Resume safely" },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.usageReceipts).toEqual([]);
    expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("input_tokens");
    expect(transport.starts).toHaveLength(1);
    expect(transport.resumes).toEqual([{
      conversationId,
      turnId: "remote-turn-1",
      resumeFrom: {
        lastAppliedEventId: "remote-turn-1:2",
        lastAppliedCursor: "remote-turn-1:2",
        lastAppliedRevision: 7,
      },
    }]);
    expect(runtime.getSnapshot().messages.filter((message) => message.role === "assistant"))
      .toMatchObject([{ content: [{ type: "text", text: "Recovered once" }] }]);
    expect(runtime.getSnapshot().tool_calls).toHaveLength(1);
    expect(runtime.getSnapshot().tool_calls[0]).toMatchObject({
      tool_call_id: "call_resume",
      name: "lookup",
    });
    expect(runtime.getSnapshot().usage_receipt_links).toHaveLength(0);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const durableJson = JSON.stringify(history.entries.map((entry) => entry.event));
    expect(durableJson).not.toContain("input_tokens");
    expect(runtime.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_scheduled",
        attempt: 1,
        reason_category: "disconnected",
      },
      { type: "turn.attempt_started", attempt: 2, operation: "resume" },
    ]);
  });

  it("stamps an opaque transport checkpoint at the durable revision before automatic retry", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const firstTransportCheckpoint = opaqueCheckpoint(1, "automatic-first");
    const firstDurableCheckpoint = opaqueCheckpoint(6, "automatic-first");
    const finalTransportCheckpoint = opaqueCheckpoint(2, "automatic-final");
    const finalDurableCheckpoint = opaqueCheckpoint(10, "automatic-final");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Opaque"),
    ], "disconnected", { checkpoint: firstTransportCheckpoint }));
    transport.resumeObservations.push(observation([
      deltaFrame(1, "Opaque"),
      completedFrame(2),
    ], "completed", { checkpoint: finalTransportCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Resume from an opaque point",
      request: { prompt: "Resume from an opaque point" },
    });

    expect(transport.resumes[0]?.resumeFrom).toEqual(firstDurableCheckpoint);
    expect(transport.resumes[0]?.resumeFrom).not.toBe(firstTransportCheckpoint);
    expect(outcome.checkpoint).toEqual(finalDurableCheckpoint);
  });

  it("accepts a terminal checkpoint at its post-persistence durable revision", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const terminalCheckpoint = opaqueCheckpoint(6, "terminal-durable-head");
    transport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed", { checkpoint: terminalCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Acknowledge the terminal durable head",
      request: { prompt: "Acknowledge the terminal durable head" },
    });

    expect(outcome).toMatchObject({
      status: "completed",
      checkpoint: terminalCheckpoint,
    });
    expect(runtime.getSnapshot().revision).toBe(6);
  });

  it("persists and hydrates an opaque transport checkpoint at its durable revision", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const transportCheckpoint = opaqueCheckpoint(1, "restart-durable");
    const durableCheckpoint = opaqueCheckpoint(6, "restart-durable");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Before restart"),
    ], "disconnected", { checkpoint: transportCheckpoint }));
    const sources = deterministicSources();
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...sources,
    });
    const disconnected = await runtimeBeforeRestart.sendMessage({
      content: "Persist the cursor",
      request: { prompt: "Persist the cursor" },
    });
    expect(disconnected.checkpoint).toEqual(durableCheckpoint);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          metadata: {
            handrail_runtime: {
              checkpoint: {
                last_applied_event_id: durableCheckpoint.lastAppliedEventId,
                last_applied_cursor: durableCheckpoint.lastAppliedCursor,
                last_applied_revision: 6,
              },
            },
          },
        }),
      }),
    ]));
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      deltaFrame(1, "Before restart"),
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "restart-final") }));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...sources,
    });

    expect((await runtimeAfterRestart.restoreActiveTurn())?.status).toBe("completed");
    expect(transport.resumes[0]?.resumeFrom).toEqual(durableCheckpoint);
    expect(transport.resumes[0]?.resumeFrom).not.toBe(durableCheckpoint);
  });

  it("does not advance the prior checkpoint when checkpoint persistence fails", async () => {
    const eventStore = new CheckpointFailingEventStore();
    const transport = new FakeTransport();
    const priorTransportCheckpoint = opaqueCheckpoint(1, "prior-safe");
    const priorDurableCheckpoint = opaqueCheckpoint(6, "prior-safe");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Durable"),
    ], "disconnected", { checkpoint: priorTransportCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtime.sendMessage({
      content: "Keep the prior point",
      request: { prompt: "Keep the prior point" },
    });

    eventStore.failCheckpointWrites = true;
    transport.resumeObservations.push(observation([
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "failed-write") }));
    await expect(runtime.resumeTurn(disconnected.turnId)).rejects.toThrow(
      "checkpoint persistence failed",
    );

    eventStore.failCheckpointWrites = false;
    transport.resumeObservations.push(observation([
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "after-recovery") }));
    expect((await runtime.resumeTurn(disconnected.turnId)).status).toBe("completed");
    expect(transport.resumes.map(({ resumeFrom }) => resumeFrom)).toEqual([
      priorDurableCheckpoint,
      priorDurableCheckpoint,
    ]);
  });

  it("rejects malformed or observation-ahead checkpoints without advancing the prior point", async () => {
    const invalidCheckpoints: readonly unknown[] = [
      {
        lastAppliedEventId: "event/partial",
        lastAppliedCursor: "cursor:partial",
      },
      opaqueCheckpoint(99, "ahead-of-observation"),
    ];

    for (const invalidCheckpoint of invalidCheckpoints) {
      const eventStore = new InMemoryConversationEventStore();
      const transport = new FakeTransport();
      const priorCheckpoint = opaqueCheckpoint(6, "valid-prior");
      transport.startObservations.push(observation([
        startedFrame(),
        deltaFrame(1, "Prior"),
      ], "disconnected", { checkpoint: priorCheckpoint }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
        ...deterministicSources(),
      });
      const first = await runtime.sendMessage({
        content: "Reject unsafe checkpoint",
        request: { prompt: "Reject unsafe checkpoint" },
      });

      transport.resumeObservations.push(observation([
        deltaFrame(2, " effect"),
      ], "disconnected", { checkpoint: invalidCheckpoint }));
      const invalid = await runtime.resumeTurn(first.turnId);
      expect(invalid).toMatchObject({
        status: "interrupted",
        checkpoint: priorCheckpoint,
        error: { code: "invalid_protocol" },
      });

      transport.resumeObservations.push(observation([
        deltaFrame(2, " effect"),
        completedFrame(3),
      ], "completed", { checkpoint: priorCheckpoint }));
      expect((await runtime.resumeTurn(first.turnId)).status).toBe("completed");
      expect(transport.resumes.map(({ resumeFrom }) => resumeFrom)).toEqual([
        priorCheckpoint,
        priorCheckpoint,
      ]);
    }
  });

  it("keeps the all-null checkpoint until the transport acknowledges a point", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const emptyCheckpoint: TurnResumePoint = {
      lastAppliedEventId: null,
      lastAppliedCursor: null,
      lastAppliedRevision: null,
    };
    transport.startObservations.push(observation([
      startedFrame(),
    ], "disconnected", { checkpoint: emptyCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtime.sendMessage({
      content: "No checkpoint yet",
      request: { prompt: "No checkpoint yet" },
    });
    expect(disconnected.checkpoint).toEqual(emptyCheckpoint);

    transport.resumeObservations.push(observation([
      completedFrame(1),
    ], "completed", { checkpoint: emptyCheckpoint }));
    const completed = await runtime.resumeTurn(disconnected.turnId);

    expect(transport.resumes[0]?.resumeFrom).toEqual(emptyCheckpoint);
    expect(completed.checkpoint).toEqual(emptyCheckpoint);
  });

  it("projects a tool-call terminal without entering a tool loop", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      frame("response.tool_call", 1, {
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
      completedFrame(2, "tool_calls"),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore: new InMemoryConversationEventStore(),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Weather?",
      request: { prompt: "Weather?" },
    });

    expect(outcome.status).toBe("completed");
    expect(runtime.getSnapshot().tool_calls[0]).toMatchObject({
      tool_call_id: "call_weather",
      name: "lookup_weather",
      arguments: { city: "Chicago" },
    });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      outcome: "tool_calls",
      output_message_ids: [],
    });
  });

  it("deduplicates request_id plus sequence replays while preserving text once", async () => {
    const transport = new FakeTransport();
    const eventStore = new InMemoryConversationEventStore();
    const delta = deltaFrame(1, "once");
    transport.startObservations.push(observation([
      startedFrame(),
      delta,
      structuredClone(delta),
      completedFrame(2),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });

    expect((await runtime.sendMessage({
      content: "Repeat",
      request: { prompt: "Repeat" },
    })).status).toBe("completed");
    expect(runtime.getSnapshot().messages[1]?.content).toEqual([
      { type: "text", text: "once" },
    ]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(1);
  });

  it("leaves malformed and conflicting-terminal observations nonterminal", async () => {
    const malformedTransport = new FakeTransport();
    malformedTransport.startObservations.push(observation([
      startedFrame(),
      { type: "response.text.delta", sequence: 1, delta: "invalid" },
    ], "completed"));
    const malformedRuntime = await createConversationRuntime({
      conversationId,
      clientId,
      transport: malformedTransport,
      eventStore: new InMemoryConversationEventStore(),
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    const malformed = await malformedRuntime.sendMessage({
      content: "Malformed",
      request: { prompt: "Malformed" },
    });
    expect(malformed).toMatchObject({ status: "interrupted", error: {
      code: "invalid_protocol",
    } });
    expect(malformed.usageReceipts).toEqual([]);
    expect(Object.isFrozen(malformed.usageReceipts)).toBe(true);
    expect(malformedRuntime.getSnapshot().turns[0]?.status).toBe("running");

    const conflictingTransport = new FakeTransport();
    conflictingTransport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
      frame("response.error", 2, {
        error: {
          category: "internal",
          code: "internal_error",
          message: "late terminal",
          retryable: false,
        },
      }),
    ], "completed"));
    const conflictingRuntime = await createConversationRuntime({
      conversationId,
      clientId,
      transport: conflictingTransport,
      eventStore: new InMemoryConversationEventStore(),
      ...deterministicSources(),
    });
    expect((await conflictingRuntime.sendMessage({
      content: "Conflict",
      request: { prompt: "Conflict" },
    })).status).toBe("interrupted");
    expect(conflictingRuntime.getSnapshot().turns[0]?.status).toBe("running");
  });

  it.each([[true, "message.text_appended"], [false, "message.text_appended"], [true, "turn.completed"]] as const)("checks authoritative completion after a failed write: %s / %s", async (completeElsewhere, failedType) => {
    const durable = new InMemoryConversationEventStore();
    const eventStore: ConversationEventStore = {
      read: (input) => durable.read(input),
      getLatestRevision: (id) => durable.getLatestRevision(id),
      async append(input) {
        if (input.events.some(event => event.payload.type === failedType)) {
          if (completeElsewhere) {
            await durable.append(input);
            const turnId = (input.events[0]!.metadata!.handrail_runtime as { turn_id: string }).turn_id;
            if (failedType !== "turn.completed") await durable.append({ conversationId, expectedRevision: input.events.at(-1)!.revision,
              events: [parseConversationEvent({ version: 1, conversation_id: conversationId,
                event_id: "server-completed", revision: input.events.at(-1)!.revision + 1,
                occurred_at: "2026-09-05T00:00:00Z", actor: { type: "system" }, source: { type: "runtime" },
                payload: { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] } })] });
          }
          throw new Error("Conversation synchronization is unavailable.");
        }
        return durable.append(input);
      },
    };
    const transport = new FakeTransport();
    transport.startObservations.push(observation([startedFrame(), deltaFrame(1, "Hey!"), completedFrame(2)], "completed"));
    const runtime = await createConversationRuntime({ conversationId, clientId, eventStore, transport,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }), ...deterministicSources() });
    try {
      const result = await runtime.sendMessage({ content: "hey", request: { prompt: "hey" } });
      expect(result.status).toBe(completeElsewhere ? "completed" : "interrupted");
      expect(transport.starts).toHaveLength(1);
      if (completeElsewhere) {
        expect(result.error).toBeUndefined();
        expect(runtime.getSnapshot().messages.filter(message => message.role === "assistant")).toHaveLength(1);
      }
    } finally { runtime.destroy(); }
  });

  it("keeps abrupt EOF disconnected and resumes from the last safely persisted frame after restart", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Recovered"),
    ], "disconnected"));
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtimeBeforeRestart.sendMessage({
      content: "Resume me",
      request: { prompt: "Resume me" },
    });
    expect(disconnected.status).toBe("disconnected");
    expect(disconnected.usageReceipts).toEqual([]);
    expect(Object.isFrozen(disconnected.usageReceipts)).toBe(true);
    expect(runtimeBeforeRestart.getSnapshot().turns[0]?.status).toBe("running");
    expect(runtimeBeforeRestart.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_exhausted",
        attempt: 1,
        reason_category: "disconnected",
        exhaustion_reason: "maximum_attempts",
      },
    ]);
    expect(disconnected.checkpoint).toMatchObject({
      lastAppliedEventId: "remote-turn-1:1",
      lastAppliedRevision: 6,
    });
    expect(runtimeBeforeRestart.getSnapshot().messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Recovered" }],
    });
    const streamedMessageId = runtimeBeforeRestart.getSnapshot().messages[1]?.message_id;
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      deltaFrame(1, "Recovered"),
      deltaFrame(2, " once"),
      completedFrame(3),
    ], "completed"));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    expect(runtimeAfterRestart.getSnapshot().messages[1]).toMatchObject({
      message_id: streamedMessageId,
      content: [{ type: "text", text: "Recovered" }],
    });
    expect(runtimeAfterRestart.getSnapshot().active_turn_id).not.toBeNull();

    const resumed = await runtimeAfterRestart.restoreActiveTurn();
    expect(resumed?.status).toBe("completed");
    expect(transport.resumes).toEqual([{
      conversationId,
      turnId: "remote-turn-1",
      resumeFrom: {
        lastAppliedEventId: "remote-turn-1:1",
        lastAppliedCursor: "remote-turn-1:1",
        lastAppliedRevision: 6,
      },
    }]);
    expect(runtimeAfterRestart.getSnapshot().messages[1]).toMatchObject({
      message_id: streamedMessageId,
      content: [{ type: "text", text: "Recovered once" }],
    });
    expect(runtimeAfterRestart.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      output_message_ids: [streamedMessageId],
    });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(2);
  });

  it("disconnects local observers and clears subscriptions on destroy without deleting history", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const disconnected = vi.fn();
    transport.startObservations.push(pendingObservation(disconnected));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    const observer = vi.fn();
    runtime.observe(observer);
    const sending = runtime.sendMessage({
      content: "Stay active",
      request: { prompt: "Stay active" },
    });
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));
    const revisionBeforeDestroy = await eventStore.getLatestRevision(conversationId);

    runtime.destroy();
    runtime.destroy();

    await expect(sending).rejects.toThrow("destroyed");
    expect(disconnected).toHaveBeenCalledOnce();
    expect(await eventStore.getLatestRevision(conversationId)).toBe(revisionBeforeDestroy);
    const observerCalls = observer.mock.calls.length;
    await Promise.resolve();
    expect(observer).toHaveBeenCalledTimes(observerCalls);
  });

  it("aborts a pending runtime retry delay on destroy", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startFailures.push({
      code: "unavailable",
      message: "Temporarily unavailable",
      retryable: true,
    });
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        sleep: (_delayMs, signal) => {
          markSleepStarted();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      }),
      ...deterministicSources(),
    });
    const sending = runtime.sendMessage({
      content: "Destroy during retry",
      request: { prompt: "Destroy during retry" },
    });
    await sleepStarted;

    runtime.destroy();

    await expect(sending).rejects.toThrow("destroyed");
    expect(transport.starts).toHaveLength(1);
  });
});
