import { describe, expect, it, vi } from "vitest";

import {
  TRANSCRIPTION_CONTRACT_VERSION,
  normalizeTranscriptionError,
  parseTranscriptionRequest,
  transcriptionSafeError,
  type TranscriptionAudioFormatDescriptor,
  type TranscriptionRequest,
} from "../src/index.js";
import {
  OPENAI_TRANSCRIPTION_AUDIO_FORMATS,
  OPENAI_TRANSCRIPTION_LIMITS,
  createOpenAITranscriptionCapability,
  type OpenAITranscriptionAudioResolver,
  type OpenAITranscriptionRequest,
  type OpenAITranscriptionRequestFunction,
  type OpenAITranscriptionRequestOptions,
  type OpenAITranscriptionResolvedAudio,
} from "../src/providers/openai.js";

const bytes = new Uint8Array([1, 2, 3, 4]);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function transcriptionRequest(
  overrides: Record<string, unknown> = {},
): TranscriptionRequest {
  return parseTranscriptionRequest({
    request_id: "request-1",
    inputs: [{
      audio_id: "audio-1",
      content_ref: "content-1",
      format: { media_type: "audio/webm", container: "webm" },
      byte_size: bytes.byteLength,
      duration_seconds: 2.5,
    }],
    language: "en-US",
    idempotency_key: "transcribe:conversation-1:turn-1",
    signal: new AbortController().signal,
    ...overrides,
  });
}

function resolvedAudio(
  overrides: Partial<OpenAITranscriptionResolvedAudio> = {},
): OpenAITranscriptionResolvedAudio {
  return {
    bytes,
    media_type: "audio/webm",
    byte_size: bytes.byteLength,
    duration_seconds: 2.5,
    ...overrides,
  };
}

function providerResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: "A transcript.",
    language: "en-US",
    duration: 2.5,
    ...overrides,
  };
}

function capability(
  overrides: {
    resolve_audio?: OpenAITranscriptionAudioResolver;
    request?: OpenAITranscriptionRequestFunction;
  } = {},
) {
  return createOpenAITranscriptionCapability({
    model: "gpt-4o-mini-transcribe",
    resolve_audio: overrides.resolve_audio ?? (async () => resolvedAudio()),
    request: overrides.request ?? (async () => providerResponse()),
  });
}

async function safeFailure(promise: Promise<unknown>, signal?: AbortSignal) {
  try {
    await promise;
    throw new Error("Expected transcription operation to reject");
  } catch (error) {
    return normalizeTranscriptionError(error, signal);
  }
}

