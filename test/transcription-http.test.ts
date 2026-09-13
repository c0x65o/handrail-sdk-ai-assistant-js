import { describe, expect, it, vi } from "vitest";
import { createTranscriptionHttpClient, DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, resolveTranscriptionEndpoint } from "../src/transcription-http.js";
import { createTranscriptionHttpHandler } from "../src/server/transcription.js";
import { createApplicationGateway } from "../src/transports/application-gateway.js";
import { createApplicationGatewayExpressMiddleware } from "../src/server/application-gateway.js";
import { createHandrailAiClient } from "../src/client/bootstrap.js";
import { ConversationCatalogError } from "../src/conversation/catalog.js";
import { transcriptionSafeError } from "../src/transcription.js";

const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const format = { media_type: "audio/webm", container: "webm" } as const;
const capture = () => ({ source: new Blob([bytes], { type: format.media_type }), format, byteSize: bytes.length, durationSeconds: 1 });
const input = () => ({ capture: capture(), conversationId: "thread", idempotencyKey: "recording-1", signal: new AbortController().signal });
const headers = { "content-type": "audio/webm", "idempotency-key": "recording-1",
  "x-handrail-conversation-id": "thread", "x-handrail-audio-duration-seconds": "1" };
const transport = { capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
  attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } } as const,
  async startTurn() { throw new Error("unused"); }, async resumeTurn() { throw new Error("unused"); } };

describe("shared authenticated transcription HTTP", () => {
  it("keeps negotiated speech endpoints on the application origin and supports relative bases", () => {
    expect(resolveTranscriptionEndpoint("/api/ai", DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY)).toBe("/api/ai/transcriptions");
    expect(resolveTranscriptionEndpoint("https://app.test/ai", { ...DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, url: "/speech" })).toBe("https://app.test/speech");
    for (const url of ["https://other.test/speech", "//other.test/speech", "https://user:secret@app.test/speech"]) {
      expect(() => resolveTranscriptionEndpoint("https://app.test/ai", { ...DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, url })).toThrow("application origin");
    }
  });

  it("does not offer a retry for an unknown durable dispatch outcome", async () => {
    const transcribe = createTranscriptionHttpClient({ endpoint: "https://app.test/ai/transcriptions",
      fetch: async () => Response.json({ ok: false, error: transcriptionSafeError("outcome_unknown") }, { status: 409 }) });
    await expect(transcribe(input())).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("cancels stalled audio intake at the configured deadline", async () => {
    const cancel = vi.fn(), transcribe = vi.fn();
    const handler = createTranscriptionHttpHandler({ timeoutMilliseconds: 10, authorizeConversation: async () => undefined, transcribe });
    const body = new ReadableStream({ cancel });
    const request = new Request("https://app.test/ai/transcriptions", { method: "POST", headers, body, duplex: "half" } as RequestInit);
    expect((await handler(request, {})).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce(); expect(transcribe).not.toHaveBeenCalled();
  });
  it("negotiates the microphone endpoint and sends raw audio through the app's protected request", async () => {
    const transcribe = vi.fn(async () => "  a dictated message  ");
    const authorizeConversation = vi.fn(async () => undefined);
    const gateway = createApplicationGateway({ transport,
      authorize: async (request) => {
        if (request.headers.get("x-session") !== "session-test") throw new Response(null, { status: 401 });
        return { principalId: "alice" };
      }, checkpointForEvent: () => ({ lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null }),
      capabilities: { transcription: { ...DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, url: "transcriptions" } },
      handlers: { transcription: createTranscriptionHttpHandler({ transcribe, authorizeConversation }) },
    });
    const client = await createHandrailAiClient({ baseUrl: "https://app.test/ai",
      fetch: async (url, init) => gateway.handle(new Request(String(url), init)),
      protectedRequest: (request) => {
        const protectedHeaders = new Headers(request.headers); protectedHeaders.set("x-session", "session-test");
        return { ...request, headers: protectedHeaders };
      },
    });
    try {
      expect(client.transcription).not.toBeNull();
      expect(await client.transcription!(input())).toBe("a dictated message");
      expect(authorizeConversation).toHaveBeenCalledWith({ principalId: "alice" }, "thread");
      expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ bytes, mediaType: "audio/webm", conversationId: "thread",
        idempotencyKey: "recording-1" }), { principalId: "alice" });
      expect((await gateway.handle(new Request("https://app.test/ai/transcriptions", { method: "POST", headers, body: bytes }))).status).toBe(401);
      expect(transcribe).toHaveBeenCalledOnce();
    } finally { await client.dispose(); }
  });

  it("authorizes the conversation before reading audio or transcribing", async () => {
    const transcribe = vi.fn();
    const handler = createTranscriptionHttpHandler({ transcribe,
      authorizeConversation: async () => { throw new ConversationCatalogError("forbidden", "get"); } });
    const request = new Request("https://app.test/ai/transcriptions", { method: "POST", headers, body: bytes });
    expect((await handler(request, { principalId: "other" })).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("enforces byte bounds while streaming and rejects mismatched container bytes", async () => {
    const transcribe = vi.fn();
    const handler = createTranscriptionHttpHandler({ transcribe, authorizeConversation: async () => undefined,
      capability: { ...DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, maximumBytes: 8 } });
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.enqueue(bytes); }, cancel });
    const tooLarge = new Request("https://app.test/ai/transcriptions", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    expect((await handler(tooLarge, {})).status).toBe(413);
    expect(cancel).toHaveBeenCalled();
    const invalid = new Request("https://app.test/ai/transcriptions", { method: "POST", headers, body: "not webm" });
    expect((await handler(invalid, {})).status).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("supports existing multipart routes without requiring app-owned request handling", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.body).toBeInstanceOf(FormData);
      const body = init!.body as FormData;
      expect(body.get("idempotencyKey")).toBe("recording-1");
      expect((body.get("file") as Blob).size).toBe(bytes.length);
      expect(new Headers(init?.headers).get("content-type")).toBeNull();
      return Response.json({ data: { text: "legacy endpoint" } });
    });
    const transcribe = createTranscriptionHttpClient({ endpoint: "https://app.test/legacy", encoding: "multipart", fetch: fetcher });
    expect(await transcribe(input())).toBe("legacy endpoint");
  });

  it("retains cancellation when authentication supplies another signal", async () => {
    const abort = new AbortController();
    const transcribe = createTranscriptionHttpClient({ endpoint: "https://app.test/ai/transcriptions",
      protectedRequest: (request) => ({ ...request, signal: new AbortController().signal }),
      fetch: async (_url, init) => { abort.abort(); expect(init?.signal?.aborted).toBe(true); return Response.json({ data: { text: "late" } }); },
    });
    await expect(transcribe({ ...input(), signal: abort.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  it.each(["parsed", "stream"])("preserves raw audio through Express %s bodies", async (mode) => {
    const handle = vi.fn(async (request: Request) => {
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
      return Response.json({ ok: true });
    });
    const middleware = createApplicationGatewayExpressMiddleware({ handle }, { origin: "https://app.test" });
    const next = vi.fn();
    const response = { status: vi.fn().mockReturnThis(), setHeader: vi.fn(), write: vi.fn(() => true), end: vi.fn() };
    await middleware({ method: "POST", url: "/transcriptions", headers,
      ...(mode === "parsed" ? { body: bytes } : { async *[Symbol.asyncIterator]() { yield bytes; } }),
    }, response, next);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
