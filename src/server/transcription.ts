import { createHash } from "node:crypto";
import { ConversationCatalogError, type ConversationCatalog } from "../conversation/catalog.js";
import { PostgresProviderOperationStore, PostgresProviderOperationConflictError, PostgresProviderOperationUncertainError,
  PostgresProviderOperationDeletedError, PostgresConversationDeletedError, PostgresOpenAIAudioUsageEvidenceStore, type PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import { parseNormalizedUsageReceipt, projectProviderUsageToReceipt, type ProviderUsageReceiptContext, type NormalizedUsageReceipt } from "../usage.js";
import type { ProviderUsage } from "../providers/index.js";
import type { OpenAIReportedAudioUsage } from "../providers/openai-audio-usage.js";
import { TranscriptionOperationError, transcriptionSafeError, type TranscriptionAudioMimeType } from "../transcription.js";
import { DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, validateTranscriptionHttpCapability,
  type TranscriptionHttpCapability } from "../transcription-http.js";
import type { HandrailAssistantAuthorizationContext } from "./assistant.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

export interface TranscriptionHttpServerInput {
  readonly bytes: Uint8Array;
  readonly mediaType: TranscriptionAudioMimeType;
  /** Declared capture duration, not measured or billable provider usage. */
  readonly durationSeconds: number;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface AssistantTranscriptionProvider<TContext> {
  readonly providerId: string;
  readonly modelId: string;
  readonly capability?: TranscriptionHttpCapability;
  /** Bounds intake and provider observation. Defaults to 60 seconds. */
  readonly timeoutMilliseconds?: number;
  transcribe(input: TranscriptionHttpServerInput & {
    readonly context: TContext;
    readonly recordUsage: (usage: AssistantTranscriptionUsage, status: "completed" | "failed" | "cancelled") => Promise<void>;
  }): Promise<string>;
}

export type AssistantTranscriptionUsage = ProviderUsage | { readonly kind: "openai_audio"; readonly usage: OpenAIReportedAudioUsage } | null;

function withSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function response(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
}

async function readAudio(request: Request, maximumBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > maximumBytes) throw new TranscriptionOperationError("limit_exceeded");
  if (!request.body) throw new TranscriptionOperationError("invalid_request");
  const reader = request.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  request.signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) throw new TranscriptionOperationError("limit_exceeded");
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { request.signal.removeEventListener("abort", onAbort); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function matchesContainer(bytes: Uint8Array, mediaType: string): boolean {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (mediaType === "audio/webm") return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mediaType === "audio/mp4") return bytes.length >= 12 && ascii(4, 4) === "ftyp";
  if (mediaType === "audio/wav") return bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
  if (mediaType === "audio/flac") return ascii(0, 4) === "fLaC";
  if (mediaType === "audio/ogg") return ascii(0, 4) === "OggS";
  return mediaType === "audio/mpeg" && (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0));
}

/** Validates already-authenticated raw or multipart audio without inventing a
 * duration for older clients. Copies bytes before asynchronous claim/dispatch.
 */
export function validateTranscriptionAudio(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly idempotencyKey: string;
  readonly durationSeconds?: number;
}, capability: TranscriptionHttpCapability = DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY) {
  const limits = validateTranscriptionHttpCapability(capability);
  const mediaType = input.mediaType.split(";", 1)[0]?.trim().toLowerCase();
  const format = limits.formats.find(candidate => candidate.media_type === mediaType);
  if (!format) throw new TranscriptionOperationError("unsupported_audio");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.idempotencyKey) || !input.bytes.length ||
    !matchesContainer(input.bytes, format.media_type)) throw new TranscriptionOperationError("invalid_request");
  if (input.bytes.length > limits.maximumBytes) throw new TranscriptionOperationError("limit_exceeded");
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) ||
    input.durationSeconds <= 0 || input.durationSeconds > limits.maximumDurationSeconds)) {
    throw new TranscriptionOperationError("invalid_request");
  }
  return { ...input, bytes: new Uint8Array(input.bytes), mediaType: format.media_type };
}

