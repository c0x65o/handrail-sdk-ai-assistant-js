import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cleanupPostgresAssistantAttachmentStaging, startPostgresAssistantAttachmentStagingCleanupWorker,
  PostgresAiPersistence, PostgresRealtimeCallStore, PostgresRealtimeToolActivityStore,
  postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { parseConversationEvent } from "../src/conversation/events.js";

const database = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) }; return client;
}
const client: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = new PostgresAiPersistence(client);
beforeAll(() => persistence.migrate());
afterAll(() => database.close());
const tenant = () => randomUUID();
const bundle = (tenantId: string, scopeId = "alice", partition = "fixture-uploads") =>
  postgresFromClient(client, { attachmentMaintenanceScopeId: partition }).forScope({ tenantId, scopeId }, {
    createConversationId: () => "unused" as never,
  });
const stage = (tenantId: string, idempotencyKey = "upload", scopeId = "alice", partition = "fixture-uploads") =>
  bundle(tenantId, scopeId, partition).attachments.stage({ ownerScopeId: scopeId, conversationId: "conversation",
    idempotencyKey, fingerprint: "original", mediaType: "text/plain", bytes: new Uint8Array([1, 2, 3]) });
const counts = async (tenantId: string) => ({
  records: (await client.query("SELECT record_id FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'", [tenantId])).rows,
  blobs: (await client.query("SELECT blob_key FROM handrail_ai_attachment_blobs WHERE tenant_id=$1", [tenantId])).rows,
});
// Past-date only this disposable fixture's leases; production cleanup never
// rewrites old metadata or adopts unmarked records into the retention policy.
async function expire(tenantId: string) {
  await client.query(`UPDATE handrail_ai_documents SET version=version+1,
    payload=jsonb_set(jsonb_set(payload,'{createdAt}','"2000-01-01T00:00:00.000Z"'),'{expiresAt}','"2000-01-01T00:01:00.000Z"')
    WHERE tenant_id=$1 AND kind='attachment'`, [tenantId]);
  await client.query("UPDATE handrail_ai_attachment_blobs SET expires_at='2000-01-01T00:01:00Z' WHERE tenant_id=$1", [tenantId]);
}
const cleanup = (tenantId: string, scopeId?: string) => cleanupPostgresAssistantAttachmentStaging({
  persistence, tenantId, maintenanceScopeId: "fixture-uploads", ...(scopeId === undefined ? {} : { scopeId }),
});

it("expires newly managed uploads after restart and preserves other principals, tenants, partitions and old policies", async () => {
  const own = tenant(), foreign = tenant();
  const disposable = await stage(own), old = await stage(own, "old"), retained = await stage(own, "retained");
  await stage(own, "bob", "bob"); await stage(own, "other-service", "alice", "other-service"); await stage(foreign);
  await client.query("UPDATE handrail_ai_documents SET payload=payload-'retention' WHERE tenant_id=$1 AND record_id=$2", [own, old.content_ref]);
  await client.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{retention,version}','1') WHERE tenant_id=$1 AND record_id=$2",
    [own, retained.content_ref]);
  await expire(own); await expire(foreign);
  expect(await bundle(own).attachments.cleanupExpired()).toBe(1);
  expect(await bundle(own).attachmentMetadata.getByContentRef(disposable.content_ref)).toBeNull();
  expect((await counts(own)).records).toHaveLength(4); expect((await counts(own)).blobs).toHaveLength(4);
  expect((await counts(foreign)).records).toHaveLength(1);
  expect(await bundle(own).attachments.cleanupExpired()).toBe(0);
});

it("rejects a foreign owner scope during managed admission without leaving bytes", async () => {
  const own = tenant();
  await expect(bundle(own).attachments.stage({ ownerScopeId: "bob", conversationId: "conversation",
    idempotencyKey: "forged", fingerprint: "original", mediaType: "text/plain", bytes: new Uint8Array([1]) }))
    .rejects.toMatchObject({ code: "forbidden" });
  expect(await counts(own)).toEqual({ records: [], blobs: [] });
});

