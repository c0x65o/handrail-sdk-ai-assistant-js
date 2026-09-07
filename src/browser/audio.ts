import {
  TRANSCRIPTION_AUDIO_FORMATS,
  TRANSCRIPTION_LIMITS,
  type TranscriptionAudioFormatDescriptor,
  type TranscriptionAudioMimeType,
} from "../transcription.js";

export const BROWSER_AUDIO_CAPTURE_ERROR_CODES = Object.freeze([
  "unsupported_format",
  "media_devices_unavailable",
  "recorder_unavailable",
  "permission_denied",
  "recorder_failed",
  "empty_capture",
  "byte_limit_exceeded",
  "blob_unavailable",
  "object_url_unavailable",
  "cancelled",
  "disposed",
  "invalid_state",
] as const);

export type BrowserAudioCaptureErrorCode =
  (typeof BROWSER_AUDIO_CAPTURE_ERROR_CODES)[number];

export interface BrowserAudioSafeError {
  readonly code: BrowserAudioCaptureErrorCode;
  readonly message: string;
}

const ERROR_MESSAGES: Readonly<Record<BrowserAudioCaptureErrorCode, string>> =
  Object.freeze({
    unsupported_format: "This browser cannot record audio in a supported format.",
    media_devices_unavailable: "Microphone capture is unavailable.",
    recorder_unavailable: "Audio recording is unavailable.",
    permission_denied: "Microphone access was not granted.",
    recorder_failed: "Audio recording failed.",
    empty_capture: "The audio capture was empty.",
    byte_limit_exceeded: "The audio capture exceeded its byte limit.",
    blob_unavailable: "A browser audio source could not be created.",
    object_url_unavailable: "An object URL could not be created.",
    cancelled: "Audio capture was cancelled.",
    disposed: "The audio capture controller was disposed.",
    invalid_state: "Audio capture is not available in the current state.",
  });

export class BrowserAudioCaptureError extends Error {
  readonly code: BrowserAudioCaptureErrorCode;

  constructor(code: BrowserAudioCaptureErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BrowserAudioCaptureError";
    this.code = code;
  }
}

export class BrowserAudioCaptureValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAudioCaptureValidationError";
  }
}

export interface BrowserAudioTrack {
  stop(): void;
}

export interface BrowserAudioStream {
  getTracks(): readonly BrowserAudioTrack[];
}

export interface BrowserAudioMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<BrowserAudioStream>;
}

export interface BrowserAudioDataEvent {
  readonly data: Blob;
}

export type BrowserAudioRecorderListener = (event: unknown) => void;

export interface BrowserAudioMediaRecorder {
  readonly state: string;
  readonly mimeType?: string;
  start(timeslice?: number): void;
  stop(): void;
  addEventListener(type: string, listener: BrowserAudioRecorderListener): void;
  removeEventListener(type: string, listener: BrowserAudioRecorderListener): void;
}

export interface BrowserAudioMediaRecorderApi {
  isTypeSupported(mediaType: string): boolean;
  create(
    stream: BrowserAudioStream,
    options: { readonly mimeType: string },
  ): BrowserAudioMediaRecorder;
}

export interface BrowserAudioClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BrowserAudioBlobApi {
  create(parts: readonly Blob[], options: { readonly type: string }): Blob;
}