/** Authenticated gateway resource. The caller authenticates before invoking this handler. */
export function createTranscriptionHttpHandler<TContext>(options: {
  readonly capability?: TranscriptionHttpCapability;
  readonly timeoutMilliseconds?: number;
  readonly diagnostics?: AiDiagnosticSink;
  readonly authorizeConversation: (context: TContext, conversationId: string) => Promise<void>;
  readonly transcribe: (input: TranscriptionHttpServerInput, context: TContext) => Promise<string>;
}) {
  const capability = validateTranscriptionHttpCapability(options.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY);
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300_000) {
    throw new TypeError("The transcription timeout must be between 1 and 300000 milliseconds.");
  }
  return async (request: Request, context: TContext): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new TranscriptionOperationError("deadline_exceeded")), timeoutMilliseconds);
    timeout.unref?.();
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    try {
      const conversationId = request.headers.get("x-handrail-conversation-id") ?? "";
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      const durationSeconds = Number(request.headers.get("x-handrail-audio-duration-seconds"));
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (!conversationId || conversationId.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(idempotencyKey)
        || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > capability.maximumDurationSeconds) {
        throw new TranscriptionOperationError("invalid_request");
      }
      const format = capability.formats.find((candidate) => candidate.media_type === mediaType);
      if (!format) throw new TranscriptionOperationError("unsupported_audio");
      await withSignal(options.authorizeConversation(context, conversationId), signal);
      // Reading uses the same bounded signal without consuming an unauthorized request body.
      const bytes = await readAudio(new Request(request, { signal }), capability.maximumBytes);
      const audio = validateTranscriptionAudio({ bytes, mediaType: format.media_type, durationSeconds, idempotencyKey }, capability);
      const text = await withSignal(options.transcribe({ ...audio, durationSeconds, conversationId, signal }, context), signal);
      if (!text.trim() || text.length > 20_000) throw new TranscriptionOperationError("internal_failure");
      return response(200, { ok: true, value: { text: text.trim() } });
    } catch (error) {
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "transcription", phase: "failed",
        code: "transcription_failed", cause: error });
      if (error instanceof PostgresProviderOperationDeletedError || error instanceof PostgresConversationDeletedError) {
        return response(404, { ok: false, error: { code: "forbidden", message: "This conversation is unavailable." } });
      }
      if (error instanceof ConversationCatalogError) return response(error.code === "not_found" ? 404 : 403,
        { ok: false, error: { code: "forbidden", message: "This conversation is unavailable." } });
      const code = request.signal.aborted ? "cancelled" : deadline.signal.aborted ? "deadline_exceeded"
        : error instanceof PostgresProviderOperationConflictError ? "idempotency_conflict"
        : error instanceof PostgresProviderOperationUncertainError ? "outcome_unknown"
          : error instanceof TranscriptionOperationError ? error.code : "service_unavailable";
      const status = code === "deadline_exceeded" ? 504 : code === "cancelled" ? 408 : code === "limit_exceeded" ? 413 : code === "unsupported_audio" ? 415
        : code === "invalid_request" ? 400 : code === "idempotency_conflict" || code === "outcome_unknown" ? 409 : code === "rate_limited" ? 429 : 503;
      return response(status, { ok: false, error: transcriptionSafeError(code) });
    } finally { clearTimeout(timeout); }
  };
}

/** One physical transcription attempt's receipt and audio evidence lifecycle.
 * Supply server-derived attribution and existing persistence namespaces. These
 * callbacks are intentionally independent of request cancellation: incurred
 * usage must remain durable even when the caller has left.
 */
