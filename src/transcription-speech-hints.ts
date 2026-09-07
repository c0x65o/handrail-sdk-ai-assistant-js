/** Project-owned context for recognition, never required transcript output. */
export interface TranscriptionSpeechHints {
  readonly keywords?: readonly string[];
  readonly context?: string;
  readonly languages?: readonly string[];
}

/** SDK configuration bounds, not a claim about provider maximums. */
export const TRANSCRIPTION_SPEECH_HINT_LIMITS = Object.freeze({
  keywords: 100, keywordLength: 120, contextLength: 2000, languages: 10, totalLength: 4000,
});

export function parseTranscriptionSpeechHints(value: unknown): TranscriptionSpeechHints {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalidHints();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidHints();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(fields).some((field) => !("value" in field)) ||
    Object.keys(fields).some((key) => !["keywords", "context", "languages"].includes(key))) throw invalidHints();
  const source = value as Record<string, unknown>;
  const list = (key: "keywords" | "languages", maxCount: number, maxLength: number): string[] => {
    if (source[key] === undefined) return [];
    if (!Array.isArray(source[key]) || source[key].length > maxCount) throw invalidHints();
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of source[key]) {
      if (typeof item !== "string" || item.length > maxLength || /[<>\p{Cc}]/u.test(item)) throw invalidHints();
      const text = item.trim().normalize("NFC");
      if (!text || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      result.push(key === "languages" ? text.toLowerCase() : text);
    }
    return result;
  };
  const keywords = list("keywords", TRANSCRIPTION_SPEECH_HINT_LIMITS.keywords, TRANSCRIPTION_SPEECH_HINT_LIMITS.keywordLength);
  const languages = list("languages", TRANSCRIPTION_SPEECH_HINT_LIMITS.languages, 12);
  if (languages.some((language) => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(language))) throw invalidHints();
  if (source.context !== undefined && (typeof source.context !== "string" ||
    source.context.length > TRANSCRIPTION_SPEECH_HINT_LIMITS.contextLength || source.context.includes("\0"))) throw invalidHints();
  const context = (source.context as string | undefined)?.trim();
  if ((context?.length ?? 0) + keywords.join(", ").length + languages.join(", ").length >
    TRANSCRIPTION_SPEECH_HINT_LIMITS.totalLength) throw invalidHints();
  return Object.freeze({
    ...(keywords.length ? { keywords: Object.freeze(keywords) } : {}),
    ...(context ? { context } : {}),
    ...(languages.length ? { languages: Object.freeze(languages) } : {}),
  });
}

/** Read the same project setting in any host; no provider credential is involved. */
export function transcriptionSpeechHintsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): TranscriptionSpeechHints {
  const raw = environment.HANDRAIL_AI_SPEECH_HINTS;
  if (!raw?.trim()) return parseTranscriptionSpeechHints(undefined);
  try { return parseTranscriptionSpeechHints(JSON.parse(raw)); }
  catch { throw new TypeError("HANDRAIL_AI_SPEECH_HINTS must be a valid speech hints JSON object."); }
}

export interface OpenAITranscriptionHintFields {
  readonly prompt?: string;
  readonly keywords?: readonly string[];
  readonly languages?: readonly string[];
  readonly language?: string;
}

/** Translate project hints; an explicit per-recording language takes precedence. */
export function openAITranscriptionHintFields(
  model: string, value?: TranscriptionSpeechHints, language?: string,
): OpenAITranscriptionHintFields {
  const hints = parseTranscriptionSpeechHints(value);
  const currentModel = /^gpt-(?:live-)?transcribe(?:$|-)/u.test(model);
  const primary = language?.toLowerCase().split("-")[0];
  const recordingLanguage = language?.toLowerCase().startsWith("zh-") && currentModel
    ? language.toLowerCase() : primary;
  const languages = recordingLanguage ? [recordingLanguage] : hints.languages?.map((hint) =>
    currentModel && hint.startsWith("zh-") ? hint : hint.split("-")[0]!);
  const distinctLanguages = languages ? [...new Set(languages)] : undefined;
  if (currentModel) return Object.freeze({
    ...(hints.context ? { prompt: hints.context } : {}),
    ...(hints.keywords ? { keywords: hints.keywords } : {}),
    ...(distinctLanguages?.length ? { languages: Object.freeze(distinctLanguages) } : {}),
  });
  if (model.includes("diarize") && Object.keys(hints).length) {
    throw new TypeError("Speech hints are not supported by this diarization model.");
  }
  if ((distinctLanguages?.length ?? 0) > 1) throw new TypeError("Multiple speech languages require gpt-transcribe.");
  const prompt = [hints.context, hints.keywords?.length ? `Vocabulary: ${hints.keywords.join(", ")}` : undefined]
    .filter(Boolean).join("\n");
  const legacyLanguage = distinctLanguages?.[0];
  return Object.freeze({
    ...(prompt ? { prompt } : {}),
    ...(legacyLanguage && /^[a-z]{2}$/u.test(legacyLanguage) ? { language: legacyLanguage } : {}),
  });
}

function invalidHints(): TypeError {
  // Never echo project vocabulary or context in errors.
  return new TypeError("Speech hints must contain bounded context, single-line keywords, and language codes.");
}