export interface BrowserAudioObjectUrlApi {
  createObjectURL(source: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserAudioObjectUrl {
  readonly url: string;
  /** Idempotently revokes this URL. */
  revoke(): void;
}

export interface BrowserAudioObjectUrlOptions {
  /** Defaults lazily to the browser's URL static methods. */
  readonly api?: BrowserAudioObjectUrlApi;
}

export interface BrowserAudioMetadata {
  readonly format: TranscriptionAudioFormatDescriptor;
  readonly byteSize: number;
  readonly durationSeconds: number;
  readonly filename?: string;
  /** Opaque metadata/session identity; it is not a durable content reference. */
  readonly fingerprint: string;
}

export interface BrowserAudioCaptureResult extends BrowserAudioMetadata {
  /** Host-owned binary source. The controller releases its reference on handoff. */
  readonly source: Blob;
  readonly objectUrl?: BrowserAudioObjectUrl;
}

export type BrowserAudioCaptureState =
  | { readonly status: "idle" }
  | {
      readonly status: "requesting";
      readonly format: TranscriptionAudioFormatDescriptor;
    }
  | {
      readonly status: "recording";
      readonly format: TranscriptionAudioFormatDescriptor;
      readonly accumulatedBytes: number;
      readonly elapsedSeconds: number;
    }
  | ({ readonly status: "stopped" } & BrowserAudioMetadata)
  | { readonly status: "failed"; readonly error: BrowserAudioSafeError };

export type BrowserAudioCaptureListener = (
  state: BrowserAudioCaptureState,
) => void;

export interface BrowserAudioCaptureOptions {
  /** Ordered, exact transcription MIME/container pairs the host accepts. */
  readonly formats: readonly TranscriptionAudioFormatDescriptor[];
  readonly maxBytes: number;
  readonly maxDurationSeconds: number;
  /** Recorder data interval. Defaults to 250 ms. */
  readonly timesliceMs?: number;
  readonly audioConstraints?: MediaTrackConstraints;
  /** Optional safe upload filename metadata; recording still produces a Blob. */
  readonly filename?: string;
  readonly mediaDevices?: BrowserAudioMediaDevices;
  readonly mediaRecorder?: BrowserAudioMediaRecorderApi;
  readonly clock?: BrowserAudioClock;
  readonly blobApi?: BrowserAudioBlobApi;
  /** Object URLs are never created unless this option is present. */
  readonly objectUrl?: true | BrowserAudioObjectUrlOptions;
  /** Receives automatic duration/byte-cutoff results without controller retention. */
  readonly onResult?: (result: BrowserAudioCaptureResult) => void;
}

export interface BrowserAudioCaptureController {
  getState(): BrowserAudioCaptureState;
  subscribe(listener: BrowserAudioCaptureListener): () => void;
  start(): Promise<void>;
  /** Returns null after an already-completed handoff. */
  stop(): Promise<BrowserAudioCaptureResult | null>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

export interface BrowserAudioIntakeOptions {
  /** Exact transcription MIME/container pairs the host accepts. */
  readonly acceptedFormats: readonly TranscriptionAudioFormatDescriptor[];
  readonly maxBytes: number;
  readonly maxDurationSeconds?: number;
  /** Host-declared duration, when already known without reading the source. */
  readonly durationSeconds?: number;
  readonly filename?: string;
  /** Object URLs are never created unless this option is present. */
  readonly objectUrl?: true | BrowserAudioObjectUrlOptions;
}

export interface BrowserAudioIntakeResult {
  readonly source: Blob;
  readonly format: TranscriptionAudioFormatDescriptor;
  readonly byteSize: number;
  readonly durationSeconds?: number;
  readonly filename?: string;
  readonly fingerprint: string;
  readonly objectUrl?: BrowserAudioObjectUrl;
  /** Idempotently revokes an explicitly requested object URL. */
  dispose(): void;
}

const FORMAT_BY_KEY = new Map(
  TRANSCRIPTION_AUDIO_FORMATS.map((format) => [
    `${format.media_type}:${format.container}`,
    format,
  ]),
);
const FORMAT_BY_MEDIA_TYPE = new Map<
  TranscriptionAudioMimeType,
  TranscriptionAudioFormatDescriptor
>(TRANSCRIPTION_AUDIO_FORMATS.map((format) => [format.media_type, format]));
const UNSAFE_FILENAME_CHARACTERS = '<>:"/\\|?*';
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
  /(?:^|[^a-z0-9])(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+/i,
] as const;

let captureSequence = 0;

function safeError(code: BrowserAudioCaptureErrorCode): BrowserAudioSafeError {
  return Object.freeze({ code, message: ERROR_MESSAGES[code] });
}

function opaqueHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function exactFormat(
  value: TranscriptionAudioFormatDescriptor,
  field: string,
): TranscriptionAudioFormatDescriptor {
  if (value === null || typeof value !== "object") {
    throw new BrowserAudioCaptureValidationError(`${field} must be an object`);
  }
  const match = FORMAT_BY_KEY.get(`${value.media_type}:${value.container}`);
  if (match === undefined) {
    throw new BrowserAudioCaptureValidationError(
      `${field} must exactly match a transcription audio format`,
    );
  }
  return match;
}

function validateFormats(
  values: readonly TranscriptionAudioFormatDescriptor[],
  field: string,
): readonly TranscriptionAudioFormatDescriptor[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new BrowserAudioCaptureValidationError(
      `${field} must contain at least one transcription audio format`,
    );
  }
  const seen = new Set<string>();
  const formats = values.map((value, index) => {
    const format = exactFormat(value, `${field}[${index}]`);
    const key = `${format.media_type}:${format.container}`;
    if (seen.has(key)) {
      throw new BrowserAudioCaptureValidationError(
        `${field} must not contain duplicate formats`,
      );
    }
    seen.add(key);
    return format;
  });
  return Object.freeze(formats);
}

function validateMaxBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < TRANSCRIPTION_LIMITS.audioBytesMin ||
    value > TRANSCRIPTION_LIMITS.audioBytesMax
  ) {
    throw new BrowserAudioCaptureValidationError(
      `maxBytes must be an integer from ${TRANSCRIPTION_LIMITS.audioBytesMin} through ${TRANSCRIPTION_LIMITS.audioBytesMax}`,
    );
  }
  return value;
}