export function createTranscriptionUsageRecorder(options: {
  readonly identity: Omit<ProviderUsageReceiptContext, "quality" | "terminal_status">;
  readonly evidence: (serviceEnvironmentId: string) => Pick<PostgresOpenAIAudioUsageEvidenceStore, "capture">;
  readonly capture?: (receipt: NormalizedUsageReceipt) => Promise<void>;
}) {
  let attempted = false;
  return {
    get attempted() { return attempted; },
    async record(usage: AssistantTranscriptionUsage, status: "completed" | "failed" | "cancelled"): Promise<void> {
      if (attempted) throw new Error("Transcription usage was already reported.");
      attempted = true;
      const identity = { ...options.identity, terminal_status: status };
      const unavailable = { status: "unavailable" as const };
      const audioUsage = usage && "kind" in usage ? usage.usage : null;
      const tokens = audioUsage?.type === "tokens" ? audioUsage : null;
      const quantity = (value: number | null | undefined) => value == null ? unavailable : { status: "reported" as const, value };
      const receipt = usage && !("kind" in usage) ? projectProviderUsageToReceipt(usage, { ...identity, quality: "reported" })
        : parseNormalizedUsageReceipt({ version: 1, ...identity, tokens: {
          input_tokens: quantity(tokens?.input_tokens), cached_input_tokens: quantity(tokens?.input_token_details?.cached_tokens),
          output_tokens: quantity(tokens?.output_tokens), reasoning_tokens: unavailable, total_tokens: quantity(tokens?.total_tokens),
        }, provider_cost: unavailable });
      if (audioUsage) {
        const serviceEnvironmentId = options.identity.attribution.service_environment.id;
        if (!serviceEnvironmentId) throw new TypeError("Transcription evidence requires a server-derived service environment.");
        const { version, tokens, provider_cost, ...evidenceContext } = receipt;
        void version; void tokens; void provider_cost;
        await options.evidence(serviceEnvironmentId).capture({ version: 1, context: evidenceContext, usage: audioUsage });
      }
      await options.capture?.(receipt);
    },
  };
}

export interface TranscriptionAttemptOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  /** Defaults to 20000; a compatibility adapter may preserve a smaller limit. */
  readonly maximumTextLength?: number;
  readonly admit?: () => Promise<unknown>;
  readonly usage: () => Pick<ReturnType<typeof createTranscriptionUsageRecorder>, "record">;
  readonly transcribe: (input: {
    readonly signal: AbortSignal;
    readonly recordUsage: ReturnType<typeof createTranscriptionUsageRecorder>["record"];
  }) => Promise<string>;
}

function transcriptionLimits(options: Pick<TranscriptionAttemptOptions, "timeoutMilliseconds" | "maximumTextLength">) {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  const maximumTextLength = options.maximumTextLength ?? 20_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300_000) {
    throw new TypeError("The transcription timeout must be between 1 and 300000 milliseconds.");
  }
  if (!Number.isSafeInteger(maximumTextLength) || maximumTextLength < 1 || maximumTextLength > 20_000) {
    throw new TypeError("The transcription text limit must be between 1 and 20000 characters.");
  }
  return { timeoutMilliseconds, maximumTextLength };
}

function transcriptionResult(text: unknown, maximumTextLength: number): string {
  if (typeof text !== "string" || !text.trim() || text.length > maximumTextLength) throw new TranscriptionOperationError("internal_failure");
  return text;
}

/** One bounded physical attempt, after the caller has authorized and retained
 * its operation claim. Prefer runRetainedTranscription for new server adapters.
 * Late usage is recorded; a late result never completes the caller's claim.
 */
export async function runTranscriptionAttempt(options: TranscriptionAttemptOptions): Promise<string> {
  const { timeoutMilliseconds, maximumTextLength } = transcriptionLimits(options);
  options.signal?.throwIfAborted();
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new TranscriptionOperationError("deadline_exceeded")), timeoutMilliseconds);
  timeout.unref?.();
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const work = async () => {
    signal.throwIfAborted();
    await options.admit?.();
    signal.throwIfAborted();
    const usage = options.usage();
    let attempted = false;
    const recordUsage: ReturnType<typeof createTranscriptionUsageRecorder>["record"] = async (value, status) => {
      if (attempted) throw new Error("Transcription usage was already reported.");
      attempted = true;
      await usage.record(value, status);
    };
    try {
      const text = transcriptionResult(await options.transcribe({ signal, recordUsage }), maximumTextLength);
      if (!attempted) await recordUsage(null, "completed");
      signal.throwIfAborted();
      return text;
    } catch (error) {
      if (!attempted) await recordUsage(null, signal.aborted ? "cancelled" : "failed");
      throw error;
    }
  };
  try { return await withSignal(work(), signal); }
  finally { clearTimeout(timeout); }
}

