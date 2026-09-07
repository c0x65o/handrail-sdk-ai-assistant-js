import { parseOpenAIReportedAudioUsage, type OpenAIReportedAudioUsage } from "./openai-audio-usage.js";
import { openAITranscriptionHintFields, parseTranscriptionSpeechHints,
  type TranscriptionSpeechHints } from "../transcription-speech-hints.js";
export { openAITranscriptionHintFields, parseTranscriptionSpeechHints, transcriptionSpeechHintsFromEnvironment,
  TRANSCRIPTION_SPEECH_HINT_LIMITS, type TranscriptionSpeechHints, type OpenAITranscriptionHintFields } from "../transcription-speech-hints.js";
export { parseOpenAIReportedAudioUsage, type OpenAIReportedAudioUsage, type OpenAIAudioTokenDetails } from "./openai-audio-usage.js";
import {
  TRANSCRIPTION_AUDIO_FORMATS,
  TRANSCRIPTION_CONTRACT_VERSION,
  TRANSCRIPTION_LIMITS,
  TranscriptionOperationError,
  parseTranscriptionRequest,
  parseTranscriptionResult,
  type SupportedTranscriptionCapability,
  type TranscriptionAudioMimeType,
  type TranscriptionAudioResolutionRequest,
  type TranscriptionIdempotencyKey,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "../transcription.js";

export const OPENAI_TRANSCRIPTION_AUDIO_FORMATS = Object.freeze([
  TRANSCRIPTION_AUDIO_FORMATS[0],
  TRANSCRIPTION_AUDIO_FORMATS[1],
  TRANSCRIPTION_AUDIO_FORMATS[2],
  TRANSCRIPTION_AUDIO_FORMATS[3],
  TRANSCRIPTION_AUDIO_FORMATS[4],
  TRANSCRIPTION_AUDIO_FORMATS[5],
] as const);

/** Conservative bounds within the provider-neutral contract ceilings. */
export const OPENAI_TRANSCRIPTION_LIMITS = Object.freeze({
  maxInputs: 1,
  maxBytesPerInput: 25 * 1024 * 1024,
  maxDurationSeconds: 60 * 60,
  modelLength: 128,
} as const);

/** Ephemeral host-owned audio. The adapter never includes this in its result. */
export interface OpenAITranscriptionResolvedAudio {
  readonly bytes: Uint8Array;
  readonly media_type: TranscriptionAudioMimeType;
  readonly byte_size: number;
  readonly duration_seconds: number;
}

export type OpenAITranscriptionAudioResolver = (
  request: TranscriptionAudioResolutionRequest,
) =>
  | OpenAITranscriptionResolvedAudio
  | Promise<OpenAITranscriptionResolvedAudio>;

export interface OpenAITranscriptionFile {
  readonly bytes: Uint8Array;
  readonly media_type: TranscriptionAudioMimeType;
  readonly filename: string;
}

/** SDK-independent minimum for OpenAI's non-streaming transcription operation. */
export interface OpenAITranscriptionRequest {
  readonly model: string;
  readonly file: OpenAITranscriptionFile;
  readonly response_format: "json";
  readonly language?: string;
  readonly languages?: readonly string[];
  readonly keywords?: readonly string[];
  readonly prompt?: string;
}

export interface OpenAITranscriptionRequestOptions {
  readonly signal: AbortSignal;
  readonly idempotency_key: string;
}

export type OpenAITranscriptionRequestFunction = (
  request: OpenAITranscriptionRequest,
  options: OpenAITranscriptionRequestOptions,
) => unknown | Promise<unknown>;

export interface OpenAITranscriptionUsageObservation {
  readonly request_id: string;
  readonly audio_id: string;
  /** Same bounded identity supplied to the provider; stable across delivery retries. */
  readonly provider_idempotency_key: string;
  readonly model_id: string;
  readonly usage: OpenAIReportedAudioUsage;
}

export interface OpenAITranscriptionOptions {
  readonly model: string;
  /** Trusted project defaults, copied and validated when the capability is created. */
  readonly speech_hints?: TranscriptionSpeechHints;
  readonly resolve_audio: OpenAITranscriptionAudioResolver;
  readonly request: OpenAITranscriptionRequestFunction;
  /** Trusted-server durable capture. Awaited before returning/validating the transcript.
   * It may finish after caller cancellation; do not bind storage to that signal.
   * The host supplies authoritative attribution and a deduplicating usage store.
   */
  readonly capture_usage?: (observation: OpenAITranscriptionUsageObservation) => Promise<void>;
}

type UnknownRecord = Record<string, unknown>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CREDENTIAL_MODEL_ID = /^sk-[A-Za-z0-9_-]{8,}$/iu;
const UTF8_ENCODER = new TextEncoder();

function safeRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: UnknownRecord = Object.create(null) as UnknownRecord;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function isOperationError(error: unknown): error is TranscriptionOperationError {
  try {
    return error instanceof TranscriptionOperationError;
  } catch {
    return false;
  }
}

function safeErrorField(error: unknown, field: string): unknown {
  try {
    return error !== null && typeof error === "object" && !Array.isArray(error)
      ? (error as UnknownRecord)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

function rejectIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TranscriptionOperationError("cancelled");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  rejectIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new TranscriptionOperationError("cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeResolverFailure(
  error: unknown,
  signal: AbortSignal,
): TranscriptionOperationError {
  if (signal.aborted) return new TranscriptionOperationError("cancelled");
  const name = safeErrorField(error, "name");
  const code = safeErrorField(error, "code");
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new TranscriptionOperationError("deadline_exceeded");
  }
  return new TranscriptionOperationError("content_unavailable");
}

function normalizeProviderFailure(
  error: unknown,
  signal: AbortSignal,
): TranscriptionOperationError {
  if (signal.aborted) return new TranscriptionOperationError("cancelled");
  if (isOperationError(error)) return error;

  const status = safeErrorField(error, "status");
  const name = safeErrorField(error, "name");
  const code = safeErrorField(error, "code");
  if (
    status === 408 ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new TranscriptionOperationError("deadline_exceeded");
  }
  if (status === 409) {
    return new TranscriptionOperationError("idempotency_conflict");
  }
  if (status === 413) return new TranscriptionOperationError("limit_exceeded");
  if (status === 415) return new TranscriptionOperationError("unsupported_audio");
  if (status === 429) return new TranscriptionOperationError("rate_limited");
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return new TranscriptionOperationError("service_unavailable");
  }
  if (typeof status === "number" && status >= 400 && status <= 499) {
    return new TranscriptionOperationError("invalid_request");
  }
  return new TranscriptionOperationError("internal_failure");
}

function parseResolvedAudio(
  value: unknown,
  request: TranscriptionRequest,
): OpenAITranscriptionResolvedAudio {
  const source = safeRecord(value);
  if (
    source === null ||
    Object.keys(source).some((key) =>
      !["bytes", "media_type", "byte_size", "duration_seconds"].includes(key)) ||
    !Object.hasOwn(source, "bytes") ||
    !Object.hasOwn(source, "media_type") ||
    !Object.hasOwn(source, "byte_size") ||
    !Object.hasOwn(source, "duration_seconds")
  ) {
    throw new TranscriptionOperationError("content_unavailable");
  }

  const audio = request.inputs[0]!;
  if (!(source.bytes instanceof Uint8Array)) {
    throw new TranscriptionOperationError("content_unavailable");
  }
  if (
    !Number.isSafeInteger(source.byte_size) ||
    (source.byte_size as number) < TRANSCRIPTION_LIMITS.audioBytesMin
  ) {
    throw new TranscriptionOperationError("content_unavailable");
  }
  if ((source.byte_size as number) > OPENAI_TRANSCRIPTION_LIMITS.maxBytesPerInput) {
    throw new TranscriptionOperationError("limit_exceeded");
  }
  if (
    typeof source.duration_seconds !== "number" ||
    !Number.isFinite(source.duration_seconds) ||
    source.duration_seconds < TRANSCRIPTION_LIMITS.audioDurationSecondsMin
  ) {
    throw new TranscriptionOperationError("content_unavailable");
  }
  if (source.duration_seconds > OPENAI_TRANSCRIPTION_LIMITS.maxDurationSeconds) {
    throw new TranscriptionOperationError("limit_exceeded");
  }
  if (!OPENAI_TRANSCRIPTION_AUDIO_FORMATS.some(
    (format) => format.media_type === source.media_type,
  )) {
    throw new TranscriptionOperationError("unsupported_audio");
  }
  if (
    source.media_type !== audio.format.media_type ||
    source.byte_size !== audio.byte_size ||
    source.duration_seconds !== audio.duration_seconds ||
    source.bytes.byteLength !== source.byte_size
  ) {
    throw new TranscriptionOperationError("content_unavailable");
  }

  return Object.freeze({
    bytes: source.bytes,
    media_type: source.media_type as TranscriptionAudioMimeType,
    byte_size: source.byte_size as number,
    duration_seconds: source.duration_seconds,
  });
}

async function providerIdempotencyIdentity(
  key: TranscriptionIdempotencyKey,
): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new TranscriptionOperationError("internal_failure");
    const digest = await subtle.digest(
      "SHA-256",
      UTF8_ENCODER.encode(`handrail.openai.transcription.v1\u0000${key}`),
    );
    const hex = [...new Uint8Array(digest)]
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("");
    return `handrail-transcription-${hex}`;
  } catch (error) {
    if (isOperationError(error)) throw error;
    throw new TranscriptionOperationError("internal_failure");
  }
}

