import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parseConversationEvent, type ConversationId, type ConversationCatalogDescriptor } from "../src/index.js";
import { deletePostgresConversationHistory, PostgresAiPersistence, PostgresConversationCatalog,
  PostgresConversationDeletedError, PostgresRealtimeCallStore, PostgresRealtimeToolActivityStore,
  postgresRealtimeToolActivityScope, type PostgresSqlClient } from "../src/postgres/index.js";

const database = new PGlite();
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = {
    async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    transaction: operation => operation(client),
  };
  return client;
};
const client: PostgresSqlClient = { query: adapt(database).query, transaction: operation =>
  database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = new PostgresAiPersistence(client);
const authorize = async () => undefined;
const event = (conversationId: string, tenantId = "tenant") => parseConversationEvent({
  version: 1, event_id: `${tenantId}-${conversationId}-event`, conversation_id: conversationId, revision: 1,
  occurred_at: "2026-09-13T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" },
  payload: { type: "conversation.metadata_updated", metadata: { note: "private transcript metadata" } },
});
const seed = (conversationId: string, tenantId = "tenant") => persistence.appendEvents({ tenantId,
  conversationId, expectedRevision: null, events: [event(conversationId, tenantId)] });
const remove = (conversationId: string, override: Partial<Parameters<typeof deletePostgresConversationHistory>[0]> = {}) =>
  deletePostgresConversationHistory({ client, tenantId: "tenant", conversationId: conversationId as ConversationId, authorize, ...override });
const doc = (conversationId: string, kind: "durable_turn" | "realtime_call", status: string) => persistence.compareAndSetDocument({
  tenantId: "tenant", kind, scopeId: kind === "durable_turn" ? conversationId : "voice-owner", recordId: conversationId,
  expectedVersion: null, value: { conversationId, status },
});
beforeAll(async () => { await persistence.migrate(); }, 20_000);
afterAll(async () => { await database.close(); });

it("removes only the authorized canonical history/state and retains business and usage receipts", async () => {
  await seed("finished"); await seed("other"); await seed("finished", "foreign");
  await client.query("SELECT handrail_ai_wake_approval_recovery('tenant','finished')");
  for (const kind of ["durable_turn", "turn_state", "sync_state"] as const) {
    await persistence.compareAndSetDocument({ tenantId: "tenant", kind, scopeId: "finished", recordId: "record",
      expectedVersion: null, value: { conversationId: "finished", status: "completed", privateText: "remove me" } });
  }
  await persistence.compareAndSetDocument({ tenantId: "tenant", kind: "activity", scopeId: "owner", recordId: "finished",
    expectedVersion: null, value: { summary: "remove me" } });
  for (const kind of ["usage_outbox", "audio_usage_evidence", "tool_execution", "provider_operation"] as const) {
    await persistence.compareAndSetDocument({ tenantId: "tenant", kind, scopeId: "finished", recordId: "receipt",
      expectedVersion: null, value: { receipt: "retain me" } });
  }
  expect(await remove("finished")).toEqual({ status: "deleted" });
  await client.query("SELECT handrail_ai_wake_approval_recovery('tenant','finished')");
  expect((await client.query("SELECT conversation_id FROM handrail_ai_approval_recovery WHERE tenant_id='tenant' AND conversation_id='finished'")).rows).toEqual([]);
  expect(await persistence.readEvents("tenant", "finished")).toEqual([]);
  expect(await persistence.readEvents("tenant", "other")).toHaveLength(1);
  expect(await persistence.readEvents("foreign", "finished")).toHaveLength(1);
  for (const kind of ["durable_turn", "turn_state", "sync_state"] as const) {
    expect(await persistence.getDocument("tenant", kind, "finished", "record")).toBeNull();
  }
  expect(await persistence.getDocument("tenant", "activity", "owner", "finished")).toBeNull();
  for (const kind of ["usage_outbox", "audio_usage_evidence", "tool_execution", "provider_operation"] as const) {
    expect(await persistence.getDocument("tenant", kind, "finished", "receipt")).toMatchObject({ value: { receipt: "retain me" } });
  }
  expect(await persistence.getDocument("tenant", "conversation_deleted", "finished", "deleted"))
    .toMatchObject({ value: { schemaVersion: 1 } });
  expect(await remove("finished")).toEqual({ status: "idempotent" });
});

