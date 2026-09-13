# Handrail standard composer

`HandrailComposer` places the multiline draft above a toolbar with Add and an optional shield on the left, and dictation and a green Send arrow on the right. Padding is 8 logical pixels, draft inset 4 pixels, corner radius 16 pixels, minimum draft height 26 pixels, and controls 40 pixels with smaller icons. The draft starts at one line and grows with its content.

Pass the shared draft controller, an authenticated SDK session adapter, the host attachment picker, and current availability. The SDK session owns admission, synchronization and the pending-message journal; hosts supply authentication and storage bindings. `input` and `voiceControls` let existing authenticated text/paste/transcription implementations share the layout. Dictation appends to the draft and never sends it. Default device dictation uses speech_to_text; platform availability and microphone/speech permissions apply.

`decoration`, `inputTextStyle`, and `sendButtonStyle` customize the stock composer for host branding and dark themes. Unspecified properties retain the standard defaults. Custom input widgets retain their own typography. Set `showAttachmentControl: false` when the authenticated gateway does not offer uploads; this hides the toolbar control without changing upload policy.

`showApprovalControl` only changes visibility. Default `approvalMode` is required. Wire `onApprovalModeChanged` to the per-message preference and include `handrailApprovalMetadata(mode)` in the retained gateway ChatRequest metadata. The server must validate and resolve this preference before executing tools, while enforcing account permissions. Never implement automatic mode by confirming old proposal cards in the client. Changes to the preference apply to the next submitted request; retained retries preserve their original preference.

Image paste is opt-in via `onPasteImage`. The default editor includes a Paste image context action and Control/Command+V handling with normal text fallback. All pasted bytes go through the host's normal attachment validation and upload path. Prefer the default input. A custom `input` must receive the same `focusNode` as the composer, and remains responsible for its platform input actions.

Add NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription on iOS. On Android declare RECORD_AUDIO and query android.speech.RecognitionService. See the speech_to_text and pasteboard package documentation for supported platforms. Pasteboard's FileProvider, if configured, should expose only the application cache required by the integration.


## Shared message Markdown

Use `HandrailMarkdown(data: answer)` for assistant messages in custom or legacy
transcripts. CommonMark/GFM parsing (including aligned tables) is owned by this
SDK. Wide tables scroll horizontally inside the message. `selectable: true`
retains text selection; `isUserMessage: true` displays the source literally.
Links only navigate through the optional safe `onTapLink(text, href, title)` host
callback; inline images stay disabled. `styleSheet` accepts `MarkdownStyleSheet`
(re-exported by this library) for host typography/colors. Table scrolling remains
SDK-owned. See `docs/markdown-rendering.md` in the repository for the shared
React/Flutter contract and examples.

## Shared submission lifecycle

`HandrailDraftController` clears only the submitted edit revision when the SDK
session calls `onAccepted`. Keep the input `enabled` during a response and gate
`canSend` separately on authorization, prompt bounds, pending intent and active
turn state. Send restores input focus immediately; completion never restores
focus or clears a later draft. Enter sends, Shift+Enter inserts a newline, and
IME composition does not send. Set `sendOnEnter: false` for newline behavior.
The Stop control uses the supplied authoritative cancellation callback.

Use `HandrailComposerDrafts<TAttachment>` for per-conversation text and file
selections. Call `select(conversationId)` during navigation; `controller` and
`attachments` expose the selected draft. `submit` captures its exact text edit
and file selections; `retry` reconciles the retained submission without using a
new draft. Removed/re-added identical files and identical later text survive
admission. A background callback only affects its originating conversation.
`discard(id)`, `clear()` and `dispose()` invalidate old callbacks. Dispose the
workspace on account changes. Validate files in the host business adapter before
`addAttachments`; upload through the authenticated SDK attachment endpoint.

```dart
// Keep one drafts workspace per authenticated assistant surface.
final drafts = HandrailComposerDrafts<HostAttachment>();
drafts.select(session.conversationId);

// Listen to drafts and session.changes to rebuild the shared composer.
// The host captures its route/business request and approval preference once.
await drafts.submit((text, files, accepted) async {
  final request = await prepareHostRequest(text, files, approvalMode);
  return session.sendMessage(
    operationId: createOperationId(),
    clientId: 'my-project-mobile',
    request: request,
    pendingStore: authenticatedPendingStore,
    onAccepted: (_) => accepted(),
  );
});

// On an uncertain-send Retry action, preserve the saved request/IDs.
await drafts.retry((accepted) => session.retryPendingMessage(
  authenticatedPendingStore, onAccepted: (_) => accepted(),
));
```

`allowExpand: true` adds an SDK-owned full-message editor; `maxLines` controls
the compact field and `expandedEditorTitle` supplies branding. The expanded
editor shares the draft without submitting, and closes when its controller or
authorization scope changes. `expandKey` and `expandedInputKey` support host UI
qualification without replacing the editor.

These APIs are a local consolidation candidate until included in a public,
committed SDK revision. Consumer manifests/locks must use that full HTTPS Git
SHA through normal Flutter resolution. Test-only candidate package resolution
is not an installed dependency or evidence of production/mobile parity.
Shared upload orchestration and a complete Flutter workspace/history surface
remain in progress. Authenticated transcription is now available through the
negotiated SDK client binding below; device dictation is the explicit fallback
when an app has not configured a transcription transport.


## Authenticated microphone input

The optional composer can bind directly to a configured gateway:

```dart
final capability = session.capabilities?.transcription;
HandrailComposer(
  controller: drafts.controller,
  transcriptionScope: (authenticatedClient, session.conversationId),
  transcribeAudio: capability == null ? null
      : authenticatedClient.transcriptionForConversation(
          session.conversationId, capability: capability),
  transcriptionMaximumBytes: capability?.maximumBytes ?? 25 * 1024 * 1024,
  transcriptionMaximumDuration: const Duration(seconds: 60), // Clamp to gateway limit.
  transcriptionMaxDraftLength: 2000,
  // Configure canSend/onSend/onStop from the SDK session as above.
);
```

Require a negotiated WAV format and clamp the capture duration to the advertised
maximum. A null transport retains the device-dictation fallback; hosts can hide
unavailable voice using `voiceControls: const []`. Control visibility does not
change server authorization. `HandrailTranscriptionControl` is also exported for
custom shells; its `transcribe` accepts the same SDK-bound function.

The shared control owns permission/capture progress, Stop/Discard, bounded PCM/WAV
capture, per-recording identity, cancellation, authenticated HTTP retry and draft
insertion. It inserts into the latest draft without sending. If the combined text
is too long, it retains the transcript for insertion after editing, without a
second provider request. Retryable transport failures retain the exact audio/key;
unknown outcomes cannot retry. Scope/controller changes, backgrounding and
unmount cancel observation and exclude late results. Audio is cleared after use.
`audioRecorderFactory` is an optional platform/test adapter; the default is SDK
`HandrailPcmAudioRecorder`, consolidated from Mills' former implementation.

Recording uses [record 6.2.1](https://pub.dev/packages/record/versions/6.2.1), the
version already used by Mills. The widgets now require Dart 3.5 and Flutter 3.24.
Declare `RECORD_AUDIO` on Android and `NSMicrophoneUsageDescription` on iOS;
permission is requested when the microphone is activated. Device speech recognition
additionally needs its platform setup described above. No provider API key belongs
in the mobile app. A normal SDK dependency update must resolve the recorder plugin
and platform dependencies through Flutter; explicit candidate test configurations
do not qualify native plugin registration or live microphone behavior.