function normalizeResponse(
  value: unknown,
  request: TranscriptionRequest,
  resolved: OpenAITranscriptionResolvedAudio,
): TranscriptionResult {
  const source = safeRecord(value);
  if (
    source === null ||
    !Object.hasOwn(source, "text")
  ) {
    throw new TranscriptionOperationError("internal_failure");
  }
  try {
    let language = Object.hasOwn(source, "language") ? source.language : null;
    if (!Object.hasOwn(source, "language") && Object.hasOwn(source, "languages")) {
      // gpt-transcribe can report multiple detected languages. The shared
      // contract has one language slot; do not label multilingual audio as one.
      if (!Array.isArray(source.languages)) {
        throw new TranscriptionOperationError("internal_failure");
      }
      if (source.languages.length === 1) {
        const detected = safeRecord(source.languages[0]);
        if (detected === null || !Object.hasOwn(detected, "code")) {
          throw new TranscriptionOperationError("internal_failure");
        }
        language = detected.code;
      }
    }
    return parseTranscriptionResult({
      status: "completed",
      request_id: request.request_id,
      outputs: [{
        audio_id: request.inputs[0]!.audio_id,
        text: source.text,
        metadata: {
          language,
          // JSON transcription need not report duration. This is validated
          // host-owned media metadata, never provider-reported billable usage.
          duration_seconds: Object.hasOwn(source, "duration")
            ? source.duration : resolved.duration_seconds,
        },
      }],
    }, request);
  } catch {
    throw new TranscriptionOperationError("internal_failure");
  }
}