it.each(["pending", "running"])("refuses deletion while a durable turn is %s", async status => {
  const conversation = `text-${status}`; await seed(conversation); await doc(conversation, "durable_turn", status);
  await expect(remove(conversation)).rejects.toMatchObject({ code: "conversation_deletion_blocked" });
  expect(await persistence.readEvents("tenant", conversation)).toHaveLength(1);
  expect(await persistence.getDocument("tenant", "conversation_deleted", conversation, "deleted")).toBeNull();
});

it.each(["admitted", "starting", "active", "ending", "uncertain"])("refuses deletion while a voice call is %s", async status => {
  const conversation = `voice-${status}`; await seed(conversation); await doc(conversation, "realtime_call", status);
  await expect(remove(conversation)).rejects.toMatchObject({ code: "conversation_deletion_blocked" });
});

it("waits for voice tools after confirmed hangup and fences late activity without losing call/effect evidence", async () => {
  const conversationId = 'ended-voice-with-tool'; await seed(conversationId);
  const calls = new PostgresRealtimeCallStore(persistence, 'tenant', 'voice-tools');
  await calls.admit({ callId: 'call', conversationId, workerId: 'worker', fingerprint: 'voice-settings' });
  await calls.beginCreation('call', 'worker'); await calls.attachProviderCall('call', 'worker', 'provider-ref');
  const activity = new PostgresRealtimeToolActivityStore(calls, 'call');
  const tool = { workerId: 'worker', toolCallId: 'business-tool', name: 'update_record', status: 'running' as const };
  await activity.record(tool);
  await calls.requestEnd('call'); await calls.confirmEnded('call', 'provider-ref');
  await expect(remove(conversationId)).rejects.toMatchObject({ code: 'conversation_deletion_blocked' });
  expect(await persistence.readEvents('tenant', conversationId)).toHaveLength(1);
  await activity.record({ ...tool, status: 'completed' });
  const token = (await activity.readState()).readToken!;
  await activity.markRead(token);
  expect(await remove(conversationId)).toEqual({ status: 'deleted' });
  expect((await calls.get('call'))?.status).toBe('ended');
  expect(await activity.summary()).toEqual({ total: 1, running: 0, completed: 1, failed: 0 });
  expect(await persistence.getDocument('tenant', 'realtime_activity_read', postgresRealtimeToolActivityScope('voice-tools', 'call'), 'call')).toBeNull();
  await expect(activity.record({ ...tool, status: 'completed' })).rejects.toBeInstanceOf(PostgresConversationDeletedError);
  await expect(activity.markRead(token)).rejects.toBeInstanceOf(PostgresConversationDeletedError);
  await expect(calls.admit({ callId: 'late-call', conversationId, workerId: 'worker', fingerprint: 'settings' }))
    .rejects.toBeInstanceOf(PostgresConversationDeletedError);
});

it("checks call partitions beyond the first page and refuses unknown tool outcomes", async () => {
  const conversationId = 'many-ended-calls'; await seed(conversationId);
  const calls = new PostgresRealtimeCallStore(persistence, 'tenant', 'paged-voice');
  for (let index = 0; index < 101; index += 1) {
    const callId = `call-${String(index).padStart(3, '0')}`;
    await calls.admit({ callId, conversationId, workerId: 'worker', fingerprint: 'settings' });
    await calls.requestEnd(callId);
  }
  await persistence.compareAndSetDocument({ tenantId: 'tenant', kind: 'realtime_tool_activity',
    scopeId: postgresRealtimeToolActivityScope('paged-voice', 'call-100'), recordId: 'unknown',
    expectedVersion: null, value: { status: 'uncertain' } });
  await expect(remove(conversationId)).rejects.toMatchObject({ code: 'conversation_deletion_blocked' });
  expect(await persistence.readEvents('tenant', conversationId)).toHaveLength(1);
});