export interface RetainedTranscriptionOptions<TResult = string> extends TranscriptionAttemptOptions {
  readonly operations: Pick<PostgresProviderOperationStore, "run">;
  readonly operationId: string;
  readonly requestFingerprint: string;
  /** A data-only codec preserves an existing store's result envelope. */
  readonly result?: {
    readonly encode: (text: string) => TResult;
    readonly decode: (value: unknown) => unknown;
  };
}

/** Durable transcription shared by the default gateway and legacy endpoints.
 * Authorization and configuration validation must finish before calling this.
 * Failed/uncertain claims are retained; no timeout permits another dispatch.
 */
export async function runRetainedTranscription<TResult = string>(options: RetainedTranscriptionOptions<TResult>): Promise<TResult> {
  const { maximumTextLength } = transcriptionLimits(options);
  options.signal?.throwIfAborted();
  const encode = options.result?.encode ?? ((text: string) => text as TResult);
  const decode = options.result?.decode ?? ((value: unknown) => value);
  return options.operations.run({
    operationId: options.operationId,
    requestFingerprint: options.requestFingerprint,
    parseResult: value => encode(transcriptionResult(decode(value), maximumTextLength)),
    execute: async () => encode(await runTranscriptionAttempt(options)),
  });
}

/** Durable dispatch and usage accounting shared by every high-level assistant. */
export function createAssistantTranscription<TContext extends HandrailAssistantAuthorizationContext>(options: {
  readonly assistantId: string;
  readonly provider: AssistantTranscriptionProvider<TContext>;
  readonly catalogFor: (context: TContext) => ConversationCatalog<TContext>;
  readonly bundleFor: (context: TContext) => PostgresAssistantPersistenceBundle<TContext>;
  readonly diagnostics?: AiDiagnosticSink;
}) {
  const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  return createTranscriptionHttpHandler<TContext>({
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.provider.capability ? { capability: options.provider.capability } : {}),
    ...(options.provider.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.provider.timeoutMilliseconds }),
    authorizeConversation: async (context, conversationId) => {
      const { descriptor } = await options.catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
      if (descriptor.lifecycle !== "active") throw new ConversationCatalogError("forbidden", "get");
    },
    transcribe: async (input, context) => {
      const bundle = options.bundleFor(context);
      const operationId = "transcription-" + hash(JSON.stringify([options.assistantId, context.tenantId, context.scopeId,
        context.principalId, input.conversationId, input.idempotencyKey]));
      const provider = options.provider;
      const operations = new PostgresProviderOperationStore(bundle.persistence, context.tenantId, context.scopeId).forConversation(input.conversationId);
      return runRetainedTranscription({ operations, operationId,
        requestFingerprint: hash(JSON.stringify([input.mediaType, hash(input.bytes), provider.providerId, provider.modelId])),
        signal: input.signal,
        ...(provider.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: provider.timeoutMilliseconds }),
        admit: async () => { await bundle.usageAdmissions?.admit({ idempotency_key: operationId + ":admission", provider: provider.providerId,
          model: provider.modelId, client_request_id: operationId, trace_id: operationId }); },
        usage: () => createTranscriptionUsageRecorder({
          identity: { usage_receipt_id: operationId + ":usage", conversation_id: input.conversationId,
            turn_id: operationId, logical_request_id: operationId, trace_id: operationId,
            attempt: { id: operationId + ":attempt", index: 0 }, continuation: { id: operationId + ":continuation", index: 0 },
            provider_id: provider.providerId, model_id: provider.modelId, attribution: context.attribution,
            source: "provider" as const },
          evidence: serviceEnvironmentId => new PostgresOpenAIAudioUsageEvidenceStore(
            bundle.persistence, context.tenantId, serviceEnvironmentId),
          ...(bundle.usageReceiptSink ? { capture: bundle.usageReceiptSink.capture } : {}),
        }),
        transcribe: ({ signal, recordUsage }) => provider.transcribe({ ...input, context, signal,
          idempotencyKey: operationId, recordUsage }),
      });
    },
  });
}
