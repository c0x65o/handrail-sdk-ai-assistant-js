import { describe, expect, it } from "vitest";
import { parseTranscriptionSpeechHints, transcriptionSpeechHintsFromEnvironment } from "../src/index.js";
import { openAITranscriptionHintFields } from "../src/providers/openai-transcription.js";

describe("project speech hints", () => {
  it("normalizes project vocabulary into an immutable copy", () => {
    const source = { keywords: ["  Aegis  ", "aegis", "", "Spartan Cyber Services"], context: " Financial operations. ",
      languages: ["EN", "en", "es"] };
    const hints = parseTranscriptionSpeechHints(source);
    source.keywords.push("Added later");
    expect(hints).toEqual({ keywords: ["Aegis", "Spartan Cyber Services"], context: "Financial operations.", languages: ["en", "es"] });
    expect(Object.isFrozen(hints)).toBe(true);
    expect(Object.isFrozen(hints.keywords)).toBe(true);
    expect(Object.isFrozen(hints.languages)).toBe(true);
  });

  it("reads optional project JSON without introducing any provider fields by default", () => {
    expect(transcriptionSpeechHintsFromEnvironment({})).toEqual({});
    expect(transcriptionSpeechHintsFromEnvironment({ HANDRAIL_AI_SPEECH_HINTS: " " })).toEqual({});
    expect(openAITranscriptionHintFields("gpt-transcribe")).toEqual({});
    expect(transcriptionSpeechHintsFromEnvironment({ HANDRAIL_AI_SPEECH_HINTS: '{"keywords":["Mills Family Office"]}' }))
      .toEqual({ keywords: ["Mills Family Office"] });
    expect(() => transcriptionSpeechHintsFromEnvironment({ HANDRAIL_AI_SPEECH_HINTS: "private invalid data" }))
      .toThrow("HANDRAIL_AI_SPEECH_HINTS must be a valid speech hints JSON object.");
  });

  it.each([
    null, [], new Date(), { unexpected: "private term" }, { keywords: "private term" },
    { keywords: ["private\nterm"] }, { keywords: ["private\rterm"] }, { keywords: ["<private>"] },
    { keywords: ["a".repeat(121)] }, { keywords: Array(101).fill("term") },
    { context: "a".repeat(2001) }, { context: 5 }, { languages: ["not a code"] },
    { keywords: Array.from({ length: 100 }, (_, index) => `${index}-${"a".repeat(60)}`) },
  ])("rejects invalid hints without including their values: %#", (input) => {
    expect(() => parseTranscriptionSpeechHints(input)).toThrow("Speech hints must contain bounded context, single-line keywords, and language codes.");
  });

  it("uses structured fields and plural language hints for current models", () => {
    const hints = { keywords: ["Aegis"], context: "Financial operations.", languages: ["en-US", "es", "zh-TW"] };
    expect(openAITranscriptionHintFields("gpt-transcribe", hints)).toEqual({
      keywords: ["Aegis"], prompt: "Financial operations.", languages: ["en", "es", "zh-tw"],
    });
    expect(openAITranscriptionHintFields("gpt-transcribe", hints, "fr-CA")).toEqual({
      keywords: ["Aegis"], prompt: "Financial operations.", languages: ["fr"],
    });
    expect(openAITranscriptionHintFields("gpt-transcribe", {}, "en-US")).toEqual({ languages: ["en"] });
  });

  it("preserves legacy single-language requests and projects vocabulary as prompt context", () => {
    expect(openAITranscriptionHintFields("gpt-4o-transcribe", { keywords: ["Aegis"], context: "Operations.", languages: ["en"] }))
      .toEqual({ prompt: "Operations.\nVocabulary: Aegis", language: "en" });
    expect(openAITranscriptionHintFields("whisper-1", {}, "en-US")).toEqual({ language: "en" });
    expect(openAITranscriptionHintFields("whisper-1", {}, "fil")).toEqual({});
    expect(() => openAITranscriptionHintFields("whisper-1", { languages: ["en", "es"] })).toThrow("Multiple speech languages require gpt-transcribe.");
    expect(() => openAITranscriptionHintFields("gpt-4o-transcribe-diarize", { keywords: ["private term"] }))
      .toThrow("Speech hints are not supported by this diarization model.");
  });
});