it('refuses malformed ended-call evidence instead of trusting only its status string', async () => {
  const conversationId = 'unverified-ended-voice'; await seed(conversationId);
  await doc(conversationId, 'realtime_call', 'ended');
  await expect(remove(conversationId)).rejects.toMatchObject({ code: 'conversation_deletion_blocked' });
});

it("rolls back deletion and its fence if authorization is revoked before commit", async () => {
  await seed("revoked"); let checks = 0;
  await expect(remove("revoked", { authorize: async () => { if (++checks === 3) throw new Error("Access revoked"); } }))
    .rejects.toThrow("Access revoked");
  expect(await persistence.readEvents("tenant", "revoked")).toHaveLength(1);
  expect(await persistence.getDocument("tenant", "conversation_deleted", "revoked", "deleted")).toBeNull();
});

it("checks authorization even on deletion replay and never queries storage for initial denial", async () => {
  const query = vi.fn(client.query);
  await expect(remove("finished", { client: { ...client, query: query as PostgresSqlClient["query"] }, authorize: async () => { throw new Error("Denied"); } }))
    .rejects.toThrow("Denied");
  expect(query).not.toHaveBeenCalled();
});

it("removes catalog titles and metadata from receipts without releasing their idempotency keys", async () => {
  const conversationId = "catalog-receipts" as ConversationId;
  const catalog = new PostgresConversationCatalog({ persistence, tenantId: "tenant", scopeId: () => "receipt-owner",
    authorize: () => "allow", createId: () => conversationId,
    // This fixture has no transcript; exercise a host-supported clear receipt.
    clearContents: async () => undefined });
  const creation = { authorizationContext: {}, idempotencyKey: "create" as never,
    title: "Disposable title", metadata: { preview: "Disposable preview" } };
  let current: ConversationCatalogDescriptor = (await catalog.create(creation)).descriptor;
  const replays: (() => Promise<unknown>)[] = [() => catalog.create(creation)];
  const rename = { authorizationContext: {}, conversationId, expectedVersion: current.version,
    idempotencyKey: "rename" as never, title: "Disposable renamed title" };
  current = (await catalog.rename(rename)).descriptor;
  replays.push(() => catalog.rename(rename));
  for (const operation of ["archive", "restore", "clear"] as const) {
    const input = { authorizationContext: {}, conversationId, expectedVersion: current.version,
      idempotencyKey: operation as never };
    current = (await catalog[operation](input)).descriptor;
    replays.push(() => catalog[operation](input));
  }
  const business = { conversationId, title: "Necessary business record", metadata: { retained: true } };
  await persistence.getOrCreateIdempotent({ tenantId: "tenant", domain: "business.post", scopeId: "receipt-owner",
    idempotencyKey: "business", fingerprint: "business", execute: async () => business });
  await catalog.create({ ...creation, idempotencyKey: "other" as never, conversationId: "receipt-other" as ConversationId });
  const deletion = { authorizationContext: {}, conversationId, expectedVersion: current.version,
    idempotencyKey: "delete" as never };
  expect((await catalog.permanentlyDelete(deletion)).status).toBe("deleted");
  for (const replay of replays) await expect(replay()).rejects.toMatchObject({ code: "not_found" });
  await expect(catalog.create({ ...creation, title: "Changed request" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect((await catalog.permanentlyDelete(deletion)).status).toBe("idempotent");
  const receipts = await client.query<{ domain: string; result: unknown }>(`SELECT domain,result FROM handrail_ai_idempotency
    WHERE tenant_id='tenant' AND scope_id='receipt-owner' AND result->>'conversationId'=$1`, [conversationId]);
  for (const receipt of receipts.rows) {
    if (receipt.domain === "business.post") expect(receipt.result).toEqual(business);
    else if (receipt.domain !== "catalog.permanent_delete") expect(receipt.result)
      .toEqual({ schemaVersion: 1, status: "conversation_deleted", conversationId });
  }
  expect(receipts.rows).toHaveLength(7);
  expect((await catalog.create({ ...creation, idempotencyKey: "other" as never, conversationId: "receipt-other" as ConversationId }))
    .descriptor.metadata).toEqual({ preview: "Disposable preview" });
});

it("does not advertise or falsely complete clear without a content-reset implementation", async () => {
  const catalog = new PostgresConversationCatalog<{ permitted: boolean }>({ persistence, tenantId: "tenant", scopeId: () => "clear-owner",
    authorize: ({ authorizationContext }) => authorizationContext.permitted ? "allow" : "deny",
    createId: () => "unconfigured-clear" as ConversationId });
  const created = await catalog.create({ authorizationContext: { permitted: true }, idempotencyKey: "create" as never });
  await seed(created.descriptor.conversationId);
  expect(catalog.capabilities.clear).toEqual({ supported: false, reason: "not_implemented" });
  const input = { authorizationContext: { permitted: true }, conversationId: created.descriptor.conversationId,
    expectedVersion: created.descriptor.version, idempotencyKey: "clear" as never };
  await expect(catalog.clear(input)).rejects.toMatchObject({ code: "unsupported", operation: "clear" });
  await expect(catalog.clear({ ...input, authorizationContext: { permitted: false } })).rejects.toMatchObject({ code: "forbidden" });
  expect((await catalog.get({ authorizationContext: input.authorizationContext, conversationId: input.conversationId })).descriptor)
    .toEqual(created.descriptor);
  expect(await persistence.readEvents("tenant", input.conversationId)).toHaveLength(1);
  expect((await client.query(`SELECT 1 FROM handrail_ai_idempotency WHERE tenant_id='tenant'
    AND scope_id='clear-owner' AND domain='catalog.clear'`)).rows).toEqual([]);
});

it("fences late event, turn, checkpoint, attachment, activity and voice writers", async () => {
  await seed("sealed"); await remove("sealed");
  await expect(seed("sealed")).rejects.toBeInstanceOf(PostgresConversationDeletedError);
  for (const kind of ["durable_turn", "turn_state", "sync_state", "checkpoint", "attachment", "realtime_call", "activity"] as const) {
    await expect(persistence.compareAndSetDocument({ tenantId: "tenant", kind,
      scopeId: ["attachment", "realtime_call", "activity"].includes(kind) ? "owner" : "sealed",
      recordId: kind === "activity" ? "sealed" : "late", expectedVersion: null, value: { conversationId: "sealed" } }))
      .rejects.toBeInstanceOf(PostgresConversationDeletedError);
  }
  // No UUID reuse through a new idempotency key or authenticated scope.
  const catalog = new PostgresConversationCatalog({ persistence, tenantId: "tenant", scopeId: () => "owner",
    authorize: () => "allow", createId: () => "sealed" as ConversationId });
  await expect(catalog.create({ authorizationContext: {}, idempotencyKey: "new-create" as never }))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(await persistence.readEvents("tenant", "sealed")).toEqual([]);
});

it("the default catalog deletes history and exclusive bytes, preserves shared bytes, and replays safely", async () => {
  const { PostgresAttachmentBlobStore, postgresFromClient } = await import("../src/postgres/index.js");
  const bundle = postgresFromClient(client).forScope({ tenantId: "tenant", scopeId: "owner" }, {
    createConversationId: () => "catalog-delete" as ConversationId,
  });
  const created = await bundle.catalog.create({ authorizationContext: {}, idempotencyKey: "catalog-create" as never });
  await seed("catalog-delete");
  const blobs = new PostgresAttachmentBlobStore(persistence, "tenant");
  for (const key of ["exclusive", "shared"]) {
    await blobs.put({ key, bytes: new Uint8Array([1, 2, 3]), mediaType: "text/plain", expiresAt: "infinity" });
    await persistence.compareAndSetDocument({ tenantId: "tenant", kind: "attachment", scopeId: "owner", recordId: key,
      expectedVersion: null, value: { conversationId: "catalog-delete", blobKey: key } });
  }
  await persistence.compareAndSetDocument({ tenantId: "tenant", kind: "attachment", scopeId: "another-owner", recordId: "shared-other",
    expectedVersion: null, value: { conversationId: "other", blobKey: "shared" } });
  const continuation = bundle.continuation.forConversation("catalog-delete");
  await continuation.save({ requestId: "provider-delete", inputItems: [{ type: "message", content: "private" }] });
  const input = { authorizationContext: {}, conversationId: created.descriptor.conversationId,
    expectedVersion: created.descriptor.version, idempotencyKey: "catalog-delete-key" as never };
  expect(await bundle.catalog.permanentlyDelete(input)).toMatchObject({ status: "deleted" });
  expect(await bundle.catalog.permanentlyDelete(input)).toMatchObject({ status: "idempotent" });
  expect(await persistence.readEvents("tenant", "catalog-delete")).toEqual([]);
  expect(await blobs.get("exclusive")).toBeNull();
  expect(await blobs.get("shared")).toEqual(new Uint8Array([1, 2, 3]));
  expect(await continuation.load("provider-delete")).toBeNull();
  await expect(continuation.save({ requestId: "late-provider", inputItems: [] })).rejects.toBeInstanceOf(PostgresConversationDeletedError);
  expect(await bundle.attachmentMetadata.getByContentRef("exclusive")).toBeNull();
  await expect(bundle.catalog.get({ authorizationContext: {}, conversationId: input.conversationId })).rejects.toMatchObject({ code: "not_found" });
});

it("rolls catalog, files and transcript back together when host cleanup fails", async () => {
  const catalog = new PostgresConversationCatalog({ persistence, tenantId: "tenant", scopeId: () => "owner",
    authorize: () => "allow", createId: () => "hook-failure" as ConversationId,
    permanentlyDeleteContents: async () => { throw new Error("Host cleanup failed"); } });
  const created = await catalog.create({ authorizationContext: {}, idempotencyKey: "hook-create" as never });
  await seed("hook-failure");
  await expect(catalog.permanentlyDelete({ authorizationContext: {}, conversationId: created.descriptor.conversationId,
    expectedVersion: created.descriptor.version, idempotencyKey: "hook-delete" as never })).rejects.toMatchObject({ code: "unavailable" });
  expect(await persistence.readEvents("tenant", "hook-failure")).toHaveLength(1);
  expect(await persistence.getDocument("tenant", "conversation_deleted", "hook-failure", "deleted")).toBeNull();
  expect(await catalog.get({ authorizationContext: {}, conversationId: created.descriptor.conversationId })).toMatchObject({ status: "found" });
  expect(await catalog.create({ authorizationContext: {}, idempotencyKey: "hook-create" as never }))
    .toMatchObject({ status: "idempotent", descriptor: created.descriptor });
});

it("refuses an approval saved before canonical synchronization", async () => {
  await seed("pending-review");
  await client.query(`INSERT INTO handrail_ai_approvals (tenant_id,scope_id,proposal_id,group_id,version,payload,updated_at)
    VALUES ('tenant','owner','pending-review','pending-review',1,'{"status":"pending"}',now())`);
  await expect(remove("pending-review")).rejects.toMatchObject({ code: "conversation_deletion_blocked" });
  expect(await persistence.readEvents("tenant", "pending-review")).toHaveLength(1);
});

it("keeps catalog ownership unique and refuses foreign or stale deletion requests", async () => {
  const catalog = (owner: string) => new PostgresConversationCatalog({ persistence, tenantId: "tenant", scopeId: () => owner,
    authorize: () => "allow", createId: () => "unique-owner" as ConversationId });
  const first = catalog("first"); const second = catalog("second");
  const created = await first.create({ authorizationContext: {}, idempotencyKey: "unique-create" as never });
  await seed("unique-owner");
  await expect(second.create({ authorizationContext: {}, idempotencyKey: "other-create" as never })).rejects.toMatchObject({ code: "idempotency_conflict" });
  const input = { authorizationContext: {}, conversationId: created.descriptor.conversationId,
    expectedVersion: created.descriptor.version, idempotencyKey: "unique-delete" as never };
  await expect(second.permanentlyDelete(input)).rejects.toMatchObject({ code: "not_found" });
  await expect(first.permanentlyDelete({ ...input, expectedVersion: 99 as never })).rejects.toMatchObject({ code: "version_conflict" });
  expect(await persistence.readEvents("tenant", "unique-owner")).toHaveLength(1);
});

it("fences native attachment admission after deletion", async () => {
  const { PostgresAttachmentBlobStore, PostgresAttachmentStagingMetadataStore } = await import("../src/postgres/index.js");
  await seed("late-staging"); await remove("late-staging");
  await new PostgresAttachmentBlobStore(persistence, "tenant").put({ key: "late-staging-blob",
    bytes: new Uint8Array([1]), mediaType: "text/plain", expiresAt: "2099-01-01T00:00:00Z" });
  const metadata = new PostgresAttachmentStagingMetadataStore(persistence, "tenant", "owner");
  await expect(metadata.create({ attachmentId: "att_late", contentRef: "ref_late", blobKey: "late-staging-blob",
    ownerScopeId: "owner", conversationId: "late-staging", idempotencyKey: "late", fingerprint: "late",
    mediaType: "text/plain", byteSize: 1, createdAt: "2026-09-13T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", consumedAt: null }))
    .rejects.toBeInstanceOf(PostgresConversationDeletedError);
  expect(await metadata.getByContentRef("ref_late")).toBeNull();
});


it("cleans newly staged bytes when conversation deletion wins before metadata admission", async () => {
  const { postgresFromClient } = await import("../src/postgres/index.js");
  await seed("upload-race"); await remove("upload-race");
  const bundle = postgresFromClient(client).forScope({ tenantId: "tenant", scopeId: "upload-owner" }, {
    createConversationId: () => "unused" as ConversationId,
  });
  const count = async () => (await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM handrail_ai_attachment_blobs WHERE tenant_id='tenant'")).rows[0]!.count;
  const before = await count();
  await expect(bundle.attachments.stage({ ownerScopeId: "upload-owner", conversationId: "upload-race",
    idempotencyKey: "upload-race", fingerprint: "upload-race", bytes: new Uint8Array([1]), mediaType: "text/plain" }))
    .rejects.toMatchObject({ code: "not_found" });
  expect(await count()).toBe(before);
});

it("rolls back ordinary upload bytes with failed metadata admission, then replays one retained upload", async () => {
  const { postgresFromClient } = await import("../src/postgres/index.js");
  let fail = true;
  const faulty: PostgresSqlClient = { query: client.query, transaction: operation => client.transaction(tx => {
    const wrapped: PostgresSqlClient = { query: async (sql, values) => {
      if (fail && sql.startsWith("INSERT INTO handrail_ai_documents") && sql.includes("'attachment'")) {
        fail = false; throw new Error("fixture metadata failure");
      }
      return tx.query(sql, values);
    }, transaction: nested => nested(wrapped) };
    return operation(wrapped);
  }) };
  const bundle = postgresFromClient(faulty).forScope({ tenantId: "atomic-upload", scopeId: "owner" }, {
    createConversationId: () => "unused" as ConversationId,
  });
  const input = { ownerScopeId: "owner", conversationId: "conversation", idempotencyKey: "same-upload",
    fingerprint: "same-content", bytes: new Uint8Array([1, 2, 3]), mediaType: "text/plain" };
  await expect(bundle.attachments.stage(input)).rejects.toMatchObject({ code: "unavailable" });
  expect((await client.query("SELECT 1 FROM handrail_ai_attachment_blobs WHERE tenant_id='atomic-upload'")).rows).toHaveLength(0);
  expect(await bundle.attachmentMetadata.getByIdempotency("owner", "conversation", "same-upload")).toBeNull();
  const reference = await bundle.attachments.stage(input);
  expect(await bundle.attachments.stage(input)).toEqual(reference);
  expect((await client.query("SELECT 1 FROM handrail_ai_attachment_blobs WHERE tenant_id='atomic-upload'")).rows).toHaveLength(1);
  expect((await bundle.attachments.resolve({ ...input, contentRef: reference.content_ref })).bytes).toEqual(input.bytes);
});

it("captures an ordinary upload before waiting for a database transaction", async () => {
  const { postgresFromClient } = await import("../src/postgres/index.js");
  let enter!: () => void;
  const admission = new Promise<void>(resolve => { enter = resolve; });
  const delayed: PostgresSqlClient = { query: client.query, transaction: async operation => {
    await admission; return client.transaction(operation);
  } };
  const bundle = postgresFromClient(delayed).forScope({ tenantId: "frozen-upload", scopeId: "owner" }, {
    createConversationId: () => "unused" as ConversationId,
  });
  const input = { ownerScopeId: "owner", conversationId: "conversation", idempotencyKey: "frozen-upload",
    fingerprint: "original", bytes: new Uint8Array([4, 5]), mediaType: "text/plain" };
  const staging = bundle.attachments.stage(input);
  input.bytes.fill(9); input.fingerprint = "changed";
  enter();
  const reference = await staging;
  const resolved = await bundle.attachments.resolve({ ownerScopeId: "owner", conversationId: "conversation",
    contentRef: reference.content_ref });
  expect(resolved.bytes).toEqual(new Uint8Array([4, 5]));
  expect(resolved.record.fingerprint).toBe("original");
});

it("retains an upload after a lost commit acknowledgement and safely replays its original identity", async () => {
  const { postgresFromClient } = await import("../src/postgres/index.js");
  let loseReply = true;
  const uncertain: PostgresSqlClient = { query: client.query, transaction: async operation => {
    const result = await client.transaction(operation);
    if (loseReply) { loseReply = false; throw new Error("fixture connection ended after commit"); }
    return result;
  } };
  const diagnostics = vi.fn();
  const bundle = postgresFromClient(uncertain, { diagnostics }).forScope({ tenantId: "uncertain-upload", scopeId: "owner" }, {
    createConversationId: () => "unused" as ConversationId,
  });
  const input = { ownerScopeId: "owner", conversationId: "conversation", idempotencyKey: "same-upload",
    fingerprint: "same-content", bytes: new Uint8Array([6, 7]), mediaType: "text/plain" };
  await expect(bundle.attachments.stage(input)).rejects.toMatchObject({ code: "unavailable" });
  expect(diagnostics.mock.calls.some(([value]) => value.domain === "attachment" && value.phase === "succeeded")).toBe(false);
  const committed = await bundle.attachmentMetadata.getByIdempotency("owner", "conversation", "same-upload");
  expect(committed).not.toBeNull();
  const reference = await bundle.attachments.stage(input);
  expect(reference.content_ref).toBe(committed!.contentRef);
  expect((await bundle.attachments.resolve({ ...input, contentRef: reference.content_ref })).bytes).toEqual(input.bytes);
  expect((await client.query("SELECT 1 FROM handrail_ai_attachment_blobs WHERE tenant_id='uncertain-upload'")).rows).toHaveLength(1);
  expect(diagnostics.mock.calls.filter(([value]) => value.domain === "attachment" && value.phase === "succeeded")).toHaveLength(1);
});

it("purges provider response content while preserving completion identity and refusing redispatch", async () => {
  const { PostgresProviderOperationStore } = await import("../src/postgres/index.js");
  await seed("provider-finished");
  const store = new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").forConversation("provider-finished");
  const execute = vi.fn(async () => ({ text: "private provider response", tools: [{ arguments: "private arguments" }] }));
  const parseResult = vi.fn((value: unknown) => value);
  const input = { operationId: "provider-receipt", requestFingerprint: "same-call", execute, parseResult };
  await store.run(input);
  const before = await persistence.getDocument<{ fingerprint: string }>("tenant", "provider_operation", "provider-owner", input.operationId);
  const foreign = new PostgresProviderOperationStore(persistence, "foreign", "provider-owner").forConversation("provider-finished");
  const otherConversation = new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").forConversation("other");
  await foreign.run({ ...input, execute: async () => ({ text: "other tenant" }) });
  await otherConversation.run({ ...input, operationId: "other-receipt", execute: async () => ({ text: "other conversation" }) });
  expect(await remove("provider-finished")).toEqual({ status: "deleted" });
  const receipt = await persistence.getDocument<Record<string, unknown>>("tenant", "provider_operation", "provider-owner", input.operationId);
  expect(receipt).toMatchObject({ version: 3, value: { version: 1, status: "purged", conversationId: "provider-finished",
    fingerprint: before!.value.fingerprint, completedAt: expect.any(String) } });
  expect(Object.keys(receipt!.value).sort()).toEqual(["completedAt", "conversationId", "fingerprint", "status", "version"]);
  expect(Number.isFinite(Date.parse(String(receipt!.value.completedAt)))).toBe(true);
  expect(JSON.stringify(receipt)).not.toContain("private");
  parseResult.mockClear();
  const restarted = new PostgresProviderOperationStore(new PostgresAiPersistence(client), "tenant", "provider-owner").forConversation("provider-finished");
  await expect(restarted.run(input)).rejects.toMatchObject({ code: "provider_operation_deleted" });
  await expect(new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").run(input))
    .rejects.toMatchObject({ code: "provider_operation_deleted" });
  await expect(restarted.run({ ...input, requestFingerprint: "different-call" })).rejects.toMatchObject({ code: "provider_operation_conflict" });
  await expect(restarted.run({ ...input, operationId: "new-after-delete" })).rejects.toMatchObject({ code: "conversation_deleted" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(parseResult).not.toHaveBeenCalled();
  expect((await persistence.getDocument<{ result: unknown }>("foreign", "provider_operation", "provider-owner", input.operationId))?.value.result)
    .toEqual({ text: "other tenant" });
  expect((await persistence.getDocument<{ result: unknown }>("tenant", "provider_operation", "provider-owner", "other-receipt"))?.value.result)
    .toEqual({ text: "other conversation" });
});

it("refuses deletion during a provider-only operation and permits it after completion", async () => {
  const { PostgresProviderOperationStore } = await import("../src/postgres/index.js");
  await seed("provider-running");
  const store = new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").forConversation("provider-running");
  let finish!: (text: string) => void;
  const execute = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
  const run = store.run({ operationId: "running-receipt", requestFingerprint: "running", execute, parseResult: value => String(value) });
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  await expect(remove("provider-running")).rejects.toMatchObject({ code: "conversation_deletion_blocked" });
  finish("completed response");
  expect(await run).toBe("completed response");
  expect(await remove("provider-running")).toEqual({ status: "deleted" });
});

it("keeps uncertain provider admission intact instead of treating a failed local wait as completion", async () => {
  const { PostgresProviderOperationStore } = await import("../src/postgres/index.js");
  await seed("provider-uncertain");
  const store = new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").forConversation("provider-uncertain");
  const execute = vi.fn(async () => { throw new Error("Outcome unknown"); });
  const input = { operationId: "uncertain-receipt", requestFingerprint: "uncertain", execute, parseResult: (value: unknown) => value };
  await expect(store.run(input)).rejects.toThrow("Outcome unknown");
  await expect(remove("provider-uncertain")).rejects.toMatchObject({ code: "conversation_deletion_blocked" });
  await expect(store.run(input)).rejects.toMatchObject({ code: "provider_operation_uncertain" });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await persistence.getDocument("tenant", "conversation_deleted", "provider-uncertain", "deleted")).toBeNull();
});

it("rolls provider response purging back when deletion authorization is revoked", async () => {
  const { PostgresProviderOperationStore } = await import("../src/postgres/index.js");
  await seed("provider-rollback");
  const store = new PostgresProviderOperationStore(persistence, "tenant", "provider-owner").forConversation("provider-rollback");
  const execute = vi.fn(async () => "retain on rollback");
  const input = { operationId: "rollback-receipt", requestFingerprint: "rollback", execute, parseResult: (value: unknown) => value };
  await store.run(input);
  let checks = 0;
  await expect(remove("provider-rollback", { authorize: async () => { if (++checks === 3) throw new Error("Revoked"); } }))
    .rejects.toThrow("Revoked");
  expect(await store.run(input)).toBe("retain on rollback");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await persistence.getDocument("tenant", "provider_operation", "provider-owner", input.operationId)).toMatchObject({ version: 2 });
});
