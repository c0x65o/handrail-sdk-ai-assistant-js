import { createHash } from "node:crypto";
import { ConversationCatalogError, type ConversationCatalog } from "../conversation/catalog.js";
import { PostgresProviderOperationStore, PostgresProviderOperationConflictError, PostgresProviderOperationUncertainError,
  PostgresOpenAIAudioUsageEvidenceStore, type PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import { parseNormalizedUsageReceipt, projectProviderUsageToReceipt } from "../usage.js";
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
      if (!bytes.length || !matchesContainer(bytes, format.media_type)) throw new TranscriptionOperationError("invalid_request");
      const text = await withSignal(options.transcribe({ bytes, mediaType: format.media_type, durationSeconds, conversationId, idempotencyKey, signal }, context), signal);
      if (!text.trim() || text.length > 20_000) throw new TranscriptionOperationError("internal_failure");
      return response(200, { ok: true, value: { text: text.trim() } });
    } catch (error) {
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "transcription", phase: "failed",
        code: "transcription_failed", cause: error });
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
      const operations = new PostgresProviderOperationStore(bundle.persistence, context.tenantId, context.scopeId);
      return operations.run({ operationId,
        requestFingerprint: hash(JSON.stringify([input.mediaType, hash(input.bytes), provider.providerId, provider.modelId])),
        parseResult: (value) => {
          if (typeof value !== "string" || !value.trim() || value.length > 20_000) throw new TranscriptionOperationError("internal_failure");
          return value;
        },
        execute: async () => {
          await bundle.usageAdmissions?.admit({ idempotency_key: operationId + ":admission", provider: provider.providerId,
            model: provider.modelId, client_request_id: operationId, trace_id: operationId });
          let usageAttempted = false;
          const recordUsage: Parameters<typeof provider.transcribe>[0]["recordUsage"] = async (usage, status) => {
            if (usageAttempted) throw new Error("Transcription usage was already reported.");
            usageAttempted = true;
            const identity = { usage_receipt_id: operationId + ":usage", conversation_id: input.conversationId,
              turn_id: operationId, logical_request_id: operationId, trace_id: operationId,
              attempt: { id: operationId + ":attempt", index: 0 }, continuation: { id: operationId + ":continuation", index: 0 },
              provider_id: provider.providerId, model_id: provider.modelId, attribution: context.attribution,
              source: "provider" as const, terminal_status: status };
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
              const serviceEnvironmentId = context.attribution.service_environment.id;
              if (!serviceEnvironmentId) throw new TypeError("Transcription evidence requires a server-derived service environment.");
              const { version, tokens, provider_cost, ...evidenceContext } = receipt;
              void version; void tokens; void provider_cost;
              await new PostgresOpenAIAudioUsageEvidenceStore(bundle.persistence, context.tenantId, serviceEnvironmentId)
                .capture({ version: 1, context: evidenceContext, usage: audioUsage });
            }
            await bundle.usageReceiptSink?.capture(receipt);
          };
          try {
            input.signal.throwIfAborted();
            const text = await provider.transcribe({ ...input, context, idempotencyKey: operationId, recordUsage });
            if (!usageAttempted) await recordUsage(null, "completed");
            input.signal.throwIfAborted();
            return text;
          } catch (error) {
            if (!usageAttempted) await recordUsage(null, input.signal.aborted ? "cancelled" : "failed");
            throw error;
          }
        },
      });
    },
  });
}