class OpenAITranscriptionCapability implements SupportedTranscriptionCapability {
  readonly supported = true as const;
  readonly version = TRANSCRIPTION_CONTRACT_VERSION;
  readonly formats = OPENAI_TRANSCRIPTION_AUDIO_FORMATS;
  readonly limits = Object.freeze({
    max_inputs: OPENAI_TRANSCRIPTION_LIMITS.maxInputs,
    max_bytes_per_input: OPENAI_TRANSCRIPTION_LIMITS.maxBytesPerInput,
    max_duration_seconds: OPENAI_TRANSCRIPTION_LIMITS.maxDurationSeconds,
  });

  constructor(
    private readonly model: string,
    private readonly resolveAudio: OpenAITranscriptionAudioResolver,
    private readonly requestProvider: OpenAITranscriptionRequestFunction,
    private readonly captureUsage: OpenAITranscriptionOptions["capture_usage"],
    private readonly speechHints: TranscriptionSpeechHints,
  ) {}

  async transcribe(value: TranscriptionRequest): Promise<TranscriptionResult> {
    let request: TranscriptionRequest;
    try {
      request = parseTranscriptionRequest(value);
    } catch {
      throw new TranscriptionOperationError("invalid_request");
    }
    rejectIfAborted(request.signal);

    const audio = request.inputs[0]!;
    if (!this.formats.some((format) =>
      format.media_type === audio.format.media_type &&
      format.container === audio.format.container)) {
      throw new TranscriptionOperationError("unsupported_audio");
    }
    if (
      audio.byte_size > this.limits.max_bytes_per_input ||
      audio.duration_seconds > this.limits.max_duration_seconds
    ) {
      throw new TranscriptionOperationError("limit_exceeded");
    }

    let resolvedValue: unknown;
    try {
      resolvedValue = await awaitWithSignal(
        Promise.resolve().then(() => this.resolveAudio(Object.freeze({
          audio,
          signal: request.signal,
        }))),
        request.signal,
      );
    } catch (error) {
      throw normalizeResolverFailure(error, request.signal);
    }
    let resolved: OpenAITranscriptionResolvedAudio;
    try {
      resolved = parseResolvedAudio(resolvedValue, request);
    } catch (error) {
      if (isOperationError(error)) throw error;
      throw new TranscriptionOperationError("content_unavailable");
    }
    rejectIfAborted(request.signal);

    const idempotencyIdentity = await providerIdempotencyIdentity(
      request.idempotency_key,
    );
    rejectIfAborted(request.signal);
    const providerRequest = Object.freeze({
      model: this.model,
      file: Object.freeze({
        bytes: resolved.bytes,
        media_type: resolved.media_type,
        filename: `audio.${audio.format.container}`,
      }),
      response_format: "json" as const,
      ...openAITranscriptionHintFields(this.model, this.speechHints, request.language),
    });

    let response: unknown;
    try {
      response = await awaitWithSignal(
        Promise.resolve().then(async () => {
          rejectIfAborted(request.signal);
          const response = await this.requestProvider(providerRequest, {
            signal: request.signal,
            idempotency_key: idempotencyIdentity,
          });
          // Keep this inside the provider promise: a late response after caller
          // cancellation still carries incurred usage that must reach storage.
          if (this.captureUsage !== undefined) {
            const source = safeRecord(response);
            if (source === null) throw new TranscriptionOperationError("internal_failure");
            await this.captureUsage(Object.freeze({ request_id: request.request_id,
              audio_id: audio.audio_id, provider_idempotency_key: idempotencyIdentity,
              model_id: this.model, usage: parseOpenAIReportedAudioUsage(source.usage) }));
          }
          return response;
        }),
        request.signal,
      );
    } catch (error) {
      throw normalizeProviderFailure(error, request.signal);
    }
    return normalizeResponse(response, request, resolved);
  }
}

export function createOpenAITranscriptionCapability(
  options: OpenAITranscriptionOptions,
): SupportedTranscriptionCapability {
  if (
    options === null ||
    typeof options !== "object" ||
    typeof options.model !== "string" ||
    options.model.length === 0 ||
    options.model.length > OPENAI_TRANSCRIPTION_LIMITS.modelLength ||
    (!MODEL_ID.test(options.model) || CREDENTIAL_MODEL_ID.test(options.model))
  ) {
    throw new TypeError("OpenAI transcription model must be a bounded model identifier");
  }
  if (typeof options.resolve_audio !== "function") {
    throw new TypeError("OpenAI transcription audio resolver must be a function");
  }
  if (typeof options.request !== "function") {
    throw new TypeError("OpenAI transcription request operation must be a function");
  }
  if (options.capture_usage !== undefined && typeof options.capture_usage !== "function") {
    throw new TypeError("OpenAI transcription usage capture must be a function");
  }
  const speechHints = parseTranscriptionSpeechHints(options.speech_hints);
  openAITranscriptionHintFields(options.model, speechHints);
  return new OpenAITranscriptionCapability(
    options.model,
    options.resolve_audio,
    options.request,
    options.capture_usage,
    speechHints,
  );
}
