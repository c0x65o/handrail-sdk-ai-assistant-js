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

it("discovers large retained histories through scalar metadata and authorizes before loading any body", async () => {
  const database = new PGlite();
  const reads: { query: string; rows: readonly Record<string, unknown>[] }[] = [];
  const sql: PostgresSqlClient = {
    async query<T extends Record<string, unknown>>(query: string, values: readonly unknown[] = []) {
      const result = await database.query<T>(query, [...values]);
      reads.push({ query, rows: result.rows });
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: operation => operation(sql),
  };
  try {
    const persistence = new PostgresAiPersistence(sql); await persistence.migrate();
    const store = new PostgresDurableApplicationTurnStore<string, never>(persistence, "tenant");
    // Payload length varies by 5x; recovery discovery must return neither body.
    for (const size of [20_000, 100_000]) {
      const saved = pending(`denied-${size}`, "turn");
      await store.create({ ...saved, request: `private-${"event-frame ".repeat(size)}` });
    }
    const leased = pending("leased", "turn");
    await store.create({ ...leased, status: "running", lease: { ownerId: "other-worker", expiresAt: "2099-01-01T00:00:00.000Z" } });
    reads.length = 0;
    const page = await store.scanRecoveryCandidates(10);
    const beforeMigration = await sql.query("SELECT scope_id,record_id,version::text,updated_at::text,durable_status FROM handrail_ai_documents WHERE tenant_id='tenant' ORDER BY scope_id,record_id");
    await persistence.migrate(); // Real repeated DDL, including function and trigger.
    expect(await store.scanRecoveryCandidates(10)).toEqual(page);
    expect(await sql.query("SELECT scope_id,record_id,version::text,updated_at::text,durable_status FROM handrail_ai_documents WHERE tenant_id='tenant' ORDER BY scope_id,record_id"))
      .toEqual(beforeMigration);
    expect(page.candidates.map(candidate => candidate.conversationId)).toEqual(["denied-100000", "denied-20000", "leased"]);
    expect(Object.keys(page.candidates[0]!)).toEqual(["conversationId", "turnId", "lease"]);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(1024);
    expect(reads.flatMap(read => read.rows).some(row => "payload" in row || "request" in row)).toBe(false);
    const discovery = reads.filter(read => read.query.startsWith("SELECT"));
    expect(discovery.every(read => !read.query.includes("payload"))).toBe(true);
    const load = vi.spyOn(store, "load"), legacy = vi.spyOn(store, "scanRecoverable");
    const authorize = vi.fn(async () => false), execute = vi.fn();
    const worker = createDurableApplicationTransport({ store, workerId: "fresh-worker",
      delegate: createApplicationTurnTransport<never, string>({ execute }),
      requestCodec: { encode: request => request, decode: request => request, fingerprint: request => request },
      checkpointForEvent: () => checkpoint, authorizeRecovery: authorize });
    expect(await worker.recoverPending(10)).toEqual([]);
    expect(authorize.mock.calls).toHaveLength(2); // A known live foreign lease needs no claim/read.
    expect(load).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    // The bounded legacy preparation watermark survives a new store instance.
    await sql.query("UPDATE handrail_ai_documents SET durable_status=NULL,durable_lease_owner=NULL,durable_lease_expires_at=NULL WHERE tenant_id='tenant'");
    const restarted = new PostgresDurableApplicationTurnStore(persistence, "tenant");
    expect(await restarted.backfillRecoveryMetadata(1)).toBe(1);
    expect(await new PostgresDurableApplicationTurnStore(persistence, "tenant").backfillRecoveryMetadata(1)).toBe(1);
    expect(await restarted.backfillRecoveryMetadata(1)).toBe(1);
    expect(await restarted.backfillRecoveryMetadata(1)).toBe(0);
    expect(await restarted.scanRecoveryCandidates(10)).toEqual(page);
    // A rolling old writer knows only payload/version. The trigger cannot leave
    // a resolved record in the index or hide a newly re-admitted one.
    await sql.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{status}','\"completed\"') WHERE tenant_id='tenant' AND scope_id='denied-20000'");
    expect((await restarted.scanRecoveryCandidates(10)).candidates.map(candidate => candidate.conversationId))
      .toEqual(["denied-100000", "leased"]);
    await sql.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{status}','\"pending\"') WHERE tenant_id='tenant' AND scope_id='denied-20000'");
    expect((await restarted.scanRecoveryCandidates(10)).candidates).toHaveLength(3);
    const foreign = new PostgresDurableApplicationTurnStore(persistence, "other-tenant");
    expect((await foreign.scanRecoveryCandidates(10)).candidates).toEqual([]);
  } finally { await database.close(); }
}, 30_000);
