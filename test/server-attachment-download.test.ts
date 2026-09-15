import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { createHandrailAssistant, openaiResponses, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";

const database = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: (operation) => operation(client) }; return client;
}
const persistence = postgresFromClient({ query: adapt(database).query,
  transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) }, {
  attachmentLimits: { maximumBytes: 8, acceptedMediaTypes: ["application/pdf"], ttlMilliseconds: 60_000 },
});
beforeAll(async () => { await persistence.persistence.migrate(); });
afterAll(async () => { await database.close(); });

it("provides shared PDF/DOCX defaults with an opt-out and preserves explicit provider format settings", () => {
  const options = { model: "fixture", request: async function* () { yield { type: "response.completed" }; } };
  expect(openaiResponses(options).metadata.capabilities.document_input).toMatchObject({ supported: true,
    capability: { supported_mime_types: ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      max_document_count: 2, max_document_bytes: 20 * 1024 * 1024 } });
  expect(openaiResponses({ ...options, document_input: false }).metadata.capabilities.document_input).toEqual({ supported: false });
  const custom = { supported_mime_types: ["text/csv"] as const, max_document_count: 2, max_document_bytes: 1_000, requires_host_resolution: true };
  expect(openaiResponses({ ...options, document_input: custom }).metadata.capabilities.document_input).toEqual({ supported: true, capability: custom });
});

it("uploads and reads original DOCX bytes through the default authenticated assistant, including retry and restart", async () => {
  const defaults = postgresFromClient({ query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
  const context = { tenantId: "docx-tenant", scopeId: "alice", principalId: "alice", attribution: {
    organization: { id: "org", source: "server_derived", trust: "authoritative" },
    project: { id: "project", source: "server_derived", trust: "authoritative" },
    service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
    known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
    session: { id: null, source: "server_derived", trust: "authoritative" },
    automation: { id: null, source: "server_derived", trust: "authoritative" },
  } } as const satisfies HandrailAssistantAuthorizationContext;
  const bundle = defaults.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => randomUUID() as never });
  const created = await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "docx-conversation" as never });
  const conversationId = created.descriptor.conversationId;
  const bytes = readFileSync(new URL("./fixtures/documents/invoice.docx", import.meta.url));
  const mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const make = () => createHandrailAssistant({ id: "docx", persistence: defaults, attachmentCleanup: false,
    authorize: request => {
      if (!request.headers.has("x-user")) throw new Error("unauthenticated");
      return { ...context, scopeId: request.headers.get("x-user")!, principalId: request.headers.get("x-user")! };
    }, provider: openaiResponses({ model: "test", request: async function* () {} }) });
  const assistant = await make();
  const upload = async (source: Uint8Array, key: string) => {
    const form = new FormData();
    form.set("conversationId", conversationId); form.set("idempotencyKey", key);
    form.set("file", new Blob([new Uint8Array(source)], { type: mediaType }), "invoice.docx");
    return assistant.handle(new Request("https://app.test/ai/attachments", { method: "POST", headers: { "x-user": "alice" }, body: form }));
  };
  try {
    const caps = await (await assistant.handle(new Request("https://app.test/ai/capabilities", { headers: { "x-user": "alice" } }))).json();
    expect(caps.value.attachments.acceptedMediaTypes).toContain(mediaType);
    const first = await upload(bytes, "docx-upload");
    expect(first.status).toBe(200);
    const stored = await first.json();
    expect(stored.value).toMatchObject({ media_type: mediaType, byte_size: bytes.length, filename: "invoice.docx" });
    expect(await (await upload(bytes, "docx-upload")).json()).toEqual(stored);
    expect((await upload(new Uint8Array([1, 2, 3]), "invalid-docx")).status).toBe(400);
    const reopened = await make();
    try {
      const url = `https://app.test/ai/attachments/content?conversationId=${conversationId}&attachmentId=${stored.value.attachment_id}`;
      const response = await reopened.handle(new Request(url, { headers: { "x-user": "alice" } }));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mediaType);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      expect((await reopened.handle(new Request(url, { headers: { "x-user": "bob" } }))).status).toBe(404);
    } finally { reopened.stopBackgroundWorkers(); }
  } finally { assistant.stopBackgroundWorkers(); }
});

