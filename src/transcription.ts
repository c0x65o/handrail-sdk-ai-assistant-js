/** Provider-neutral, trusted-host transcription contract. */
export const TRANSCRIPTION_CONTRACT_VERSION = "handrail.transcription.v1" as const;

export const TRANSCRIPTION_AUDIO_FORMATS = Object.freeze([
  Object.freeze({ media_type: "audio/flac", container: "flac" }),
  Object.freeze({ media_type: "audio/mpeg", container: "mp3" }),
  Object.freeze({ media_type: "audio/mp4", container: "m4a" }),
  Object.freeze({ media_type: "audio/ogg", container: "ogg" }),
  Object.freeze({ media_type: "audio/wav", container: "wav" }),
  Object.freeze({ media_type: "audio/webm", container: "webm" }),
] as const);

export const TRANSCRIPTION_UNSUPPORTED_REASONS = Object.freeze([
  "implementation_not_configured",
  "model_not_supported",
  "audio_format_not_supported",
] as const);

export const TRANSCRIPTION_ERROR_CODES = Object.freeze([
  "invalid_request",
  "idempotency_conflict",
  "outcome_unknown",
  "unsupported",
  "unsupported_audio",
  "content_unavailable",
  "limit_exceeded",
  "cancelled",
  "deadline_exceeded",
  "rate_limited",
  "service_unavailable",
  "internal_failure",
] as const);

/** Deliberately conservative bounds for one non-streaming transcription request. */
export const TRANSCRIPTION_LIMITS = Object.freeze({
  inputsPerRequest: 1,
  audioBytesMin: 1,
  audioBytesMax: 25 * 1024 * 1024,
  audioDurationSecondsMin: 0.001,
  audioDurationSecondsMax: 60 * 60,
  identifierLength: 128,
  contentReferenceLength: 256,
  idempotencyKeyLength: 128,
  languageLength: 35,
  transcriptTextLength: 1_000_000,
  resultSerializedBytes: 4 * 1024 * 1024,
  safeErrorMessageLength: 128,
} as const);

declare const opaqueTranscriptionValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaqueTranscriptionValue]: Name;
};

export type TranscriptionAudioMimeType =
  (typeof TRANSCRIPTION_AUDIO_FORMATS)[number]["media_type"];
export type TranscriptionAudioContainer =
  (typeof TRANSCRIPTION_AUDIO_FORMATS)[number]["container"];
export type TranscriptionUnsupportedReason =
  (typeof TRANSCRIPTION_UNSUPPORTED_REASONS)[number];
export type TranscriptionErrorCode =
  (typeof TRANSCRIPTION_ERROR_CODES)[number];
export type TranscriptionRequestId = OpaqueString<"TranscriptionRequestId">;
export type TranscriptionAudioId = OpaqueString<"TranscriptionAudioId">;
export type TranscriptionContentReference =
  OpaqueString<"TranscriptionContentReference">;
export type TranscriptionIdempotencyKey =
  OpaqueString<"TranscriptionIdempotencyKey">;
export type TranscriptionLanguage = OpaqueString<"TranscriptionLanguage">;

export interface TranscriptionAudioFormatDescriptor {
  readonly media_type: TranscriptionAudioMimeType;
  readonly container: TranscriptionAudioContainer;
}

/**
 * Durable-safe audio metadata. `content_ref` is only an opaque host identifier;
 * URLs, bytes, storage details, and authorization material are not accepted.
 */
export interface TranscriptionAudioReference {
  readonly audio_id: TranscriptionAudioId;
  readonly content_ref: TranscriptionContentReference;
  readonly format: TranscriptionAudioFormatDescriptor;
  readonly byte_size: number;
  readonly duration_seconds: number;
}

export interface TranscriptionRequest {
  readonly request_id: TranscriptionRequestId;
  readonly inputs: readonly TranscriptionAudioReference[];
  readonly language?: TranscriptionLanguage;
  readonly idempotency_key: TranscriptionIdempotencyKey;
  readonly signal: AbortSignal;
}

/** Ephemeral request supplied only to a trusted host's audio resolver. */
export interface TranscriptionAudioResolutionRequest {
  readonly audio: TranscriptionAudioReference;
  readonly signal: AbortSignal;
}

/**
 * A host owns storage and resolves bytes at operation time. Implementations must
 * not retain resolved bytes in results, errors, logs, or durable checkpoints.
 */
