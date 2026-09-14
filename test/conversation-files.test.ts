import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { deletePostgresConversationHistory, deletePostgresConversationAttachments } from "../src/postgres/conversation-deletion.js";
import type { ConversationId } from "../src/conversation/events.js";
import { AttachmentStagingError } from "../src/attachments/staging.js";
import { cleanupPostgresConversationFileStaging, startPostgresConversationFileStagingCleanupWorker, PostgresAiPersistence, type PostgresSqlClient } from "../src/postgres/index.js";
import { createConversationFileStorage, type ConversationFileStorageOptions, type RetainedConversationFile } from "../src/server/conversation-files.js";

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
const original = new Uint8Array([1, 2, 3, 4]);
const upload = () => ({ idempotencyKey: "upload", fileName: "report.pdf", mediaType: "application/pdf", data: original.slice() });
function fixture(overrides: Partial<ConversationFileStorageOptions> = {}) {
  let allowed = true;
  const tenantId = randomUUID();
  const options: ConversationFileStorageOptions = { persistence, tenantId, principalId: "alice",
    authorizeConversation: async conversationId => {
      if (!allowed || conversationId !== "conversation") throw new AttachmentStagingError("forbidden");
    },
    validateFile: input => input,
    limits: { maximumFiles: 3, maximumBytesPerFile: 8, maximumTotalBytes: 10, acceptedMediaTypes: ["application/pdf"] },
    ...overrides,
  };
  return { options, files: createConversationFileStorage(options), revoke: () => { allowed = false; } };
}

it("freezes submitted bytes and retains authorized files across expiry, service recreation and access revocation", async () => {
  const f = fixture(); const input = upload();
  const uploading = f.files.stage(input); input.data.fill(9); input.idempotencyKey = "mutated";
  const reference = await uploading;
  expect(await f.files.stage(upload())).toEqual(reference);
  await expect(f.files.materialize("conversation", [{ ...reference, content_ref: reference.content_ref.replace(/^ref_/u, "blob_") }]))
    .rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.files.materialize("conversation", [reference])).resolves.toEqual([
    { fileName: "report.pdf", mediaType: "application/pdf", data: original },
  ]);
  await database.query("DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2",
    [f.options.tenantId, "assistant-upload:alice"]);
  const reopened = createConversationFileStorage(f.options);
  await expect(reopened.materialize("conversation", [reference])).resolves.toHaveLength(1);
  await expect(reopened.download("conversation", reference.attachment_id)).resolves.toMatchObject({ data: original });
  const otherPrincipal = createConversationFileStorage({ ...f.options, principalId: "bob" });
  const otherTenant = createConversationFileStorage({ ...f.options, tenantId: randomUUID() });
  for (const foreign of [otherPrincipal, otherTenant]) {
    await expect(foreign.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "not_found" });
  }
  f.revoke();
  await expect(reopened.materialize("conversation", [reference])).rejects.toMatchObject({ code: "forbidden" });
  await expect(reopened.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "forbidden" });
});

it("validates the whole attachment set before consuming uploads and rejects forged or corrupted saved files", async () => {
  const f = fixture(); const reference = await f.files.stage(upload());
  await expect(f.files.stage({ ...upload(), data: new Uint8Array(9) })).rejects.toMatchObject({ code: "invalid_input" });
  for (const refs of [
    [reference, reference],
    [reference, { ...reference, attachment_id: "att_second", byte_size: 8 }],
    [reference, { ...reference, attachment_id: "att_second", media_type: "image/png" }],
  ]) await expect(f.files.materialize("conversation", refs as typeof reference[])).rejects.toMatchObject({ code: "invalid_input" });
  expect((await database.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND payload->>'consumedAt' IS NOT NULL",
    [f.options.tenantId])).rows).toHaveLength(0);
  await f.files.materialize("conversation", [reference]);
  await expect(f.files.materialize("conversation", [{ ...reference, content_ref: "ref_forged" }]))
    .rejects.toMatchObject({ code: "invalid_input" });
  const rows = await database.query<{ payload: RetainedConversationFile }>(
    "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND record_id=$2", [f.options.tenantId, reference.attachment_id]);
  const file = rows.rows[0]!.payload;
  // Simulate damaged storage directly; the public blob store disallows replacement.
  await database.query("UPDATE handrail_ai_attachment_blobs SET payload=$3 WHERE tenant_id=$1 AND blob_key=$2",
    [f.options.tenantId, file.blobKey, new Uint8Array([4, 3, 2, 1])]);
  await expect(f.files.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "unavailable" });
});

