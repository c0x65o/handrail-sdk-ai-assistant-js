import { openAITranscriptionHintFields, parseOpenAIReportedAudioUsage, parseTranscriptionSpeechHints,
  transcriptionSpeechHintsFromEnvironment, type OpenAITranscriptionRequestFunction,
  type TranscriptionSpeechHints } from "../providers/openai-transcription.js";
import { DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, validateTranscriptionHttpCapability,
  type TranscriptionHttpCapability } from "../transcription-http.js";
import { TranscriptionOperationError } from "../transcription.js";
import type { HandrailAssistantAuthorizationContext } from "./assistant.js";
import type { AssistantTranscriptionProvider } from "./transcription.js";

export interface HandrailOpenAITranscriptionOptions {
  /** Defaults to OPENAI_TRANSCRIPTION_MODEL, then gpt-transcribe. */
  readonly model?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly organization?: string;
  readonly project?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly speechHints?: TranscriptionSpeechHints;
  readonly capability?: TranscriptionHttpCapability;
  readonly timeoutMilliseconds?: number;
  /** Optional provider transport adapter. Admission, evidence and durable replay stay in the SDK. */
  readonly request?: OpenAITranscriptionRequestFunction;
}

/** Standard authenticated speech provider. Hosts supply credentials, vocabulary and feature settings. */
export function openaiTranscription<TContext extends HandrailAssistantAuthorizationContext = HandrailAssistantAuthorizationContext>(
  options: HandrailOpenAITranscriptionOptions = {},
): AssistantTranscriptionProvider<TContext> {
  const model = options.model ?? (process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-transcribe");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(model) || /^sk-/iu.test(model)) throw new TypeError("Invalid transcription model.");
  const capability = validateTranscriptionHttpCapability(options.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY);
  const hints = openAITranscriptionHintFields(model,
    parseTranscriptionSpeechHints(options.speechHints ?? transcriptionSpeechHintsFromEnvironment(process.env)));
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!options.request && !apiKey) throw new TypeError("OPENAI_API_KEY or openaiTranscription.apiKey is required");
  const endpoint = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "")}/audio/transcriptions`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const request: OpenAITranscriptionRequestFunction = options.request ?? (async (input, { signal, idempotency_key }) => {
    const body = new FormData();
    body.set("file", new Blob([new Uint8Array(input.file.bytes)], { type: input.file.media_type }), input.file.filename);
    body.set("model", input.model); body.set("response_format", input.response_format);
    if (input.prompt) body.set("prompt", input.prompt);
    if (input.language) body.set("language", input.language);
    for (const word of input.keywords ?? []) body.append("keywords[]", word);
    for (const language of input.languages ?? []) body.append("languages[]", language);
    const headers = new Headers({ authorization: `Bearer ${apiKey}`, "idempotency-key": idempotency_key, accept: "application/json" });
    const organization = options.organization ?? process.env.OPENAI_ORG_ID;
    const project = options.project ?? process.env.OPENAI_PROJECT_ID;
    if (organization) headers.set("OpenAI-Organization", organization);
    if (project) headers.set("OpenAI-Project", project);
    // No automatic HTTP retries: uncertain dispatches retain their durable claim.
    const response = await fetcher(endpoint, { method: "POST", headers, body, signal });
    if (!response.ok) throw new TranscriptionOperationError(response.status === 429 ? "rate_limited"
      : response.status === 408 || response.status === 504 ? "deadline_exceeded"
        : response.status === 413 ? "limit_exceeded" : response.status === 415 ? "unsupported_audio" : "service_unavailable");
    return response.json();
  });
  return Object.freeze({ providerId: "openai", modelId: model, capability,
    ...(options.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: options.timeoutMilliseconds }),
    async transcribe(input) {
      const format = capability.formats.find((candidate) => candidate.media_type === input.mediaType);
      if (!format) throw new TranscriptionOperationError("unsupported_audio");
      const output = await request({ model, file: { bytes: input.bytes, media_type: input.mediaType,
        filename: "recording." + format.container }, response_format: "json", ...hints },
      { signal: input.signal, idempotency_key: input.idempotencyKey });
      const result = output as { text?: unknown; usage?: unknown } | null;
      let usage;
      try { usage = parseOpenAIReportedAudioUsage(result?.usage); }
      catch {
        await input.recordUsage({ kind: "openai_audio", usage: { type: "unavailable" } }, "failed");
        throw new TranscriptionOperationError("internal_failure");
      }
      const validText = typeof result?.text === "string" && result.text.trim().length > 0 && result.text.length <= 20_000;
      // This may finish after cancellation; incurred provider evidence must still be stored.
      await input.recordUsage({ kind: "openai_audio", usage }, validText ? "completed" : "failed");
      if (!validText) throw new TranscriptionOperationError("internal_failure");
      return (result!.text as string).trim();
    },
  } satisfies AssistantTranscriptionProvider<TContext>);
}
