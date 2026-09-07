# Project speech hints

Projects can supply vocabulary, recording context, and expected languages to the
SDK's OpenAI transcription capability:

```ts
const transcription = createOpenAITranscriptionCapability({
  model: "gpt-transcribe",
  speech_hints: {
    keywords: ["Aegis", "Spartan Cyber Services", "K-1"],
    context: "Company financial operations.",
    languages: ["en", "es"],
  },
  resolve_audio,
  request,
  capture_usage,
});
```

`speech_hints` is optional. The SDK copies, validates, trims, and deduplicates
the project configuration when constructing the capability. Each project keeps
its own configuration; no module-global vocabulary is shared between projects.
An explicit per-recording `language` overrides the project's language list.

For `gpt-transcribe`, vocabulary maps to OpenAI's `keywords`, context maps to
`prompt`, and languages map to the plural `languages` field. The SDK never sends
both `language` and `languages`. Regional language tags are reduced to their
primary code except regional `zh-*` tags. The provider determines which
language codes it supports. Existing single-language models use a vocabulary
prompt and singular `language`; multiple languages require the current models.
Diarization models reject this hints configuration.

Hints are recognition context, not draft text or a required list of output
words. The host still receives the provider's transcript unchanged. Hints are
not included in results, usage observations, or error messages.

## Project configuration

Mills and Spartan read the optional server environment setting
`HANDRAIL_AI_SPEECH_HINTS` automatically. Set its value in the project's
environment configuration to a JSON object, for example:

```json
{"keywords":["Aegis","Spartan Cyber Services"],"context":"Company financial operations.","languages":["en"]}
```

Other SDK hosts can use the same contract:

```ts
import {
  createOpenAITranscriptionCapability,
  transcriptionSpeechHintsFromEnvironment,
} from "@handrail/ai-assistant/providers/openai/transcription";

const transcription = createOpenAITranscriptionCapability({
  model: "gpt-transcribe",
  speech_hints: transcriptionSpeechHintsFromEnvironment(process.env),
  resolve_audio,
  request,
  capture_usage,
});
```

Remove the setting or use `{}` to disable hints. No separate OpenAI credential
is required. An environment change applies after the server picks up that
configuration; programmatic SDK defaults apply to the newly created capability.
Replaying a completed host recording keeps its original saved transcript and
does not invoke the provider again just because the configuration changed.

Limits are conservative SDK settings: 100 keywords, 120 characters per keyword,
2,000 context characters, 10 language hints, and 4,000 total characters.
Keywords must be single-line literals without angle brackets or control
characters. Invalid configuration fails before provider invocation and does not
echo its contents. These are SDK bounds, not documented provider maximums.

## OpenAI request bridge

The host's injected `request` function must forward the projected fields. With
an OpenAI client whose generated types predate structured hints, use its
documented request-body override:

```ts
request: async ({ file, ...fields }, options) => {
  const body = { ...fields, file: await toFile(file.bytes, file.filename, { type: file.media_type }) };
  return openai.audio.transcriptions.create(body, {
    body,
    signal: options.signal,
    headers: { "Idempotency-Key": options.idempotency_key },
  });
}
```

For raw multipart requests, append repeated `keywords[]` and `languages[]`
fields and the single `prompt` field. Existing usage capture still records the
provider-reported usage; this feature does not change the billing contract.

The Mills and Spartan candidates retain their reviewed SDK dependency pin and
include a matching compatibility snapshot until these exports receive a
reviewed SDK release. Their host integration can deploy independently of that
release; other consumers need the updated SDK artifact. No deployment is
performed by these source changes.

Source: [OpenAI transcription context documentation](https://developers.openai.com/api/docs/guides/speech-to-text#add-transcription-context).