it("rolls back retained bytes when metadata storage fails, then safely retries the unconsumed upload", async () => {
  const f = fixture(); const reference = await f.files.stage(upload());
  let fail = true;
  const faulty = new PostgresAiPersistence({ query: client.query, transaction: operation => client.transaction(tx => {
    const wrapped: PostgresSqlClient = { query: async (sql, values) => {
      if (fail && sql.startsWith("INSERT INTO handrail_ai_documents") && String(values?.[2]).startsWith("assistant-files:")) {
        fail = false; throw new Error("fixture metadata write failure");
      }
      return tx.query(sql, values);
    }, transaction: nested => nested(wrapped) };
    return operation(wrapped);
  }) });
  const files = createConversationFileStorage({ ...f.options, persistence: faulty });
  await expect(files.materialize("conversation", [reference])).rejects.toThrow("fixture metadata write failure");
  const stored = await database.query<{ blob_key: string }>("SELECT blob_key FROM handrail_ai_attachment_blobs WHERE tenant_id=$1", [f.options.tenantId]);
  expect(stored.rows).toEqual([{ blob_key: expect.stringMatching(/^attachments\/ref_/u) }]);
  await expect(files.materialize("conversation", [reference])).resolves.toMatchObject([{ data: original }]);
});


async function rows(tenantId: string) {
  return { documents: (await database.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' ORDER BY scope_id,record_id", [tenantId])).rows,
    blobs: (await database.query<{ blob_key: string }>(
      "SELECT blob_key FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 ORDER BY blob_key", [tenantId])).rows };
}
async function removeConversation(tenantId: string, conversationId: string) {
  return client.transaction(async tx => {
    await deletePostgresConversationHistory({ client: tx, tenantId, conversationId: conversationId as ConversationId, authorize: async () => undefined });
    await deletePostgresConversationAttachments(tx, tenantId, conversationId);
  });
}
function failingPersistence(fail: (sql: string, values?: readonly unknown[]) => boolean) {
  return new PostgresAiPersistence({ query: client.query, transaction: operation => client.transaction(tx => {
    const wrapped: PostgresSqlClient = { query: async (sql, values) => {
      if (fail(sql, values)) throw new Error("fixture atomic storage failure");
      return tx.query(sql, values);
    }, transaction: nested => nested(wrapped) };
    return operation(wrapped);
  }) });
}

it("rolls back a failed staging claim without orphaning bytes or changing the retry identity", async () => {
  let fail = true;
  const f = fixture({ persistence: failingPersistence(sql => fail && sql.startsWith("INSERT INTO handrail_ai_documents")) });
  await expect(f.files.stage(upload())).rejects.toMatchObject({ code: "unavailable" });
  expect(await rows(f.options.tenantId)).toEqual({ documents: [], blobs: [] });
  fail = false;
  const reference = await f.files.stage(upload());
  expect(await f.files.stage(upload())).toEqual(reference);
  expect((await rows(f.options.tenantId)).blobs).toHaveLength(1);
});

it("commits consumption with retention and removes the linked staging metadata on conversation deletion", async () => {
  let fail = true;
  const f = fixture({ persistence: failingPersistence((sql, values) => fail && sql.startsWith("INSERT INTO handrail_ai_documents") &&
    values?.[1] === "attachment" && values?.[2] === "assistant-upload:alice" && String(values?.[5]).includes('"retainedConversationId"')) });
  const reference = await f.files.stage(upload());
  await expect(f.files.materialize("conversation", [reference])).rejects.toThrow("fixture atomic storage failure");
  expect((await rows(f.options.tenantId)).documents).toHaveLength(1);
  expect((await rows(f.options.tenantId)).documents[0]!.payload.consumedAt).toBeNull();
  expect((await rows(f.options.tenantId)).blobs).toHaveLength(1);
  fail = false;
  await f.files.materialize("conversation", [reference]);
  expect(await f.files.stage(upload())).toEqual(reference);
  const retained = await rows(f.options.tenantId);
  expect(retained.documents).toHaveLength(2);
  expect(retained.documents.some(row => row.payload.retainedConversationId === "conversation")).toBe(true);
  expect(retained.blobs).toHaveLength(1);
  await removeConversation(f.options.tenantId, "conversation");
  expect(await rows(f.options.tenantId)).toEqual({ documents: [], blobs: [] });
  await expect(f.files.materialize("conversation", [reference])).rejects.toMatchObject({ code: "not_found" });
});

it("expires idle managed staging after restart without deleting saved files, other tenants or unmarked old uploads", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock, maintenanceScopeId: "managed-files" });
  const saved = await f.files.stage(upload());
  await f.files.materialize("conversation", [saved]);
  const abandoned = await f.files.stage({ ...upload(), idempotencyKey: "abandoned" });
  const old = await f.files.stage({ ...upload(), idempotencyKey: "old-unmarked" });
  await database.query("UPDATE handrail_ai_documents SET payload=payload-'retention' WHERE tenant_id=$1 AND record_id=$2", [f.options.tenantId, old.content_ref]);
  const other = fixture({ now: () => clock, maintenanceScopeId: "managed-files" });
  await other.files.stage(upload());
  clock += 16 * 60_000;
  const restarted = new PostgresAiPersistence(client);
  expect(await cleanupPostgresConversationFileStaging({ persistence: restarted, tenantId: f.options.tenantId,
    maintenanceScopeId: "managed-files", now: () => clock })).toEqual({ removed: 2, blocked: 0 });
  const retained = await rows(f.options.tenantId);
  expect(retained.documents).toHaveLength(2); // Saved file plus explicitly unmarked old staging.
  expect(retained.blobs).toHaveLength(2);
  expect((await rows(other.options.tenantId)).documents).toHaveLength(1);
  await expect(createConversationFileStorage(f.options).download("conversation", saved.attachment_id)).resolves.toMatchObject({ data: original });
  await expect(f.files.materialize("conversation", [abandoned])).rejects.toMatchObject({ code: "not_found" });
  expect(await cleanupPostgresConversationFileStaging({ persistence, maintenanceScopeId: "other-partition", now: () => clock })).toEqual({ removed: 0, blocked: 0 });
});

