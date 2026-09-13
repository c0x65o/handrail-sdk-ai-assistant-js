import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { postgresFromClient, PostgresOpenAIAudioUsageEvidenceStore, type PostgresSqlClient,
  type PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { createAssistantTranscription } from "../src/server/transcription.js";
import { createHandrailAssistant, openaiResponses, openaiTranscription,
  type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import type { OpenAITranscriptionRequestFunction } from "../src/providers/openai-transcription.js";
import type { NormalizedUsageReceipt } from "../src/usage.js";

const database = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: (operation) => operation(client) }; return client;
}
const persistence = postgresFromClient({ query: adapt(database).query,
  transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
beforeAll(async () => { await persistence.persistence.migrate(); });
afterAll(async () => { await database.close(); });
const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
async function fixture(request: OpenAITranscriptionRequestFunction, timeoutMilliseconds?: number) {
  const scopeId = randomUUID();
  const context: HandrailAssistantAuthorizationContext = { tenantId: "speech-" + scopeId, scopeId, principalId: scopeId,
    attribution: { organization: { id: "org", source: "server_derived", trust: "authoritative" },
      project: { id: "project", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
      known_user: { id: scopeId, source: "server_derived", trust: "authoritative" },
      session: { id: "session", source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" } } };
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => randomUUID() as never,
    authorizeConversation: ({ authorizationContext }) => authorizationContext.principalId === scopeId ? "allow" : "deny" });
  const conversationId = (await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never })).descriptor.conversationId;
  const capture = vi.fn(async (receipt: NormalizedUsageReceipt) => { void receipt; });
  const diagnostics = vi.fn();
  const admit = vi.fn(async () => undefined);
  const provider = openaiTranscription({ model: "gpt-transcribe", request,
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }), speechHints: { keywords: ["Cents"], languages: ["en", "fr"] } });
  const options = { assistantId: "shared-assistant", provider, diagnostics, catalogFor: () => bundle.catalog,
    bundleFor: () => ({ ...bundle, usageReceiptSink: { capture }, usageAdmissions: { admit } } as unknown as typeof bundle) };
  const httpRequest = (body = bytes, signal?: AbortSignal) => new Request("https://app.test/ai/transcriptions", {
    method: "POST", body: new Uint8Array(body), ...(signal ? { signal } : {}), headers: { "content-type": "audio/webm",
      "idempotency-key": "recording-1", "x-handrail-conversation-id": conversationId, "x-handrail-audio-duration-seconds": "1" },
  });
  const evidence = new PostgresOpenAIAudioUsageEvidenceStore(bundle.persistence, context.tenantId, "env");
  return { context, bundle, conversationId, capture, admit, options, httpRequest, evidence };
}

it("replays completed transcription across server instances, validates identity, and reauthorizes every replay", async () => {
  const request = vi.fn<OpenAITranscriptionRequestFunction>(async () => ({ text: "Create a Cents group", usage: {
    type: "tokens", input_tokens: 6, output_tokens: 4, total_tokens: 10, input_token_details: { audio_tokens: 6 },
  } }));
  const f = await fixture(request);
  const first = await createAssistantTranscription(f.options)(f.httpRequest(), f.context);
  expect(first.status, String(f.options.diagnostics.mock.calls.at(-1)?.[0]?.cause)).toBe(200);
  expect(await first.json()).toEqual({ ok: true, value: { text: "Create a Cents group" } });
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), f.context)).status).toBe(200);
  expect(request).toHaveBeenCalledOnce(); expect(f.admit).toHaveBeenCalledOnce(); expect(f.capture).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-transcribe", keywords: ["Cents"], languages: ["en", "fr"],
    file: { bytes, media_type: "audio/webm", filename: "recording.webm" } }), expect.objectContaining({
    idempotency_key: expect.stringMatching(/^transcription-[a-f0-9]{64}$/u), signal: expect.any(AbortSignal),
  }));
  expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({ attribution: f.context.attribution,
    tokens: expect.objectContaining({ total_tokens: { status: "reported", value: 10 }, reasoning_tokens: { status: "unavailable" } }) }));
  const changed = new Uint8Array([...bytes, 4]);
  const conflict = await createAssistantTranscription(f.options)(f.httpRequest(changed), f.context);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: { code: "idempotency_conflict", retryable: false } });
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), { ...f.context, principalId: "other" })).status).toBe(403);
  const found = await f.bundle.catalog.get({ authorizationContext: f.context, conversationId: f.conversationId });
  await f.bundle.catalog.archive({ authorizationContext: f.context, conversationId: f.conversationId,
    expectedVersion: found.descriptor.version, idempotencyKey: "archive" as never });
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), f.context)).status).toBe(403);
  expect(request).toHaveBeenCalledOnce();
});

