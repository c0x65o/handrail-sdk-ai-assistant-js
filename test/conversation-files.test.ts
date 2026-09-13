import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AttachmentStagingError } from "../src/attachments/staging.js";
import { PostgresAiPersistence, type PostgresSqlClient } from "../src/postgres/index.js";
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
function fixture() {
  let allowed = true;
  const tenantId = randomUUID();
  const options: ConversationFileStorageOptions = { persistence, tenantId, principalId: "alice",
    authorizeConversation: async conversationId => {
      if (!allowed || conversationId !== "conversation") throw new AttachmentStagingError("forbidden");
    },
    validateFile: input => input,
    limits: { maximumFiles: 3, maximumBytesPerFile: 8, maximumTotalBytes: 10, acceptedMediaTypes: ["application/pdf"] },
  };
  return { options, files: createConversationFileStorage(options), revoke: () => { allowed = false; } };
}

it("freezes submitted bytes and retains authorized files across expiry, service recreation and access revocation", async () => {
  const f = fixture(); const input = upload();
  const uploading = f.files.stage(input); input.data.fill(9);
  const reference = await uploading;
  expect(await f.files.stage(upload())).toEqual(reference);
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
  await expect(files.import("conversation", "att_imported", upload())).resolves.toMatchObject({ contentRef: null });
  await expect(files.import("conversation", "att_imported", { ...upload(), data: new Uint8Array([9]) }))
    .rejects.toMatchObject({ code: "invalid_input" });
});