it("preserves a shared blob reference while expiring its managed staging and deleting another conversation", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  const ref = await f.files.stage(upload());
  const staged = (await rows(f.options.tenantId)).documents[0]!.payload;
  await persistence.compareAndSetDocument({ tenantId: f.options.tenantId, kind: "attachment", scopeId: "business-owned",
    recordId: "att_business", expectedVersion: null, value: { conversationId: "business", blobKey: staged.blobKey } });
  await f.files.materialize("conversation", [ref]);
  expect((await rows(f.options.tenantId)).blobs).toHaveLength(2);
  clock += 16 * 60_000;
  const options = { persistence, tenantId: f.options.tenantId, maintenanceScopeId: "conversation-files", now: () => clock };
  const workers = await Promise.all([cleanupPostgresConversationFileStaging(options), cleanupPostgresConversationFileStaging(options)]);
  expect(workers.reduce((sum, result) => sum + result.removed, 0)).toBe(1);
  await removeConversation(f.options.tenantId, "conversation");
  expect(await rows(f.options.tenantId)).toEqual({ documents: [{ payload: { conversationId: "business", blobKey: staged.blobKey } }],
    blobs: [{ blob_key: staged.blobKey }] });
});

it("runs expiry while idle, serializes sweeps and stops without a startup purge", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  await f.files.stage(upload());
  const onResult = vi.fn(), onError = vi.fn();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const worker = startPostgresConversationFileStagingCleanupWorker({ persistence, tenantId: f.options.tenantId,
    maintenanceScopeId: "conversation-files", now: () => clock, intervalMs: 1000, onResult, onError });
  try {
    expect(onResult).not.toHaveBeenCalled();
    expect((await rows(f.options.tenantId)).documents).toHaveLength(1);
    clock += 16 * 60_000;
    await vi.advanceTimersByTimeAsync(1000);
    await worker.flush();
    expect(onResult).toHaveBeenCalledWith({ removed: 1, blocked: 0 });
    expect(await rows(f.options.tenantId)).toEqual({ documents: [], blobs: [] });
    await worker.stop();
    const count = onResult.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    await worker.flush();
    expect(onResult).toHaveBeenCalledTimes(count);
    expect(onError).not.toHaveBeenCalled();
  } finally { await worker.stop(); vi.useRealTimers(); }
});