describe("OpenAI trusted-server transcription capability", () => {
  it("forwards project hints without adding them to results or usage observations", async () => {
    const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>(async () => ({ text: "Only the spoken words.", usage: { type: "duration", seconds: 2.5 } }));
    const captureUsage = vi.fn(async () => {});
    const keywords = ["Private project term"];
    const adapter = createOpenAITranscriptionCapability({
      model: "gpt-transcribe", speech_hints: { keywords, context: "Private project context", languages: ["en", "es"] },
      resolve_audio: async () => resolvedAudio(), request: requestProvider, capture_usage: captureUsage,
    });
    keywords.push("Changed after creation");
    const requestWithoutLanguage = { ...transcriptionRequest() };
    delete requestWithoutLanguage.language;
    const result = await adapter.transcribe(requestWithoutLanguage);
    expect(requestProvider).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-transcribe", keywords: ["Private project term"], prompt: "Private project context", languages: ["en", "es"],
    }), expect.anything());
    expect(requestProvider.mock.calls[0]![0]).not.toHaveProperty("language");
    expect(JSON.stringify(result)).not.toContain("Private project");
    expect(JSON.stringify(captureUsage.mock.calls)).not.toContain("Private project");
    expect(captureUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: { type: "duration", seconds: 2.5 } }));
  });

  it("rejects malformed project hints before resolving audio or invoking the provider", () => {
    const resolveAudio = vi.fn(async () => resolvedAudio());
    const requestProvider = vi.fn(async () => providerResponse());
    expect(() => createOpenAITranscriptionCapability({
      model: "gpt-transcribe", speech_hints: { keywords: ["Invalid\nkeyword"] },
      resolve_audio: resolveAudio, request: requestProvider,
    })).toThrow(TypeError);
    expect(resolveAudio).not.toHaveBeenCalled();
    expect(requestProvider).not.toHaveBeenCalled();
  });

  it("keeps vocabulary isolated between project capabilities", async () => {
    const mills = vi.fn(async () => providerResponse());
    const spartan = vi.fn(async () => providerResponse());
    await createOpenAITranscriptionCapability({ model: "gpt-transcribe", speech_hints: { keywords: ["Mills Family Office"] },
      resolve_audio: async () => resolvedAudio(), request: mills }).transcribe(transcriptionRequest());
    await createOpenAITranscriptionCapability({ model: "gpt-transcribe", speech_hints: { keywords: ["Aegis"] },
      resolve_audio: async () => resolvedAudio(), request: spartan }).transcribe(transcriptionRequest());
    expect(mills).toHaveBeenCalledWith(expect.objectContaining({ keywords: ["Mills Family Office"], languages: ["en"] }), expect.anything());
    expect(spartan).toHaveBeenCalledWith(expect.objectContaining({ keywords: ["Aegis"], languages: ["en"] }), expect.anything());
  });

  it("advertises only the exact OpenAI formats and conservative limits", () => {
    const adapter = capability();
    expect(adapter).toMatchObject({
      supported: true,
      version: TRANSCRIPTION_CONTRACT_VERSION,
      formats: OPENAI_TRANSCRIPTION_AUDIO_FORMATS,
      limits: {
        max_inputs: 1,
        max_bytes_per_input: OPENAI_TRANSCRIPTION_LIMITS.maxBytesPerInput,
        max_duration_seconds: OPENAI_TRANSCRIPTION_LIMITS.maxDurationSeconds,
      },
    });
    expect(OPENAI_TRANSCRIPTION_AUDIO_FORMATS).toEqual([
      { media_type: "audio/flac", container: "flac" },
      { media_type: "audio/mpeg", container: "mp3" },
      { media_type: "audio/mp4", container: "m4a" },
      { media_type: "audio/ogg", container: "ogg" },
      { media_type: "audio/wav", container: "wav" },
      { media_type: "audio/webm", container: "webm" },
    ]);
  });

  it.each(OPENAI_TRANSCRIPTION_AUDIO_FORMATS)(
    "resolves and projects advertised $media_type/$container audio",
    async (format: TranscriptionAudioFormatDescriptor) => {
      const controller = new AbortController();
      const resolveAudio = vi.fn<OpenAITranscriptionAudioResolver>(async () => ({
        bytes,
        media_type: format.media_type,
        byte_size: bytes.byteLength,
        duration_seconds: 2.5,
      }));
      let projected: OpenAITranscriptionRequest | undefined;
      let options: OpenAITranscriptionRequestOptions | undefined;
      const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>(async (
        request,
        requestOptions,
      ) => {
        projected = request;
        options = requestOptions;
        return providerResponse();
      });
      const request = transcriptionRequest({
        inputs: [{
          audio_id: "audio-1",
          content_ref: "content-1",
          format,
          byte_size: bytes.byteLength,
          duration_seconds: 2.5,
        }],
        signal: controller.signal,
      });

      await capability({ resolve_audio: resolveAudio, request: requestProvider })
        .transcribe(request);

      expect(resolveAudio).toHaveBeenCalledWith({
        audio: request.inputs[0],
        signal: controller.signal,
      });
      expect(projected).toEqual({
        model: "gpt-4o-mini-transcribe",
        file: {
          bytes,
          media_type: format.media_type,
          filename: `audio.${format.container}`,
        },
        response_format: "json",
        language: "en",
      });
      expect(Object.keys(projected ?? {})).toEqual([
        "model",
        "file",
        "response_format",
        "language",
      ]);
      expect(options?.signal).toBe(controller.signal);
      expect(options?.idempotency_key).toMatch(
        /^handrail-transcription-[a-f0-9]{64}$/u,
      );
    },
  );

  it.each(["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe", "whisper-1"])(
    "accepts the text-only JSON response contract for %s", async (model) => {
      const adapter = createOpenAITranscriptionCapability({
        model,
        resolve_audio: async () => resolvedAudio(),
        request: async (request) => {
          expect(request.response_format).toBe("json");
          return { text: "A valid transcript." };
        },
      });
      const result = await adapter.transcribe(transcriptionRequest());
      expect(result.outputs[0]).toEqual({
        audio_id: "audio-1",
        text: "A valid transcript.",
        metadata: { language: null, duration_seconds: 2.5 },
      });
    },
  );

  it("does not substitute usage duration or requested language for media metadata", async () => {
    const result = await capability({ request: async () => ({
      text: "Transcript with billing metadata.",
      usage: { type: "duration", seconds: 3 },
    }) }).transcribe(transcriptionRequest());
    expect(result.outputs[0]?.metadata).toEqual({ language: null, duration_seconds: 2.5 });
    expect(JSON.stringify(result)).not.toContain("usage");
  });

  it.each([
    [[{ code: "es" }], "es"],
    [[{ code: "es" }, { code: "en" }], null],
    [[], null],
  ])("projects single detected languages without inventing a multilingual label", async (languages, language) => {
    const result = await capability({ request: async () => ({ text: "Transcript", languages }) })
      .transcribe(transcriptionRequest());
    expect(result.outputs[0]?.metadata.language).toBe(language);
  });

  it("leaves language detection to the provider when the hint has no two-letter primary subtag", async () => {
    const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>(async () => ({ text: "Transcript" }));
    await capability({ request: requestProvider }).transcribe(transcriptionRequest({ language: "fil" }));
    expect(requestProvider.mock.calls[0]?.[0]).not.toHaveProperty("language");
  });

  it("normalizes only bounded transcript text, language, and duration", async () => {
    const result = await capability({
      request: async () => ({
        text: "Cafe\u0301\r\nnext",
        language: " en-us ",
        duration: 2.25,
        task: "transcribe",
        raw_response: { private: true },
      }),
    }).transcribe(transcriptionRequest());

    expect(result).toEqual({
      status: "completed",
      request_id: "request-1",
      outputs: [{
        audio_id: "audio-1",
        text: "Café\nnext",
        metadata: { language: "en-US", duration_seconds: 2.25 },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("raw_response");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outputs[0])).toBe(true);
  });

  it.each([
    ["MIME", { media_type: "audio/wav" }],
    ["declared byte size", { byte_size: bytes.byteLength - 1 }],
    ["actual byte size", { bytes: new Uint8Array([1, 2, 3]) }],
    ["duration", { duration_seconds: 2.25 }],
  ] as const)("rejects authoritative %s mismatches before requesting", async (
    _label,
    resolvedOverrides,
  ) => {
    const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>();
    const adapter = capability({
      resolve_audio: async () => resolvedAudio(resolvedOverrides),
      request: requestProvider,
    });

    expect(await safeFailure(adapter.transcribe(transcriptionRequest()))).toEqual(
      transcriptionSafeError("content_unavailable"),
    );
    expect(requestProvider).not.toHaveBeenCalled();
  });

  it("rejects authoritative oversize content before requesting", async () => {
    const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>();
    const adapter = capability({
      resolve_audio: async () => resolvedAudio({
        byte_size: OPENAI_TRANSCRIPTION_LIMITS.maxBytesPerInput + 1,
      }),
      request: requestProvider,
    });

    expect(await safeFailure(adapter.transcribe(transcriptionRequest()))).toEqual(
      transcriptionSafeError("limit_exceeded"),
    );
    expect(requestProvider).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { text: "ok", language: "not a language", duration: 2.5 },
    { text: "ok", language: "en", duration: Number.NaN },
    { text: "ok", languages: "en" },
    { text: "ok", languages: [{}] },
    { text: "ok", languages: [{ code: "not a language" }] },
    { text: "x".repeat(1_000_001), language: "en", duration: 2.5 },
  ])("maps malformed provider output to a fixed internal failure", async (response) => {
    const adapter = capability({ request: async () => response });
    expect(await safeFailure(adapter.transcribe(transcriptionRequest()))).toEqual(
      transcriptionSafeError("internal_failure"),
    );
  });

  it.each([
    [408, "deadline_exceeded", true],
    [409, "idempotency_conflict", false],
    [400, "invalid_request", false],
    [413, "limit_exceeded", false],
    [415, "unsupported_audio", false],
    [429, "rate_limited", true],
    [503, "service_unavailable", true],
  ] as const)("maps provider status %i to safe %s", async (
    status,
    code,
    retryable,
  ) => {
    const adapter = capability({ request: async () => {
      throw { status, raw_response: { transcript: "private" } };
    } });
    expect(await safeFailure(adapter.transcribe(transcriptionRequest()))).toEqual({
      ...transcriptionSafeError(code),
      retryable,
    });
  });

  it("maps resolver failures without exposing their raw values", async () => {
    const rawError = { message: "storage token and private audio", audio: bytes };
    const adapter = capability({ resolve_audio: async () => {
      throw rawError;
    } });
    const safe = await safeFailure(adapter.transcribe(transcriptionRequest()));
    expect(safe).toEqual(transcriptionSafeError("content_unavailable"));
    expect(JSON.stringify(safe)).not.toContain(rawError.message);
  });

  it("derives the same provider idempotency identity for repeated keys", async () => {
    const identities: string[] = [];
    const adapter = capability({ request: async (_request, options) => {
      identities.push(options.idempotency_key);
      return providerResponse();
    } });

    await adapter.transcribe(transcriptionRequest({ request_id: "request-1" }));
    await adapter.transcribe(transcriptionRequest({ request_id: "request-2" }));
    expect(identities).toHaveLength(2);
    expect(identities[0]).toBe(identities[1]);
    expect(identities[0]).not.toContain("transcribe:conversation-1:turn-1");
  });

  it("cancels before resolution without invoking either host boundary", async () => {
    const controller = new AbortController();
    controller.abort({ transcript: "private" });
    const resolveAudio = vi.fn<OpenAITranscriptionAudioResolver>();
    const requestProvider = vi.fn<OpenAITranscriptionRequestFunction>();
    const request = transcriptionRequest({ signal: controller.signal });

    expect(await safeFailure(
      capability({ resolve_audio: resolveAudio, request: requestProvider })
        .transcribe(request),
      controller.signal,
    )).toEqual(transcriptionSafeError("cancelled"));
    expect(resolveAudio).not.toHaveBeenCalled();
    expect(requestProvider).not.toHaveBeenCalled();
  });

  it("forwards and observes the exact signal during the provider request", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const requestStarted = deferred<void>();
    const providerPending = deferred<unknown>();
    const adapter = capability({ request: async (_request, options) => {
      receivedSignal = options.signal;
      requestStarted.resolve();
      return providerPending.promise;
    } });
    const request = transcriptionRequest({ signal: controller.signal });
    const pending = adapter.transcribe(request);
    await requestStarted.promise;
    controller.abort();

    expect(await safeFailure(pending, controller.signal)).toEqual(
      transcriptionSafeError("cancelled"),
    );
    expect(receivedSignal).toBe(controller.signal);
  });

  it("rejects credential-shaped or invalid factory configuration", () => {
    expect(() => createOpenAITranscriptionCapability({
      model: "sk-privatecredential",
      resolve_audio: async () => resolvedAudio(),
      request: async () => providerResponse(),
    })).toThrow(/model identifier/);
    expect(() => createOpenAITranscriptionCapability({
      model: "gpt-4o-mini-transcribe",
      resolve_audio: null as never,
      request: async () => providerResponse(),
    })).toThrow(/resolver/);
  });
});