export interface TranscriptionAudioResolver {
  resolveAudio(request: TranscriptionAudioResolutionRequest): Promise<Uint8Array>;
}

export interface TranscriptionOutputMetadata {
  readonly language: TranscriptionLanguage | null;
  readonly duration_seconds: number;
}

export interface TranscriptionOutput {
  readonly audio_id: TranscriptionAudioId;
  readonly text: string;
  readonly metadata: TranscriptionOutputMetadata;
}

export interface TranscriptionResult {
  readonly status: "completed";
  readonly request_id: TranscriptionRequestId;
  readonly outputs: readonly TranscriptionOutput[];
}

export interface TranscriptionCapabilityLimits {
  readonly max_inputs: number;
  readonly max_bytes_per_input: number;
  readonly max_duration_seconds: number;
}

export interface SupportedTranscriptionCapability {
  readonly supported: true;
  readonly version: typeof TRANSCRIPTION_CONTRACT_VERSION;
  readonly formats: readonly TranscriptionAudioFormatDescriptor[];
  readonly limits: TranscriptionCapabilityLimits;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface UnsupportedTranscriptionCapability {
  readonly supported: false;
  readonly reason: TranscriptionUnsupportedReason;
}

export type TranscriptionCapability =
  | SupportedTranscriptionCapability
  | UnsupportedTranscriptionCapability;

export type TranscriptionCapabilityDescriptor =
  | Pick<
    SupportedTranscriptionCapability,
    "supported" | "version" | "formats" | "limits"
  >
  | UnsupportedTranscriptionCapability;

export const TRANSCRIPTION_NOT_SUPPORTED = Object.freeze({
  supported: false,
  reason: "implementation_not_configured",
} as const) satisfies UnsupportedTranscriptionCapability;

export interface TranscriptionSafeError {
  readonly code: TranscriptionErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly cancelled: boolean;
}

export type TranscriptionOutcome =
  | { readonly ok: true; readonly result: TranscriptionResult }
  | { readonly ok: false; readonly error: TranscriptionSafeError };

export class TranscriptionValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TranscriptionValidationError";
    this.path = path;
  }
}

/** An implementation may throw this classification without retaining a cause. */
export class TranscriptionOperationError extends Error {
  readonly code: TranscriptionErrorCode;

  constructor(code: TranscriptionErrorCode) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = "TranscriptionOperationError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;
const UTF8_ENCODER = new TextEncoder();

const ERROR_DEFINITIONS: Readonly<Record<TranscriptionErrorCode, {
  readonly message: string;
  readonly retryable: boolean;
  readonly cancelled: boolean;
}>> = Object.freeze({
  invalid_request: {
    message: "The transcription request is invalid.",
    retryable: false,
    cancelled: false,
  },
  idempotency_conflict: {
    message: "The idempotency key conflicts with another transcription.",
    retryable: false,
    cancelled: false,
  },
  outcome_unknown: {
    message: "The transcription outcome is unknown. This recording will not be sent again.",
    retryable: false,
    cancelled: false,
  },
  unsupported: {
    message: "Transcription is not supported.",
    retryable: false,
    cancelled: false,
  },
  unsupported_audio: {
    message: "The audio format is not supported.",
    retryable: false,
    cancelled: false,
  },
  content_unavailable: {
    message: "The audio content is unavailable.",
    retryable: true,
    cancelled: false,
  },
  limit_exceeded: {
    message: "The transcription request exceeds a configured limit.",
    retryable: false,
    cancelled: false,
  },
  cancelled: {
    message: "The transcription operation was cancelled.",
    retryable: false,
    cancelled: true,
  },
  deadline_exceeded: {
    message: "The transcription operation exceeded its deadline.",
    retryable: true,
    cancelled: false,
  },
  rate_limited: {
    message: "Transcription is temporarily rate limited.",
    retryable: true,
    cancelled: false,
  },
  service_unavailable: {
    message: "Transcription is temporarily unavailable.",
    retryable: true,
    cancelled: false,
  },
  internal_failure: {
    message: "Transcription failed.",
    retryable: false,
    cancelled: false,
  },
});

function fail(path: string, message: string): never {
  throw new TranscriptionValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, "must be a plain object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must contain only string-named fields");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable data field");
    }
  }
  return value as UnknownRecord;
}

