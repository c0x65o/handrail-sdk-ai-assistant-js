import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresDurableApplicationTurnStore, type PostgresSqlClient } from "../src/postgres/index.js";
import { createAssistantActivityTransport } from "../src/presence/assistant-activity.js";
import { createInMemoryLivePresenceDelivery } from "../src/presence/live-delivery.js";
import { createApplicationTurnTransport, type ApplicationTurnExecutionContext,
  type ApplicationTurnTransportOptions } from "../src/transports/application-turn.js";
import { createApplicationGateway, createApplicationGatewayTransport } from "../src/transports/application-gateway.js";
import { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore,
  type DurableApplicationTurnStore } from "../src/transports/durable.js";
import type { ConversationTransport, StartTurnInput, TurnObservation } from "../src/transports/types.js";

type RequestData = { ref: string };
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const input: StartTurnInput<RequestData> = { conversationId: "conversation-1", conversationTurnId: "turn-1" as never,
  mutationId: "mutation-1", idempotencyKey: "start-1", request: { ref: "request-1" } };
const identity = (attempt: number) => ({ conversationId: input.conversationId, turnId: input.conversationTurnId, attempt });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function drain(observation: TurnObservation<string>) {
  const events = []; for await (const event of observation.events) events.push(event);
  return { events, result: await observation.result };
}
function durable(store: DurableApplicationTurnStore<RequestData, string>, delegate: ConversationTransport<string, RequestData>,
  workerId: string, now = Date.now) {
  return createDurableApplicationTransport({ store, delegate, workerId, now, leaseMilliseconds: 1_000, pollMilliseconds: 25,
    requestCodec: { encode: (request: RequestData) => request, decode: (request) => request, fingerprint: (request) => request.ref },
    checkpointForEvent: () => checkpoint });
}
async function fixture(kind: "memory" | "postgres") {
  if (kind === "memory") return { store: new InMemoryDurableApplicationTurnStore<RequestData, string>(), close: async () => {} };
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await db.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }, transaction: (operation) => operation(client),
    };
    return client;
  };
  const persistence = new PostgresAiPersistence({ query: adapt(database).query,
    transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
  await persistence.migrate();
  return { store: new PostgresDurableApplicationTurnStore<RequestData, string>(persistence, "tenant-1"), close: () => database.close() };
}

describe("durable execution identity", () => {
  it.each(["memory", "postgres"] as const)("retains the old claim after takeover and never re-executes terminal replay (%s)", async (kind) => {
    const { store, close } = await fixture(kind);
    const releaseOld = deferred(), oldFinished = deferred();
    const contexts: ApplicationTurnExecutionContext<string>[] = [];
    const delegatedInputs: StartTurnInput<RequestData>[] = [];
    const lateIdentities: unknown[] = [];
    let clock = 1_000;
    const worker = (workerId: string, old: boolean) => {
      const application = createApplicationTurnTransport<string, RequestData>({ async execute(_request, context) {
        contexts.push(context);
        if (old) {
          await releaseOld.promise;
          // This callback runs after a replacement has claimed and completed the turn.
          lateIdentities.push(context.durableExecution);
          oldFinished.resolve();
        }
        return { status: "completed", checkpoint };
      } });
      const activity = createAssistantActivityTransport({ delegate: application, delivery: createInMemoryLivePresenceDelivery(),
        sessionId: (_conversation, turn) => `${workerId}-${turn}`, activityForEvent: () => null });
      const delegate: ConversationTransport<string, RequestData> = { ...activity,
        startTurn(value, context) { delegatedInputs.push(value); return activity.startTurn(value, context); } };
      // The old process's clock is suspended, so its monitor cannot renew the expired lease.
      return durable(store, delegate, workerId, () => old ? 1_000 : clock);
    };
    const first = worker("worker-a", true), second = worker("worker-b", false);
    try {
      // A trusted outer caller cannot override the durable allocator either.
      const started = await first.startTurn(input, { durableExecution: identity(999) });
      if (!started.ok) throw new Error(started.error.message);
      await vi.waitFor(() => expect(contexts).toHaveLength(1));
      expect(contexts[0]?.durableExecution).toEqual(identity(1));
      expect(Object.isFrozen(contexts[0]?.durableExecution)).toBe(true);
      expect(Reflect.set(contexts[0]!.durableExecution!, "attempt", 999)).toBe(false);
      expect(await second.recoverTurn(input.conversationId, input.conversationTurnId))
        .toMatchObject({ ok: true, value: { status: "already_running" } });
      clock = 3_000;
      expect(await second.recoverTurn(input.conversationId, input.conversationTurnId))
        .toMatchObject({ ok: true, value: { status: "started" } });
      await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status).toBe("completed"));
      expect(contexts.map((context) => context.durableExecution)).toEqual([identity(1), identity(2)]);
      expect(delegatedInputs).toEqual([input, input]);
      expect(contexts.map(({ conversationId, turnId, mutationId }) => ({ conversationId, turnId, mutationId })))
        .toEqual([1, 2].map(() => ({ conversationId: input.conversationId, turnId: input.conversationTurnId, mutationId: input.mutationId })));
      releaseOld.resolve(); await oldFinished.promise;
      expect(lateIdentities).toEqual([identity(1)]);
      expect((await drain(started.value.observation)).result.status).toBe("completed");
      const replay = await second.startTurn(input);
      if (!replay.ok) throw new Error(replay.error.message);
      expect((await drain(replay.value.observation)).result.status).toBe("completed");
      const resumed = await second.resumeTurn({ conversationId: input.conversationId, turnId: input.conversationTurnId, resumeFrom: checkpoint });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect((await drain(resumed.value)).result.status).toBe("completed");
      expect(await second.recoverTurn(input.conversationId, input.conversationTurnId))
        .toMatchObject({ ok: true, value: { status: "terminal" } });
      expect(contexts).toHaveLength(2);
      expect((await store.load(input.conversationId, input.conversationTurnId))?.record.attempt).toBe(2);
    } finally {
      releaseOld.resolve();
      // Allow the old monitor/settlement to finish before closing its SQL boundary.
      await new Promise((resolve) => setTimeout(resolve, 75));
      await close();
    }
  }, 15_000);

  it.each([false, true])("ignores forged HTTP identity fields (durable=%s)", async (useDurable) => {
    const execute = vi.fn<ApplicationTurnTransportOptions<string, RequestData>["execute"]>(async () =>
      ({ status: "completed" as const, checkpoint }));
    const application = createApplicationTurnTransport({ execute });
    const transport = useDurable ? durable(new InMemoryDurableApplicationTurnStore<RequestData, string>(), application, "worker") : application;
    const gateway = createApplicationGateway({ transport, authorize: async () => ({ principalId: "user" }), checkpointForEvent: () => checkpoint });
    const client = createApplicationGatewayTransport<string, RequestData>({ baseUrl: "https://app.test/ai",
      fetch: (url, init) => gateway.handle(new Request(url, init)) });
    const forged = { ...input, attempt: 999, durableExecution: identity(999), context: { durableExecution: identity(999) },
      request: { ...input.request, durableExecution: identity(999) } };
    const started = await client.startTurn(forged, { durableExecution: identity(999) });
    if (!started.ok) throw new Error(started.error.message);
    expect((await drain(started.value.observation)).result.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1].durableExecution).toEqual(useDurable ? identity(1) : undefined);
  });

  it.each([false, true])("preserves cancellation and observation disconnect behavior (durable=%s)", async (useDurable) => {
    let captured: ApplicationTurnExecutionContext<string> | undefined;
    const execute = vi.fn(async (_request: RequestData, context: ApplicationTurnExecutionContext<string>) => {
      captured = context;
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "cancelled" as const, checkpoint };
    });
    const application = createApplicationTurnTransport({ execute });
    const transport = useDurable ? durable(new InMemoryDurableApplicationTurnStore<RequestData, string>(), application, "worker") : application;
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    await vi.waitFor(() => expect(captured).toBeDefined());
    started.value.observation.disconnect();
    expect(captured?.signal.aborted).toBe(false);
    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("Cancellation missing");
    await cancellation.capability.cancelTurn({ conversationId: input.conversationId, turnId: input.conversationTurnId,
      mutationId: "cancel-1", idempotencyKey: "cancel-1", reason: "user" });
    if (useDurable) {
      const resumed = await transport.resumeTurn({ conversationId: input.conversationId, turnId: input.conversationTurnId, resumeFrom: checkpoint });
      if (!resumed.ok) throw new Error(resumed.error.message);
      expect((await drain(resumed.value)).result.status).toBe("cancelled");
    } else {
      expect((await drain(started.value.observation)).result.status).toBe("cancelled");
    }
    expect(captured?.signal.aborted).toBe(true);
    expect(captured?.durableExecution).toEqual(useDurable ? identity(1) : undefined);
    expect(execute).toHaveBeenCalledOnce();
  });
});
