import { createApplicationTurnTransport } from "../src/transports/application-turn.js";
import { describe, expect, it, vi } from "vitest";

import {
  createDurableApplicationTransport,
  durableApplicationTurnStartMatches,
  InMemoryDurableApplicationTurnStore,
} from "../src/transports/durable.js";
import type { ConversationTransport, TurnObservationResult } from "../src/transports/types.js";
import type { ConversationTurnId } from "../src/conversation/events.js";

type Event = { readonly id: string; readonly text: string };
type Request = { readonly ref: string };

const checkpoint = (id: string | null) => ({ lastAppliedEventId: id, lastAppliedCursor: id, lastAppliedRevision: null });
const capabilities: ConversationTransport<Event, Request>["capabilities"] = {
  authoritativeCancellation: { supported: false }, documentInput: { supported: false },
  attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
};

function delegate(events: readonly Event[], result: TurnObservationResult = { status: "completed", checkpoint: checkpoint("2") }) {
  const startTurn = vi.fn<ConversationTransport<Event, Request>["startTurn"]>(async (input) => ({ ok: true, value: {
    conversationId: input.conversationId, turnId: `provider-${input.conversationTurnId}`, mutationId: input.mutationId,
    observation: { events: (async function* () { for (const event of events) yield event; })(),
      result: Promise.resolve(result), disconnect() {} },
  } }));
  const transport: ConversationTransport<Event, Request> = { capabilities, startTurn,
    async resumeTurn() { return { ok: false, error: { code: "not_found", message: "not supported", retryable: false } }; } };
  return { transport, startTurn };
}