function exactFields(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function boundedString(
  value: unknown,
  path: string,
  maxLength: number,
  allowTranscriptControls = false,
): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const allowedControl = allowTranscriptControls &&
      (character === "\n" || character === "\r" || character === "\t");
    if ((point <= 0x1f && !allowedControl) || point === 0x7f) {
      fail(path, "must not contain unsupported control characters");
    }
  }
  return value;
}

function safeIdentifier(
  value: unknown,
  path: string,
  maxLength: number = TRANSCRIPTION_LIMITS.identifierLength,
): string {
  const parsed = boundedString(value, path, maxLength);
  if (parsed.length === 0 || !IDENTIFIER.test(parsed)) {
    fail(path, "must be a non-empty opaque identifier");
  }
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(parsed))) {
    fail(path, "must not contain credential material");
  }
  return parsed;
}

function finiteNumber(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, `must be a finite number from ${minimum} through ${maximum}`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(path, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function" &&
    typeof (value as AbortSignal).throwIfAborted === "function";
}

function parseFormat(
  value: unknown,
  path: string,
): TranscriptionAudioFormatDescriptor {
  const source = record(value, path);
  exactFields(source, ["media_type", "container"], [], path);
  const match = TRANSCRIPTION_AUDIO_FORMATS.find(
    (format) =>
      format.media_type === source.media_type &&
      format.container === source.container,
  );
  if (match === undefined) {
    fail(path, "must use a supported MIME type and container combination");
  }
  return Object.freeze({
    media_type: match.media_type,
    container: match.container,
  });
}

export function parseTranscriptionLanguage(
  value: unknown,
): TranscriptionLanguage {
  const raw = boundedString(
    value,
    "$language",
    TRANSCRIPTION_LIMITS.languageLength,
  ).trim();
  if (raw.length === 0) fail("$language", "must not be empty");
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(raw))) {
    fail("$language", "must not contain credential material");
  }
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(raw)[0];
  } catch {
    fail("$language", "must be a valid BCP 47 language tag");
  }
  if (canonical === undefined || canonical.length > TRANSCRIPTION_LIMITS.languageLength) {
    fail("$language", "must be a valid bounded BCP 47 language tag");
  }
  return canonical as TranscriptionLanguage;
}

export function parseTranscriptionIdempotencyKey(
  value: unknown,
): TranscriptionIdempotencyKey {
  const parsed = boundedString(
    value,
    "$idempotency_key",
    TRANSCRIPTION_LIMITS.idempotencyKeyLength,
  );
  if (parsed.length === 0 || !IDEMPOTENCY_KEY.test(parsed)) {
    fail(
      "$idempotency_key",
      "must use letters, numbers, dots, underscores, colons, or hyphens",
    );
  }
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(parsed))) {
    fail("$idempotency_key", "must not contain credential material");
  }
  return parsed as TranscriptionIdempotencyKey;
}

function parseAudioReference(
  value: unknown,
  path: string,
): TranscriptionAudioReference {
  const source = record(value, path);
  exactFields(
    source,
    ["audio_id", "content_ref", "format", "byte_size", "duration_seconds"],
    [],
    path,
  );
  return Object.freeze({
    audio_id: safeIdentifier(
      source.audio_id,
      `${path}.audio_id`,
    ) as TranscriptionAudioId,
    content_ref: safeIdentifier(
      source.content_ref,
      `${path}.content_ref`,
      TRANSCRIPTION_LIMITS.contentReferenceLength,
    ) as TranscriptionContentReference,
    format: parseFormat(source.format, `${path}.format`),
    byte_size: safeInteger(
      source.byte_size,
      `${path}.byte_size`,
      TRANSCRIPTION_LIMITS.audioBytesMin,
      TRANSCRIPTION_LIMITS.audioBytesMax,
    ),
    duration_seconds: finiteNumber(
      source.duration_seconds,
      `${path}.duration_seconds`,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
    ),
  });
}

export function parseTranscriptionAudioReference(
  value: unknown,
): TranscriptionAudioReference {
  return parseAudioReference(value, "$audio");
}

