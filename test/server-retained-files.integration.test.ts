import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { postgresFromClient, cleanupPostgresConversationFileStaging, type PostgresSqlClient } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { assistantConversationFileMaintenanceScope } from "../src/server/assistant-conversation-files.js";
import { openaiResponses } from "../src/server/openai-responses.js";
import { createHandrailAiClient } from "../src/client/index.js";
import { toConversationAttachmentReference } from "../src/attachments/references.js";
import { AI_RUNTIME_PROTOCOL_VERSION, parseChatRequest, type AttachmentReference, type ChatRequest } from "../src/protocol.js";
import type { OpenAIResponsesRequest } from "../src/providers/openai-responses-tools.js";
import { SAVED_FILE_LIST_TOOL, SAVED_FILE_OPEN_TOOL } from "../src/server/saved-file-tools.js";
import { replayConversation } from "../src/conversation/replay.js";

const database = new PGlite();
const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: operation => operation(client) }; return client;
};
const sql: PostgresSqlClient = { query: adapt(database).query,
  transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
const persistence = postgresFromClient(sql, { attachmentLimits: { maximumBytes: 100_000, ttlMilliseconds: 60_000,
  acceptedMediaTypes: ["image/png", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] } });
beforeAll(() => persistence.persistence.migrate());
afterAll(() => database.close());
const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const manifest = JSON.parse(readFileSync(new URL("./fixtures/documents/manifest.json", import.meta.url), "utf8")) as
  { filename: string; uploaded: AttachmentReference }[];

it.each(manifest)("retains $filename through HTTP upload, client admission, provider input, expiry and reopened follow-up", async fixture => {
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", scopeId: "account", tenantId: randomUUID(),
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("alice"), session: fact("session"), automation: fact(null) } };
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => "conversation" as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "new" as never });
  const bytes = readFileSync(new URL(`./fixtures/documents/${fixture.filename}`, import.meta.url));
  const inputs: OpenAIResponsesRequest[] = [];
  const diagnostics = vi.fn();
  let allowed = true;
  const make = () => createHandrailAssistant({ id: "retained", persistence, automaticTitles: false,
    attachmentRetention: "conversation", attachmentCleanup: false, diagnostics,
    authorize: () => { if (!allowed) throw new Error("access revoked"); return context; },
    provider: openaiResponses({ model: "fixture", savedConversation: true, supportsToolSearch: false,
      request: async function* (request) {
        inputs.push(request);
        yield { type: "response.output_text.delta", delta: "Fixture received." };
        yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      } }) });
  let assistant = await make();
  const open = () => createHandrailAiClient<HandrailAssistantAuthorizationContext, ChatRequest>({
    baseUrl: "https://app.test", startActivityPolling: false,
    fetch: (url, init) => assistant.handle(new Request(url, init)),
    conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  let browser = await open();
  const send = async (text: string, reference?: AttachmentReference) => {
    const runtime = await browser.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
    return runtime.sendMessage({ content: text,
      ...(reference ? { attachments: [toConversationAttachmentReference(reference)] } : {}),
      request: parseChatRequest({ protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: "user", content: [{ type: "text", text }, ...(reference ? [{
          type: reference.media_type.startsWith("image/") ? "image" as const : "document" as const, attachment: reference,
        }] : [])] }], tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} }) });
  };
  try {
    const reference = await browser.attachmentUpload!.upload({
      source: new Blob([bytes], { type: fixture.uploaded.media_type }), idempotencyKey: "upload",
      metadata: { conversationId: "conversation", filename: fixture.filename, mediaType: fixture.uploaded.media_type,
        byteSize: bytes.length, kind: fixture.uploaded.media_type.startsWith("image/") ? "image" : "document" },
      signal: new AbortController().signal, onProgress: () => {},
    });
    const result = await send("Read this invoice", reference);
    expect(result, JSON.stringify(diagnostics.mock.calls)).toMatchObject({ status: "completed" });
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(inputs[0])).toContain(bytes.toString("base64"));
    const rows = await sql.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id LIKE 'assistant-retained:%'", [context.tenantId]);
    expect(rows.rows).toHaveLength(1);
    await browser.dispose(); await assistant.stopBackgroundWorkers();
    // Expire only the synthetic managed drafts. Retained copies have their own
    // durable policy; no clock or provider/network timing is mocked here.
    await sql.query("UPDATE handrail_ai_documents SET version=version+1, payload=jsonb_set(jsonb_set(payload,'{createdAt}','\"2000-01-01T00:00:00.000Z\"'),'{expiresAt}','\"2000-01-01T00:01:00.000Z\"') WHERE tenant_id=$1 AND scope_id LIKE 'assistant-draft:%' AND kind='attachment'", [context.tenantId]);
    expect(await cleanupPostgresConversationFileStaging({ persistence: persistence.persistence, tenantId: context.tenantId,
      maintenanceScopeId: assistantConversationFileMaintenanceScope("retained") })).toEqual({ removed: 1, blocked: 0 });
    assistant = await make(); browser = await open();
    const followup = await send("What was the total in that file?");
    expect(followup, JSON.stringify(diagnostics.mock.calls)).toMatchObject({ status: "completed" });
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs[1])).toContain(bytes.toString("base64"));
    const url = `https://app.test/attachments/content?conversationId=conversation&attachmentId=${reference.attachment_id}`;
    const download = await assistant.handle(new Request(url));
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    allowed = false;
    expect((await assistant.handle(new Request(url))).status).toBe(403);
  } finally { await browser.dispose(); await assistant.stopBackgroundWorkers(); }
}, 30_000);