it("stores provider duration evidence without estimating tokens or using browser duration as billing", async () => {
  const f = await fixture(async () => ({ text: "Duration evidence", usage: { type: "duration", seconds: 2.5 } }));
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), f.context)).status).toBe(200);
  expect(f.capture.mock.calls[0]![0].tokens.total_tokens).toEqual({ status: "unavailable" });
  const evidence = await f.evidence.list();
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.usage).toEqual({ type: "duration", seconds: 2.5 });
  expect(evidence[0]!.context.attribution).toEqual(f.context.attribution);
});

it("retains uncertain dispatch after a receipt failure without replacing reported usage", async () => {
  const request = vi.fn(async () => ({ text: "Incurred usage", usage: { type: "duration", seconds: 2 } }));
  const f = await fixture(request);
  f.capture.mockRejectedValue(new Error("private storage error"));
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), f.context)).status).toBe(503);
  const retry = await createAssistantTranscription(f.options)(f.httpRequest(), f.context);
  expect(retry.status).toBe(409);
  expect(await retry.json()).toMatchObject({ error: { code: "outcome_unknown", retryable: false } });
  expect(request).toHaveBeenCalledOnce(); expect(f.capture).toHaveBeenCalledOnce();
  expect((await f.evidence.list())[0]!.usage).toEqual({ type: "duration", seconds: 2 });
});

it.each(["cancel", "timeout"])("bounds %s while preserving late provider usage and preventing redispatch", async (action) => {
  let finish!: (value: unknown) => void;
  const request = vi.fn<OpenAITranscriptionRequestFunction>(() => new Promise((resolve) => { finish = resolve; }));
  const f = await fixture(request, action === "timeout" ? 150 : undefined);
  const controller = new AbortController();
  const pending = createAssistantTranscription(f.options)(f.httpRequest(bytes, controller.signal), f.context);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  if (action === "cancel") controller.abort();
  expect((await pending).status).toBe(action === "cancel" ? 408 : 504);
  expect(request.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(f.capture).not.toHaveBeenCalled();
  finish({ text: "Late output", usage: { type: "duration", seconds: 3 } });
  await vi.waitFor(() => expect(f.capture).toHaveBeenCalledOnce());
  expect((await f.evidence.list())[0]!.usage).toEqual({ type: "duration", seconds: 3 });
  const retry = await createAssistantTranscription(f.options)(f.httpRequest(), f.context);
  expect(retry.status).toBe(409); expect(request).toHaveBeenCalledOnce();
});

it("owns multipart provider HTTP and negotiates configured speech on the high-level assistant", async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://provider.test/v1/audio/transcriptions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-key");
    expect(headers.get("idempotency-key")).toMatch(/^transcription-/u);
    expect(headers.get("content-type")).toBeNull();
    const body = init!.body as FormData;
    expect(body.get("model")).toBe("gpt-transcribe");
    expect(body.getAll("keywords[]")).toEqual(["Cents"]);
    expect(body.getAll("languages[]")).toEqual(["en", "fr"]);
    expect(body.get("language")).toBeNull();
    expect((body.get("file") as Blob).type).toBe("audio/webm");
    return Response.json({ text: "Provider HTTP", usage: { type: "duration", seconds: 2 } });
  });
  const f = await fixture(async () => ({ text: "unused" }));
  const provider = openaiResponses({ model: "test-model", request: async function* () { yield { type: "response.completed" }; },
    transcription: { apiKey: "fixture-key", baseUrl: "https://provider.test/v1", fetch: fetcher,
      speechHints: { keywords: ["Cents"], languages: ["en", "fr"] } } });
  for (const disabled of [false, true]) {
    const assistant = await createHandrailAssistant({ id: "speech-app", authorize: () => f.context, provider,
      persistence: { ...persistence, forScope: <T>() => f.options.bundleFor() as unknown as PostgresAssistantPersistenceBundle<T> },
      ...(disabled ? { transcription: false } : {}) });
    try {
      const capabilities = await (await assistant.handle(new Request("https://app.test/ai/capabilities"))).json();
      expect(capabilities.value.transcription).toEqual(disabled ? false : expect.objectContaining({ url: "transcriptions", maximumDurationSeconds: 60 }));
      expect((await assistant.handle(f.httpRequest())).status).toBe(disabled ? 501 : 200);
    } finally { assistant.stopUsageWorker(); }
  }
  expect(fetcher).toHaveBeenCalledOnce();
});