function validateMaxDuration(value: number, field = "maxDurationSeconds"): number {
  if (
    !Number.isFinite(value) ||
    value < TRANSCRIPTION_LIMITS.audioDurationSecondsMin ||
    value > TRANSCRIPTION_LIMITS.audioDurationSecondsMax
  ) {
    throw new BrowserAudioCaptureValidationError(
      `${field} must be from ${TRANSCRIPTION_LIMITS.audioDurationSecondsMin} through ${TRANSCRIPTION_LIMITS.audioDurationSecondsMax}`,
    );
  }
  return value;
}

function safeFilename(value: unknown, fallbackExtension: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const sanitized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 ||
        codePoint === 127 ||
        UNSAFE_FILENAME_CHARACTERS.includes(character)
        ? "_"
        : character;
    })
    .join("")
    .slice(0, TRANSCRIPTION_LIMITS.identifierLength);
  if (
    sanitized.length === 0 ||
    sanitized === "." ||
    sanitized === ".." ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(sanitized))
  ) {
    return `audio.${fallbackExtension}`;
  }
  return sanitized;
}

function nativeMediaRecorderApi(): BrowserAudioMediaRecorderApi {
  const constructor = (globalThis as { MediaRecorder?: typeof MediaRecorder })
    .MediaRecorder;
  if (typeof constructor !== "function") {
    throw new BrowserAudioCaptureError("recorder_unavailable");
  }
  return {
    isTypeSupported: (mediaType) => constructor.isTypeSupported(mediaType),
    create: (stream, options) =>
      new constructor(stream as MediaStream, options) as unknown as BrowserAudioMediaRecorder,
  };
}

function nativeMediaDevices(): BrowserAudioMediaDevices {
  const devices = (globalThis as {
    navigator?: { mediaDevices?: BrowserAudioMediaDevices };
  }).navigator?.mediaDevices;
  if (devices === undefined || typeof devices.getUserMedia !== "function") {
    throw new BrowserAudioCaptureError("media_devices_unavailable");
  }
  return devices;
}

function nativeClock(): BrowserAudioClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function nativeBlobApi(): BrowserAudioBlobApi {
  const constructor = (globalThis as { Blob?: typeof Blob }).Blob;
  if (typeof constructor !== "function") {
    throw new BrowserAudioCaptureError("blob_unavailable");
  }
  return {
    create: (parts, options) => new constructor([...parts], options),
  };
}

function nativeObjectUrlApi(): BrowserAudioObjectUrlApi {
  const candidate = (globalThis as { URL?: Partial<BrowserAudioObjectUrlApi> }).URL;
  if (
    candidate === undefined ||
    typeof candidate.createObjectURL !== "function" ||
    typeof candidate.revokeObjectURL !== "function"
  ) {
    throw new BrowserAudioCaptureError("object_url_unavailable");
  }
  return candidate as BrowserAudioObjectUrlApi;
}

function createObjectUrl(
  source: Blob,
  option: true | BrowserAudioObjectUrlOptions,
  onRevoke?: (revoke: () => void) => void,
): BrowserAudioObjectUrl {
  const api = option === true ? nativeObjectUrlApi() : option.api ?? nativeObjectUrlApi();
  let url: string;
  try {
    url = api.createObjectURL(source);
  } catch {
    throw new BrowserAudioCaptureError("object_url_unavailable");
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new BrowserAudioCaptureError("object_url_unavailable");
  }
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    try {
      api.revokeObjectURL(url);
    } catch {
      // Cleanup remains idempotent even when a host URL boundary fails.
    }
  };
  onRevoke?.(revoke);
  return Object.freeze({ url, revoke });
}