export function parseTranscriptionRequest(value: unknown): TranscriptionRequest {
  const path = "$request";
  const source = record(value, path);
  exactFields(
    source,
    ["request_id", "inputs", "idempotency_key", "signal"],
    ["language"],
    path,
  );
  if (!Array.isArray(source.inputs)) fail(`${path}.inputs`, "must be an array");
  if (
    source.inputs.length < 1 ||
    source.inputs.length > TRANSCRIPTION_LIMITS.inputsPerRequest
  ) {
    fail(
      `${path}.inputs`,
      `must contain 1-${TRANSCRIPTION_LIMITS.inputsPerRequest} items`,
    );
  }
  if (!isAbortSignal(source.signal)) {
    fail(`${path}.signal`, "must be an AbortSignal");
  }
  const inputs = Object.freeze(source.inputs.map((input, index) =>
    parseAudioReference(input, `${path}.inputs[${index}]`)));
  const audioIds = new Set(inputs.map((input) => input.audio_id));
  const contentReferences = new Set(inputs.map((input) => input.content_ref));
  if (audioIds.size !== inputs.length) {
    fail(`${path}.inputs`, "must use unique audio_id values");
  }
  if (contentReferences.size !== inputs.length) {
    fail(`${path}.inputs`, "must use unique content_ref values");
  }
  const request = {
    request_id: safeIdentifier(
      source.request_id,
      `${path}.request_id`,
    ) as TranscriptionRequestId,
    inputs,
    idempotency_key: parseIdempotencyKeyAt(
      source.idempotency_key,
      `${path}.idempotency_key`,
    ),
    signal: source.signal,
    ...(Object.hasOwn(source, "language")
      ? { language: parseLanguageAt(source.language, `${path}.language`) }
      : {}),
  };
  return Object.freeze(request);
}

export function parseTranscriptionAudioResolutionRequest(
  value: unknown,
): TranscriptionAudioResolutionRequest {
  const path = "$resolution_request";
  const source = record(value, path);
  exactFields(source, ["audio", "signal"], [], path);
  if (!isAbortSignal(source.signal)) {
    fail(`${path}.signal`, "must be an AbortSignal");
  }
  return Object.freeze({
    audio: parseAudioReference(source.audio, `${path}.audio`),
    signal: source.signal,
  });
}

function parseLanguageAt(value: unknown, path: string): TranscriptionLanguage {
  try {
    return parseTranscriptionLanguage(value);
  } catch (error) {
    if (error instanceof TranscriptionValidationError) {
      fail(path, error.message.replace(/^\$language:\s*/u, ""));
    }
    throw error;
  }
}

function parseIdempotencyKeyAt(
  value: unknown,
  path: string,
): TranscriptionIdempotencyKey {
  try {
    return parseTranscriptionIdempotencyKey(value);
  } catch (error) {
    if (error instanceof TranscriptionValidationError) {
      fail(path, error.message.replace(/^\$idempotency_key:\s*/u, ""));
    }
    throw error;
  }
}

function parseOutput(
  value: unknown,
  path: string,
): TranscriptionOutput {
  const source = record(value, path);
  exactFields(source, ["audio_id", "text", "metadata"], [], path);
  const metadataPath = `${path}.metadata`;
  const metadataSource = record(source.metadata, metadataPath);
  exactFields(metadataSource, ["language", "duration_seconds"], [], metadataPath);
  const language = metadataSource.language === null
    ? null
    : parseLanguageAt(metadataSource.language, `${metadataPath}.language`);
  const metadata = Object.freeze({
    language,
    duration_seconds: finiteNumber(
      metadataSource.duration_seconds,
      `${metadataPath}.duration_seconds`,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
    ),
  });
  return Object.freeze({
    audio_id: safeIdentifier(
      source.audio_id,
      `${path}.audio_id`,
    ) as TranscriptionAudioId,
    text: boundedString(
      source.text,
      `${path}.text`,
      TRANSCRIPTION_LIMITS.transcriptTextLength,
      true,
    ).normalize("NFC").replace(/\r\n?/gu, "\n"),
    metadata,
  });
}