it("refuses a stale materialization after deletion and does not resurrect saved bytes", async () => {
  const f = fixture();
  const reference = await f.files.stage(upload());
  await removeConversation(f.options.tenantId, "conversation");
  await expect(f.files.materialize("conversation", [reference])).rejects.toMatchObject({ code: "conversation_deleted" });
  const remaining = await rows(f.options.tenantId);
  expect(remaining.documents).toHaveLength(1); // Unclaimed upload, still subject to its own TTL.
  expect(remaining.blobs).toEqual([{ blob_key: `attachments/${reference.content_ref}` }]);
});

it("reports malformed managed rows instead of deleting an unverified blob target", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  const ref = await f.files.stage(upload());
  await database.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{blobKey}','\"business-secret\"'::jsonb) WHERE tenant_id=$1 AND record_id=$2", [f.options.tenantId, ref.content_ref]);
  const before = await rows(f.options.tenantId);
  clock += 16 * 60_000;
  expect(await cleanupPostgresConversationFileStaging({ persistence, tenantId: f.options.tenantId,
    maintenanceScopeId: "conversation-files", now: () => clock })).toEqual({ removed: 0, blocked: 1 });
  expect(await rows(f.options.tenantId)).toEqual(before);
});

it("lets the retained-file worker pass a blocked first batch and expire healthy uploads", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  const bad = await f.files.stage(upload());
  await f.files.stage({ ...upload(), idempotencyKey: "healthy" });
  await database.query("UPDATE handrail_ai_documents SET record_id=$3 WHERE tenant_id=$1 AND record_id=$2",
    [f.options.tenantId, bad.content_ref, "\u0001invalid-row"]);
  clock += 16 * 60_000;
  const onResult = vi.fn(), onError = vi.fn();
  const worker = startPostgresConversationFileStagingCleanupWorker({ persistence, tenantId: f.options.tenantId,
    maintenanceScopeId: "conversation-files", now: () => clock, batchSize: 1, onResult, onError });
  try {
    await worker.flush();
    expect(onResult).toHaveBeenLastCalledWith({ removed: 0, blocked: 1 });
    await worker.flush();
    expect(onResult).toHaveBeenLastCalledWith({ removed: 1, blocked: 0 });
    expect((await rows(f.options.tenantId)).documents).toHaveLength(1);
    expect((await rows(f.options.tenantId)).blobs).toEqual([{ blob_key: `attachments/${bad.content_ref}` }]);
    expect(onError).not.toHaveBeenCalled();
  } finally { await worker.stop(); }
});

it("keeps expired upload retry identity after staging removal while saved files remain available", async () => {
  let clock = Date.now();
  const f = fixture({ now: () => clock });
  const ref = await f.files.stage(upload());
  await f.files.materialize("conversation", [ref]);
  clock += 16 * 60_000;
  expect(await cleanupPostgresConversationFileStaging({ persistence, tenantId: f.options.tenantId,
    maintenanceScopeId: "conversation-files", now: () => clock })).toEqual({ removed: 1, blocked: 0 });
  const restarted = createConversationFileStorage(f.options);
  await expect(restarted.stage(upload())).rejects.toMatchObject({ code: "expired" });
  await expect(restarted.stage({ ...upload(), fileName: "changed.pdf" })).rejects.toMatchObject({ code: "conflict" });
  expect(await restarted.materialize("conversation", [ref])).toEqual([
    { fileName: "report.pdf", mediaType: "application/pdf", data: original },
  ]);
  expect((await rows(f.options.tenantId)).documents).toHaveLength(1);
  expect((await rows(f.options.tenantId)).blobs).toHaveLength(1);
  const receipts = await client.query<{ result: unknown }>(
    "SELECT result FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain='attachment.expired'", [f.options.tenantId]);
  expect(receipts.rows).toEqual([{ result: { version: 1, status: "expired" } }]);
  await expect(restarted.stage({ ...upload(), idempotencyKey: "new-upload" })).resolves.toMatchObject({ byte_size: 4 });
});
