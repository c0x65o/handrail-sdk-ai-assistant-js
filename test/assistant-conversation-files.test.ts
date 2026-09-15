import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseConversationEvent } from "../src/conversation/events.js";
import { toConversationAttachmentReference } from "../src/attachments/references.js";
import { AttachmentStagingError } from "../src/attachments/staging.js";
import { PostgresAiPersistence, postgresFromClient, cleanupPostgresConversationFileStaging, type PostgresSqlClient } from "../src/postgres/index.js";
import { createAssistantConversationFiles, assistantConversationFileMaintenanceScope,
  type AssistantConversationFilesOptions } from "../src/server/assistant-conversation-files.js";
import type { AttachmentReference } from "../src/protocol.js";
import { deletePostgresConversationHistory, deletePostgresConversationAttachments } from "../src/postgres/conversation-deletion.js";

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
const bytes = new Uint8Array(readFileSync(new URL("./fixtures/documents/invoice.png", import.meta.url)));
beforeAll(() => persistence.migrate());
afterAll(() => database.close());
function fixture() {
  let now = Date.now(), allowed = true;
  const options: AssistantConversationFilesOptions = { persistence, tenantId: randomUUID(), scopeId: "account", principalId: "alice",
    assistantId: "fixture-assistant", limits: { maximumBytes: 100_000, acceptedMediaTypes: ["image/png"], ttlMilliseconds: 60_000 },
    now: () => now, authorizeConversation: async id => {
      if (!allowed || !["conversation", "other"].includes(id)) throw new AttachmentStagingError("forbidden");
    } };
  const files = createAssistantConversationFiles(options);
  const stage = (key = "upload") => files.stage("conversation", { idempotencyKey: key, fileName: "invoice.png", mediaType: "image/png", data: bytes });
  const cleanup = () => cleanupPostgresConversationFileStaging({ persistence, tenantId: options.tenantId,
    maintenanceScopeId: assistantConversationFileMaintenanceScope(options.assistantId), now: () => now });
  return { files, options, stage, cleanup, expire: () => { now += 61_000; }, revoke: () => { allowed = false; } };
}
function admission(references: readonly AttachmentReference[], conversationId = "conversation", principalId = "alice") {
  const payloads = [
    { type: "message.created", message_id: "message", role: "user", content: [{ type: "text", text: "Read the invoice" }] },
    ...references.map(reference => ({ type: "message.attachment_referenced", message_id: "message", attachment: toConversationAttachmentReference(reference) })),
    { type: "turn.started", turn_id: "turn", input_message_ids: ["message"] },
  ];
  return { conversationId: conversationId as never, expectedRevision: null,
    events: payloads.map((payload, index) => parseConversationEvent({ version: 1, conversation_id: conversationId,
      event_id: `event-${index}`, revision: index + 1, occurred_at: "2026-09-15T12:00:00Z",
      actor: { type: "user", id: principalId }, source: { type: "runtime" }, payload })) };
}
async function counts(tenant: string) {
  return {
    events: (await client.query("SELECT 1 FROM handrail_ai_events WHERE tenant_id=$1", [tenant])).rows.length,
    retained: (await client.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id LIKE 'assistant-retained:%'", [tenant])).rows.length,
    blobs: (await client.query("SELECT 1 FROM handrail_ai_attachment_blobs WHERE tenant_id=$1", [tenant])).rows.length,
  };
}

it("retains original files atomically with admission across expiry, cleanup, restart and an exact admission retry", async () => {
  const f = fixture(), reference = await f.stage();
  expect(await f.stage()).toEqual(reference);
  expect((await f.files.download("conversation", reference.attachment_id)).retained).toBe(false);
  const input = admission([reference]);
  expect((await f.files.events.append(input)).status).toBe("appended");
  const abandoned = await f.stage("abandoned");
  f.expire();
  await f.cleanup();
  const reopened = createAssistantConversationFiles(f.options);
  const saved = await reopened.savedFiles.list({ conversationId: "conversation", signal: new AbortController().signal });
  expect(saved.files).toHaveLength(1);
  const handle = saved.files[0]!.handle;
  expect((await reopened.savedFiles.read({ conversationId: "conversation", handle, signal: new AbortController().signal })).bytes).toEqual(bytes);
  expect(await reopened.resolve("conversation", reference)).toEqual({ media_type: "image/png", bytes });
  expect((await reopened.download("conversation", reference.attachment_id)).retained).toBe(true);
  expect((await reopened.events.append(input)).status).toBe("idempotent");
  await expect(reopened.download("conversation", abandoned.attachment_id)).rejects.toMatchObject({ code: "not_found" });
  expect(await counts(f.options.tenantId)).toEqual({ events: 3, retained: 1, blobs: 1 });
});

it("does not admit expired drafts or resurrect their binary data", async () => {
  const f = fixture(), reference = await f.stage();
  f.expire();
  await expect(f.files.events.append(admission([reference]))).rejects.toMatchObject({ code: "attachment_expired" });
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 1 });
  await f.cleanup();
  await expect(f.stage()).rejects.toMatchObject({ code: "expired" });
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 0 });
});

it("rolls back all event and retention writes when a later file identity is invalid", async () => {
  const f = fixture(), first = await f.stage(), second = await f.stage("second");
  await expect(f.files.events.append(admission([first, { ...second, byte_size: second.byte_size + 1 }]))).rejects.toThrow();
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 2 });
  expect((await f.files.download("conversation", first.attachment_id)).file.data).toEqual(bytes);
  await f.files.events.append(admission([first, second]));
  expect(await counts(f.options.tenantId)).toEqual({ events: 4, retained: 2, blobs: 2 });
});

