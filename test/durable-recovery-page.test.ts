import { expect, it, vi } from "vitest";
import { createDurableApplicationTransport, DurableRecoveryWorkerPool, InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";

const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
async function fixture(count = 60) {
  const store = new InMemoryDurableApplicationTurnStore<string, never>();
  for (let index = 0; index < count; index++) await store.create({ schemaVersion: 1,
    conversationId: `chat-${String(index).padStart(3, "0")}`, turnId: "turn", mutationId: "admission", idempotencyKey: "start",
    requestFingerprint: "saved", request: "saved", delegateTurnId: null, status: "pending", attempt: 0,
    events: [], terminal: null, cancellation: null, lease: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const authorize = vi.fn(async (_input: { conversationId: string; turnId: string }) => false);
  const execute = vi.fn(async () => ({ status: "completed" as const, checkpoint }));
  const transport = createDurableApplicationTransport({ store, workerId: "worker", pollMilliseconds: 25,
    delegate: createApplicationTurnTransport<never, string>({ execute }), authorizeRecovery: authorize,
    requestCodec: { encode: request => request, decode: request => request, fingerprint: request => request },
    checkpointForEvent: () => checkpoint });
  return { store, authorize, execute, transport };
}

it("bounds each discovery batch and lets a reauthorized later page reach work behind denied identities", async () => {
  const f = await fixture();
  const load = vi.spyOn(f.store, "load"), scan = vi.spyOn(f.store, "scanRecoveryCandidates");
  const first = await f.transport.recoverPendingPage({ limit: 25 });
  expect(first.started).toEqual([]); expect(first.cursor).not.toBeNull();
  expect(f.authorize).toHaveBeenCalledTimes(25); expect(scan).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled();
  const second = await f.transport.recoverPendingPage({ limit: 25, cursor: first.cursor! });
  expect(second.started).toEqual([]); expect(f.authorize).toHaveBeenCalledTimes(50); expect(load).not.toHaveBeenCalled();
  f.authorize.mockImplementation(async ({ conversationId }) => conversationId === "chat-059");
  const last = await f.transport.recoverPendingPage({ limit: 25, cursor: second.cursor! });
  expect(last).toEqual({ started: [{ conversationId: "chat-059", turnId: "turn" }], cursor: null });
  await vi.waitFor(async () => expect((await f.store.load("chat-059", "turn"))?.record.status).toBe("completed"));
  expect(f.execute).toHaveBeenCalledOnce();
  expect(load.mock.calls.every(([id]) => id === "chat-059")).toBe(true);
});

it("cancels discovery during authorization before loading or claiming the saved turn", async () => {
  const f = await fixture(1), closed = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.authorize.mockImplementation(async () => { await held; return true; });
  const load = vi.spyOn(f.store, "load");
  const pending = f.transport.recoverPendingPage({ limit: 1, signal: closed.signal });
  await vi.waitFor(() => expect(f.authorize).toHaveBeenCalledOnce());
  closed.abort(); release();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(load).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  await expect(f.transport.recoverPendingPage({ signal: closed.signal })).rejects.toMatchObject({ name: "AbortError" });
});

it("bounds recovered execution and body hydration across 30 isolated contexts, then drains without cancelling intent", async () => {
  const pool = new DurableRecoveryWorkerPool(4);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  const contexts = await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const { store } = await fixture(1);
    const load = vi.spyOn(store, "load");
    const execute = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active); await held; active--;
      return { status: "completed" as const, checkpoint };
    });
    const transport = createDurableApplicationTransport({ store, workerId: `context-${index}`, pollMilliseconds: 25,
      recoveryWorkers: pool, authorizeRecovery: () => true,
      delegate: createApplicationTurnTransport<never, string>({ execute }),
      requestCodec: { encode: request => request, decode: request => request, fingerprint: request => request },
      checkpointForEvent: () => checkpoint });
    return { store, load, execute, transport };
  }));
  const results = await Promise.all(contexts.map(context => context.transport.recoverPendingPage()));
  expect(results.filter(page => page.started.length === 1)).toHaveLength(4);
  expect(results.filter(page => page.deferred)).toHaveLength(26);
  await vi.waitFor(() => expect(active).toBe(4)); expect(maximum).toBe(4);
  const deferred = contexts.filter((_, index) => results[index]?.deferred);
  for (const context of deferred) expect(context.load).not.toHaveBeenCalled();
  let stopped = false;
  const draining = Promise.all(contexts.filter((_, index) => results[index]?.started.length).map(context => context.transport.stopWorkers()))
    .then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  release(); await draining; expect(pool.available).toBe(true);
  for (const context of contexts.filter((_, index) => results[index]?.started.length)) {
    expect((await context.store.load("chat-000", "turn"))?.record).toMatchObject({ status: "completed", cancellation: null });
    await expect(context.transport.recoverPendingPage()).rejects.toThrow("draining");
  }
  // Durable intent skipped under load is still recoverable by a later batch.
  expect((await deferred[0]!.transport.recoverPendingPage()).started).toHaveLength(1);
  await vi.waitFor(() => expect(deferred[0]!.execute).toHaveBeenCalledOnce());
  await Promise.all(deferred.map(context => context.transport.stopWorkers()));
});

it("repeats a partially dispatched page after capacity returns without duplicating its earlier turn", async () => {
  const { store } = await fixture(3), pool = new DurableRecoveryWorkerPool(1);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = vi.fn(async () => { await held; return { status: "completed" as const, checkpoint }; });
  const transport = createDurableApplicationTransport({ store, workerId: "worker", pollMilliseconds: 25,
    recoveryWorkers: pool, authorizeRecovery: () => true,
    delegate: createApplicationTurnTransport<never, string>({ execute }),
    requestCodec: { encode: request => request, decode: request => request, fingerprint: request => request },
    checkpointForEvent: () => checkpoint });
  const first = await transport.recoverPendingPage({ limit: 3 });
  expect(first).toMatchObject({ started: [{ conversationId: "chat-000" }], cursor: null, deferred: true });
  release(); await vi.waitFor(() => expect(pool.available).toBe(true));
  for (let i = 0; i < 3; i++) {
    await transport.recoverPendingPage({ limit: 3 });
    await vi.waitFor(() => expect(pool.available).toBe(true));
  }
  expect(execute).toHaveBeenCalledTimes(3);
  await transport.stopWorkers();
});