function blobLike(value: unknown): value is Blob {
  return value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger((value as Blob).size) &&
    (value as Blob).size >= 0 &&
    typeof (value as Blob).type === "string";
}

interface ValidatedCaptureOptions {
  readonly formats: readonly TranscriptionAudioFormatDescriptor[];
  readonly maxBytes: number;
  readonly maxDurationSeconds: number;
  readonly timesliceMs: number;
  readonly filename?: string;
  readonly raw: BrowserAudioCaptureOptions;
}

function validateCaptureOptions(
  options: BrowserAudioCaptureOptions,
): ValidatedCaptureOptions {
  if (options === null || typeof options !== "object") {
    throw new BrowserAudioCaptureValidationError("options must be an object");
  }
  const timesliceMs = options.timesliceMs ?? 250;
  if (!Number.isSafeInteger(timesliceMs) || timesliceMs < 1 || timesliceMs > 60_000) {
    throw new BrowserAudioCaptureValidationError(
      "timesliceMs must be an integer from 1 through 60000",
    );
  }
  const formats = validateFormats(options.formats, "formats");
  const first = formats[0]!;
  const filename = safeFilename(options.filename, first.container);
  return Object.freeze({
    formats,
    maxBytes: validateMaxBytes(options.maxBytes),
    maxDurationSeconds: validateMaxDuration(options.maxDurationSeconds),
    timesliceMs,
    ...(filename === undefined ? {} : { filename }),
    raw: options,
  });
}

interface DeferredStop {
  readonly promise: Promise<BrowserAudioCaptureResult | null>;
  readonly resolve: (value: BrowserAudioCaptureResult | null) => void;
  readonly reject: (error: BrowserAudioCaptureError) => void;
}

