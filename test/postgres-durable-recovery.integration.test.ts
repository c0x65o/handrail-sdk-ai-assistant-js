import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresDurableApplicationTurnStore, type PostgresSqlClient } from "../src/postgres/index.js";
import { createDurableApplicationTransport, type DurableApplicationRecoveryCursor,
  type DurableApplicationTurnRecord } from "../src/transports/durable.js";
import { createApplicationTurnTransport } from "../src/transports/application-turn.js";

const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const pending = (conversationId: string, turnId: string): DurableApplicationTurnRecord<string, never> => ({
  schemaVersion: 1, conversationId, turnId, mutationId: `admission-${conversationId}-${turnId}`,
  idempotencyKey: `start-${conversationId}-${turnId}`, requestFingerprint: "request", request: "request",
  delegateTurnId: null, status: "pending", attempt: 0, events: [], terminal: null, cancellation: null, lease: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

it("pages on immutable tenant keys, retains the scan boundary, and recovers behind denied rows without claiming them", async () => {
  const database = new PGlite();
  const sql: PostgresSqlClient = {
    async query<T extends Record<string, unknown>>(query: string, values?: readonly unknown[]) {
      const result = await database.query<T>(query, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    transaction: operation => operation(sql),
  };
  try {
    const persistence = new PostgresAiPersistence(sql);
    await persistence.migrate();
    const store = new PostgresDurableApplicationTurnStore<string, never>(persistence, "household");
    const foreign = new PostgresDurableApplicationTurnStore<string, never>(persistence, "foreign-household");
    for (let index = 0; index < 30; index++) await store.create(pending("alice", `turn-${String(index).padStart(2, "0")}`));
    await store.create(pending("bob", "turn-00"));
    await store.create(pending("bob", "turn-01"));
    await foreign.create(pending("bob", "turn-00"));
    const first = await store.scanRecoverable(7);
    expect(first.documents).toHaveLength(7);
    expect(first.cursor).not.toBeNull();
    // Changing a visited row's update time/status must not shift later pages.
    const visited = first.documents[0]!;
    await store.compareAndSet({ conversationId: "alice", turnId: visited.record.turnId, expectedVersion: visited.version,
      record: { ...visited.record, status: "completed", terminal: { status: "completed", checkpoint } } });
    // A newly appended high key is for the next recovery pass, beyond this scan's upper bound.
    await store.create(pending("zzz", "new-work"));
    const seen = first.documents.map(item => `${item.record.conversationId}/${item.record.turnId}`);
    let cursor: DurableApplicationRecoveryCursor | null = first.cursor;
    while (cursor) {
      const page = await store.scanRecoverable(7, cursor);
      expect(page.documents.length).toBeLessThanOrEqual(7);
      seen.push(...page.documents.map(item => `${item.record.conversationId}/${item.record.turnId}`));
      cursor = page.cursor;
    }
    expect(seen).toHaveLength(32);
    expect(new Set(seen).size).toBe(32);
    expect(seen.slice(-2)).toEqual(["bob/turn-00", "bob/turn-01"]);
    const aliceBefore = await Promise.all(Array.from({ length: 30 }, (_, index) => store.load("alice", `turn-${String(index).padStart(2, "0")}`)));
    const execute = vi.fn(async () => ({ status: "completed" as const, checkpoint }));
    const transport = createDurableApplicationTransport({ store, workerId: "bob-worker", pollMilliseconds: 25,
      delegate: createApplicationTurnTransport<never, string>({ execute }),
      requestCodec: { encode: request => request, decode: request => request, fingerprint: request => request },
      checkpointForEvent: () => checkpoint,
      authorizeRecovery: ({ conversationId }) => conversationId === "bob",
    });
    // The bound limits work started, not how many denied rows can hide that work.
    expect(await transport.recoverPending(1)).toEqual([{ conversationId: "bob", turnId: "turn-00" }]);
    await vi.waitFor(async () => expect((await store.load("bob", "turn-00"))?.record.status).toBe("completed"));
    expect((await store.load("bob", "turn-01"))?.record.status).toBe("pending");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await transport.recoverPending(1)).toEqual([{ conversationId: "bob", turnId: "turn-01" }]);
    await vi.waitFor(async () => expect((await store.load("bob", "turn-01"))?.record.status).toBe("completed"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await Promise.all(Array.from({ length: 30 }, (_, index) => store.load("alice", `turn-${String(index).padStart(2, "0")}`)))).toEqual(aliceBefore);
    expect((await foreign.load("bob", "turn-00"))?.record).toEqual(pending("bob", "turn-00"));
    expect((await store.load("zzz", "new-work"))?.record.status).toBe("pending");
    expect(await transport.recoverPending(1)).toEqual([]);
  } finally { await database.close(); }
}, 30_000);
