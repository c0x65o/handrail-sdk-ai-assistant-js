import { TRANSCRIPTION_AUDIO_FORMATS, TRANSCRIPTION_LIMITS, TranscriptionOperationError, parseTranscriptionSafeError,
  type TranscriptionAudioFormatDescriptor } from "./transcription.js";

export interface TranscriptionHttpCapability {
  readonly formats: readonly TranscriptionAudioFormatDescriptor[];
  readonly maximumBytes: number;
  readonly maximumDurationSeconds: number;
  readonly url?: string;
}

/** Bounded microphone defaults, shared by negotiation, capture and server intake. */
export const DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY: TranscriptionHttpCapability = Object.freeze({
  formats: Object.freeze([
    { media_type: "audio/webm", container: "webm" } as const,
    { media_type: "audio/mp4", container: "m4a" } as const,
    { media_type: "audio/wav", container: "wav" } as const,
  ]),
  maximumBytes: TRANSCRIPTION_LIMITS.audioBytesMax,
  maximumDurationSeconds: 60,
});

export function validateTranscriptionHttpCapability(value: TranscriptionHttpCapability): TranscriptionHttpCapability {
  if (!Array.isArray(value.formats) || value.formats.length === 0 || !value.formats.every((format) =>
    TRANSCRIPTION_AUDIO_FORMATS.some((allowed) => allowed.media_type === format.media_type && allowed.container === format.container))
    || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1 || value.maximumBytes > TRANSCRIPTION_LIMITS.audioBytesMax
    || !Number.isFinite(value.maximumDurationSeconds) || value.maximumDurationSeconds <= 0
    || value.maximumDurationSeconds > TRANSCRIPTION_LIMITS.audioDurationSecondsMax) {
    throw new TypeError("The transcription capability has invalid formats or limits.");
  }
  return Object.freeze({ ...value, formats: Object.freeze(value.formats.map((format) => Object.freeze({ ...format }))) });
}

export interface TranscriptionHttpInput {
  readonly capture: {
    readonly source: Blob;
    readonly format: TranscriptionAudioFormatDescriptor;
    readonly byteSize: number;
    readonly durationSeconds: number;
  };
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface TranscriptionHttpClientOptions {
  readonly endpoint: string;
  readonly capability?: TranscriptionHttpCapability;
  readonly fetch?: typeof globalThis.fetch;
  readonly protectedRequest?: (input: RequestInit & { readonly url: string }) => RequestInit | Promise<RequestInit>;
  /** Existing multipart endpoints are a migration option. SDK endpoints use bounded raw audio. */
  readonly encoding?: "raw" | "multipart";
}

/** Negotiated endpoints stay on the authenticated application origin, including relative base URLs. */
export function resolveTranscriptionEndpoint(baseUrl: string, capability: TranscriptionHttpCapability): string {
  const relativeBase = baseUrl.startsWith("/") && !baseUrl.startsWith("//");
  const base = new URL(baseUrl.replace(/\/+$/u, "") + "/", relativeBase ? "https://handrail-relative.invalid" : undefined);
  const endpoint = new URL(capability.url ?? "transcriptions", base);
  if (endpoint.origin !== base.origin || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError("The negotiated transcription endpoint must share the application origin.");
  }
  return relativeBase ? endpoint.pathname + endpoint.search : endpoint.href;
}

/** App authentication is injected once; recording, cancellation and request identity stay shared. */
export function createTranscriptionHttpClient(options: TranscriptionHttpClientOptions) {
  const capability = validateTranscriptionHttpCapability(options.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY);
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (input: TranscriptionHttpInput): Promise<string> => {
    const { capture, signal } = input;
    if (signal.aborted) throw new TranscriptionOperationError("cancelled");
    if (!input.conversationId || input.conversationId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey)
      || capture.source.size !== capture.byteSize || capture.byteSize <= 0 || capture.byteSize > capability.maximumBytes
      || !Number.isFinite(capture.durationSeconds) || capture.durationSeconds <= 0 || capture.durationSeconds > capability.maximumDurationSeconds
      || !capability.formats.some((format) => format.media_type === capture.format.media_type && format.container === capture.format.container)
      || capture.source.type.split(";", 1)[0]?.trim().toLowerCase() !== capture.format.media_type) {
      throw new TranscriptionOperationError("invalid_request");
    }
    const headers = new Headers({ accept: "application/json" });
    let body: BodyInit;
    if (options.encoding === "multipart") {
      const form = new FormData();
      form.append("file", capture.source, "recording." + capture.format.container);
      form.append("idempotencyKey", input.idempotencyKey);
      body = form;
    } else {
      headers.set("content-type", capture.format.media_type);
      headers.set("idempotency-key", input.idempotencyKey);
      headers.set("x-handrail-conversation-id", input.conversationId);
      headers.set("x-handrail-audio-duration-seconds", String(capture.durationSeconds));
      body = capture.source;
    }
    try {
      const initial: RequestInit = { method: "POST", credentials: "same-origin", headers, body, signal };
      const protectedInit = await options.protectedRequest?.({ url: options.endpoint, ...initial }) ?? initial;
      if (signal.aborted) throw new TranscriptionOperationError("cancelled");
      const response = await fetcher(options.endpoint, { ...protectedInit,
        signal: protectedInit.signal && protectedInit.signal !== signal ? AbortSignal.any([signal, protectedInit.signal]) : signal });
      if (!response.ok) {
        // Only accept the SDK's validated safe error vocabulary, never provider text.
        let errorCode;
        try {
          const body = await response.json() as { ok?: boolean; error?: unknown };
          if (body.ok === false) errorCode = parseTranscriptionSafeError(body.error).code;
        } catch { /* Legacy endpoints are mapped by their HTTP status below. */ }
        if (errorCode) throw new TranscriptionOperationError(errorCode);
        throw new TranscriptionOperationError(response.status === 429 ? "rate_limited"
          : response.status === 408 || response.status === 504 ? "deadline_exceeded"
            : response.status === 409 ? "idempotency_conflict"
              : response.status === 413 ? "limit_exceeded"
                : response.status === 415 ? "unsupported_audio"
                  : response.status >= 500 ? "service_unavailable" : "invalid_request");
      }
      const result = await response.json() as { ok?: boolean; value?: { text?: unknown }; data?: { text?: unknown } };
      const text = result?.ok === true ? result.value?.text : result?.data?.text;
      if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new TranscriptionOperationError("internal_failure");
      if (signal.aborted) throw new TranscriptionOperationError("cancelled");
      return text.trim();
    } catch (error) {
      if (signal.aborted) throw new TranscriptionOperationError("cancelled");
      if (error instanceof TranscriptionOperationError) throw error;
      throw new TranscriptionOperationError("service_unavailable");
    }
  };
}