export function parseTranscriptionResult(
  value: unknown,
  expectedRequest?: TranscriptionRequest,
): TranscriptionResult {
  const path = "$result";
  const source = record(value, path);
  exactFields(source, ["status", "request_id", "outputs"], [], path);
  if (source.status !== "completed") {
    fail(`${path}.status`, 'must equal "completed"');
  }
  if (!Array.isArray(source.outputs)) fail(`${path}.outputs`, "must be an array");
  if (
    source.outputs.length < 1 ||
    source.outputs.length > TRANSCRIPTION_LIMITS.inputsPerRequest
  ) {
    fail(
      `${path}.outputs`,
      `must contain 1-${TRANSCRIPTION_LIMITS.inputsPerRequest} items`,
    );
  }
  const requestId = safeIdentifier(
    source.request_id,
    `${path}.request_id`,
  ) as TranscriptionRequestId;
  const outputs = Object.freeze(source.outputs.map((output, index) =>
    parseOutput(output, `${path}.outputs[${index}]`)));
  if (new Set(outputs.map((output) => output.audio_id)).size !== outputs.length) {
    fail(`${path}.outputs`, "must use unique audio_id values");
  }
  if (expectedRequest !== undefined) {
    if (requestId !== expectedRequest.request_id) {
      fail(`${path}.request_id`, "must match the transcription request");
    }
    if (
      outputs.length !== expectedRequest.inputs.length ||
      outputs.some(
        (output, index) => output.audio_id !== expectedRequest.inputs[index]?.audio_id,
      )
    ) {
      fail(`${path}.outputs`, "must correspond to request inputs in order");
    }
  }
  const result = Object.freeze({
    status: "completed" as const,
    request_id: requestId,
    outputs,
  });
  if (
    UTF8_ENCODER.encode(JSON.stringify(result)).byteLength >
    TRANSCRIPTION_LIMITS.resultSerializedBytes
  ) {
    fail(
      path,
      `must serialize to at most ${TRANSCRIPTION_LIMITS.resultSerializedBytes} bytes`,
    );
  }
  return result;
}

function parseCapabilityLimits(
  value: unknown,
  path: string,
): TranscriptionCapabilityLimits {
  const source = record(value, path);
  exactFields(
    source,
    ["max_inputs", "max_bytes_per_input", "max_duration_seconds"],
    [],
    path,
  );
  return Object.freeze({
    max_inputs: safeInteger(
      source.max_inputs,
      `${path}.max_inputs`,
      1,
      TRANSCRIPTION_LIMITS.inputsPerRequest,
    ),
    max_bytes_per_input: safeInteger(
      source.max_bytes_per_input,
      `${path}.max_bytes_per_input`,
      TRANSCRIPTION_LIMITS.audioBytesMin,
      TRANSCRIPTION_LIMITS.audioBytesMax,
    ),
    max_duration_seconds: finiteNumber(
      source.max_duration_seconds,
      `${path}.max_duration_seconds`,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
    ),
  });
}

export function parseTranscriptionCapabilityDescriptor(
  value: unknown,
): TranscriptionCapabilityDescriptor {
  const path = "$capability";
  const source = record(value, path);
  if (source.supported === false) {
    exactFields(source, ["supported", "reason"], [], path);
    if (
      !TRANSCRIPTION_UNSUPPORTED_REASONS.includes(
        source.reason as TranscriptionUnsupportedReason,
      )
    ) {
      fail(
        `${path}.reason`,
        `must be one of: ${TRANSCRIPTION_UNSUPPORTED_REASONS.join(", ")}`,
      );
    }
    return Object.freeze({
      supported: false,
      reason: source.reason as TranscriptionUnsupportedReason,
    });
  }
  if (source.supported === true) {
    exactFields(source, ["supported", "version", "formats", "limits"], [], path);
    if (source.version !== TRANSCRIPTION_CONTRACT_VERSION) {
      fail(`${path}.version`, `must equal ${TRANSCRIPTION_CONTRACT_VERSION}`);
    }
    if (!Array.isArray(source.formats) || source.formats.length === 0) {
      fail(`${path}.formats`, "must be a non-empty array");
    }
    const formats = Object.freeze(source.formats.map((format, index) =>
      parseFormat(format, `${path}.formats[${index}]`)));
    const formatKeys = new Set(
      formats.map((format) => `${format.media_type}:${format.container}`),
    );
    if (formatKeys.size !== formats.length) {
      fail(`${path}.formats`, "must not contain duplicate formats");
    }
    return Object.freeze({
      supported: true,
      version: TRANSCRIPTION_CONTRACT_VERSION,
      formats,
      limits: parseCapabilityLimits(source.limits, `${path}.limits`),
    });
  }
  fail(`${path}.supported`, "must be a boolean discriminant");
}