describe("OpenAI transcription usage capture", () => {
  it("waits for capture before validating output and excludes transcript/audio from the observation", async () => {
    const stored = deferred<void>();
    const capture = vi.fn(() => stored.promise);
    const adapter = createOpenAITranscriptionCapability({ model: "gpt-4o-mini-transcribe",
      resolve_audio: async () => resolvedAudio(), capture_usage: capture,
      request: async () => ({ text: null, usage: { type: "duration", seconds: 1.25 } }),
    });
    let finished = false;
    const result = adapter.transcribe(transcriptionRequest()).then(() => { finished = true; },
      (error: unknown) => { finished = true; return error; });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(capture.mock.calls[0]).toEqual([{
      request_id: "request-1", audio_id: "audio-1", model_id: "gpt-4o-mini-transcribe",
      provider_idempotency_key: expect.any(String), usage: { type: "duration", seconds: 1.25 },
    }]);
    stored.resolve();
    expect(normalizeTranscriptionError(await result).code).toBe("internal_failure");
  });

  it("captures a late provider response even after the caller cancels", async () => {
    const controller = new AbortController();
    const response = deferred<unknown>();
    const capture = vi.fn(async () => undefined);
    const provider = vi.fn(() => response.promise);
    const adapter = createOpenAITranscriptionCapability({ model: "gpt-4o-mini-transcribe",
      resolve_audio: async () => resolvedAudio(), request: provider, capture_usage: capture });
    const result = safeFailure(adapter.transcribe(transcriptionRequest({ signal: controller.signal })), controller.signal);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
    controller.abort();
    expect((await result).code).toBe("cancelled");
    response.resolve(providerResponse({ usage: { type: "tokens", input_tokens: 17,
      output_tokens: 9, total_tokens: 26, input_token_details: { audio_tokens: 17, text_tokens: 0 } } }));
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(capture.mock.calls[0]).toMatchObject([{ usage: { type: "tokens", total_tokens: 26 } }]);
  });

  it("fails without another provider call when durable capture rejects", async () => {
    const provider = vi.fn(async () => providerResponse());
    const capture = vi.fn(async () => { throw new Error("private storage failure"); });
    const adapter = createOpenAITranscriptionCapability({ model: "gpt-4o-mini-transcribe",
      resolve_audio: async () => resolvedAudio(), request: provider, capture_usage: capture });
    const failure = await safeFailure(adapter.transcribe(transcriptionRequest()));
    expect(failure.code).toBe("internal_failure");
    expect(JSON.stringify(failure)).not.toContain("private storage failure");
    expect(provider).toHaveBeenCalledOnce();
    expect(capture.mock.calls[0]).toMatchObject([{ usage: { type: "unavailable" } }]);
  });
});