it("keeps only a minimal expired-upload receipt and refuses old retries after storage recreation", async () => {
  const own = tenant(), ref = await stage(own); await expire(own);
  expect(await cleanup(own)).toMatchObject({ removed: 1, blocked: 0 });
  await expect(stage(own)).rejects.toMatchObject({ code: "expired" });
  await expect(bundle(own).attachments.stage({ ownerScopeId: "alice", conversationId: "conversation",
    idempotencyKey: "upload", fingerprint: "changed", mediaType: "text/plain", bytes: new Uint8Array([1]) }))
    .rejects.toMatchObject({ code: "conflict" });
  expect(await counts(own)).toEqual({ records: [], blobs: [] });
  const receipts = await client.query<{ idempotency_key: string; fingerprint: string; result: unknown }>(
    "SELECT idempotency_key,fingerprint,result FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain='attachment.expired'", [own]);
  expect(receipts.rows).toHaveLength(1);
  expect(receipts.rows[0]).toEqual({ idempotency_key: expect.stringMatching(/^[a-f0-9]{64}$/u),
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), result: { version: 1, status: "expired" } });
  expect(JSON.stringify(receipts.rows)).not.toContain(ref.content_ref);
  await expect(stage(own, "upload", "bob")).resolves.toMatchObject({ byte_size: 3 });
});

it("consumes its own upload without collecting bytes retained by a business attachment", async () => {
  const own = tenant(), ref = await stage(own);
  const record = (await bundle(own).attachmentMetadata.getByContentRef(ref.content_ref))!;
  await persistence.compareAndSetDocument({ tenantId: own, kind: "attachment", scopeId: "business", recordId: "shared",
    expectedVersion: null, value: { conversationId: "business-conversation", blobKey: record.blobKey } });
  await bundle(own).attachments.consume({ ownerScopeId: "alice", conversationId: "conversation", contentRef: ref.content_ref });
  expect((await counts(own)).blobs).toHaveLength(1);
  expect((await bundle(own).attachmentMetadata.getByContentRef(ref.content_ref))?.consumedAt).not.toBeNull();
});

it("rolls back consumption with a failed byte removal so the original upload remains resolvable", async () => {
  const own = tenant(), ref = await stage(own);
  const failDeletes = (db: PostgresSqlClient): PostgresSqlClient => ({
    query: async (sql, values) => {
      if (sql.startsWith("DELETE FROM handrail_ai_attachment_blobs")) throw new Error("fixture byte deletion failure");
      return db.query(sql, values);
    }, transaction: operation => db.transaction(tx => operation(failDeletes(tx))),
  });
  const broken = postgresFromClient(failDeletes(client)).forScope({ tenantId: own, scopeId: "alice" }, {
    createConversationId: () => "unused" as never,
  });
  await expect(broken.attachments.consume({ ownerScopeId: "alice", conversationId: "conversation", contentRef: ref.content_ref }))
    .rejects.toMatchObject({ code: "unavailable" });
  const resolved = await bundle(own).attachments.resolve({ ownerScopeId: "alice", conversationId: "conversation", contentRef: ref.content_ref });
  expect(resolved.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(resolved.record.consumedAt).toBeNull();
});

it.each(["durable_turn", "realtime_call", "provider_operation", "approval"] as const)(
  "preserves expired input while %s work is unresolved", async kind => {
    const own = tenant(); await stage(own); await expire(own);
    if (kind === "approval") await client.query(`INSERT INTO handrail_ai_approvals
      (tenant_id,scope_id,proposal_id,group_id,version,payload,updated_at)
      VALUES ($1,'alice','proposal','conversation',1,'{"status":"pending"}',now())`, [own]);
    else await persistence.compareAndSetDocument({ tenantId: own, kind, scopeId: kind === "durable_turn" ? "conversation" : "owner",
      recordId: "work", expectedVersion: null, value: { conversationId: "conversation", status: "uncertain" } });
    const before = await counts(own);
    expect(await cleanup(own)).toMatchObject({ removed: 0, blocked: 1 });
    expect(await counts(own)).toEqual(before);
    expect(await persistence.getDocument(own, "conversation_deleted", "conversation", "deleted")).toBeNull();
  },
);

it("waits for business work after voice hangup, then expires bytes without changing history, read acknowledgements or receipts", async () => {
  const own = tenant(); await stage(own); await expire(own);
  await persistence.appendEvents({ tenantId: own, conversationId: "conversation", expectedRevision: null, events: [parseConversationEvent({
    version: 1, event_id: "metadata", conversation_id: "conversation", revision: 1,
    occurred_at: "2026-09-14T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" },
    payload: { type: "conversation.metadata_updated", metadata: { title: "Retain history" } },
  })] });
  const calls = new PostgresRealtimeCallStore(persistence, own, "voice");
  await calls.admit({ callId: "call", conversationId: "conversation", workerId: "worker", fingerprint: "settings" });
  await calls.beginCreation("call", "worker"); await calls.attachProviderCall("call", "worker", "provider-ref");
  const activity = new PostgresRealtimeToolActivityStore(calls, "call");
  const tool = { workerId: "worker", toolCallId: "effect", name: "update_record", status: "running" as const };
  await activity.record(tool); await calls.requestEnd("call"); await calls.confirmEnded("call", "provider-ref");
  expect(await cleanup(own)).toMatchObject({ removed: 0, blocked: 1 });
  await activity.record({ ...tool, status: "completed" });
  await activity.markRead((await activity.readState()).readToken!);
  for (const kind of ["usage_outbox", "tool_execution", "audio_usage_evidence"] as const) {
    await persistence.compareAndSetDocument({ tenantId: own, kind, scopeId: "conversation", recordId: "receipt",
      expectedVersion: null, value: { receipt: "retain evidence" } });
  }
  const retained = () => client.query(`SELECT kind,scope_id,record_id,version::text,payload FROM handrail_ai_documents
    WHERE tenant_id=$1 AND kind<>'attachment' ORDER BY kind,scope_id,record_id`, [own]);
  const before = await retained(), history = await persistence.readEvents(own, "conversation");
  expect(await cleanup(own)).toMatchObject({ removed: 1, blocked: 0 });
  expect(await counts(own)).toEqual({ records: [], blobs: [] });
  expect(await retained()).toEqual(before); expect(await persistence.readEvents(own, "conversation")).toEqual(history);
});