it("authorizes saved reads by account, tenant and conversation, independently of uploads, without extending retention", async () => {
  const context = { tenantId: "tenant", scopeId: "alice", principalId: "alice", attribution: {
    organization: { id: "org", source: "server_derived", trust: "authoritative" },
    project: { id: "project", source: "server_derived", trust: "authoritative" },
    service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
    known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
    session: { id: null, source: "server_derived", trust: "authoritative" },
    automation: { id: null, source: "server_derived", trust: "authoritative" },
  } } as const satisfies HandrailAssistantAuthorizationContext;
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, {
    authorizeConversation: () => "allow", createConversationId: () => randomUUID() as never });
  const conversation = await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  const conversationId = conversation.descriptor.conversationId;
  const other = await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "other" as never });
  const reference = await bundle.attachments.stage({ ownerScopeId: context.scopeId, conversationId, idempotencyKey: "upload",
    fingerprint: "hash", mediaType: "application/pdf", filename: "report\r\n\".pdf", bytes: new Uint8Array([1, 2, 3]) });
  const original = await bundle.attachmentMetadata.getByContentRef(reference.content_ref);
  const actions: string[] = [];
  const assistant = await createHandrailAssistant({ id: "files", persistence, attachmentUpload: false,
    provider: openaiResponses({ model: "test-model", request: async function* () { yield { type: "response.completed" }; } }),
    authorize: (request, action) => {
      actions.push(action);
      if (!request.headers.has("x-user")) throw new Error("not signed in");
      return { ...context, tenantId: request.headers.get("x-tenant") ?? context.tenantId,
        scopeId: request.headers.get("x-user")!, principalId: request.headers.get("x-user")! };
    },
  });
  const url = `https://app.test/ai/attachments/content?conversationId=${conversationId}&attachmentId=${reference.attachment_id}`;
  const headers = { "x-user": "alice" };
  try {
    const caps = await assistant.handle(new Request("https://app.test/ai/capabilities", { headers }));
    expect(await caps.json()).toMatchObject({ value: { attachments: false, attachmentDownloads: { maximumBytes: 8 } } });
    const response = await assistant.handle(new Request(url, { headers }));
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report___.pdf"');
    expect(actions).toContain("attachment_download");
    expect(await bundle.attachmentMetadata.getByContentRef(reference.content_ref)).toEqual(original);
    expect((await assistant.handle(new Request(url))).status).toBe(403);
    expect((await assistant.handle(new Request(url, { headers: { "x-user": "bob" } }))).status).toBe(404);
    expect((await assistant.handle(new Request(url, { headers: { ...headers, "x-tenant": "another" } }))).status).toBe(404);
    expect((await assistant.handle(new Request(url.replace(conversationId, other.descriptor.conversationId), { headers }))).status).toBe(404);
    expect((await assistant.handle(new Request(url, { method: "POST", headers }))).status).toBe(405);
    // Archived history remains readable; only the actual retention/authorization determines access.
    await bundle.catalog.archive({ authorizationContext: context, conversationId, expectedVersion: conversation.descriptor.version,
      idempotencyKey: "archive" as never });
    expect((await assistant.handle(new Request(url, { headers }))).status).toBe(200);
    await bundle.attachmentMetadata.markConsumed(reference.content_ref, new Date().toISOString());
    expect((await assistant.handle(new Request(url, { headers }))).status).toBe(404);
    await database.query("UPDATE handrail_ai_documents SET payload=jsonb_set(payload,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) WHERE kind='attachment'");
    expect((await assistant.handle(new Request(url, { headers }))).status).toBe(410);
  } finally { assistant.stopUsageWorker(); }
});