function durable(store: InMemoryDurableApplicationTurnStore<Request, Event>, inner: ConversationTransport<Event, Request>, workerId: string) {
  return createDurableApplicationTransport({ delegate: inner, store, workerId, pollMilliseconds: 25,
    requestCodec: { encode: (request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
    checkpointForEvent: (event) => checkpoint(event.id) });
}

const input = { conversationId: "conversation-1", conversationTurnId: "turn-1" as ConversationTurnId,
  mutationId: "mutation-1", idempotencyKey: "start-1", request: { ref: "request-1" } };
async function collect(events: AsyncIterable<Event>) { const output: Event[] = []; for await (const event of events) output.push(event); return output; }

describe("createDurableApplicationTransport", () => {
  it.each(["completed", "failed", "cancelled"] as const)("publishes %s without observers and does not republish on replay", async (status) => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const terminal: TurnObservationResult = status === "failed"
      ? { status, checkpoint: checkpoint("2"), error: { code: "unavailable", message: "Failed", retryable: true } }
      : { status, checkpoint: checkpoint("2") };
    const inner = delegate([{ id: "2", text: "result" }], terminal);
    const onTurnStatusChanged = vi.fn();
    const transport = createDurableApplicationTransport({ delegate: inner.transport, store, workerId: "writer",
      pollMilliseconds: 25, onTurnStatusChanged,
      requestCodec: { encode: (request: Request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
      checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    started.value.observation.disconnect();
    // Never consume the original stream: completion must belong to the worker.
    await vi.waitFor(() => expect(onTurnStatusChanged.mock.calls.map(([update]) => update.status))
      .toEqual(["pending", "running", status]));
    expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status).toBe(status);
    const replay = await transport.startTurn(input);
    if (!replay.ok) throw new Error(replay.error.message);
    await collect(replay.value.observation.events);
    expect((await replay.value.observation.result).status).toBe(status);
    const resumed = await transport.resumeTurn({ conversationId: input.conversationId,
      turnId: input.conversationTurnId, resumeFrom: checkpoint(null) });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await collect(resumed.value.events);
    expect((await resumed.value.result).status).toBe(status);
    expect(onTurnStatusChanged).toHaveBeenCalledTimes(3);
    expect(inner.startTurn).toHaveBeenCalledOnce();
  });

  it("keeps a durable success when status delivery fails", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const diagnostics = vi.fn();
    const transport = createDurableApplicationTransport({ delegate: delegate([]).transport, store, workerId: "writer",
      pollMilliseconds: 25, diagnostics, onTurnStatusChanged: () => { throw new Error("delivery unavailable"); },
      requestCodec: { encode: (request: Request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
      checkpointForEvent: (event) => checkpoint(event.id) });
    await transport.startTurn(input);
    await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status)
      .toBe("completed"));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      domain: "activity", operation: "durable_turn_status", code: "activity_update_failed" }));
  });
  it("matches idempotent JSON identity after Postgres jsonb reorders keys", () => {
    const base = { schemaVersion: 1 as const, conversationId: "conversation-1", turnId: "turn-1",
      mutationId: "mutation-1", idempotencyKey: "start-1", requestFingerprint: "request-1",
      delegateTurnId: null, status: "pending" as const, attempt: 0, events: [], terminal: null,
      cancellation: null, lease: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(durableApplicationTurnStartMatches({ ...base, request: { b: 2, a: 1 } },
      { ...base, request: { a: 1, b: 2 } })).toBe(true);
  });
  it("starts once, checkpoints events, and replays after a process change", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const firstDelegate = delegate([{ id: "1", text: "hello" }, { id: "2", text: " world" }]);
    const first = durable(store, firstDelegate.transport, "worker-a");
    const started = await first.startTurn(input);
    expect(started.ok).toBe(true); if (!started.ok) return;
    expect(await collect(started.value.observation.events)).toEqual([
      { id: "1", text: "hello" }, { id: "2", text: " world" },
    ]);
    expect((await started.value.observation.result).status).toBe("completed");

    const secondDelegate = delegate([]);
    const second = durable(store, secondDelegate.transport, "worker-b");
    const resumed = await second.resumeTurn({ conversationId: input.conversationId, turnId: input.conversationTurnId,
      resumeFrom: checkpoint("1") });
    expect(resumed.ok).toBe(true); if (!resumed.ok) return;
    expect(await collect(resumed.value.events)).toEqual([{ id: "2", text: " world" }]);
    expect((await resumed.value.result).status).toBe("completed");
    expect(firstDelegate.startTurn).toHaveBeenCalledTimes(1);
    expect(secondDelegate.startTurn).not.toHaveBeenCalled();
  });

  it("makes identical starts idempotent and rejects changed request identity", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const inner = delegate([]);
    const transport = durable(store, inner.transport, "worker-a");
    expect((await transport.startTurn(input)).ok).toBe(true);
    expect((await transport.startTurn(input)).ok).toBe(true);
    const conflict = await transport.startTurn({ ...input, request: { ref: "request-2" } });
    expect(conflict).toEqual({ ok: false, error: { code: "conflict",
      message: "The turn start conflicts with retained identity.", retryable: false } });
    await vi.waitFor(() => expect(inner.startTurn).toHaveBeenCalledTimes(1));
  });

  it("allows only one process to claim a shared pending turn", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const innerA = delegate([]), innerB = delegate([]);
    const a = durable(store, innerA.transport, "worker-a"), b = durable(store, innerB.transport, "worker-b");
    await Promise.all([a.startTurn(input), b.startTurn(input)]);
    await vi.waitFor(() => expect(innerA.startTurn.mock.calls.length + innerB.startTurn.mock.calls.length).toBe(1));
  });

  it("does not invoke the provider when cancellation arrives during request decoding", async () => {
    let release!: () => void, entered!: () => void, decodeSignal: AbortSignal | undefined;
    const decoding = new Promise<void>((resolve) => { entered = resolve; });
    const continueDecode = new Promise<void>((resolve) => { release = resolve; });
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const inner = delegate([]);
    const transport = createDurableApplicationTransport({ delegate: inner.transport, store,
      workerId: "decode-worker", pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request,
        async decode(request: Request, context) { decodeSignal = context?.signal; entered(); await continueDecode; return request; },
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await decoding;
    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("Missing cancellation");
    expect(await cancellation.capability.cancelTurn({ conversationId: input.conversationId,
      turnId: input.conversationTurnId, mutationId: "cancel-decoding", idempotencyKey: "cancel-decoding",
      reason: "user" })).toMatchObject({ ok: true });
    try {
      await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status).toBe("cancelled"));
    } finally { release(); }
    await collect(started.value.observation.events);
    expect(await started.value.observation.result).toMatchObject({ status: "cancelled" });
    expect(inner.startTurn).not.toHaveBeenCalled();
    expect(decodeSignal?.aborted).toBe(true);
  });

  it("does not execute a decoded request after another worker takes its expired lease", async () => {
    let clock = 1_000, release!: () => void, entered!: () => void;
    const decoding = new Promise<void>((resolve) => { entered = resolve; });
    const continueDecode = new Promise<void>((resolve) => { release = resolve; });
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const firstDelegate = delegate([{ id: "wrong", text: "old worker" }]);
    const secondDelegate = delegate([{ id: "winner", text: "new worker" }]);
    const first = createDurableApplicationTransport({ delegate: firstDelegate.transport, store,
      workerId: "old-worker", now: () => clock, leaseMilliseconds: 1_000, pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request,
        async decode(request: Request) { entered(); await continueDecode; return request; },
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const second = createDurableApplicationTransport({ delegate: secondDelegate.transport, store,
      workerId: "new-worker", now: () => clock, leaseMilliseconds: 1_000, pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request, decode: (request: Request) => request,
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await first.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await decoding;
    clock = 3_000;
    await second.recoverTurn(input.conversationId, input.conversationTurnId);
    await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status).toBe("completed"));
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await collect(started.value.observation.events)).toEqual([{ id: "winner", text: "new worker" }]);
    expect(firstDelegate.startTurn).not.toHaveBeenCalled();
    expect(secondDelegate.startTurn).toHaveBeenCalledOnce();
  });

  it("keeps the preparation lease live while an input lookup is still pending", async () => {
    let clock = 1_000, release!: () => void, entered!: () => void;
    const decoding = new Promise<void>((resolve) => { entered = resolve; });
    const continueDecode = new Promise<void>((resolve) => { release = resolve; });
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const inner = delegate([]), contenderDelegate = delegate([]);
    const transport = createDurableApplicationTransport({ delegate: inner.transport, store,
      workerId: "preparing-worker", now: () => clock, leaseMilliseconds: 1_000, pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request,
        async decode(request: Request) { entered(); await continueDecode; return request; },
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const contender = createDurableApplicationTransport({ delegate: contenderDelegate.transport, store,
      workerId: "contender", now: () => clock, leaseMilliseconds: 1_000, pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request, decode: (request: Request) => request,
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await decoding;
    clock = 1_600;
    try {
      await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.lease?.expiresAt)
        .toBe(new Date(2_600).toISOString()));
      clock = 2_100;
      expect(await contender.recoverTurn(input.conversationId, input.conversationTurnId))
        .toMatchObject({ ok: true, value: { status: "already_running" } });
      expect(contenderDelegate.startTurn).not.toHaveBeenCalled();
    } finally { release(); }
    await collect(started.value.observation.events);
    expect(inner.startTurn).toHaveBeenCalledOnce();
  });

  it("renews an expired decode lease before provider dispatch", async () => {
    let clock = 1_000, release!: () => void, entered!: () => void, dispatchExpiry: string | undefined;
    const decoding = new Promise<void>((resolve) => { entered = resolve; });
    const continueDecode = new Promise<void>((resolve) => { release = resolve; });
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const inner = delegate([]);
    const transport = createDurableApplicationTransport({ delegate: { ...inner.transport,
      async startTurn(value) {
        dispatchExpiry = (await store.load(value.conversationId, value.conversationTurnId))?.record.lease?.expiresAt;
        return inner.transport.startTurn(value);
      } }, store, workerId: "decode-worker", now: () => clock, leaseMilliseconds: 1_000, pollMilliseconds: 25,
      requestCodec: { encode: (request: Request) => request,
        async decode(request: Request) { entered(); await continueDecode; return request; },
        fingerprint: (request: Request) => request.ref }, checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await decoding;
    clock = 3_000;
    release();
    await collect(started.value.observation.events);
    expect(dispatchExpiry).toBe(new Date(4_000).toISOString());
    expect((await started.value.observation.result).status).toBe("completed");
  });

  it("persists cancellation, forwards it once, and emits nothing after the cancelled terminal", async () => {
    let finish!: () => void, entered!: () => void, cancellationCalls = 0;
    const providerStarted = new Promise<void>((resolve) => { entered = resolve; });
    const cancelled = new Promise<void>((resolve) => { finish = resolve; });
    const inner: ConversationTransport<Event, Request> = {
      capabilities: { ...capabilities, authoritativeCancellation: { supported: true, capability: {
        async cancelTurn() { cancellationCalls += 1; finish();
          return { ok: true as const, value: { status: "cancellation_requested" as const } }; },
      } } },
      async startTurn(value) { entered(); return { ok: true, value: { conversationId: value.conversationId,
        turnId: "provider-turn", mutationId: value.mutationId, observation: {
          events: (async function* () { await cancelled; yield* [] as Event[]; })(),
          result: cancelled.then(() => ({ status: "cancelled" as const, checkpoint: checkpoint(null) })),
          disconnect() { finish(); },
        } } }; },
      async resumeTurn() { return { ok: false, error: { code: "not_found", message: "unused", retryable: false } }; },
    };
    const transport = durable(new InMemoryDurableApplicationTurnStore<Request, Event>(), inner, "worker-cancel");
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await providerStarted;
    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("cancellation missing");
    expect(await cancellation.capability.cancelTurn({ conversationId: input.conversationId,
      turnId: input.conversationTurnId, mutationId: "cancel-mutation", idempotencyKey: "cancel-idem",
      reason: "user" })).toMatchObject({ ok: true, value: { status: "cancellation_requested" } });
    expect(await collect(started.value.observation.events)).toEqual([]);
    expect(await started.value.observation.result).toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(cancellationCalls).toBe(1));
  });
});


it("does not recover or poll approval waits, and human resumes do not exhaust the crash budget", async () => {
  const store = new InMemoryDurableApplicationTurnStore<string, never>();
  let invocations = 0;
  const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
  const worker = (workerId: string) => createDurableApplicationTransport({ store, workerId, maximumAttempts: 1, pollMilliseconds: 25,
    delegate: createApplicationTurnTransport<never, string>({ execute: async () => {
      invocations++;
      return invocations < 5 ? { status: "waiting_for_approval", pendingToolCallIds: [`call-${invocations}`], checkpoint }
        : { status: "completed", checkpoint };
    } }), requestCodec: { encode: value => value, decode: value => value, fingerprint: value => value },
    checkpointForEvent: () => checkpoint });
  const started = await worker("first").startTurn({ conversationId: "paused", conversationTurnId: "paused" as never,
    mutationId: "paused", idempotencyKey: "paused", request: "saved" });
  if (!started.ok) throw new Error(started.error.message);
  for await (const event of started.value.observation.events) { void event; }
  expect((await started.value.observation.result).status).toBe("waiting_for_approval");
  for (let index = 1; index < 5; index++) {
    const restarted = worker(`worker-${index}`);
    expect(await restarted.recoverPending()).toEqual([]);
    expect(invocations).toBe(index);
    expect((await store.load("paused", "paused"))?.record.lease).toBeNull();
    await restarted.resumeApprovalTurn("paused", "paused");
    await vi.waitFor(async () => expect((await store.load("paused", "paused"))?.record.status).toBe(index < 4 ? "waiting_for_approval" : "completed"));
  }
  expect((await store.load("paused", "paused"))?.record).toMatchObject({ attempt: 5, approvalResumes: 4 });
});
