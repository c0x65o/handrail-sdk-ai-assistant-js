# Standard composer

All React styled presets now use `StandardChatComposer`, also exported from `@handrail/ai-assistant/react/styled` for custom application shells. Flutter consumers use the companion `flutter/handrail_ai_widgets` package. The composer follows the supplied two-row reference: multiline text at the upper left, Add and shield at the lower left, dictation and green circular Send at the lower right. The send arrow becomes Stop only while a response is running.

React uses 10px padding (8px on narrow screens), a 2px draft inset, a 26px minimum draft, 18px corners (16px on narrow screens), and 32px controls with a 34px Send button (40px on touch pointers). Long drafts grow to 120px then scroll. The default composer does not offer manual message, attachment, or voice Retry controls. Supported image/document uploads, drag/drop, and clipboard image paste use the existing composer uploader, including validation, progress, cancellation, and removal. Voice input changes the draft without submitting. A supplied `voiceControls` adapter takes precedence over browser SpeechRecognition; unsupported browsers receive a visible availability message. Recognition is stopped on unmount and submission is blocked while listening.

## Approval controls

`approvalMode` is `required` or `automatic`; default is `required`. `showApprovalControl={false}` hides the shield without changing permissions. `onApprovalModeChange` enables the accessible Auto-approve changes switch; without it, the badge is read-only. The application must connect this preference to its authorized execution path before enabling the switch.

The endpoint launcher writes an explicitly supplied mode into `metadata.handrail_approval_mode`. Custom shells call `withComposerApprovalMode(request, mode)`. The backend reads `composerApprovalModeFromRequest(request)`, rejects invalid values, and resolves it before provider execution. This field is a user preference, not an authorization grant. User roles, tenant boundaries, tool availability, validation, audit trails, and execution idempotency still apply. Model tool arguments must never control this preference.

Mills and Spartan map the preference to their existing server mutation resolvers. Explicit required mode overrides legacy automatic configuration; explicit automatic mode uses the existing authorized automatic path. Requests from old clients that omit the field retain the existing server default. Each original message retains its mode in the durable request, so changing the control affects the next submission, not running work or retries. Standalone SDK hosts must wire the same helper into their own approval policy before exposing an editable control.

These are local SDK/host candidates. They apply after the updated SDK artifact and backend/UI changes are built and deployed together; no registry publication or deployment is performed by these changes.

Browser recognition contract: https://webaudio.github.io/web-speech-api/
Flutter package documentation: https://pub.dev/packages/speech_to_text and https://pub.dev/packages/pasteboard

The hosts retain their reviewed public Git SDK dependency. Compact compatibility styles cover that pinned version until the updated SDK source receives a reviewed release commit. No SDK archives are introduced.
