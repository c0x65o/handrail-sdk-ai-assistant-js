# Handrail standard composer

`HandrailComposer` places the multiline draft above a toolbar with Add and an optional shield on the left, and dictation and a green Send arrow on the right. Padding is 8 logical pixels, draft inset 4 pixels, corner radius 16 pixels, minimum draft height 26 pixels, and controls 40 pixels with smaller icons. The draft starts at one line and grows with its content.

Pass a controller, the host attachment picker, the host send/cancel callbacks, and current availability. The host owns uploads, authorization, and network persistence. `input` and `voiceControls` let existing authenticated text/paste/transcription implementations share the layout. Dictation appends to the draft and never sends it. Default device dictation uses speech_to_text; platform availability and microphone/speech permissions apply.

`showApprovalControl` only changes visibility. Default `approvalMode` is required. Wire `onApprovalModeChanged` to the per-message preference and include `handrailApprovalMetadata(mode)` in the retained gateway ChatRequest metadata. The server must validate and resolve this preference before executing tools, while enforcing account permissions. Never implement automatic mode by confirming old proposal cards in the client. Changes to the preference apply to the next submitted request; retained retries preserve their original preference.

Image paste is opt-in via `onPasteImage`. The default editor includes a Paste image context action and Control/Command+V handling with normal text fallback. All pasted bytes go through the host's normal attachment validation and upload path. A custom `input` retains its own platform paste handling.

Add NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription on iOS. On Android declare RECORD_AUDIO and query android.speech.RecognitionService. See the speech_to_text and pasteboard package documentation for supported platforms. Pasteboard's FileProvider, if configured, should expose only the application cache required by the integration.