it("rejects another conversation, account, tenant or actor without retaining their file", async () => {
  const f = fixture(), reference = await f.stage();
  for (const files of [createAssistantConversationFiles({ ...f.options, scopeId: "other-account" }),
    createAssistantConversationFiles({ ...f.options, tenantId: randomUUID() })]) {
    await expect(files.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "not_found" });
  }
  await expect(f.files.events.append(admission([reference], "other"))).rejects.toMatchObject({ code: "attachment_unavailable" });
  await expect(f.files.events.append(admission([reference], "conversation", "mallory"))).rejects.toMatchObject({ code: "forbidden" });
  f.revoke();
  await expect(f.files.events.append(admission([reference]))).rejects.toMatchObject({ code: "forbidden" });
  await expect(f.files.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "forbidden" });
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 1 });
});

it("preserves existing ordinary upload identities and policy without adopting them", async () => {
  const f = fixture();
  const legacy = postgresFromClient(client, { attachmentLimits: f.options.limits }).forScope(f.options,
    { createConversationId: () => "conversation" as never });
  const reference = await legacy.attachments.stage({ ownerScopeId: f.options.scopeId, conversationId: "conversation",
    idempotencyKey: "old", fingerprint: "old-fingerprint", mediaType: "image/png", filename: "invoice.png", bytes });
  const original = await legacy.attachmentMetadata.getByContentRef(reference.content_ref);
  await f.files.events.append(admission([reference]));
  expect(await legacy.attachmentMetadata.getByContentRef(reference.content_ref)).toEqual(original);
  expect(await f.files.resolveSaved("conversation", toConversationAttachmentReference(reference))).toEqual(reference);
  expect(await counts(f.options.tenantId)).toEqual({ events: 3, retained: 0, blobs: 1 });
  f.expire();
  await expect(f.files.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "expired" });
  await f.cleanup();
  expect(await legacy.attachmentMetadata.getByContentRef(reference.content_ref)).toEqual(original);
});

it("recovers a lost admission commit acknowledgement without a second blob or event batch", async () => {
  const f = fixture(), reference = await f.stage(), input = admission([reference]);
  let loseAcknowledgement = true;
  const uncertain = new PostgresAiPersistence({ query: client.query, transaction: async work => {
    const committed = await client.transaction(work);
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("lost commit acknowledgement"); }
    return committed;
  } });
  const files = createAssistantConversationFiles({ ...f.options, persistence: uncertain });
  await expect(files.events.append(input)).rejects.toThrow("lost commit acknowledgement");
  expect(await counts(f.options.tenantId)).toEqual({ events: 3, retained: 1, blobs: 1 });
  expect((await files.events.append(input)).status).toBe("idempotent");
  expect(await counts(f.options.tenantId)).toEqual({ events: 3, retained: 1, blobs: 1 });
});

it("keeps admitted files after cancellation and removes saved files and bound drafts only on explicit conversation deletion", async () => {
  const f = fixture(), reference = await f.stage();
  await f.files.events.append(admission([reference]));
  await f.stage("unsent-draft");
  const other = await f.files.stage("other", { idempotencyKey: "other-draft", fileName: "invoice.png", mediaType: "image/png", data: bytes });
  await f.files.events.append({ conversationId: "conversation" as never, expectedRevision: 3 as never, events: [parseConversationEvent({
    version: 1, conversation_id: "conversation", event_id: "cancel", revision: 4, occurred_at: "2026-09-15T12:01:00Z",
    actor: { type: "assistant" }, source: { type: "runtime" }, payload: { type: "turn.cancelled", turn_id: "turn", reason: "user" },
  })] });
  expect((await f.files.download("conversation", reference.attachment_id)).file.data).toEqual(bytes);
  await client.transaction(async tx => {
    await deletePostgresConversationHistory({ client: tx, tenantId: f.options.tenantId, conversationId: "conversation" as never, authorize: async () => {} });
    await deletePostgresConversationAttachments(tx, f.options.tenantId, "conversation");
  });
  await expect(f.files.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "not_found" });
  await expect(f.stage("stale-upload")).rejects.toMatchObject({ code: "conversation_deleted" });
  await expect(f.files.events.append(admission([reference]))).rejects.toMatchObject({ code: "conversation_deleted" });
  expect((await f.files.download("other", other.attachment_id)).file.data).toEqual(bytes);
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 1 });
  f.expire();
  expect(await f.cleanup()).toEqual({ removed: 1, blocked: 0 });
  expect(await counts(f.options.tenantId)).toEqual({ events: 0, retained: 0, blobs: 0 });
});

it("captures original bytes and references before authorization awaits and rechecks read authorization", async () => {
  const f = fixture();
  let release!: () => void, block = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const files = createAssistantConversationFiles({ ...f.options, authorizeConversation: async id => {
    if (block) { block = false; await gate; }
    await f.options.authorizeConversation(id);
  } });
  const mutable = new Uint8Array(bytes);
  const pending = files.stage("conversation", { idempotencyKey: "capture", fileName: "invoice.png", mediaType: "image/png", data: mutable });
  mutable.fill(0); release();
  const reference = await pending;
  expect((await files.download("conversation", reference.attachment_id)).file.data).toEqual(bytes);
  let reads = 0;
  const revoked = createAssistantConversationFiles({ ...f.options, authorizeConversation: async () => {
    if (++reads > 2) throw new AttachmentStagingError("forbidden");
  } });
  await expect(revoked.download("conversation", reference.attachment_id)).rejects.toMatchObject({ code: "forbidden" });
});
