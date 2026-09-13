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

The SDK blocks submission throughout capture and transcription while leaving text editing available. Stop finishes capture; Cancel aborts and releases it. Success appends to the latest draft. Conversation switches and unmount discard late text. Retrying a recoverable delivery error keeps the recording's original idempotency key and blocks submission again.

Server operation identities include the authenticated assistant, tenant, scope, principal, conversation and recording identity. Fingerprints include audio bytes, media type, provider and model. Completed results replay across instances; conflicting input is rejected. An uncertain dispatch returns `outcome_unknown` and is not automatically repeated. Late provider usage after a disconnected or timed-out browser request is still recorded; unknown usage is never replaced with estimated tokens. Provider-reported audio duration remains separate evidence, not a token receipt.

`createTranscriptionHttpClient` supports an explicit `encoding: "multipart"` adapter for existing authenticated routes during migration. Standard SDK routes use raw audio with conversation, duration and idempotency headers. The Express gateway middleware accepts both parsed binary bodies and native incoming streams; mount it behind the host's authentication and request protections. Do not use a JSON-only body adapter for audio.

The provider HTTP implementation follows the official [file transcription and speech hints contract](https://developers.openai.com/api/docs/guides/speech-to-text), checked on 2026-09-12. No live provider calls are part of the local fixture tests.

## Current release boundary

These APIs are local candidate changes under the shared assistant consolidation goal. Applications pinned to the existing committed SDK SHA do not receive them yet. Consumer migration requires a reviewed committed SDK revision and matching HTTPS Git dependency/lockfile updates through the normal install/build pipeline. These tests do not establish deployed parity.
