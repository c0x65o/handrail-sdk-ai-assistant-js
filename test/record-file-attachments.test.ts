import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { PostgresAiPersistence, postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import { toConversationAttachmentReference } from "../src/attachments/references.js";
import { createAssistantConversationFiles } from "../src/server/assistant-conversation-files.js";
import { createRecordFileAttachments, createRecordFileAttachmentAdmission, createPostgresRecordFileAttachmentStore, RecordFileAttachmentError,
  type RecordFileAttachmentDestination, type RecordFileDestinationInput, type RecordFileAttachmentRequest } from "../src/server/record-file-attachments.js";
import type { JsonObject } from "../src/protocol.js";
import manifest from "./fixtures/documents/manifest.json" with { type: "json" };
import { createHandrailAssistant, openaiResponses, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { createHandrailAiClient } from "../src/client/index.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import { AI_RUNTIME_PROTOCOL_VERSION } from "../src/protocol.js";
import { replayConversation } from "../src/conversation/replay.js";
import { createAiApplication } from "../src/server/application.js";

const database = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) }; return client;
}
const sql: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = new PostgresAiPersistence(sql);
beforeAll(async () => {
  await persistence.migrate();
  await sql.query(`CREATE TABLE fixture_record_files (tenant text NOT NULL, operation text NOT NULL, id text NOT NULL,
    target jsonb NOT NULL, metadata jsonb NOT NULL, filename text NOT NULL, media_type text NOT NULL, bytes bytea NOT NULL,
    PRIMARY KEY(tenant, operation))`);
});
afterAll(() => database.close());
const location = () => ({ conversationId: "conversation", signal: new AbortController().signal });
type DomainRow = { id: string; target: JsonObject; metadata: JsonObject; filename: string; media_type: string; bytes: Uint8Array };
async function fixture(filename = "invoice.png") {
  const tenant = randomUUID(), namespace = [tenant, "alice", "assistant"];
  let allowed = true;
  const files = createAssistantConversationFiles({ persistence, tenantId: tenant, scopeId: "account", principalId: "alice",
    assistantId: "test", limits: { maximumBytes: 100_000, ttlMilliseconds: 60_000,
      acceptedMediaTypes: manifest.map(file => file.uploaded.media_type) },
    authorizeConversation: async () => { if (!allowed) throw new RecordFileAttachmentError("forbidden"); } });
  const source = manifest.find(file => file.filename === filename)!;
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/documents/${filename}`, import.meta.url)));
  const reference = await files.stage("conversation", { idempotencyKey: "upload", fileName: filename, mediaType: source.uploaded.media_type, data: bytes });
  await files.events.append({ conversationId: "conversation" as never, expectedRevision: null,
    events: [{ type: "message.created", message_id: "message", role: "user", content: [{ type: "text", text: "Save this document" }] },
      { type: "message.attachment_referenced", message_id: "message", attachment: toConversationAttachmentReference(reference) }]
      .map((payload, index) => parseConversationEvent({ version: 1, conversation_id: "conversation", event_id: `event-${index}`,
        revision: index + 1, occurred_at: "2026-09-15T12:00:00Z", actor: { type: "user", id: "alice" }, source: { type: "runtime" }, payload })) });
  const handle = (await files.savedFiles.list(location())).files[0]!.handle;
  const stored = async (operationId: string) => (await sql.query<DomainRow>(
    "SELECT id,target,metadata,filename,media_type,bytes FROM fixture_record_files WHERE tenant=$1 AND operation=$2", [tenant, operationId])).rows[0];
  const authorize = vi.fn(async (input: RecordFileDestinationInput) => {
    if (!allowed || input.request.target.id !== "record-1") throw new RecordFileAttachmentError("forbidden");
  });
  const destination: RecordFileAttachmentDestination = {
    id: "record_documents", maximumBytes: 100_000, mediaTypes: manifest.map(file => file.uploaded.media_type), authorize,
    lookup: vi.fn(async input => { const row = await stored(input.operationId); return row ? { attachmentId: row.id } : null; }),
    attach: vi.fn(async input => {
      await authorize(input);
      await sql.query(`INSERT INTO fixture_record_files (tenant,operation,id,target,metadata,filename,media_type,bytes)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) ON CONFLICT(tenant,operation) DO NOTHING`,
      [tenant, input.operationId, randomUUID(), JSON.stringify(input.request.target), JSON.stringify(input.request.metadata),
        input.source.fileName, input.source.mediaType, input.bytes]);
      const row = (await stored(input.operationId))!;
      // The fixture models a domain service's immutable idempotency binding.
      if (Buffer.compare(Buffer.from(row.bytes), Buffer.from(input.bytes)) || row.filename !== input.source.fileName || row.media_type !== input.source.mediaType) {
        throw new RecordFileAttachmentError("operation_conflict");
      }
      return { attachmentId: row.id };
    }),
    readBack: vi.fn(async input => {
      await authorize(input);
      const row = await stored(input.operationId);
      if (!row || row.id !== input.attachmentId) throw new RecordFileAttachmentError("destination_missing");
      return { target: row.target, metadata: row.metadata, fileName: row.filename, mediaType: row.media_type, bytes: row.bytes };
    }),
  };
  const store = createPostgresRecordFileAttachmentStore(persistence, tenant);
  const make = (overrideNamespace = namespace) => createRecordFileAttachments({ namespace: overrideNamespace, files: files.savedFiles, store, destinations: [destination] });
  const service = make();
  const request: RecordFileAttachmentRequest = { destinationId: destination.id, fileHandle: handle,
    target: { type: "person", id: "record-1" }, metadata: { displayName: "Invoice", documentDate: "2026-09-15" }, writeOptions: { expectedVersion: 1 } };
  const prepare = () => service.prepare({ ...location(), idempotencyKey: "tool-operation", request });
  return { tenant, bytes, source, files, destination, store, make, service, request, prepare, stored,
    revoke: () => { allowed = false; }, restore: () => { allowed = true; },
    count: async () => (await sql.query("SELECT 1 FROM fixture_record_files WHERE tenant=$1", [tenant])).rows.length };
}

it.each(manifest)("attaches original $filename and verifies durable metadata/bytes through restart and retry", async ({ filename, sha256 }) => {
  const f = await fixture(filename), intent = await f.prepare();
  expect(await f.count()).toBe(0); expect(intent.source.sha256).toBe(sha256);
  expect(await f.prepare()).toEqual(intent);
  const execute = { ...location(), operationId: intent.operationId };
  const receipt = await f.service.execute(execute);
  expect(receipt).toMatchObject({ type: "handrail.record_file_attached.v1", metadata: f.request.metadata, target: f.request.target,
    source: { fileName: filename, sha256 } });
  expect((await f.stored(intent.operationId))!.bytes).toEqual(f.bytes);
  expect(await f.make().execute(execute)).toEqual(receipt);
  expect(await f.count()).toBe(1); expect(f.destination.attach).toHaveBeenCalledOnce();
  expect(JSON.stringify(receipt)).not.toContain("content_ref");
  expect(JSON.stringify(receipt)).not.toContain(Buffer.from(f.bytes).toString("base64"));
});

it("refuses a reused preparation key with a changed target, source or metadata", async () => {
  const f = await fixture(); await f.prepare();
  await expect(f.service.prepare({ ...location(), idempotencyKey: "tool-operation",
    request: { ...f.request, metadata: { displayName: "Different name" } } })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(f.service.prepare({ ...location(), idempotencyKey: "tool-operation",
    request: { ...f.request, target: { ...f.request.target, id: "foreign" } } })).rejects.toMatchObject({ code: "forbidden" });
  expect(await f.count()).toBe(0);
});

it("deduplicates concurrent execution through the domain's atomic identity and the shared receipt", async () => {
  const f = await fixture(), intent = await f.prepare();
  const input = { ...location(), operationId: intent.operationId };
  const [first, second] = await Promise.all([f.service.execute(input), f.make().execute(input)]);
  expect(second).toEqual(first); expect(await f.count()).toBe(1);
});

it("recovers a lost domain commit acknowledgement by lookup and verified read-back", async () => {
  const f = await fixture(), intent = await f.prepare();
  const attach = vi.mocked(f.destination.attach).getMockImplementation()!;
  vi.mocked(f.destination.attach).mockImplementationOnce(async input => {
    await attach(input);
    throw new Error("lost acknowledgement with private database detail");
  });
  expect(await f.service.execute({ ...location(), operationId: intent.operationId })).toMatchObject({ operationId: intent.operationId });
  expect(await f.count()).toBe(1);
});

it("repairs a lost SDK receipt acknowledgement without writing another business attachment", async () => {
  const f = await fixture(), intent = await f.prepare();
  const original = persistence.compareAndSetDocument.bind(persistence);
  let lost = false;
  const spy = vi.spyOn(persistence, "compareAndSetDocument").mockImplementation(async input => {
    const saved = await original(input);
    if (!lost && input.recordId === intent.operationId) { lost = true; throw new Error("lost acknowledgement"); }
    return saved;
  });
  try {
    expect(await f.service.execute({ ...location(), operationId: intent.operationId })).toMatchObject({ operationId: intent.operationId });
    expect(await f.count()).toBe(1);
  } finally { spy.mockRestore(); }
});

it.each(["bytes", "metadata", "target", "filename", "media_type"])("never reports success for mismatched destination %s", async column => {
  const f = await fixture(), intent = await f.prepare();
  const original = vi.mocked(f.destination.attach).getMockImplementation()!;
  vi.mocked(f.destination.attach).mockImplementation(async input => {
    const saved = await original(input);
    const value = column === "bytes" ? new Uint8Array([1, 2]) : column === "metadata" || column === "target" ? '{"wrong":true}' : "wrong";
    await sql.query(`UPDATE fixture_record_files SET ${column}=$1 WHERE tenant=$2 AND operation=$3`, [value, f.tenant, input.operationId]);
    return saved;
  });
  const input = { ...location(), operationId: intent.operationId };
  await expect(f.service.execute(input)).rejects.toMatchObject({ code: "destination_mismatch" });
  await expect(f.make().execute(input)).rejects.toMatchObject({ code: "destination_mismatch" });
  expect(await f.count()).toBe(1); expect(f.destination.attach).toHaveBeenCalledOnce();
  expect((await f.store.read("conversation", intent.operationId))!.receipt).toBeNull();
});

it("rechecks authorization after a write and reconciles the same operation after restored access", async () => {
  const f = await fixture(), intent = await f.prepare();
  const original = vi.mocked(f.destination.attach).getMockImplementation()!;
  vi.mocked(f.destination.attach).mockImplementation(async input => { const result = await original(input); f.revoke(); return result; });
  const input = { ...location(), operationId: intent.operationId };
  await expect(f.service.execute(input)).rejects.toMatchObject({ code: "forbidden" });
  expect((await f.store.read("conversation", intent.operationId))!.receipt).toBeNull();
  f.restore();
  expect(await f.make().execute(input)).toMatchObject({ operationId: intent.operationId });
  expect(await f.count()).toBe(1); expect(f.destination.attach).toHaveBeenCalledOnce();
});

it("cancels while a domain acknowledgement is pending, then resumes without duplicate bytes", async () => {
  const f = await fixture(), intent = await f.prepare(), controller = new AbortController();
  const original = vi.mocked(f.destination.attach).getMockImplementation()!;
  let release!: () => void, notify!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const written = new Promise<void>(resolve => { notify = resolve; });
  vi.mocked(f.destination.attach).mockImplementationOnce(async input => { const value = await original(input); notify(); await gate; return value; });
  const execution = f.service.execute({ conversationId: "conversation", operationId: intent.operationId, signal: controller.signal });
  await written; controller.abort(new Error("cancelled"));
  await expect(execution).rejects.toThrow("cancelled"); release();
  expect((await f.store.read("conversation", intent.operationId))!.receipt).toBeNull();
  expect(await f.make().execute({ ...location(), operationId: intent.operationId })).toMatchObject({ operationId: intent.operationId });
  expect(await f.count()).toBe(1); expect(f.destination.attach).toHaveBeenCalledOnce();
});

it("does not recreate a completed attachment that was explicitly removed", async () => {
  const f = await fixture(), intent = await f.prepare(), input = { ...location(), operationId: intent.operationId };
  await f.service.execute(input);
  await sql.query("DELETE FROM fixture_record_files WHERE tenant=$1", [f.tenant]);
  await expect(f.make().execute(input)).rejects.toMatchObject({ code: "destination_missing" });
  expect(await f.count()).toBe(0); expect(f.destination.attach).toHaveBeenCalledOnce();
});

it("fails closed on a lookup outage and foreign operation namespace without leaking raw details", async () => {
  const f = await fixture(), intent = await f.prepare(), input = { ...location(), operationId: intent.operationId };
  vi.mocked(f.destination.lookup).mockRejectedValue(new Error("private database credential"));
  await expect(f.service.execute(input)).rejects.toMatchObject({ code: "unavailable", message: expect.not.stringContaining("credential") });
  await expect(f.make([f.tenant, "foreign"]).execute(input)).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.destination.attach).not.toHaveBeenCalled();
});

it("rejects source bytes changed after preparation even when storage reports a new matching checksum", async () => {
  const f = await fixture(), intent = await f.prepare();
  const changed = new Uint8Array(f.bytes); changed[changed.length - 1] = changed.at(-1)! ^ 1;
  await sql.query("UPDATE handrail_ai_attachment_blobs SET payload=$1 WHERE tenant_id=$2 AND blob_key LIKE 'blob_retained_%'", [changed, f.tenant]);
  await sql.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{sha256}',$1::jsonb),version=version+1 WHERE tenant_id=$2 AND scope_id LIKE 'assistant-retained:%'", [JSON.stringify(createHash("sha256").update(changed).digest("hex")), f.tenant]);
  await expect(f.service.execute({ ...location(), operationId: intent.operationId })).rejects.toMatchObject({ code: "source_changed" });
  expect(f.destination.attach).not.toHaveBeenCalled();
});

it("captures request values before asynchronous source authorization", async () => {
  const f = await fixture();
  const pending = f.prepare();
  f.request.metadata.displayName = "Changed by caller";
  f.request.target.id = "foreign";
  const intent = await pending;
  expect(intent.request.metadata.displayName).toBe("Invoice"); expect(intent.request.target.id).toBe("record-1");
  expect(await f.service.execute({ ...location(), operationId: intent.operationId })).toMatchObject({ metadata: { displayName: "Invoice" } });
});

it("refuses a corrupt persisted intent before any destination write", async () => {
  const f = await fixture(), intent = await f.prepare();
  await sql.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{intent,request,metadata,displayName}','\"corrupt\"'),version=version+1 WHERE tenant_id=$1 AND record_id=$2", [f.tenant, intent.operationId]);
  await expect(f.make().execute({ ...location(), operationId: intent.operationId })).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.destination.attach).not.toHaveBeenCalled();
});

it.each(["confirmed", "rejected", "revoked"] as const)("uses the SDK approval/receipt path after restart: %s", async decision => {
  const f = await fixture(), prepared = await f.prepare();
  const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", tenantId: f.tenant, scopeId: "account",
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("alice"), session: fact("session"), automation: fact(null) } };
  const persistence = postgresFromClient(sql);
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => "conversation" as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "new" as never });
  const plugin = createToolPlugin({ pluginId: "fixture.documents", version: "1.0.0", displayName: "Fixture document destination",
    registrations: [{ definition: { name: "attach_record_file", description: "Attach the reviewed file",
      input_schema: { type: "object", required: ["operationId"], additionalProperties: false, properties: { operationId: { type: "string" } } } },
    executor: async (arguments_: JsonObject, input: { signal: AbortSignal; location?: { conversationId: string } }) => {
      if (!input.location) throw new RecordFileAttachmentError("invalid_request");
      return f.make().execute({ ...input.location, signal: input.signal, operationId: String(arguments_.operationId) });
    } }], approvals: [{ toolName: "attach_record_file", mode: "always",
      summarize: () => `Attach ${prepared.source.fileName} to ${String(prepared.request.target.id)} as ${String(prepared.request.metadata.displayName)}` }] });
  let physical = 0;
  const diagnostics = vi.fn();
  const create = () => createHandrailAssistant({ id: "record-files", persistence, authorize: () => context, tools: [plugin],
    toolAdmission: createRecordFileAttachmentAdmission({ toolNames: ["attach_record_file"], serviceFor: () => f.make() }),
    automaticTitles: false, diagnostics,
    provider: openaiResponses({ model: "fixture", supportsToolSearch: false, request: async function* () {
      if (++physical === 1) {
        yield { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "save-file", name: "attach_record_file", arguments: "" } };
        yield { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc", arguments: JSON.stringify({ operationId: prepared.operationId }) };
      } else yield { type: "response.output_text.delta", delta: "Reviewed the saved tool result." };
      yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
    } }) });
  let assistant = await create();
  const browser = await createHandrailAiClient({ baseUrl: "https://app.test", startActivityPolling: false,
    fetch: (url, init) => assistant.handle(new Request(url, init)),
    conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  try {
    const runtime = await browser.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
    const pending = await runtime.sendMessage({ content: "Attach this file to the record", request: {
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null, tools: [], tool_results: [],
      messages: [{ role: "user", content: [{ type: "text", text: "Attach this file to the record" }] }],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} } });
    expect(pending, JSON.stringify(diagnostics.mock.calls)).toMatchObject({ status: "waiting_for_approval" });
    expect(await f.count()).toBe(0);
    const proposal = (await bundle.approvals.listGroup({ permissionContext: context, groupId: "conversation" as never }))[0]!;
    await assistant.stopBackgroundWorkers(); assistant = await create();
    if (decision === "revoked") f.revoke();
    const post = () => assistant.handle(new Request("https://app.test/approvals/transition", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conversation", proposalId: proposal.proposal_id, expectedVersion: 1,
        status: decision === "rejected" ? "rejected" : "confirmed", idempotencyKey: "decide", idempotencyFingerprint: "decide" }) }));
    expect((await post()).status).toBe(200);
    await vi.waitFor(async () => {
      const replay = await replayConversation({ conversationId: "conversation" as never, eventStore: bundle.events });
      try { expect(replay.state.turns.at(-1)?.status, JSON.stringify(diagnostics.mock.calls)).toBe("completed"); }
      finally { replay.store.destroy(); }
    }, { timeout: 10_000 });
    expect(await f.count()).toBe(decision === "confirmed" ? 1 : 0);
    expect((await f.store.read("conversation", prepared.operationId))!.receipt === null).toBe(decision !== "confirmed");
    expect(physical).toBe(2);
    expect((await post()).status).toBe(200);
    expect(physical).toBe(2); expect(await f.count()).toBe(decision === "confirmed" ? 1 : 0);
  } finally { await browser.dispose(); await assistant.stopBackgroundWorkers(); }
}, 30_000);

it("checks current destination access before returning a cached tool success", async () => {
  const f = await fixture(), prepared = await f.prepare();
  const execute = vi.fn(async () => f.service.execute({ ...location(), operationId: prepared.operationId }));
  const plugin = createToolPlugin({ pluginId: "fixture.receipt", version: "1.0.0", displayName: "Fixture receipt",
    registrations: [{ definition: { name: "attach", description: "Attach the reviewed file", input_schema: {
      type: "object", required: ["operationId"], additionalProperties: false, properties: { operationId: { type: "string" } } } }, executor: execute }] });
  const app = await createAiApplication({ plugins: [plugin], installContext: undefined, policy: () => ({ outcome: "allow" }),
    toolAdmission: createRecordFileAttachmentAdmission({ toolNames: ["attach"], serviceFor: () => f.make() }) });
  const input = { discovery: { context: undefined }, applicationContext: undefined, location: { conversationId: "conversation", turnId: "turn" },
    call: { name: "attach", tool_call_id: "same-call", arguments: { operationId: prepared.operationId } } };
  const first = await app.executeTool(input);
  expect(first).toMatchObject({ status: "completed", result: { is_error: false } });
  expect(await app.executeTool(input)).toEqual(first); expect(execute).toHaveBeenCalledOnce();
  f.revoke();
  expect(await app.executeTool(input)).toMatchObject({ status: "completed", result: { is_error: true } });
  expect(execute).toHaveBeenCalledOnce(); expect(await f.count()).toBe(1);
});