it("rejects an expired unsent file once through the real client without admitting events or starting a provider", async () => {
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", scopeId: "account", tenantId: randomUUID(),
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("alice"), session: fact("session"), automation: fact(null) } };
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => "conversation" as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "new" as never });
  const provider = vi.fn(async function* () { throw new Error("A rejected message cannot reach the provider"); yield {}; });
  const assistant = await createHandrailAssistant({ id: "expired", persistence, automaticTitles: false,
    attachmentRetention: "conversation", attachmentCleanup: false, authorize: () => context,
    provider: openaiResponses({ model: "fixture", savedConversation: true, request: provider }) });
  let admissions = 0;
  const browser = await createHandrailAiClient<HandrailAssistantAuthorizationContext, ChatRequest>({
    baseUrl: "https://app.test", startActivityPolling: false,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      if (request.url.endsWith("/synchronization") && (await request.clone().json()).operation === "append_mutations") admissions++;
      return assistant.handle(request);
    }, conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  try {
    const bytes = readFileSync(new URL("./fixtures/documents/invoice.png", import.meta.url));
    const reference = await browser.attachmentUpload!.upload({ source: new Blob([bytes], { type: "image/png" }), idempotencyKey: "upload",
      metadata: { conversationId: "conversation", filename: "invoice.png", mediaType: "image/png", byteSize: bytes.length },
      signal: new AbortController().signal, onProgress: () => {} });
    await sql.query("UPDATE handrail_ai_documents SET version=version+1, payload=jsonb_set(jsonb_set(payload,'{createdAt}','\"2000-01-01T00:00:00.000Z\"'),'{expiresAt}','\"2000-01-01T00:01:00.000Z\"') WHERE tenant_id=$1 AND scope_id LIKE 'assistant-draft:%' AND kind='attachment'", [context.tenantId]);
    const runtime = await browser.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
    const accepted = vi.fn();
    await expect(runtime.sendMessage({ content: "Read this invoice", attachments: [toConversationAttachmentReference(reference)], onAccepted: accepted,
      request: parseChatRequest({ protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: "user", content: [{ type: "text", text: "Read this invoice" }, { type: "image", attachment: reference }] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} }) }))
      .rejects.toMatchObject({ retryable: false, message: "A file upload expired before the message was saved. Select the file again." });
    expect(admissions).toBe(1); expect(accepted).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
    expect((await bundle.events.read({ conversationId: "conversation" as never })).entries).toHaveLength(0);
    expect((await sql.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id LIKE 'assistant-retained:%'", [context.tenantId])).rows).toHaveLength(0);
  } finally { await browser.dispose(); await assistant.stopBackgroundWorkers(); }
});

