import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { postgresFromClient, PostgresOpenAIAudioUsageEvidenceStore, PostgresProviderOperationStore, type PostgresSqlClient,
  type PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { createAssistantTranscription, createTranscriptionUsageRecorder, runRetainedTranscription, runTranscriptionAttempt, validateTranscriptionAudio } from "../src/server/transcription.js";
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


it("shared usage recording preserves legacy identity and never replaces failed evidence with unknown usage", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  const identity = {
    occurred_at: "2026-09-01T00:00:00.000Z",
    usage_receipt_id: "legacy:transcription:operation", conversation_id: "legacy:principal",
    turn_id: "operation", logical_request_id: "operation", trace_id: "operation",
    attempt: { id: "operation:0", index: 0 }, continuation: { id: "operation:0", index: 0 },
    provider_id: "openai", model_id: "gpt-transcribe", source: "provider" as const,
    attribution: f.context.attribution,
  };
  const capture = vi.fn(async (receipt: NormalizedUsageReceipt) => { void receipt; });
  const evidenceCapture = vi.fn(async () => { throw new Error("evidence storage unavailable"); });
  const evidence = vi.fn(() => ({ capture: evidenceCapture }));
  const recording = createTranscriptionUsageRecorder({ identity, evidence, capture });
  await expect(recording.record({ kind: "openai_audio", usage: { type: "duration", seconds: 2.75 } }, "completed"))
    .rejects.toThrow("evidence storage unavailable");
  expect(recording.attempted).toBe(true);
  expect(evidence).toHaveBeenCalledWith("env");
  expect(evidenceCapture).toHaveBeenCalledWith(expect.objectContaining({
    context: expect.objectContaining(identity), usage: { type: "duration", seconds: 2.75 },
  }));
  expect(capture).not.toHaveBeenCalled();
  await expect(recording.record(null, "failed")).rejects.toThrow("already reported");
  expect(evidenceCapture).toHaveBeenCalledOnce();
});


it("retained adapters replay historical envelopes and preserve uncertain claims", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  const operations = new PostgresProviderOperationStore(f.bundle.persistence, f.context.tenantId, "legacy");
  const retained = { text: "  Original whitespace  " };
  await operations.run({ operationId: "completed", requestFingerprint: "original",
    execute: async () => retained, parseResult: value => value });
  await expect(operations.run({ operationId: "uncertain", requestFingerprint: "original",
    execute: async () => { throw new Error("lost provider reply"); }, parseResult: value => value })).rejects.toThrow();
  const usage = vi.fn(() => { throw new Error("must not construct a replay receipt"); });
  const transcribe = vi.fn(async () => "wrong replacement");
  const options = { operations, requestFingerprint: "original", usage, transcribe,
    result: { encode: (text: string) => ({ text }), decode: (value: unknown) => (value as { text?: unknown })?.text } };
  expect(await runRetainedTranscription({ ...options, operationId: "completed" })).toEqual(retained);
  await expect(runRetainedTranscription({ ...options, operationId: "completed", requestFingerprint: "changed" }))
    .rejects.toMatchObject({ name: "PostgresProviderOperationConflictError" });
  await expect(runRetainedTranscription({ ...options, operationId: "uncertain" }))
    .rejects.toMatchObject({ name: "PostgresProviderOperationUncertainError" });
  expect(usage).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});

it("a bounded retained wait rejects late success but captures incurred provider evidence", async () => {
  const f = await fixture(async () => ({ text: "unused" }));
  const operations = new PostgresProviderOperationStore(f.bundle.persistence, f.context.tenantId, "timeout");
  let release!: () => void, finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const settled = new Promise<void>(resolve => { finished = resolve; });
  const identity = { usage_receipt_id: "late-usage", conversation_id: f.conversationId,
    turn_id: "late", logical_request_id: "late", trace_id: "late",
    attempt: { id: "late:0", index: 0 }, continuation: { id: "late:0", index: 0 },
    provider_id: "openai", model_id: "gpt-transcribe", source: "provider" as const, attribution: f.context.attribution };
  const transcribe = vi.fn(async ({ recordUsage }: Parameters<Parameters<typeof runRetainedTranscription>[0]["transcribe"]>[0]) => {
    await held;
    await recordUsage({ kind: "openai_audio", usage: { type: "duration", seconds: 1.25 } }, "completed");
    finished();
    return "Too late";
  });
  const options = { operations, operationId: "late", requestFingerprint: "audio", timeoutMilliseconds: 30,
    usage: () => createTranscriptionUsageRecorder({ identity, evidence: () => f.evidence, capture: f.capture }), transcribe };
  await expect(runRetainedTranscription(options)).rejects.toMatchObject({ code: "deadline_exceeded" });
  expect(transcribe).toHaveBeenCalledOnce();
  await expect(runRetainedTranscription(options)).rejects.toMatchObject({ name: "PostgresProviderOperationUncertainError" });
  release();
  await settled;
  expect(f.capture).toHaveBeenCalledOnce();
  expect((await f.evidence.get("late-usage"))?.usage).toEqual({ type: "duration", seconds: 1.25 });
  await expect(runRetainedTranscription(options)).rejects.toMatchObject({ name: "PostgresProviderOperationUncertainError" });
  expect(transcribe).toHaveBeenCalledOnce();
});

