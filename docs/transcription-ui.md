# Shared speech input

The optional React UI can capture a microphone recording, send it through the application's authenticated gateway, and insert the transcript into the current draft. It does not submit the draft. The server owns conversation authorization, bounded audio intake, provider dispatch identity, durable replay, usage admission and usage receipts. Applications supply authentication, speech vocabulary and feature settings.

## Standard integration

`openaiResponses` enables the SDK transcription provider when using its built-in HTTP transport. It reads the existing `OPENAI_API_KEY`, `OPENAI_TRANSCRIPTION_MODEL` (default `gpt-transcribe`) and `HANDRAIL_AI_SPEECH_HINTS` settings. Its explicit `transcription` options override these defaults. A custom Responses `request` adapter must explicitly configure transcription, so a test or alternate provider cannot accidentally dispatch microphone audio to a default provider.

```tsx
// Server: add to the application's existing authenticated assistant setup.
const assistant = await createHandrailAssistant({
  id: "company-assistant",
  authorize: authorizeAssistantRequest,
  persistence,
  provider: openaiResponses({
    model: configuredChatModel,
    transcription: { speechHints: { keywords: ["Cents"], languages: ["en"] } },
  }),
  tools: businessTools,
});

// Browser: the launcher negotiates and configures the standard microphone.
<HandrailAssistantLauncher
  endpoint="/api/assistant"
  key={accountId}
  protectedRequest={authenticatedRequest}
/>
```

The application must derive `tenantId`, `scopeId`, `principalId` and attribution on the server. OpenAI audio evidence requires a known server-derived `attribution.service_environment.id`. The host's `authorize` receives the `transcription` gateway action, allowing its existing CSRF, authentication and rate-limit policy to apply. The SDK checks conversation access and active lifecycle again before reading audio or returning a saved result.

For an existing `HandrailChatWorkspace`, pass the negotiated client explicitly:

```tsx
<HandrailChatWorkspace
  {...workspaceOptions}
  transcription={client.transcription && client.capabilities.transcription
    ? { transcribe: client.transcription, capability: client.capabilities.transcription }
    : false}
  renderComposerActions={({ composer }) => <PromptCounter draft={composer.draft} />}
/>
```

`renderComposerActions` is independent of `renderVoiceControls`; a character counter no longer replaces the microphone. `voiceControls`/`renderVoiceControls` remain explicit overrides for another voice experience. Set server `transcription: false` to disable the endpoint; set UI `transcription: false` to hide its control. Hiding a control does not change server authorization. The endpoint launcher never silently replaces a disabled or unavailable authenticated microphone with browser speech recognition. Lower-level `StandardChatComposer` retains its browser-dictation fallback for compatibility unless `transcription` is configured or disabled.

## Capture, retry and cancellation

Defaults are WebM, M4A and WAV, 25 MiB, and 60 seconds of browser capture. `capability` can reduce limits and supported formats. `timeoutMilliseconds` bounds server intake and provider observation (60 seconds by default). The declared browser duration is not measured provider usage or a billing quantity.

The shared composer leaves text editing available during capture and transcription. Stop finishes capture and appends the transcript to the latest draft for review. Send (including the configured send keyboard shortcut) finishes capture, waits for transcription, then submits the combined draft once. Send is available during recording even with an empty draft; pending attachments and other submission blocks still apply. Failed transcription preserves the draft without sending, and retry does not restore an earlier send request.

The default control has no cancel X. After success it returns to the microphone button without a persistent success notice. Conversation switches, unmount and an active response still cancel capture and discard late text. Retrying a recoverable delivery error keeps the recording's original idempotency key. The lower-level cancellation API remains available for custom hosts and lifecycle cleanup.

Server operation identities include the authenticated assistant, tenant, scope, principal, conversation and recording identity. Fingerprints include audio bytes, media type, provider and model. Completed results replay across instances; conflicting input is rejected. An uncertain dispatch returns `outcome_unknown` and is not automatically repeated. Late provider usage after a disconnected or timed-out browser request is still recorded; unknown usage is never replaced with estimated tokens. Provider-reported audio duration remains separate evidence, not a token receipt.

`createTranscriptionHttpClient` supports an explicit `encoding: "multipart"` adapter for existing authenticated routes during migration. Standard SDK routes use raw audio with conversation, duration and idempotency headers. The Express gateway middleware accepts both parsed binary bodies and native incoming streams; mount it behind the host's authentication and request protections. Do not use a JSON-only body adapter for audio.

The provider HTTP implementation follows the official [file transcription and speech hints contract](https://developers.openai.com/api/docs/guides/speech-to-text), checked on 2026-09-12. No live provider calls are part of the local fixture tests.

## Current release boundary

These APIs are local candidate changes under the shared assistant consolidation goal. Applications pinned to the existing committed SDK SHA do not receive them yet. Consumer migration requires a reviewed committed SDK revision and matching HTTPS Git dependency/lockfile updates through the normal install/build pipeline. These tests do not establish deployed parity.

### Compatibility server adapters

Prefer `createHandrailAssistant` with `openaiTranscription` for new integrations.
Existing authenticated multipart endpoints can reuse `validateTranscriptionAudio`,
`createOpenAIAudioTranscriber`, `runRetainedTranscription` and
`createTranscriptionUsageRecorder` from `@handrail/ai-assistant/server/assistant`
while preserving historical operation IDs, result envelopes and persistence
namespaces. Audio validation copies the bytes before asynchronous work and does
not invent a duration for older clients. The retained-operation helper owns the
deadline, one physical dispatch, result validation and usage fallback. A data-only
`result: { encode, decode }` codec preserves a legacy envelope such as `{ text }`;
`preserveWhitespace: true` on the provider preserves historical text formatting.
Completed requests replay; failed or uncertain claims cannot dispatch again.

`createOpenAITranscriptionRequest` is the lower-level multipart HTTP transport.
It accepts the retained provider idempotency key and an abort signal and performs
no automatic physical retries. Authenticate and validate configuration before
claiming an operation. Prefer the retained-operation helper to a custom timer or
retry loop. Late provider usage is still recorded after a deadline, while late
text cannot complete the retained claim.

For a compatibility endpoint that already owns an SDK durable operation claim,
`runTranscriptionAttempt` provides the same bounded physical attempt used by
`runRetainedTranscription`. It requires the caller to authorize and retain that
claim first. It does not create another identity or authorize a retry. Supply a
usage-recording adapter for an existing receipt contract; the SDK prevents a
second/fallback receipt after the first capture attempt, including capture
failure. `maximumTextLength` can preserve a smaller host limit (Mills uses 4,000);
the default is 20,000. Both new provider results and completed replay are bounded
when using `runRetainedTranscription`.

The recorder accepts server-derived receipt identity, an audio-evidence store
factory and a durable receipt capture callback. It writes reported audio evidence
before the normalized receipt, preserves provider duration without estimating
tokens, and rejects a second recording attempt even when the first storage write
fails. Evidence writes remain independent of request cancellation. These adapters
share implementation with the default high-level transcription path; they do not
replace host authorization or authorize replay of uncertain provider operations.

`createAIRuntimeUsageDelivery` from `@handrail/ai-assistant/server/usage-control`
provides optional startup and periodic outbox delivery, shared by the high-level
assistant and compatibility adapters. Await `ready` where startup must finish
before serving; call `stop()` on shutdown. It coalesces scheduled flushes, survives
delivery errors, and stops new work without deleting receipts or abandoning an
in-flight acknowledgement. The host supplies the existing durable sink and
namespace, not another scheduler.