it("preserves a shared blob and refuses a changed blob lease without orphaning its metadata", async () => {
  const own = tenant(); const shared = await stage(own), renewed = await stage(own, "renewed");
  const metadata = await bundle(own).attachmentMetadata.getByContentRef(shared.content_ref);
  await persistence.compareAndSetDocument({ tenantId: own, kind: "attachment", scopeId: "business", recordId: "business-file",
    expectedVersion: null, value: { conversationId: "business-conversation", blobKey: metadata!.blobKey } });
  await expire(own);
  await client.query("UPDATE handrail_ai_attachment_blobs SET expires_at='infinity' WHERE tenant_id=$1 AND blob_key=$2",
    [own, `attachments/${renewed.content_ref}`]);
  expect(await cleanup(own)).toMatchObject({ removed: 1, blocked: 1 });
  const after = await counts(own);
  expect(after.records).toHaveLength(2); expect(after.blobs).toHaveLength(2);
  expect(await bundle(own).attachmentMetadata.getByContentRef(renewed.content_ref)).not.toBeNull();
});

it("preserves an unreadable conversation without preventing another conversation's expiry", async () => {
  const own = tenant(), bad = await stage(own);
  await bundle(own).attachments.stage({ ownerScopeId: "alice", conversationId: "healthy",
    idempotencyKey: "healthy", fingerprint: "original", mediaType: "text/plain", bytes: new Uint8Array([1]) });
  await client.query(`INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload)
    VALUES ($1,'conversation',1,'damaged','{"invalid":"history"}'::jsonb)`, [own]);
  await expire(own);
  expect(await cleanup(own)).toMatchObject({ removed: 1, blocked: 1 });
  expect((await counts(own)).records).toEqual([{ record_id: bad.content_ref }]);
});

it("reports a history database outage as unavailable and preserves the expired upload", async () => {
  const own = tenant(); await stage(own); await expire(own);
  const unavailable = (db: PostgresSqlClient): PostgresSqlClient => ({
    query: async (sql, values) => {
      if (sql.includes("WITH head AS")) throw new Error("fixture database outage");
      return db.query(sql, values);
    }, transaction: operation => db.transaction(tx => operation(unavailable(tx))),
  });
  const before = await counts(own);
  await expect(cleanupPostgresAssistantAttachmentStaging({ persistence: new PostgresAiPersistence(unavailable(client)),
    tenantId: own, maintenanceScopeId: "fixture-uploads" })).rejects.toMatchObject({
    name: "ConversationEventStoreUnavailableError", retryable: true,
  });
  expect(await counts(own)).toEqual(before);
});