it.each([{ filename: "invoice-scan.pdf", currentDocuments: 0, revokeDuringRetry: false }, { filename: "invoice.docx", currentDocuments: 0, revokeDuringRetry: false },
  { filename: "invoice-scan.pdf", currentDocuments: 2, revokeDuringRetry: false }, { filename: "invoice-scan.pdf", currentDocuments: 0, revokeDuringRetry: true }])("reopens $filename with $currentDocuments current files after five documents, expiry and restart (revoke=$revokeDuringRetry)", async ({ filename, currentDocuments, revokeDuringRetry }) => {
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", scopeId: "account", tenantId: randomUUID(),
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("alice"), session: fact("session"), automation: fact(null) } };
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => "conversation" as never });
  await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "new" as never });
  const original = readFileSync(new URL(`./fixtures/documents/${filename}`, import.meta.url));
  const originalMediaType = manifest.find(file => file.filename === filename)!.uploaded.media_type;
  const recent = readFileSync(new URL("./fixtures/documents/invoice.pdf", import.meta.url));
  const inputs: OpenAIResponsesRequest[] = [], diagnostics = vi.fn();
  let followup = false, readable = true, step = 0, openedHandle = "";
  const make = () => createHandrailAssistant({ id: "reopen", persistence, automaticTitles: false,
    attachmentRetention: "conversation", attachmentCleanup: false, diagnostics, authorize: () => context,
    provider: openaiResponses({ model: "fixture", savedConversation: { maximumHistoricalMessages: 1,
      authorize: () => { if (!readable) throw Object.assign(new Error("private domain permission detail"), { status: 403 }); } }, supportsToolSearch: false,
      // This legacy limit must not silently discard an explicitly reopened file.
      maximumInputMessages: 1, retry: { initialDelayMs: 1 },
      request: async (request) => {
        inputs.push(request);
        if (followup && step === 2 && revokeDuringRetry) {
          readable = false;
          throw Object.assign(new Error("temporary connection failure"), { status: 503 });
        }
        return (async function* () {
          if (followup && step < 3) {
            let name = SAVED_FILE_LIST_TOOL, arguments_: Record<string, unknown> = { after: null, limit: 20 };
            if (step === 1) {
              const output = request.input.find(item => item.type === "function_call_output" && item.call_id === "file-call-0");
              const parts = JSON.parse(String(output?.output));
              const listing = parts.find((part: { type: string }) => part.type === "json").value;
              expect(listing.status).toBe("listed"); expect(listing.files).toHaveLength(5 + currentDocuments);
              openedHandle = listing.files.find((file: { fileName: string }) => file.fileName === filename).handle;
              name = SAVED_FILE_OPEN_TOOL; arguments_ = { handles: [openedHandle] };
            }
            yield { type: "response.output_item.added", output_index: 0, item: {
              type: "function_call", id: `fc-${step}`, call_id: `file-call-${step}`, name, arguments: "" } };
            yield { type: "response.function_call_arguments.done", output_index: 0, item_id: `fc-${step}`, arguments: JSON.stringify(arguments_) };
            step++;
          } else yield { type: "response.output_text.delta", delta: "Fixture received." };
          yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
        })();
      } }) });
  let assistant = await make();
  const open = () => createHandrailAiClient<HandrailAssistantAuthorizationContext, ChatRequest>({ baseUrl: "https://app.test", startActivityPolling: false,
    fetch: (url, init) => assistant.handle(new Request(url, init)),
    conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  let browser = await open();
  const send = async (text: string, references: readonly AttachmentReference[] = []) => {
    const runtime = await browser.workspace!.open({ authorizationContext: context, conversationId: "conversation" as never });
    return runtime.sendMessage({ content: text, attachments: references.map(toConversationAttachmentReference),
      request: parseChatRequest({ protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: "user", content: [{ type: "text", text }, ...references.map(reference => ({ type: "document", attachment: reference }))] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} }) });
  };
  try {
    for (let index = 0; index < 5; index++) {
      const bytes = index === 0 ? original : recent;
      const mediaType = index === 0 ? originalMediaType : "application/pdf";
      const reference = await browser.attachmentUpload!.upload({ source: new Blob([bytes], { type: mediaType }),
        idempotencyKey: `upload-${index}`, metadata: { conversationId: "conversation", filename: index === 0 ? filename : `recent-${index}.pdf`,
          mediaType, byteSize: bytes.length, kind: "document" }, signal: new AbortController().signal, onProgress: () => {} });
      expect(await send(`Read invoice ${index}`, [reference]), JSON.stringify(diagnostics.mock.calls)).toMatchObject({ status: "completed" });
    }
    await browser.dispose(); await assistant.stopBackgroundWorkers();
    await sql.query("UPDATE handrail_ai_documents SET version=version+1, payload=jsonb_set(jsonb_set(payload,'{createdAt}','\"2000-01-01T00:00:00.000Z\"'),'{expiresAt}','\"2000-01-01T00:01:00.000Z\"') WHERE tenant_id=$1 AND scope_id LIKE 'assistant-draft:%' AND kind='attachment'", [context.tenantId]);
    expect(await cleanupPostgresConversationFileStaging({ persistence: persistence.persistence, tenantId: context.tenantId,
      maintenanceScopeId: assistantConversationFileMaintenanceScope("reopen") })).toEqual({ removed: 5, blocked: 0 });
    assistant = await make(); browser = await open(); followup = true;
    const current: AttachmentReference[] = [];
    for (let index = 0; index < currentDocuments; index++) current.push(await browser.attachmentUpload!.upload({
      source: new Blob([recent], { type: "application/pdf" }), idempotencyKey: `current-${index}`, metadata: {
        conversationId: "conversation", filename: `current-${index}.pdf`, mediaType: "application/pdf", byteSize: recent.length, kind: "document" },
      signal: new AbortController().signal, onProgress: () => {} }));
    const result = await send("What is on the oldest scanned invoice?", current);
    expect(result, JSON.stringify(diagnostics.mock.calls)).toMatchObject(revokeDuringRetry
      ? { status: "failed", error: { code: "forbidden", retryable: false, message: "Access to the saved files is no longer available." } }
      : { status: "completed" });
    expect(JSON.stringify(result)).not.toContain("private domain permission detail");
    // Revocation after the first connection failure prevents any retry from
    // sending the already-resolved bytes again.
    expect(inputs).toHaveLength(revokeDuringRetry ? 8 : 9);
    expect(JSON.stringify(inputs[5])).not.toContain(original.toString("base64"));
    const final = inputs.at(-1)!;
    const messages = JSON.stringify(final.input.filter(item => item.type !== "function_call_output"));
    if (currentDocuments) {
      expect(messages).not.toContain(original.toString("base64"));
      expect(messages).toContain(recent.toString("base64"));
    } else {
      expect(messages).toContain(original.toString("base64"));
      expect(messages).not.toContain(recent.toString("base64"));
    }
    expect(final.tools.some(tool => tool.type === "function" && tool.name === SAVED_FILE_OPEN_TOOL)).toBe(true);
    const receipt = final.input.find(item => item.type === "function_call_output" && item.call_id === "file-call-1");
    if (currentDocuments) {
      expect(String(receipt?.output)).toContain("exceed this request's attachment limits");
      expect(String(receipt?.output)).not.toContain('"status":"opened"');
    } else {
      expect(String(receipt?.output)).toContain(openedHandle);
      expect(String(receipt?.output)).toContain('"status":"opened"');
    }
    expect(String(receipt?.output)).not.toContain("content_ref");
    expect(String(receipt?.output)).not.toContain(original.toString("base64"));
    const replay = await replayConversation({ conversationId: "conversation" as never, eventStore: bundle.events });
    try { expect(replay.state.replay_error).toBeNull(); expect(replay.state.messages.filter(message => message.role === "user")).toHaveLength(6); }
    finally { replay.store.destroy(); }
  } finally { await browser.dispose(); await assistant.stopBackgroundWorkers(); }
}, 60_000);
