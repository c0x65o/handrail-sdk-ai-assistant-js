import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { deletePostgresConversationHistory, enqueuePostgresConversationFileCleanup, drainPostgresConversationFileCleanup,
  startPostgresConversationFileCleanupWorker, PostgresAiPersistence, type PostgresSqlClient } from "../src/postgres/index.js";
import type { ConversationId } from "../src/index.js";
const database = new PGlite();
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) }; return client;
};
const client: PostgresSqlClient = { query: adapt(database).query, transaction: operation =>
  database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
let sequence = 0;
let time = new Date("2026-09-13T00:00:00.000Z");
const now = () => time;
const seal = (conversationId: string, tenantId = "tenant") => deletePostgresConversationHistory({ client, tenantId,
  conversationId: conversationId as ConversationId, authorize: async () => undefined });
const prepare = async (scopeId: string, tenantId = "tenant") => {
  const jobId = `job-${++sequence}`, conversationId = `conversation-${sequence}`;
  await seal(conversationId, tenantId);
  const request = { client, tenantId, scopeId, conversationId, jobId, now: time, target: { key: `chat/${jobId}`, tenantId } };
  await client.transaction(tx => enqueuePostgresConversationFileCleanup({ ...request, client: tx }));
  return request;
};
const record = async (jobId: string) => (await client.query<{ payload: Record<string, unknown> }>(
  "SELECT payload FROM handrail_ai_documents WHERE kind='conversation_file_cleanup' AND record_id=$1", [jobId])).rows[0]?.payload;
const parseTarget = (value: unknown, tenantId: string) => {
  if (!value || typeof value !== "object" || !("key" in value) || typeof value.key !== "string" || !value.key.startsWith("chat/") ||
    !("tenantId" in value) || value.tenantId !== tenantId) throw new Error("Wrong target");
  return value.key;
};
beforeAll(async () => { await new PostgresAiPersistence(client).migrate(); }, 20_000);
afterAll(async () => { await database.close(); });

it("requires a sealed conversation and rolls back queued work with its deletion transaction", async () => {
  const input = { client, tenantId: "tenant", scopeId: "rollback", conversationId: "unsealed", jobId: "unsealed", target: { key: "chat/unsealed" } };
  await expect(enqueuePostgresConversationFileCleanup(input)).rejects.toThrow("sealed conversation");
  await seal(input.conversationId);
  await expect(client.transaction(async tx => {
    await enqueuePostgresConversationFileCleanup({ ...input, client: tx }); throw new Error("Audit failed");
  })).rejects.toThrow("Audit failed");
  expect(await record(input.jobId)).toBeUndefined();
});

it("deduplicates immutable targets, drains only its service partition and removes targets from completed receipts", async () => {
  const input = await prepare("success"), other = await prepare("another-service");
  await enqueuePostgresConversationFileCleanup({ ...input, target: { tenantId: input.tenantId, key: input.target.key } });
  await expect(client.transaction(tx => enqueuePostgresConversationFileCleanup({ ...input, client: tx, target: { key: "chat/different" } })))
    .rejects.toThrow("another object");
  const deleteFile = vi.fn(async () => undefined);
  expect(await drainPostgresConversationFileCleanup({ client, scopeId: "success", parseTarget, deleteFile, now }))
    .toEqual({ completed: 1, retrying: 0, blocked: 0 });
  expect(deleteFile).toHaveBeenCalledWith(input.target.key, expect.any(AbortSignal));
  expect(await record(input.jobId)).toEqual({ schemaVersion: 1, status: "completed", fingerprint: expect.any(String), attempts: 1, completedAt: time.toISOString() });
  expect((await record(other.jobId))?.status).toBe("pending");
  await enqueuePostgresConversationFileCleanup(input);
  expect((await drainPostgresConversationFileCleanup({ client, scopeId: "success", parseTarget, deleteFile, now })).completed).toBe(0);
  expect(deleteFile).toHaveBeenCalledTimes(1);
});

it("retries failed or lost remote acknowledgements without logging provider content", async () => {
  const input = await prepare("retry"); let calls = 0;
  const deleteFile = vi.fn(async () => { if (++calls === 1) throw new Error("private provider details"); });
  const options = { client, scopeId: "retry", parseTarget, deleteFile, now };
  expect((await drainPostgresConversationFileCleanup(options)).retrying).toBe(1);
  expect(await record(input.jobId)).toMatchObject({ status: "pending", attempts: 1, errorCode: "external_file_delete_failed" });
  expect(JSON.stringify(await record(input.jobId))).not.toContain("private provider");
  expect((await drainPostgresConversationFileCleanup(options)).completed).toBe(0);
  time = new Date(time.getTime() + 1001);
  expect((await drainPostgresConversationFileCleanup(options)).completed).toBe(1); expect(calls).toBe(2);
});

it("repeats an idempotent remote delete if the SQL completion transaction is lost", async () => {
  const input = await prepare("sql-rollback"); const deleteFile = vi.fn(async () => undefined);
  const failing: PostgresSqlClient = { query: client.query, transaction: operation => client.transaction(async tx => {
    await operation(tx); throw new Error("Lost SQL transaction");
  }) };
  await expect(drainPostgresConversationFileCleanup({ client: failing, scopeId: "sql-rollback", parseTarget, deleteFile, now })).rejects.toThrow("Lost SQL");
  expect((await record(input.jobId))?.status).toBe("pending");
  expect((await drainPostgresConversationFileCleanup({ client, scopeId: "sql-rollback", parseTarget, deleteFile, now })).completed).toBe(1);
  expect(deleteFile).toHaveBeenCalledTimes(2);
});

it("blocks invalid tenant/object targets without deleting or silently discarding them", async () => {
  const input = await prepare("invalid");
  const deleteFile = vi.fn(async () => undefined);
  expect((await drainPostgresConversationFileCleanup({ client, scopeId: "invalid", now, deleteFile,
    parseTarget: () => { throw new Error("Bucket does not belong to this deployment"); } })).blocked).toBe(1);
  expect(deleteFile).not.toHaveBeenCalled();
  expect(await record(input.jobId)).toMatchObject({ status: "blocked", target: input.target, errorCode: "invalid_file_cleanup_target" });
});

it("bounds an unresponsive provider and leaves the job retryable", async () => {
  const input = await prepare("timeout"); let signal: AbortSignal | undefined;
  const result = await drainPostgresConversationFileCleanup({ client, scopeId: "timeout", parseTarget, now, timeoutMs: 10,
    deleteFile: async (_target, current) => { signal = current; await new Promise(() => undefined); } });
  expect(result.retrying).toBe(1); expect(signal?.aborted).toBe(true);
  expect((await record(input.jobId))?.status).toBe("pending");
});

it("joins concurrent flushes, tolerates diagnostic failures and stops its worker", async () => {
  await prepare("worker"); const deleteFile = vi.fn(async () => undefined);
  const worker = startPostgresConversationFileCleanupWorker({ client, scopeId: "worker", parseTarget, deleteFile, now,
    onResult: () => { throw new Error("Diagnostic sink failed"); }, onError: () => undefined });
  try { await Promise.all([worker.flush(), worker.flush()]); }
  finally { await worker.stop(); }
  await worker.flush(); expect(deleteFile).toHaveBeenCalledTimes(1);
});