it("legacy audio intake snapshots bytes without inventing capture duration", () => {
  const source = new Uint8Array(bytes);
  const audio = validateTranscriptionAudio({ bytes: source, mediaType: "Audio/WebM;codecs=opus", idempotencyKey: "legacy-1" });
  source.fill(0);
  expect(audio.bytes).toEqual(bytes);
  expect(audio.mediaType).toBe("audio/webm");
  expect(audio).not.toHaveProperty("durationSeconds");
  expect(() => validateTranscriptionAudio({ ...audio, bytes: source })).toThrow();
  expect(() => validateTranscriptionAudio({ ...audio, idempotencyKey: "../invalid" })).toThrow();
  expect(() => validateTranscriptionAudio({ ...audio, durationSeconds: 61 })).toThrow();
});

it("preserves a compatibility text limit without replacing usage, and does no work after a prior abort", async () => {
  const record = vi.fn(async () => {});
  const usage = { kind: "openai_audio" as const, usage: { type: "duration" as const, seconds: 1.25 } };
  await expect(runTranscriptionAttempt({ maximumTextLength: 4, usage: () => ({ record }),
    transcribe: async ({ recordUsage }) => { await recordUsage(usage, "completed"); return "longer"; },
  })).rejects.toMatchObject({ code: "internal_failure" });
  expect(record).toHaveBeenCalledExactlyOnceWith(usage, "completed");
  record.mockClear();
  await expect(runTranscriptionAttempt({ maximumTextLength: 4, usage: () => ({ record }),
    transcribe: async () => "longer",
  })).rejects.toMatchObject({ code: "internal_failure" });
  expect(record).toHaveBeenCalledExactlyOnceWith(null, "failed");
  const controller = new AbortController(); controller.abort(new Error("caller left"));
  const admit = vi.fn(); const transcribe = vi.fn(); const recorder = vi.fn(() => ({ record }));
  await expect(runTranscriptionAttempt({ signal: controller.signal, admit, transcribe, usage: recorder })).rejects.toThrow("caller left");
  expect(admit).not.toHaveBeenCalled(); expect(transcribe).not.toHaveBeenCalled(); expect(recorder).not.toHaveBeenCalled();
});

it("deletes retained dictated text, keeps usage evidence, and refuses a replay racing deletion", async () => {
  const request = vi.fn<OpenAITranscriptionRequestFunction>(async () => ({ text: "Disposable dictated text",
    usage: { type: "duration", seconds: 2 } }));
  const f = await fixture(request);
  expect((await createAssistantTranscription(f.options)(f.httpRequest(), f.context)).status).toBe(200);
  const found = await f.bundle.catalog.get({ authorizationContext: f.context, conversationId: f.conversationId });
  await f.bundle.catalog.permanentlyDelete({ authorizationContext: f.context, conversationId: f.conversationId,
    expectedVersion: found.descriptor.version, idempotencyKey: "delete-transcription" as never });
  const rows = await database.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM handrail_ai_documents
    WHERE tenant_id=$1 AND kind='provider_operation'`, [f.context.tenantId]);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]!.payload).toMatchObject({ status: "purged", conversationId: f.conversationId });
  expect(rows.rows[0]!.payload).not.toHaveProperty("result");
  expect(JSON.stringify(rows.rows)).not.toContain("Disposable dictated text");
  expect(await f.evidence.list()).toHaveLength(1);
  expect(f.capture).toHaveBeenCalledOnce();
  // Simulate an authorization lookup that finished before deletion committed.
  const catalogRead = vi.spyOn(f.bundle.catalog, "get").mockResolvedValue(found);
  try {
    const replay = await createAssistantTranscription(f.options)(f.httpRequest(), f.context);
    expect(replay.status).toBe(404);
    expect(await replay.json()).toEqual({ ok: false, error: { code: "forbidden", message: "This conversation is unavailable." } });
    expect(request).toHaveBeenCalledOnce();
  } finally { catalogRead.mockRestore(); }
});