export function describeTranscriptionCapability(
  capability: TranscriptionCapability,
): TranscriptionCapabilityDescriptor {
  if (capability.supported) {
    if (typeof capability.transcribe !== "function") {
      fail("$capability.transcribe", "must be a function");
    }
    return parseTranscriptionCapabilityDescriptor({
      supported: true,
      version: capability.version,
      formats: capability.formats,
      limits: capability.limits,
    });
  }
  return parseTranscriptionCapabilityDescriptor(capability);
}

export function transcriptionSafeError(
  code: TranscriptionErrorCode,
): TranscriptionSafeError {
  return Object.freeze({ code, ...ERROR_DEFINITIONS[code] });
}

export function parseTranscriptionSafeError(
  value: unknown,
): TranscriptionSafeError {
  const path = "$error";
  const source = record(value, path);
  exactFields(source, ["code", "message", "retryable", "cancelled"], [], path);
  if (!TRANSCRIPTION_ERROR_CODES.includes(source.code as TranscriptionErrorCode)) {
    fail(
      `${path}.code`,
      `must be one of: ${TRANSCRIPTION_ERROR_CODES.join(", ")}`,
    );
  }
  const expected = transcriptionSafeError(source.code as TranscriptionErrorCode);
  if (
    source.message !== expected.message ||
    source.retryable !== expected.retryable ||
    source.cancelled !== expected.cancelled
  ) {
    fail(path, "must use fixed safe metadata for its code");
  }
  return expected;
}

export function normalizeTranscriptionError(
  error: unknown,
  signal?: AbortSignal,
): TranscriptionSafeError {
  if (signal?.aborted) return transcriptionSafeError("cancelled");
  if (error instanceof TranscriptionOperationError) {
    return transcriptionSafeError(error.code);
  }
  try {
    return parseTranscriptionSafeError(error);
  } catch {
    return transcriptionSafeError("internal_failure");
  }
}

function unsupportedByCapability(
  request: TranscriptionRequest,
  descriptor: Extract<TranscriptionCapabilityDescriptor, { readonly supported: true }>,
): TranscriptionErrorCode | undefined {
  if (
    request.inputs.length > descriptor.limits.max_inputs ||
    request.inputs.some((input) =>
      input.byte_size > descriptor.limits.max_bytes_per_input ||
      input.duration_seconds > descriptor.limits.max_duration_seconds)
  ) {
    return "limit_exceeded";
  }
  const supportedFormats = new Set(
    descriptor.formats.map((format) => `${format.media_type}:${format.container}`),
  );
  if (
    request.inputs.some((input) =>
      !supportedFormats.has(`${input.format.media_type}:${input.format.container}`))
  ) {
    return "unsupported_audio";
  }
  return undefined;
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new TranscriptionOperationError("cancelled"));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(new TranscriptionOperationError("cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Validates both sides of an operation and converts every failure into fixed,
 * public metadata. The caller's AbortSignal is always forwarded unchanged.
 */
export async function executeTranscription(
  capability: TranscriptionCapability,
  value: unknown,
): Promise<TranscriptionOutcome> {
  let request: TranscriptionRequest;
  try {
    request = parseTranscriptionRequest(value);
  } catch {
    return Object.freeze({
      ok: false,
      error: transcriptionSafeError("invalid_request"),
    });
  }
  if (request.signal.aborted) {
    return Object.freeze({
      ok: false,
      error: transcriptionSafeError("cancelled"),
    });
  }
  if (!capability.supported) {
    return Object.freeze({
      ok: false,
      error: transcriptionSafeError("unsupported"),
    });
  }

  let descriptor: Extract<
    TranscriptionCapabilityDescriptor,
    { readonly supported: true }
  >;
  try {
    const parsed = describeTranscriptionCapability(capability);
    if (!parsed.supported) throw new TypeError("Invalid capability discriminant");
    descriptor = parsed;
  } catch {
    return Object.freeze({
      ok: false,
      error: transcriptionSafeError("internal_failure"),
    });
  }
  const unsupportedCode = unsupportedByCapability(request, descriptor);
  if (unsupportedCode !== undefined) {
    return Object.freeze({
      ok: false,
      error: transcriptionSafeError(unsupportedCode),
    });
  }

  try {
    const result = await raceWithAbort(
      Promise.resolve(capability.transcribe(request)),
      request.signal,
    );
    return Object.freeze({
      ok: true,
      result: parseTranscriptionResult(result, request),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      error: normalizeTranscriptionError(error, request.signal),
    });
  }
}