function deferredStop(): DeferredStop {
  let resolve!: (value: BrowserAudioCaptureResult | null) => void;
  let reject!: (error: BrowserAudioCaptureError) => void;
  const promise = new Promise<BrowserAudioCaptureResult | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Creates a browser-only, dependency-injected microphone capture controller. */
export function createBrowserAudioCaptureController(
  rawOptions: BrowserAudioCaptureOptions,
): BrowserAudioCaptureController {
  const options = validateCaptureOptions(rawOptions);
  let state: BrowserAudioCaptureState = Object.freeze({ status: "idle" });
  const listeners = new Set<BrowserAudioCaptureListener>();
  const stoppedTracks = new WeakSet<BrowserAudioTrack>();
  const urlRevokers = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  let pendingStopRequest: Promise<BrowserAudioCaptureResult | null> | null = null;
  let stopOperation: DeferredStop | null = null;
  let stream: BrowserAudioStream | null = null;
  let recorder: BrowserAudioMediaRecorder | null = null;
  let format: TranscriptionAudioFormatDescriptor | null = null;
  let chunks: Blob[] | null = null;
  let accumulatedBytes = 0;
  let startedAtMs = 0;
  let timer: unknown;
  let clock: BrowserAudioClock | null = null;
  let dataListener: BrowserAudioRecorderListener | null = null;
  let stopListener: BrowserAudioRecorderListener | null = null;
  let errorListener: BrowserAudioRecorderListener | null = null;
  let sessionFingerprint = "";

  const publish = (next: BrowserAudioCaptureState): void => {
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Host observers cannot alter capture cleanup or state progression.
      }
    }
  };

  const stopTracks = (value: BrowserAudioStream | null): void => {
    if (value === null) return;
    let tracks: readonly BrowserAudioTrack[];
    try {
      tracks = value.getTracks();
    } catch {
      return;
    }
    for (const track of tracks) {
      if (stoppedTracks.has(track)) continue;
      stoppedTracks.add(track);
      try {
        track.stop();
      } catch {
        // Continue exact-once cleanup for every acquired track.
      }
    }
  };

  const clearTimer = (): void => {
    if (timer === undefined) return;
    try {
      clock?.clearTimeout(timer);
    } catch {
      // Timer cleanup is best-effort at an injected host boundary.
    }
    timer = undefined;
  };

  const detachRecorder = (): void => {
    if (recorder !== null) {
      const registrations = [
        ["dataavailable", dataListener],
        ["stop", stopListener],
        ["error", errorListener],
      ] as const;
      for (const [type, listener] of registrations) {
        if (listener === null) continue;
        try {
          recorder.removeEventListener(type, listener);
        } catch {
          // Continue releasing the remaining browser-owned resources.
        }
      }
    }
    dataListener = null;
    stopListener = null;
    errorListener = null;
  };

  const releaseActive = (): void => {
    clearTimer();
    detachRecorder();
    stopTracks(stream);
    stream = null;
    recorder = null;
    format = null;
    chunks = null;
    accumulatedBytes = 0;
    startedAtMs = 0;
    sessionFingerprint = "";
  };

  const rejectStop = (error: BrowserAudioCaptureError): void => {
    const operation = stopOperation;
    stopOperation = null;
    operation?.reject(error);
  };

  const stopNativeRecorder = (value: BrowserAudioMediaRecorder | null): void => {
    if (value === null) return;
    try {
      if (value.state === "inactive") return;
    } catch {
      // Still attempt stop when an injected state getter fails.
    }
    try {
      value.stop();
    } catch {
      // Public cleanup and failure classification do not retain native errors.
    }
  };

  const fail = (code: BrowserAudioCaptureErrorCode): BrowserAudioCaptureError => {
    const error = new BrowserAudioCaptureError(code);
    const activeRecorder = recorder;
    detachRecorder();
    stopNativeRecorder(activeRecorder);
    releaseActive();
    publish({ status: "failed", error: safeError(code) });
    rejectStop(error);
    return error;
  };

  const elapsedSeconds = (): number => {
    const now = clock?.now() ?? startedAtMs;
    if (!Number.isFinite(now)) return TRANSCRIPTION_LIMITS.audioDurationSecondsMin;
    return Math.min(
      options.maxDurationSeconds,
      Math.max(
        TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
        Math.max(0, now - startedAtMs) / 1_000,
      ),
    );
  };

  const complete = (): void => {
    const operation = stopOperation;
    if (operation === null || format === null || chunks === null) return;
    const completedFormat = format;
    const completedChunks = chunks;
    const completedBytes = accumulatedBytes;
    const durationSeconds = elapsedSeconds();

    if (completedBytes === 0) {
      fail("empty_capture");
      return;
    }
    if (completedBytes > options.maxBytes) {
      fail("byte_limit_exceeded");
      return;
    }

    let source: Blob;
    try {
      source = (options.raw.blobApi ?? nativeBlobApi()).create(completedChunks, {
        type: completedFormat.media_type,
      });
    } catch {
      fail("blob_unavailable");
      return;
    }
    if (!blobLike(source) || source.size !== completedBytes) {
      fail("blob_unavailable");
      return;
    }

    const fingerprint = `browser-audio:${opaqueHash(JSON.stringify([
      sessionFingerprint,
      completedFormat.media_type,
      completedFormat.container,
      completedBytes,
      durationSeconds,
      options.filename ?? "",
    ]))}`;
    const metadata: BrowserAudioMetadata = Object.freeze({
      format: completedFormat,
      byteSize: completedBytes,
      durationSeconds,
      ...(options.filename === undefined ? {} : { filename: options.filename }),
      fingerprint,
    });

    let objectUrl: BrowserAudioObjectUrl | undefined;
    try {
      if (options.raw.objectUrl !== undefined) {
        objectUrl = createObjectUrl(source, options.raw.objectUrl, (revoke) => {
          urlRevokers.add(revoke);
        });
      }
    } catch {
      releaseActive();
      fail("object_url_unavailable");
      return;
    }

    const result: BrowserAudioCaptureResult = Object.freeze({
      source,
      ...metadata,
      ...(objectUrl === undefined ? {} : { objectUrl }),
    });
    releaseActive();
    publish({ status: "stopped", ...metadata });
    try {
      options.raw.onResult?.(result);
    } catch {
      // The host owns the result; callback failures do not invalidate capture.
    }
    stopOperation = null;
    operation.resolve(result);
  };

  const initiateStop = (): Promise<BrowserAudioCaptureResult | null> => {
    if (stopOperation !== null) return stopOperation.promise;
    if (state.status === "stopped") return Promise.resolve(null);
    if (state.status === "failed") {
      return Promise.reject(new BrowserAudioCaptureError(state.error.code));
    }
    if (state.status !== "recording" || recorder === null) {
      return Promise.reject(new BrowserAudioCaptureError("invalid_state"));
    }
    stopOperation = deferredStop();
    const promise = stopOperation.promise;
    clearTimer();
    try {
      if (recorder.state === "inactive") complete();
      else recorder.stop();
    } catch {
      fail("recorder_failed");
    }
    return promise;
  };

  const start = (): Promise<void> => {
    if (disposed) return Promise.reject(new BrowserAudioCaptureError("disposed"));
    if (startPromise !== null) return startPromise;
    if (state.status !== "idle") {
      return Promise.reject(new BrowserAudioCaptureError("invalid_state"));
    }

    const runGeneration = ++generation;
    startPromise = (async () => {
      let recorderApi: BrowserAudioMediaRecorderApi;
      try {
        recorderApi = options.raw.mediaRecorder ?? nativeMediaRecorderApi();
      } catch {
        throw fail("recorder_unavailable");
      }

      let selected: TranscriptionAudioFormatDescriptor | undefined;
      for (const candidate of options.formats) {
        let supported: boolean;
        try {
          supported = recorderApi.isTypeSupported(candidate.media_type);
        } catch {
          continue;
        }
        if (supported) {
          selected = candidate;
          break;
        }
      }
      if (selected === undefined) throw fail("unsupported_format");

      let mediaDevices: BrowserAudioMediaDevices;
      try {
        mediaDevices = options.raw.mediaDevices ?? nativeMediaDevices();
      } catch {
        throw fail("media_devices_unavailable");
      }
      format = selected;
      publish({ status: "requesting", format: selected });

      let acquired: BrowserAudioStream;
      try {
        acquired = await mediaDevices.getUserMedia({
          audio: options.raw.audioConstraints ?? true,
          video: false,
        });
      } catch {
        if (runGeneration !== generation || disposed) {
          throw new BrowserAudioCaptureError(disposed ? "disposed" : "cancelled");
        }
        throw fail("permission_denied");
      }
      if (runGeneration !== generation || disposed) {
        stopTracks(acquired);
        throw new BrowserAudioCaptureError(disposed ? "disposed" : "cancelled");
      }
      stream = acquired;

      try {
        recorder = recorderApi.create(acquired, { mimeType: selected.media_type });
      } catch {
        throw fail("recorder_failed");
      }
      if (runGeneration !== generation || disposed) {
        releaseActive();
        throw new BrowserAudioCaptureError(disposed ? "disposed" : "cancelled");
      }

      clock = options.raw.clock ?? nativeClock();
      const now = clock.now();
      if (!Number.isFinite(now)) throw fail("recorder_failed");
      chunks = [];
      accumulatedBytes = 0;
      startedAtMs = now;
      captureSequence += 1;
      sessionFingerprint = `${captureSequence}:${now}`;

      dataListener = (event): void => {
        const data = (event as Partial<BrowserAudioDataEvent> | null)?.data;
        if (chunks === null || !blobLike(data) || data.size === 0) return;
        // MediaRecorder commonly includes codec parameters in emitted chunks.
        // The host contract describes the container MIME type, not its codecs.
        if (data.type.length > 0 && data.type.split(";", 1)[0]?.trim().toLowerCase() !== selected.media_type) {
          fail("unsupported_format");
          return;
        }
        if (accumulatedBytes > Number.MAX_SAFE_INTEGER - data.size) {
          fail("byte_limit_exceeded");
          return;
        }
        chunks.push(data);
        accumulatedBytes += data.size;
        publish({
          status: "recording",
          format: selected,
          accumulatedBytes,
          elapsedSeconds: elapsedSeconds(),
        });
        if (accumulatedBytes >= options.maxBytes) {
          void initiateStop().catch(() => undefined);
        }
      };
      stopListener = (): void => complete();
      errorListener = (): void => {
        fail("recorder_failed");
      };
      try {
        recorder.addEventListener("dataavailable", dataListener);
        recorder.addEventListener("stop", stopListener);
        recorder.addEventListener("error", errorListener);
        recorder.start(options.timesliceMs);
        publish({
          status: "recording",
          format: selected,
          accumulatedBytes: 0,
          elapsedSeconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
        });
        timer = clock.setTimeout(() => {
          void initiateStop().catch(() => undefined);
        }, options.maxDurationSeconds * 1_000);
      } catch {
        throw fail("recorder_failed");
      }
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  };

  const cancelActive = (code: "cancelled" | "disposed"): void => {
    generation += 1;
    if (state.status === "stopped") {
      for (const revoke of urlRevokers) revoke();
      urlRevokers.clear();
      return;
    }
    if (state.status === "failed") return;
    const activeRecorder = recorder;
    detachRecorder();
    stopNativeRecorder(activeRecorder);
    const error = new BrowserAudioCaptureError(code);
    releaseActive();
    publish({ status: "failed", error: safeError(code) });
    rejectStop(error);
    for (const revoke of urlRevokers) revoke();
    urlRevokers.clear();
  };

  return Object.freeze({
    getState: () => state,
    subscribe(listener: BrowserAudioCaptureListener): () => void {
      if (typeof listener !== "function") {
        throw new BrowserAudioCaptureValidationError("listener must be a function");
      }
      listeners.add(listener);
      try {
        listener(state);
      } catch {
        // Match later notifications: observers cannot affect the controller.
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    start,
    stop(): Promise<BrowserAudioCaptureResult | null> {
      if (state.status === "requesting" && startPromise !== null) {
        if (pendingStopRequest !== null) return pendingStopRequest;
        pendingStopRequest = startPromise
          .then(() => initiateStop())
          .finally(() => {
            pendingStopRequest = null;
          });
        return pendingStopRequest;
      }
      return initiateStop();
    },
    async cancel(): Promise<void> {
      if (disposed || state.status === "failed") return;
      cancelActive("cancelled");
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      cancelActive("disposed");
      listeners.clear();
    },
  });
}

/** Validates a host-selected Blob/File without reading or copying its contents. */
export function intakeBrowserAudio(
  source: Blob,
  options: BrowserAudioIntakeOptions,
): BrowserAudioIntakeResult {
  if (!blobLike(source)) {
    throw new BrowserAudioCaptureValidationError("source must be a Blob or File");
  }
  if (options === null || typeof options !== "object") {
    throw new BrowserAudioCaptureValidationError("options must be an object");
  }
  const formats = validateFormats(options.acceptedFormats, "acceptedFormats");
  const maxBytes = validateMaxBytes(options.maxBytes);
  const format = FORMAT_BY_MEDIA_TYPE.get(source.type as TranscriptionAudioMimeType);
  if (format === undefined || !formats.includes(format)) {
    throw new BrowserAudioCaptureError("unsupported_format");
  }
  if (source.size < TRANSCRIPTION_LIMITS.audioBytesMin) {
    throw new BrowserAudioCaptureError("empty_capture");
  }
  if (source.size > maxBytes) {
    throw new BrowserAudioCaptureError("byte_limit_exceeded");
  }

  const maxDurationSeconds = validateMaxDuration(
    options.maxDurationSeconds ?? TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
  );
  if (options.durationSeconds !== undefined) {
    if (
      !Number.isFinite(options.durationSeconds) ||
      options.durationSeconds < TRANSCRIPTION_LIMITS.audioDurationSecondsMin ||
      options.durationSeconds > maxDurationSeconds
    ) {
      throw new BrowserAudioCaptureValidationError(
        `durationSeconds must be from ${TRANSCRIPTION_LIMITS.audioDurationSecondsMin} through maxDurationSeconds`,
      );
    }
  }

  const file = source as Blob & {
    readonly name?: unknown;
    readonly lastModified?: unknown;
  };
  const filename = safeFilename(
    options.filename ?? file.name,
    format.container,
  );
  const lastModified =
    typeof file.lastModified === "number" && Number.isFinite(file.lastModified)
      ? file.lastModified
      : 0;
  const fingerprint = `browser-audio:${opaqueHash(JSON.stringify([
    typeof file.name === "string" ? file.name : "",
    source.type,
    source.size,
    lastModified,
    options.durationSeconds ?? null,
  ]))}`;

  let objectUrl: BrowserAudioObjectUrl | undefined;
  if (options.objectUrl !== undefined) {
    objectUrl = createObjectUrl(source, options.objectUrl);
  }
  const dispose = (): void => objectUrl?.revoke();
  return Object.freeze({
    source,
    format,
    byteSize: source.size,
    ...(options.durationSeconds === undefined
      ? {}
      : { durationSeconds: options.durationSeconds }),
    ...(filename === undefined ? {} : { filename }),
    fingerprint,
    ...(objectUrl === undefined ? {} : { objectUrl }),
    dispose,
  });
}