it("rolls back expiry metadata and its receipt when byte removal fails, then retries safely", async () => {
  const own = tenant(); await stage(own); await expire(own);
  const failDeletes = (db: PostgresSqlClient): PostgresSqlClient => ({
    query: async (sql, values) => {
      if (sql.startsWith("DELETE FROM handrail_ai_attachment_blobs")) throw new Error("fixture byte deletion failure");
      return db.query(sql, values);
    }, transaction: operation => db.transaction(tx => operation(failDeletes(tx))),
  });
  const before = await counts(own);
  await expect(cleanupPostgresAssistantAttachmentStaging({ persistence: new PostgresAiPersistence(failDeletes(client)),
    tenantId: own, maintenanceScopeId: "fixture-uploads" })).rejects.toThrow("fixture byte deletion failure");
  expect(await counts(own)).toEqual(before);
  expect((await client.query("SELECT idempotency_key FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain='attachment.expired'", [own])).rows)
    .toHaveLength(0);
  expect(await cleanup(own)).toMatchObject({ removed: 1, blocked: 0 });
  await expect(stage(own)).rejects.toMatchObject({ code: "expired" });
});

it("advances past malformed rows, cleans while idle without a startup sweep, and stops scheduling", async () => {
  const own = tenant(); const refs = [await stage(own), await stage(own, "second")].sort((a, b) => a.content_ref.localeCompare(b.content_ref));
  await expire(own);
  await client.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{fingerprint}','null') WHERE tenant_id=$1 AND record_id=$2",
    [own, refs[0]!.content_ref]);
  const onResult = vi.fn(), onError = vi.fn();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const worker = startPostgresAssistantAttachmentStagingCleanupWorker({ persistence, tenantId: own,
    maintenanceScopeId: "fixture-uploads", intervalMs: 1000, batchSize: 1, onResult, onError });
  try {
    expect(onResult).not.toHaveBeenCalled(); expect((await counts(own)).records).toHaveLength(2);
    await worker.flush(); expect(onResult.mock.calls[0]![0]).toMatchObject({ blocked: 1, removed: 0 });
    await vi.advanceTimersByTimeAsync(1000); await worker.flush();
    expect(onResult.mock.calls.some(([result]) => result.removed === 1)).toBe(true);
    expect((await counts(own)).records).toEqual([{ record_id: refs[0]!.content_ref }]);
    await worker.stop(); const seen = onResult.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); await worker.flush();
    expect(onResult).toHaveBeenCalledTimes(seen); expect(onError).not.toHaveBeenCalled();
  } finally { await worker.stop(); vi.useRealTimers(); }
});

it("coalesces concurrent flushes and joins an in-flight cleanup before shutdown", async () => {
  const own = tenant(); await stage(own); await expire(own);
  let entered!: () => void, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const delayed: PostgresSqlClient = { query: async (sql, values) => {
    if (sql.includes("payload->'retention'->>'version'='2'")) { entered(); await gate; }
    return client.query(sql, values);
  }, transaction: client.transaction };
  const onResult = vi.fn(), onError = vi.fn();
  const worker = startPostgresAssistantAttachmentStagingCleanupWorker({ persistence: new PostgresAiPersistence(delayed),
    tenantId: own, maintenanceScopeId: "fixture-uploads", onResult, onError });
  try {
    const first = worker.flush(); await arrived;
    expect(worker.flush()).toBe(first);
    let closed = false; const stopping = worker.stop().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    release(); await first; await stopping;
    expect(onResult).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled();
    expect(await counts(own)).toEqual({ records: [], blobs: [] });
    await worker.flush(); expect(onResult).toHaveBeenCalledTimes(1);
  } finally { release(); await worker.stop(); }
});

it("advances the scan past a malformed database row identity while keeping that row untouched", async () => {
  const own = tenant(); const bad = await stage(own); await stage(own, "healthy"); await expire(own);
  await client.query("UPDATE handrail_ai_documents SET record_id=$3 WHERE tenant_id=$1 AND record_id=$2",
    [own, bad.content_ref, "\u0001invalid-row"]);
  const options = { persistence, tenantId: own, maintenanceScopeId: "fixture-uploads" };
  const first = await cleanupPostgresAssistantAttachmentStaging(options, 1);
  expect(first).toMatchObject({ removed: 0, blocked: 1 });
  expect(first.nextCursor).not.toBeNull();
  expect(await cleanupPostgresAssistantAttachmentStaging(options, 1, first.nextCursor!))
    .toMatchObject({ removed: 1, blocked: 0 });
  expect((await counts(own)).records).toEqual([{ record_id: "\u0001invalid-row" }]);
});
