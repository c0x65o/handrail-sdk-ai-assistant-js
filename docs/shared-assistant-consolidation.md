# Shared assistant consolidation

> Historical consolidation ledger. The current disposable-chat cleanup objective
> and its source/installed/production boundaries are recorded in
> [assistant cleanup progress](assistant-cleanup-goal-progress.md). Saved-data
> migration adapters described below are not current integration requirements.

Goal: `6f19391a-7545-4926-85bb-13761e8a404c`. This is the chronological implementation and evidence ledger for making the optional SDK UI suitable for 35 projects. The [final local acceptance review](./shared-assistant-acceptance.md) supersedes historical remaining-work notes below; neither document establishes deployment or production parity.

The target ownership is SDK-managed assistant behavior with host formatting, business logic, and explicit feature settings. Cents must receive Spartan's sending experience by consuming the SDK, not by copying Spartan components.

## Current feature ownership

The requirement-by-requirement result, remaining host responsibilities, final
validation receipts and immutable-release handoff are recorded in
[shared-assistant-acceptance.md](./shared-assistant-acceptance.md).

- SDK: draft admission/edit revisions, Send/Stop/focus/keyboard behavior, file
  queues and protected downloads, approval preferences, authenticated dictation,
  conversation history/read state, transcripts/activity/recovery, reusable
  provider/transcription/usage and file-retention/content-validation helpers.
- Hosts: branding/formatting, route context, authenticated identity, domain tools
  and authorization, required business approvals, provider/feature settings,
  and compatibility mappings for existing saved data.

The following sections retain the chronological checks and discoveries. Their
"remaining" statements describe that stage, not new outstanding implementation
work after the final acceptance review.

## Sending implementation contract

`ConversationRuntimeSendMessageInput.onAccepted` is an optional synchronous presentation notification with conversation, message and turn identities. It runs only after `persistAdmittedTurn` succeeds, before response observation. Admission does not establish business-operation success. A throwing UI notification cannot strand an admitted turn. Runtime adapters that forward send input should retain the callback.

`useConversationComposer` captures the submitted edit revision and composer lifecycle. Admission clears text only when that exact revision remains current. It releases only submitted attachment resources. Later identical text is a new draft, never eligible for clearing by the previous send. Old conversation completion/error callbacks cannot change the current draft or sending state. Adapters lacking acceptance notification retain completion-based fallback behavior, with the same revision protection.

The input stays editable; submission and file intake remain gated independently. This avoids enabling file uploads simply because the next text draft can be edited. Focus changes happen during Send activation, not on response events.

## Verification ledger

Initial SDK candidate checks on 2026-09-12:

- Focused suites: `test/react-composer.test.tsx`, `test/react-primitives.test.tsx`, `test/standard-composer.test.tsx`, and `test/runtime.test.ts`, one worker. All 82 tests passed after the final unmount/focus refinement.
- `npm run typecheck` passed after lifecycle and intake changes.
- Scoped ESLint passed for the changed sending source/tests.
- `npm run build` passed for the final sending source.
- The broader React run exposed two stale expectations: an already removed visible idle label and already updated browser-audio error wording. Their expectations were corrected without weakening idle-state or safe-error-code assertions. `npx vitest run test/react test/standard-composer.test.tsx --maxWorkers=1 --minWorkers=1` then passed all 266 tests in 33 files. The 39 runtime tests are separate; the focused React tests overlap this broader run and must not be added twice.
- Regressions cover acceptance before completion, identical subsequent drafts, edits before admission, completed/failed/cancelled/disconnected outcomes, duplicate attempts, conversation switches, busy file intake, focus retention and callback exceptions not stopping runtime execution.

Still required: additional real-runtime integration/browser evidence, full consumer/migration validation, mobile validation and final requirement-by-requirement audit. A passing SDK source test does not prove that a Git-pinned application consumes this candidate.

Authenticated STT candidate checks on 2026-09-12:

- `npm run typecheck` passed with the new client, server, React control and integration fixtures.
- Eleven relevant suites passed, one worker: transcription contract, HTTP, OpenAI transcription, React transcription, composer transcription, endpoint launcher, server transcription, assistant, conversation titles, client bootstrap and application gateway: 143 tests. These overlap previous suites and are not an additional unique total.
- Six new composer cases verify duplicate capture prevention, submission blocks, latest-draft insertion, repeated capture failures, stable retry identity, cancellation/switch/unmount disposal, and a counter beside the standard microphone.
- Six local PGlite server cases verify durable replay, conflict rejection, replay authorization and archived access, observed usage without duration-to-token estimation, failed receipt capture, cancellation/timeout with late provider evidence, negotiated server disablement and SDK-owned multipart provider requests. Ten HTTP cases cover protected requests, endpoint origin, raw Express streams, bounded/stalled intake and safe errors.
- Database validation caught an audio-evidence scope mismatch: evidence is partitioned by authoritative service environment rather than the conversation workspace scope. Fixed before the passing run.
- SDK Coverage Q&A search for human-answered transcription decisions returned no entries. The active user objective remains authoritative.
- Scoped ESLint and `npm run build` passed for the speech source and regression fixtures.

History candidate checks on 2026-09-12:

- `useConversationHistory` keeps catalog selection and mutation identities in SDK state. New retries reuse their catalog identity after failed hydration; rejected Archive preserves the selected runtime/draft. Old-account loads cannot publish into a replacement scope. Background previews hydrate at most 20 active conversations by default, configurable from 0 to 100.
- The endpoint launcher now defaults to `historyLayout: "sidebar"`. Low-level workspace consumers can select that layout; `"compact"` and explicit custom/disabled pickers remain available. `historyOptions` controls preload, read recovery, automatic selection and refresh notifications. Creation from the standard launcher forwards the controller's stable idempotency key.
- Eight history cases use real SDK runtimes, catalog and registry. They cover all-page listing, bounded preloads, active/archived/unread filters, selection races, New retries, archive rejection/success, automatic and manual read recovery, account changes, and the actual shared workspace's archived composer/approval behavior. Launcher startup-recovery expectations were updated for the new visible sidebar.
- `scripts/check-assistant-layout.mjs` passed in Chromium at 320, 390, 768 and 1280 pixels. It renders synthetic SDK component markup, checks page containment and composer/microphone/counter visibility, and closes its browser. The 390px and 1280px screenshots were inspected. This is geometry evidence, not hydrated event interaction, provider transcription accuracy, application login or mobile-preview evidence.
- Chromium initially failed because the runner's temporary path exceeded its Unix socket path limit. Running this synthetic test with `TMPDIR=/tmp` resolved the launch failure. No application proxy or authorization boundary was bypassed.

Shared client workspace and Cents candidate work:

- `HandrailAssistantWorkspace` now binds an existing authenticated client to the complete optional UI. The endpoint launcher delegates to it. The SDK owns uncontrolled approval preference, per-conversation upload queues, negotiated STT, titles and history; hosts can still supply controlled settings and domain renderers. `maxPromptCharacters` and the accessory slot keep host prompt limits independent of voice. `visible: false` preserves background work without marking hidden messages read.
- Compact catalog presentation now uses `useConversationHistory` too. The exported preset CSS includes history styling, including when a host bundles it under a strict CSP. The old duplicated catalog mutation/load implementation is removed. Sidebar and compact selection now share the common workspace wrapper and archived read-only binding.
- The default server policy for tools declaring approval mode `policy` reads `handrail_approval_mode` from the durable admitted request. Missing/invalid context fails closed; application and plugin authorization runs first; mandatory `always` approvals remain mandatory. Custom server approval policies remain supported. A real tool-executor regression covers concurrent per-turn preferences, missing/invalid metadata, denied operations and mandatory review.
- A Cents file-only test found that `message.created` rejected the composer's empty content array. The runtime now records one empty text part alongside the attachment events. This preserves the event contract and fixes headless and UI callers. A runtime replay regression covers the admission.
- Cents locally uses the new client workspace and enables native uploads and policy-controlled writes. Its obsolete history shell, dummy uploader, hidden-activity flag and voice-slot counter are removed. Its branding, route context, domain results and prompt limit remain. See the Cents repository's `docs/cents-shared-ui-candidate.md` for evidence and release prerequisites.
- SDK history/launcher/styled/server suites passed after consolidation (46 tests across those four suites). Runtime and standard-composer suites passed after file-only admission/drop guards (46 tests). These totals overlap previous runs and are not cumulative unique coverage. New source builds passed; final typecheck/lint and consumer refinements are still being checked.
- The Cents component passed 11 candidate tests. Its gateway fixture passed required/automatic approval, replay/usage/account-isolation and cancellation/deadline cases against local PGlite and fixture HTTP. The earlier unconfirmed-write expectation timed out correctly once confirmation became the default; the fixture now exercises confirmation explicitly. No provider credentials or production database were used.
- `examples/minimal-shared-assistant.tsx` shows the endpoint UI with host authentication and branding. It does not require a host composer, recorder, history controller or approval preference state.
- Final checks for this stage: SDK `npm run typecheck`, `npm run build`, examples typecheck and scoped ESLint passed. Cents browser and server candidate compiles passed. The 11 Cents component tests also passed with the full-features case under React Strict Mode. Its normal Git-pinned browser compile correctly fails on the unpublished `HandrailAssistantWorkspace` export (and the test fixture's new transcription capability export); package/lockfile remain unchanged. A source-path candidate pass is not an installed-pin pass.
- An existing `scripts/check-cents-web-ui.ts` can validate the actual Cents component, application CSS, CSP and authenticated SDK gateway against synthetic identity/provider/PGlite. It still expects the retired New-chat labels and must be adapted to this candidate before being rerun. Its older saved results do not validate this change.

Spartan/shared transcript stage:

- Spartan now uses `HandrailAssistantWorkspace` directly. Its remaining UI code is launcher branding/account binding, ERP message and action formatting, business request construction and resource refresh. The bespoke composer, draft hook, upload lifetime hook, attachment runtime wrapper, drop target, codec wrapper, voice component, transcript ordering module and global compact stylesheet are removed. Generic speech-hint parsing is an SDK re-export.
- `conversationTimeline` and `ConversationTranscript` preserve original-question ordering across delayed decisions, imported identities, automatic completions and saved failures. The styled default consumes them. At this historical milestone `renderApproval`, `renderConversationMessage`, `renderCompletedTool` and the legacy identity callback were supported extension points. The turn 36 cleanup removes the unused legacy identity callback; canonical ordering and domain renderers remain.
- `assistantToolArgumentReference` is a shared portable canonical digest, verified against Node SHA-256. The default confirmation card shows authorized arguments only when they match the proposal binding; missing/mismatched review disables confirmation. Archived cards cannot submit decisions. The server still reauthorizes every decision/execution.
- Archive integration exposed a store-destruction race. SDK history now flushes React detachment before successful runtime release. Rejected archive still preserves the runtime and draft. View changes can select a healthy saved thread without creating a replacement.
- Full-workspace integration exposed an unwired default Stop. `useConversationActions` now exports runtime cancellation and the composer uses it when no custom callback is supplied. New drag feedback and busy drop suppression also live in the shared composer.
- SDK typecheck/build and 83 tests across seven focused suites passed. These overlap earlier totals. Spartan's sending/uploader lifetime run passed 12 tests; separate archive/scroll/voice/upload suites passed. Cents' 11 drawer tests passed again after the shared transcript change.
- Spartan's new actual assistant composition test verifies raw-audio capability, durable replay and account isolation. Its mounted API test verifies both installed-client multipart compatibility and the SDK raw route with session/same-origin protection, no duplicate provider dispatch. Both use synthetic provider responses and local PGlite. Candidate server compile passed with the repository's existing ambient MCP declarations.
- During this stage the shared SDK checkout advanced independently to commit `54d8a6d` (version 0.2.31) and Spartan to `9e286b7`; this goal run did not execute those commits. Subsequent fixes remain local. Consumer SDK pins remain `3b5983c30d63f9e5188c86d7decf200bd1895aa2`, so candidate test resolution is still distinct from installed dependency qualification.

Follow-up web qualification:

- The SDK also queues Stop activated before admission and sends cancellation once a turn identity exists. A separate `canStop` presentation flag now blocks Enter/form sends even before the composer observes the running turn. The next draft remains editable.
- SDK history no longer hydrates the same failed saved thread twice within one initial catalog refresh. `showConversationTitle` lets a host use the current catalog title in the shared header.
- The SDK now exports `useBoundApprovalReview` for a single domain review's loading/retry/abort lifecycle. It invalidates data immediately on account, conversation, proposal version, tool binding, argument reference and enablement changes. It complements the existing `useApprovalReview` proposal/decision controller; existing exports remain intact. Host loaders authenticate and validate returned domain reviews. Spartan and Mills now use it.
- SDK typecheck/build and 62 tests across five suites passed after these changes (shared composer, standard composer, history, existing approval controller and bound domain review). Five new review cases cover scope/version/reference changes, stable polling objects, retry, disable/re-enable and stale unmount errors. These totals overlap earlier runs.
- Spartan's full shared UI plus domain review suites passed all 40 tests, including required matching argument bindings, no stale authority after account switches, exact proposal decisions, titles, history recovery, unread filtering and transcript order.
- Mills removed its submitted-draft component, keyboard interception, recorder wrapper and compact CSS. Shared voice controls retain the authenticated legacy endpoint/live-call adapter; shared attachment preview retains Mills' imported-ID/storage route mapping. The submitted-draft regression now exercises the SDK directly, including identical later text and deliberate empty drafts. The focused seven-suite set passed all 51 cases after updating old picker expectations for the sidebar. Its candidate client compile and scoped ESLint passed. The household reconciliation gate and session-expiry behavior remain tested.
- Cents' updated `scripts/check-cents-web-ui.ts` passed the actual component, app CSS and authenticated SDK gateway in Chromium at 1280×900 and 390×844, in light and dark modes. It verifies admission clearing/focus, an editable next draft, Enter/Shift+Enter, the shared approval/microphone/attachment controls, New/history navigation, rich results and route context. Zero page errors and CSP violations. Desktop-light and small-web-dark screenshots at `/tmp/cents-web-check-ORjYHm` were inspected; browser/server/database cleanup completed. The fixture uses synthetic identity/provider/PGlite and explicit candidate resolution, not production login, real speech accuracy or Mobile Preview.
- Human-answered Coverage Q&A searches for assistant decisions in Mills, Spartan and Hitcents returned no entries. The active user's objective remains authoritative.
- Independently of this run, application checkouts/dependencies continued advancing, including Cents commit `76f96fc` and Mills commit `29e78ff` with the SDK pin `54d8a6d13fb98d0f9fa24ca464f002b694e5e96d`. Some in-flight working changes were included by that separate activity. This run has not committed, pushed or deployed. Subsequent local SDK fixes still need a reviewed committed revision and matching install/build qualification.

Remaining: shared saved-attachment handling, remaining domain/legacy server and approval adapter review, Mills legacy STT/live-call compatibility, registered mobile consolidation, authorized application/mobile validation, and the final acceptance audit. The goal remains active; passing SDK/Spartan/Cents subsets do not establish all-project or production parity.

Initial mobile audit (superseded by the candidate progress below):

- [`packages/handrail_ai_widgets/lib/handrail_ai_widgets.dart`](https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter/blob/main/packages/handrail_ai_widgets/lib/handrail_ai_widgets.dart) supplies `HandrailComposer`, attachment/dictation controls and an approval badge. Hosts still own the `TextEditingController` and send callback. Default input uses newline, and Send does not yet restore focus or own admission/revision handling. The widgets package has no dependency on the client package, which is useful for retaining a platform-neutral submission adapter.
- [`packages/handrail_ai_client/lib/src/session.dart`](https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter/blob/main/packages/handrail_ai_client/lib/src/session.dart) already persists intent before admission and retains uncertain requests. `_submitTurn` validates every mutation acknowledgement and the refreshed canonical turn before starting observation, but it has no UI admission callback. Reusable draft clearing should be triggered there without changing persisted idempotency or retry semantics.
- Cents mobile `cents_sheet.dart` replaces the shared input, disables input while `sdk.busy`, hides approval settings, supplies an empty voice slot, and clears/refocuses only after `sdk.send` (which also refreshes and names the thread). It has the same adoption problem as the old web shell. `cents_sdk.dart` captures each request once and uses the SDK pending-message store; preserve that contract while moving the shared composer behavior into the Flutter SDK.
- Spartan mobile still has `aegis_draft_controller.dart` for per-thread drafts/files and a custom composer section in `aegis_conversation_screen.dart`; its repository sends through `HandrailConversationSession.sendMessage`. Reuse the shared behavior instead of copying those controllers into Cents. Mills' `assistant_session_screen.dart` and legacy voice/history-recovery adapters remain part of the audit.

Final checks for this web stage: SDK build/typecheck and scoped ESLint passed; Spartan client candidate compile/ESLint passed; Mills client candidate compile/ESLint passed; Cents browser-fixture candidate tools compile/ESLint passed. These do not replace the remaining mobile/provider work or installed-pin qualification.

## Repository and release boundaries

At the start of this goal turn, the SDK already had independent changes in `src/react-styled/index.tsx` and `test/react-realtime-launcher.test.tsx`; `docs/adoption-standard.md` also changed independently during the turn. Mills has independent startup/history edits. Preserve these changes and review provenance before any release operation.

Application dependencies must use the public HTTPS SDK Git repository, full committed SHAs and matching package-manager lockfiles. No file/workspace/tarball dependency or manual package installation may substitute for the supported install/build pipeline. Do not claim end-to-end completion while consumer adoption or validation is still pending.


## Flutter composer consolidation candidate

The native gap was the same ownership problem: Cents replaced the SDK input and
cleared/refocused only after send/refresh/title work; Spartan retained a bespoke
per-thread draft/files controller and input/paste/full-editor implementation.

Implemented locally:
- Flutter client `sendMessage`/`submitTurn`/`retryPendingMessage` expose verified
  admission notifications. Concurrent identical submissions notify each caller;
  callback exceptions do not prevent provider start. Pending-journal and lost
  acknowledgement semantics remain unchanged.
- Widgets export `HandrailDraftController` and `HandrailComposerDrafts<T>`.
  Accepted text clears by edit revision, while later identical/blank edits and
  re-added identical files survive success, failure, cancellation and retry.
  Per-conversation selection and account disposal invalidate/route callbacks.
- `HandrailComposer` owns immediate Send focus, Enter/Shift+Enter/IME handling,
  an editable next draft, bounded paste, and the optional full-message editor.
  The editor closes on controller/scope change. Host flags/theme remain explicit.
- Cents mobile now uses the default SDK input and draft controller, captures the
  shared approval preference into each retained request, keeps the next draft
  editable and permits Stop during send acknowledgement. Retry never clears a
  later draft. Branding, 2,000-character validation, route metadata and domain
  presentation remain in the host.
- Spartan mobile now uses the SDK per-conversation draft/files workspace and
  default input/editor. Deleted `aegis_draft_controller.dart` and redundant
  text-controller synchronization, paste handling and editor navigation. Its
  business repository forwards SDK admission; uploads remain in the draft until
  admission, so failure cannot restore over later edits. Domain attachment
  validation and exact reviewed business operations remain in Spartan.

Validation, sequential with one worker:
- Flutter client scoped analysis and 7 submission gateway tests passed, including
  the real Node SDK fixture for journal failure, duplicate admission and lost
  start acknowledgement.
- Flutter widget scoped analysis passed; 22 composer/draft/workspace tests passed.
  They include responsive geometry, keyboard/IME, focus, expanded-editor scope,
  file selection identity, background admission, disposal and retry.
- Actual Cents SDK binding and sheet: 21 tests passed under explicit candidate
  resolution, including account isolation, durable retry and Stop while the
  start response is held.
- Spartan controller/repository/SDK screen/presentation: 74 existing cases passed.
  The SDK screen suite then passed all 9 cases after adding completion/failure/
  cancellation checks for identical later draft text and focus. These are
  overlapping runs, not 83 unique tests.

Candidate commands use `flutter test --no-pub --packages` with a temporary,
explicit package-config copy mapping only the two SDK package roots to this
working source. Their original package graphs and pubspecs are copied for native
asset hooks; manifests, locks and normal package resolution are unchanged. This
compiles the real consumer source but does not qualify the installed pins or
live Mobile Preview. Spartan still pins client `391280a1db696ebcded1d0c3fba9a74c3084438f`
and widgets `92fbdf616defc19aac3eedf92b7e0f92195b246f`; Cents pins both packages to
`70526d57b6b449854fa9b2127124f6d24e8cc152`. These new APIs require a later authorized
committed SDK revision and matching consumer lock updates before normal builds.

Authenticated capture/transcription was addressed in the next stage below.
Current outstanding work is tracked in the feature table above. This goal run
has not committed, pushed, opened PRs, deployed or written production data.



## Flutter authenticated transcription candidate

The next mobile gap is now implemented in the SDK: Mills' microphone recorder
previously lived in the app and the optional Flutter UI only offered device
speech recognition. The Flutter client now negotiates transcription and exposes
a direct optional-UI binding. It validates formats/limits/URL scope, uses the same
protected raw gateway transport, bounds responses, preserves retry identity and
safe error codes, and excludes cancelled/late results. Request bytes remain stable
until the actual transport settles even if a custom transport cannot abort.

`HandrailPcmAudioRecorder` owns bounded PCM/WAV recording, actual PCM duration,
permission/start/stop/dispose sequencing and byte cleanup. `HandrailTranscriptionControl`
owns capture/transcription state, cancellation, retained retry and insertion into
the latest draft. Draft-limit recovery reuses the saved transcript without another
provider request; unknown outcomes cannot retry. `HandrailComposer.transcribeAudio`
uses this control and gates Send during capture/transcription.

Cents and Spartan use `client.transcriptionForConversation` when the gateway
advertises WAV support, with negotiated limits and explicit scope. Cents' Android
and iOS microphone declarations were missing; both are now added and parsed for
validity. Spartan already declared microphone access. Mills' former 300-line
recorder is now a compatibility type-alias file delegating to the SDK; its existing
legacy transcription UI/endpoint remains to migrate.

The SDK widgets add the existing Mills recorder dependency `record: 6.2.1` and
require Dart >=3.5/Flutter >=3.24. SDK `flutter pub get` resolved that third-party
plugin normally. No Handrail dependency reference or app lock was changed. The
explicit candidate package configurations include the SDK recorder's dependency
graph for typed consumer tests; this is not native plugin/deployment qualification.

Current passing evidence:
- Flutter transcription client: 8 tests for protected raw requests, negotiation,
  scope, safe errors, stable retry identity, cancellation and response limits.
- Shared transcription control: 6 tests for latest-draft insertion, Send gating,
  retained retry, draft-limit recovery without another request, uncertain outcome,
  and scope/disposal/cancel guards.
- Recorder tests initially passed 4 cases; partial-platform-start cleanup was then
  added and is included in the final checks recorded below.
- Cents sheet: all 14 cases passed including the actual negotiated UI/client
  binding. Its SDK binding suite had passed 8 cases before this fixture addition.
- Spartan SDK screen/repository: all 29 cases passed with the new negotiated voice
  binding, including existing approval/send/account and background-turn checks.
- Mills' actual assistant screen compiled and its speech-recording/transcript
  insertion case passed with the SDK recorder aliases.

These are source/controlled-transport checks, not successful live provider,
Microphone/OS, protected Mobile Preview or deployed parity. Remaining: shared
mobile upload/history/workspace adoption, Mills' remaining composer/voice and
legacy endpoint migration, admission-time cancellation consolidation, and the
provider/server/saved-attachment work in the earlier ledger. The goal stays active.


Final checks for the authenticated Flutter transcription stage: scoped client
and widget analysis passed. The combined client transcription/submission run
passed 15 cases, including the Node gateway fixture. The final widget run passed
33 cases (5 recorder, 6 transcription control, and 22 composer/draft/workspace).
Consumer tests compiled their real typed sources through explicit candidate
resolution as described above; Cents 14, Spartan 29, and Mills' focused speech
insertion case passed. All four changed repository diffs pass whitespace checks.
No live microphone/browser/provider proof or release is claimed.


## Provider and initial history consolidation candidate

The initial host gap extended to provider infrastructure: Spartan owned a native
Responses stream bridge, connection retry loop, physical usage projection and
normalized invocation retention. Those now live in supported SDK server/provider
modules, and the default durable `openaiResponses` assembly installs them.
Spartan keeps its original operation scope/hash and receipt namespace, plus
business history, instructions, receipt content and write-blocking adapters.
See [provider replay](./provider-replay.md) for ownership, defaults and migration.

Retained terminal outcomes are withheld until storage acknowledges completion;
store failures stop tool execution. Default server recovery without an initial
receipt stops safely instead of dispatching a potentially legacy request again.
The physical accounting path does not add duplicate aggregate receipts or charge
new provider work during replay. Domain execution still uses its durable ledger.

Cents' client factory now negotiates identity/capabilities only. The shared
history UI lists and opens saved threads, recovers reads, and creates an initial
thread once after a successful empty active-history read. Failed creation retains
its operation key for New; unreadable saved history never triggers replacement
creation. The endpoint launcher now delegates to this same controller, including
recovery when the picker is hidden.

Validation for this stage:
- SDK function correlation: 12 cases passed; adapter/tool-loop/eager-bound and
  authorized attachment suites passed 37 additional cases.
- Shared replay integration: 8 cases passed; existing PostgreSQL operation-store
  integration passed. The default provider case includes physical retry/receipt
  accounting, native tool-call identity, replay, changed-request rejection and
  legacy recovery without an initial receipt. Storage failure exposes no successful
  terminal or tool authorization.
- Shared history: 10 cases passed; endpoint/voice launcher: 6 cases passed;
  styled UI: 24 cases passed. These overlap older runs; do not sum the ledger.
- Spartan's actual provider regressions: 25 cases passed, covering approval
  restart, action idempotency, continuation, retry/usage, cancellation and safe
  diagnostics. Candidate server compile passed.
- Cents drawer: 13 cases passed, including initial catalog and hydration failures
  recovering inside the SDK without client recreation or replacement history.
  Its native gateway suite passed all 4 cases, including both approval modes,
  replay/usage/account isolation and cancellation/deadline behavior.
- Cents browser fixture passed again at 1280×900 and 390×844, light/dark, using
  the actual component/CSS/authenticated gateway with synthetic identity/provider/
  PGlite. Zero page errors and CSP violations. Desktop-light and small-web-dark
  screenshots at `/tmp/cents-web-check-BUeBxe` were inspected; browser/server/
  database cleanup completed. Browser and server candidate compiles passed.
- SDK build, full typed compile and scoped source/test ESLint passed after the
  final recovery guard. Consumer follow-up checks are recorded below.

This run has not released anything. Other workspace activity independently
advanced consumer commits/staging while this work ran; those changes were retained.
SDK HEAD and the web consumers' dependency references still point to the full
committed revision `54d8a6d13fb98d0f9fa24ca464f002b694e5e96d` at this check. The new
SDK helpers/UI defaults require a later authorized committed revision plus matching
locks before normal installed builds can use them. Candidate fixtures explicitly
resolve current source/build output and do not establish production parity.
The overall goal remains active for mobile upload/history/workspace, Mills' remaining
UI/legacy voice integration, shared saved-attachment support and final acceptance.

Final consumer follow-up: Mills' real launcher/composer suites passed all 14 cases
and its candidate client compile passed. Scoped Cents and Spartan source/test lint
passed. Combined working-tree diffs against HEAD pass whitespace checks for the
SDK, Cents and Spartan; existing staging owned by other workspace activity was
preserved. No test process or browser from this stage remains open.


## Flutter upload consolidation candidate

Spartan's repository previously uploaded each selected file in a host loop using
new send-derived identities on every attempt. Cents had no file controls and kept
one sheet-local draft that its history callback cleared on navigation. Both gaps
are addressed through shared Flutter APIs in this local candidate:

- `HandrailAiClient.attachmentUploader` binds the optional UI to the protected
  application gateway. Upload HTTP now has cancellation/deadline/response bounds,
  validates returned reference identity and metadata, and keeps diagnostics free
  of file content. The existing `uploadAttachment` API remains available.
- `HandrailComposerController` owns negotiated intake limits, bounded native file
  reads, per-conversation selection state, upload identities/references, progress,
  errors, retry and cancellation. A partially successful batch reuses its successful
  references. Admission removes exact original selections; later text and file
  selections survive. Disposal excludes late results.
- The default `HandrailComposer` includes a bounded, scrollable file list, picker,
  remove controls, inline guidance and image-paste binding. Minimal adoption and
  the structural client binding are documented in the Flutter widgets README.
- Cents uses an account-owned controller that survives closing/reopening the sheet.
  Navigation retains each conversation's draft/files. File-only messages keep
  Cents' route and approval metadata and receive a filename-based conversation
  label. An upload from a conversation left before admission cannot submit into
  the newly selected conversation. Prompt limits and domain rendering remain.
- Spartan's picker and upload loop now delegate to the SDK, preserving its MIME
  mapping, file limits, progress presentation, request identity and pending journal.
  Its failed-upload retry uses the original file upload key; the server receives
  one eventual message admission/start.
- Dart file-only submissions now emit valid durable `message.created` content
  plus attachment-reference events before execution, preserving the original
  attachment-only request. This is exercised against the real Node SDK gateway.

Validation for this stage (overlapping previous suites, not additive): client
attachment/transcription 14 tests and gateway submission 8 tests passed; SDK
widgets composer/drafts/uploads/recorder/transcription 41 tests passed. Client
library and widgets library/test analyses passed. Cents' sheet and SDK suites
passed 24 cases; its file-only case passed again after adding filename-based
naming. Spartan repository 20 and screen 38 tests passed, including shared picker
MIME mapping, preflight capability rejection, retries and responsive composer
coverage. Consumer tests compile their real typed application sources with
explicit temporary candidate resolution. No application manifest/lock was changed. Mills' real assistant screen also
compiled and passed its focused speech-recording/transcript insertion check.

The picker dependency is `file_picker: 12.1.1`, the version already used by
Spartan. Its current platform-interface and native plugin dependencies must be
resolved together by normal Flutter installation; mixing old plugin versions
with a newer platform interface fails compilation. Candidate configurations were
corrected as a unit. The SDK widgets now declare Dart >=3.10/Flutter >=3.38; the
picker requires iOS >=14. Cents and Mills already declare iOS 15. This is not native
plugin registration, OS microphone/file access, protected Mobile Preview, or
production qualification. The SDK and consumers still need an authorized public
committed revision and matching normal lockfiles before this code is installed.

Remaining for the full goal: complete Flutter history/workspace/transcript
adoption; mobile Stop during the pre-admission interval; Mills' remaining
composer/legacy voice adapter; shared authorized saved-attachment handling;
remaining server/legacy adapter audit; available application/mobile qualification
and the final acceptance review. The goal is active, not complete.

## Flutter history/controller consolidation candidate

Cents and Spartan still owned catalog loops, session registries and history
lifecycle plumbing after the composer/upload migration. Cents' history shell
also lacked the reusable archive/unread experience. These now delegate to
`HandrailAssistantController` in the Flutter client and
`HandrailConversationHistory` in the optional Flutter widgets.

- The controller owns paged active/archived history, selection, cached sessions,
  remote unread/preview presentation, immutable creation recovery, pending send
  recovery, versioned archive/restore and stable cancellation identities.
  Duplicate/late page responses cannot replace a newer view. Opening a chat
  refreshes canonical metadata and recovers only that account's saved intent.
- The shared picker/sidebar supplies New, history filters, dates, previews,
  running indicators, archive/restore, loading/errors/retry and older pages.
  Unread counts currently cover loaded catalog pages. The 320-pixel, double-text
  accessibility test exposed overflow in New and error controls; those controls
  now fit and the whole history surface scrolls. Old account overlays close when
  the binding changes or is disposed.
- Shared draft capture reconciles a saved send on reopening without clearing
  another chat or a later edit/reselected file. A new Cents adapter regression
  verifies recovery clears the original draft and preserves another chat's text.
- Cents uses the SDK controller and history binding directly, with its branding,
  route context, prompt bounds and result formatting. Archived conversations keep
  their transcript and become read-only until restored.
- Spartan's repository removes its session registry/subscriptions, catalog
  paging, creation keys, terminal wait loop and archive/cancellation identity
  code. It delegates those to the SDK while retaining its domain projection,
  approval-review validation and presentation labels. `newConversation(onReady:)`
  retains creation across a failed business view; `session.waitForTurn` observes
  a terminal outcome without changing selection or cancelling background work.
- SDK streams allow consumer listeners to update filters safely; initialized
  sessions are reused without an implicit refresh on every domain projection.
  Documentation and a minimal binding/ownership table live in the Flutter
  repository at `docs/mobile-assistant-adoption.md`.

Validation: both SDK package analyses pass with fatal infos; all 79 client tests
and 54 widget tests pass serially with one worker. The client set includes ten
real Node gateway cases and controller race/recovery regressions. Cents' actual
adapter/sheet suites pass all 27 tests; Spartan repository/screen suites pass all
31, including draft/focus behavior for completion/failure/cancellation and bound
approval review. HTTP fixture assertions in Spartan now use `expectSync` because
account-owned stream callbacks run outside the widget pump's guarded test scope.
Both consumer runs compile their actual typed source against test-only candidate
resolution; the application dependency manifests/locks were not changed.
Mills' existing speech/transcript screen regression also passes against the same
candidate packages; this is a focused compatibility check, not complete Mills
mobile qualification. No live Mobile Preview/browser session ran in this stage.

During this stage separate workspace activity extracted Flutter into the SDK
project's declared writable sibling repository `handrail-sdk-ai-assistant-flutter`.
This run verified that repository through Handrail before following the new
`AGENTS.md` boundary. The old JS `flutter/` source tree must not be recreated.
The extracted source appeared at commit
`e0329ffc5199c706281f1158989ef0b40a9492df`; subsequent local fixes still require
their own reviewed public full SHA. This goal run did not commit, push, open a
PR, deploy, mutate production data or alter SDK project configuration.

Cents, Spartan and Mills still pin historical full SHAs and `flutter/...` package
paths in the JS repository. Normal adoption must use a reviewed full SHA from
the Flutter repository, `packages/...` paths and matching lockfiles. Temporary
candidate resolution used for tests is neither installed nor deployed parity.

Remaining: complete shared Flutter transcript/workspace adoption; mobile Stop
before admission; coalesced account polling instead of one activity read per
retained session; remaining Mills composer/legacy voice integration; authorized
saved attachments and remaining server adapter review; authorized mobile/browser
qualification and final acceptance review. The goal remains active.

## Shared mobile Stop and account observation candidate

The mobile composer previously showed Stop only after a canonical turn was
visible, leaving a gap during message preparation/admission. The SDK assistant
controller now exposes `submitting`, `canStop` and queued `stopping` state. A Stop
requested during submission remains bound to its originating conversation.
An internal SDK session gate honors it after verified admission and before
provider dispatch. Failed queued cancellation leaves the exact saved send
recoverable and retries the same cancellation identity before allowing a start.
An explicit expected turn ID prevents late cancellation from targeting a later
turn. Canonical state remains authoritative; queued Stop is not completion.

Cents consumes that state for its standard Send/Stop button. Spartan delegates
its control eligibility and cancellation to the SDK controller/attachment queue,
including Stop during uploads. Neither application adds a pre-admission queue.
Tests confirm later drafts and deliberate focus changes survive cancellation;
upload Stop retains unsent text/files without starting or cancelling a server
turn that does not exist.

The account controller also replaces per-session timers with one coalesced
activity/observation loop. Each cycle reads account activity once and refreshes
selected, running or pending open conversations; idle unselected transcripts do
not repeatedly poll. Remote running activity makes an already-open session
eligible again. Failed activity reads preserve unread evidence without changing
send eligibility. Disposal stops the timer and excludes late responses. Manual
`refreshObservations` uses the same coalesced path. Lower-level standalone
sessions preserve their existing polling behavior.

Validation: both SDK package analyses pass with fatal infos; all 83 client and
54 widget tests pass serially with one worker. The real Node gateway set now
includes 12 cases. Its pre-admission Stop cases verify zero provider starts and
invocations, correct conversation targeting after navigation, and retained retry
identity after a failed cancellation. Account observation tests cover coalescing,
idle-session exclusion, remote running activity, retained unread state and late
disposal replies. Cents adapter/sheet tests pass all 28 cases. Spartan's selected
repository/screen/controller set passes all 43 cases, with a separate new upload
Stop case passing afterward. These runs compile the actual consumer source
against the local candidate. The initial SDK analysis caught four unnecessary
non-null assertions in the new test; they were removed before the passing check.

The Flutter client/widgets READMEs and minimal adoption example now use the
shared assistant controller for send/retry/Stop and describe account observation.
All application SDK manifests and lockfiles remain on their prior full public
Git pins; no release, production mutation, configuration change or live Mobile
Preview/browser action occurred in this stage. The result applies to local
candidate qualification until a reviewed public SDK revision is adopted through
normal installation/build with matching consumer lockfiles.

Remaining: shared Flutter transcript/workspace adoption; Mills' remaining
composer/legacy voice integration; authorized saved-attachment handling and
remaining server adapter review; authorized mobile/browser qualification and the
full acceptance audit. The overall goal remains active.

## Shared mobile transcript candidate

The optional Flutter UI now supplies `HandrailConversationTranscript` and
`HandrailTranscriptMessage`. The account controller's `transcriptBinding` connects
canonical messages, pending/error state, recovery and read acknowledgement without
coupling the headless client to Flutter. Defaults include themed user/assistant
bubbles, selectable Markdown, safe citation chips, Copy, collapsed tool activity,
and retry/status notices. Tool arguments stay out of activity details. Domain
result cards and protected saved attachments use explicit host adapters; without
a saved-file adapter the default shows filenames only.

Cents now consumes that transcript instead of its message loop, bubble widget,
inline recovery notices, scrolling and read-state observer. Its branding,
navigation checks, business result cards, route context and prompt bound remain
host-owned. Spartan uses the same message component inside its existing business
projection and delegates transcript scrolling/read lifecycle through the shared
`contentBuilder` formatting option. Its business action cards and custom status
formatting remain. The optional default content is available without that override.

This migration found and fixed several lifecycle problems: lazy-list height
estimates could leave the view short of the latest reply; a stale automatic-scroll
flag could override explicit navigation; returning from a covered route needed a
read-visibility check without a new server event; a previous conversation's retry
could unlock a later retry; and an empty loaded catalog could retain a permanent
spinner. Read acknowledgement now requires the actual transcript end to be
visible on the current foreground route. Spartan's repository no longer marks a
conversation read merely because it loaded it. Its thin acknowledgement adapter
uses the SDK controller's terminal-turn check. Stateful domain formatting and
message controls are isolated by account and conversation. Shared message
semantics preserve Spartan's author labels; unsafe citations are disabled before
navigation.

Validation: both Flutter package analyses pass with fatal infos, all 84 client
tests and all 60 widget tests pass serially with one worker. The new six transcript
tests cover minimal-host formatting/actions, scrolled-up new replies, covered and
background views, overlapping retries, account replacement and custom domain
state isolation. Spartan's screen/repository set passes 71 cases; a separate new
consumer test confirms a covered reply stays unread until its SDK transcript is
visible. Cents adapter/sheet tests pass all 29 cases, including actual shared
citations/Copy and preserved rich results. Consumer tests compile their real typed
source against temporary candidate resolution. Diff whitespace checks pass.

Adoption/ownership documentation now shows the standard history, transcript and
composer APIs. Application manifests and lockfiles retain their existing full
public HTTPS Git pins. This stage did not commit, push, open a PR, deploy, change
production data/configuration, or open a live Mobile Preview/browser session.
These results apply to local candidate qualification; normal consumer adoption
still needs a reviewed public Flutter SDK full SHA and matching locked install.

Remaining: the combined mobile workspace/composer surface; Mills' remaining
composer/legacy voice integration; authorized saved-attachment handling and
remaining server adapter review; authorized mobile/browser qualification and the
full acceptance audit. The overall goal remains active.

## Mills mobile draft/editor candidate

Mills now binds `HandrailDraftController.submit` to verified SDK admission for
text and finalized-file sends. Its former immediate clear and seven
failure/Stop draft-restoration branches were removed. Submitted text stays in the
editor until acceptance; later edits, including identical or empty drafts,
survive acceptance/completion/failure/cancellation. The standard composer editor
now owns Send focus and keyboard behavior. A new optional `contextMenuBuilder`
keeps Mills' native clipboard menu as a platform adapter without replacing the
editor. Its transparent editor background preserves the existing theme.

Account replacement resets draft and old attachment/recording/presentation state.
Mills captures approval preference at Send activation before upload; its repository
passes that preference into the saved SDK request and preserves existing metadata
when retrying. Protected signed upload/finalization and domain result handling
remain app adapters.

Validation: Mills' actual screen/repository candidate run passes 104 tests,
including seven new delayed-admission, identical-edit, focus and account cases.
The real repository journal test confirms no admission callback on a failed
journal acknowledgement and verifies captured approval metadata. A separate
focused upload case proves a later preference change cannot alter its submission.
Both Flutter SDK package analyses pass with fatal infos; 84 client and 60 widget
tests pass serially with one worker. These consumer tests compile actual typed
source using temporary candidate package resolution. The final whitespace checks
pass. No application manifest/lock changed, and no release, production write,
configuration mutation or live Mobile Preview/browser run occurred in this stage.

The app still needs a reviewed public Flutter SDK full SHA and matching locked
adoption before ordinary builds can use the new optional widget API. Current
evidence is local candidate qualification. The dictation follow-up below removes
the remaining app voice insertion/capture state. Remaining Mills work includes
session/catalog/cancellation orchestration and transcript
shell. The group goal still includes the combined optional workspace, protected
saved attachments, remaining server adapter review and final authorized
browser/mobile and requirement-by-requirement validation. The goal remains active.

## Mills mobile dictation candidate

Mills now uses the SDK's authenticated transcription control inside the standard
composer. Its capture/stop/insert methods, timers, recording/transcribing flags,
status/error rows and microphone implementation were removed. A factory provides
a fresh SDK recorder per capture. The SDK preserves the latest draft and owns
retry/discard, duration bounds, cancellation and late-result exclusion.

The protected Mills endpoint remains a transport adapter. SDK operation keys
contain characters its legacy header validator rejects; the adapter now hashes
the operation identity into a stable supported key. Actual transport tests
verify identical retry audio/key and non-retryable uncertain outcomes.
Actual consumer tests also found that SDK snackbars covered bottom-positioned
Retry/Insert controls. Error text is now inline and accessible in the shared
composer, with a status callback for standalone control consumers.

Validation: 128 actual Mills screen/route/host-operation tests pass using
temporary candidate package resolution. The Flutter SDK's full checks pass
both fatal-info analyses, 84 client tests and 60 widget tests. Recovery tests
cover the bottom layout, same-recording retry, draft-limit insertion without a
second provider request, fresh recorder factories and account-change cancellation.
Logs: `/tmp/mills-shared-voice-final-tests.log` and
`/tmp/flutter-sdk-mills-voice-final-check.log`.

No consumer manifests/locks, releases, production data or project configuration
changed. Ordinary adoption still requires a reviewed public Flutter SDK full SHA
and matching normal locked build. No new live browser/Mobile Preview or physical
microphone evidence is asserted. The broader remaining work above keeps this
goal active.

## Combined Flutter workspace and Cents adoption

The optional Flutter UI now includes `HandrailAssistantWorkspace`, bound to the
headless controller's `uiBinding`. A
`HandrailComposerController.forAssistant` factory binds account draft selection
and negotiated uploads. Minimal adoption supplies the two retained controllers;
the SDK owns responsive history, transcript, send/Stop/stopping, approval
preferences, file upload, authenticated microphone negotiation and initial titles.
The packages remain independent through a structural Dart binding.

Cents consumes this combined surface. Its manual Send/upload/approval/voice
wiring, draft-selection listener and title implementation were removed. It
retains immutable route context, its request validator and 2,000-character
limit, branding, outer keyboard padding and business-result renderers. The
workspace captures origin/context/builder/preference before upload and stamps
approval metadata into the submitted request. Navigation cannot redirect a
captured send into another conversation. Server authorization remains decisive.

Minimal-host tests exposed two further shared issues. Inserting attachment rows
could replace the unkeyed editor and toolbar; stable keys now retain their input
and recording state. Approval sheets could outlive account changes; the shared
badge now closes the old route and rejects stale callbacks when its scope or
enabled state changes. Stopping has an explicit disabled progress state.

Final qualification:

- SDK: both fatal-info analyses, 84 client tests and 66 widget tests pass. Six
  new minimal-workspace cases cover defaults, delayed admission/identical edits,
  Stop, captured upload context/origin, account replacement, approval overlays,
  320-pixel layout with doubled text and 1,000-pixel layout.
- Cents: 29 actual sheet/repository integration tests pass on the combined UI.
  Phone history flows use a 390×844 viewport; tablet recovery keeps the expected
  ongoing-work indicator without confusing it with incomplete admission.
- Spartan: 72 screen/repository compatibility tests pass.
- Mills: 128 screen/route/protected-operation compatibility tests pass.
- Whitespace checks pass, and all three mobile manifests/locks remain unchanged.

Logs: `/tmp/flutter-sdk-workspace-final-check.log`,
`/tmp/flutter-sdk-workspace-focused-tests.log`,
`/tmp/cents-combined-workspace-final-tests.log`,
`/tmp/spartan-workspace-compat-tests.log`, and
`/tmp/mills-workspace-compat-tests.log`.
The minimal example and ownership guidance are in the Flutter SDK's
`docs/mobile-assistant-adoption.md`; Cents records its migration in
`docs/cents-shared-composer-candidate.md`.

This is local candidate qualification using temporary test package resolution.
No commit, push, PR, deployment, production write, project configuration or
separate packaging operation occurred. Normal consumer builds still require a
reviewed full public Flutter SDK commit and matching locked adoption. No new
live browser, Mobile Preview or physical microphone validation is asserted.

The goal remains active for remaining host and server-adapter consolidation,
protected saved-attachment access, available runtime qualification and the
final acceptance audit. The combined workspace itself is implemented and Cents
has adopted it; earlier sections listing that surface as absent are historical.

## Shared saved-file UI and Spartan adoption

Spartan's app-owned image-load, file-open and failure-snackbar lifecycle was
removed in favor of `HandrailAttachmentPreview`. The shared component adds
fresh authorized reads on Open, duplicate-open gating, inline load/platform
retry, account/conversation invalidation, navigation/disposal checks and private
buffer cleanup. Returned size bounds and optional saved byte counts are checked
before use. An inline presentation mode preserves Spartan's images/PDF buttons
and now also opens supported saved spreadsheets.

Spartan retains its canonical authorized endpoint, supported media/size settings,
MIME validation, labels and native share adapter. The SDK copies returned data
and lends its private open buffer for the callback lifetime; the existing host
download model takes its own copy for platform use. Old `loadBytes`/`onOpen`
consumers retain compatibility. Legacy load callbacks do not receive a network
cancellation signal, though their late results cannot open stale files.

Validation: both SDK fatal-info analyses, 84 client tests and 74 widget tests
pass. Ten attachment-preview cases cover image retry, same-ID scope replacement,
duplicate opening, private buffer cleanup, load/platform failures, returned
bounds and reauthorization of cached previews. Spartan's 55 actual screen and
download tests pass, including truncated-CSV rejection and recovery through the
shared UI. Mills' 128 screen/route/protected-operation cases also pass.
Whitespace checks pass; no app manifest/lock changed.

Logs: `/tmp/flutter-sdk-saved-attachment-final-tests.log`,
`/tmp/flutter-sdk-saved-attachments-final-check.log`,
`/tmp/spartan-shared-saved-attachments-tests.log`, and
`/tmp/mills-saved-attachments-compat-tests.log`.

The remaining transport audit confirms the SDK's default native attachment
handler currently accepts uploads only. Staging resolution obeys its configured
expiry; consume deletes the staged blob. A common saved-download path therefore
must preserve ownership and configured retention instead of inventing public
URLs or extending retention silently. Cents' minimal transcript still shows
saved filenames until that protected adapter is available. Spartan also retains
composer/workspace orchestration which requires further consolidation.

No commit, push, PR, deployment, production data, project configuration or
separate packaging operation occurred. All evidence here is local candidate
qualification; ordinary builds require reviewed full public SDK commits and
matching lockfiles. No new browser/Mobile Preview or physical-device evidence
is asserted. The full goal remains active.

## Protected saved downloads, PDF defaults and Cents browser qualification

The standard server now negotiates `attachmentDownloads` and provides an
authenticated GET handler. It checks the conversation catalog and account/tenant
attachment metadata, validates retained MIME/size and preserves expiry and
consumption. The PostgreSQL lookup uses the existing document table; no schema
or production-data change is needed. Download capability is independent of
upload controls. The current default retention remains one hour.

The shared client reader enforces a same-origin negotiated endpoint, refuses
redirects, bounds streaming bytes, and cancels observation through authentication,
fetch and body reads. Late responses are discarded/cancelled and safe errors
never expose server bodies. The optional React workspace negotiates it by
default. Saved image previews and file buttons share account/conversation
invalidation, abort, duplicate-activation gating, safe retry, fresh authorization
on Download and temporary-URL cleanup. Explicit legacy host URL/render adapters
retain precedence.

The actual Cents browser flow exposed two further SDK integration defects:
high-level OpenAI document input defaulted off despite its SDK-owned resolver,
and staging returned `blob_…` content references rejected by the protocol's
`ref_…` grammar. High-level OpenAI now defaults to two PDFs per message with a
20 MiB per-file bound, subject to upload/storage limits; false opts out and
explicit format descriptors retain precedence. New uploads return `ref_…`.
Retried legacy uploads expose a compatible alias while preserving their original
record, fingerprint, blob and expiry; shared resolution and consumption maintain
the original storage identity. No files are restaged merely to repair the alias.

Cents requires no new app composer or file-renderer implementation for these
features. Its gateway tests now exercise protected reads under actual Cents
authorization, including account/conversation substitution and archived history.
The real web component fixture uploads, sends and downloads the exact submitted
PDF through the SDK queue and protected HTTP path. Visual inspection caught dark
text on a dark file button inside Cents' orange user bubble; shared styling now
uses the button's own theme colors and inherited metadata text. The final narrow
dark screenshot was inspected; the button's measured contrast is 15.7:1.

Validation: SDK build/typecheck and repository lint pass. There are 112 passing
attachment/gateway/provider/persistence/styled regressions, 14 cancellation cases
and three adoption-CLI cases. Repository lint also required declaring Node
globals for its existing .mjs scripts/tests and minor existing lint cleanups;
lint rules were not disabled. Cents' 24 focused auth/gateway/runtime/modal cases
pass, as do its browser/server/test/tool compiles. Spartan client/server and
Mills client scoped candidate compiles pass.

The final Chromium fixture passes at 1280x900 and 390x844 in light/dark themes,
including a saved-card width assertion, file-button contrast, exact downloaded
bytes, route context, shared controls, accepted-send clearing, retained next
draft, keyboard sends and history navigation. There are no page errors or CSP
violations. Browser/context, HTTP server and synthetic PostgreSQL were closed.
The browser artifact is
`/opt/handrail/.handrail/codex-runs/cb7aa3b3-4d22-4da1-b60c-502ca6ab5d84/tmp/cents-web-check-smYLZA/report.json`.
Logs include `/tmp/sdk-protected-download-final-tests.log`,
`/tmp/cents-protected-download-final-tests.log`,
`/tmp/cents-protected-download-final-browser.log`, and
`/tmp/protected-download-final-*-compile.log`.

These remain local candidate checks with explicit temporary test resolution.
No SDK/app dependency or lockfile changed, and no commit, push, PR, deployment,
production write, project configuration or separate packaging operation occurred.
The fixes apply to consumers after an authorized committed public SDK revision
and matching locked adoption; this evidence does not establish live parity.
No new Flutter/Mobile Preview or physical-device validation is claimed.
Flutter's default protected download binding, remaining Spartan workspace
orchestration, business-adapter cleanup and final acceptance audit remain active
goal work.

## Flutter default protected downloads and upload ownership

The Flutter client now negotiates the standard `attachmentDownloads` capability
and supplies a protected reader through `uiBinding.downloaderFor`. The combined
optional workspace supplies previews and Download controls using the SDK's
existing file picker save dialog, with optional host presentation/platform
overrides. Upload visibility does not hide authorized saved files. Older gateways
without the capability retain the filename fallback; legacy attachment builders
retain precedence.

Reads validate gateway confinement, MIME, byte limits and expected size, reject
redirects, bound response time and stream size, and cancel through authentication,
request and body reads. Scope replacement and disposal invalidate/cancel pending
UI reads, prevent late platform opens and clear private preview copies. Every
Download activation reads fresh protected bytes. Retention remains server-owned.

Cross-SDK qualification exposed a missing upload binding: Flutter's shared
uploader omitted `conversationId`, which the standard JS gateway requires.
`uiBinding.uploaderFor` now captures the originating conversation and sends it
in multipart data. Optional lower-level arguments preserve legacy compatibility.
The real synthetic HTTP test uploads after switching selection, admits the file
to its original conversation, reads the exact bytes, rejects a different account
and conversation, and observes expiry. It explicitly uses
`HANDRAIL_TEST_JS_SDK_DIST`; the committed gateway test dependency is unchanged.

Validation: complete Flutter SDK `make check` with that candidate variable passes
both fatal-info analyses, 94 client tests and 80 widget tests. Six saved-file
widget cases cover minimal-host controls with uploads hidden, native save callback
and dialog cancellation, safe retry, account/conversation/disposal invalidation
and explicit host override precedence. Cents' 30, Spartan's 55 and Mills' 128
relevant consumer tests pass through temporary candidate package resolution.
The actual Cents control and request identities are verified independently.
Logs: `/tmp/flutter-protected-download-full-check.log`,
`/tmp/cents-protected-download-mobile-tests.log`,
`/tmp/spartan-protected-download-mobile-tests.log` and
`/tmp/mills-protected-download-mobile-tests.log`.

No manifest, lock, release or production data changed. No physical-device save
dialog, microphone, Mobile Preview or live parity is claimed. These candidate
features need reviewed public full SDK SHAs and matching locked adoption.
Remaining Spartan/Mills orchestration and business-adapter cleanup, available
runtime qualification and the final acceptance audit keep the goal active.

## Spartan mobile account replacement guard

The actual Aegis screen retained a final controller when its authenticated
repository changed, which could keep an old account's same-ID transcript and
draft visible. It now replaces the controller and widget subtree, rejects late
picker/send/review callbacks, and removes its old history/discard/review routes
without popping unrelated navigation. The shared expanded editor borrows its
draft controller; release now follows widget detachment, preventing a disposed
controller rebuild during account replacement. The repository's shared upload
binding also supplies the originating conversation ID.

All 95 relevant Spartan screen/controller/repository/download cases pass with
candidate SDK resolution, including eight new account replacement regressions.
Log: `/tmp/spartan-account-scope-final-tests.log`. These checks compile the actual
typed consumer source; no Mobile Preview, device or released-pin parity is
claimed. No dependency/lock or release changed. Spartan still retains generic
mobile workspace/composer orchestration, which remains the next consolidation
task; the account guards do not replace that required cleanup.


## Spartan combined mobile workspace and close policy

Spartan mobile now renders `HandrailAssistantWorkspace` directly and deletes its
custom conversation controller, history picker, composer and upload/send/retry
coordinator. Its repository retains authenticated business reviews, result
projection and protected legacy file reads around one SDK account controller and
composer. Business formatting observes the canonical revision without starting
a second synchronization loop. Archive decision eligibility now checks the
canonical conversation lifecycle instead of the selected history filter.

The SDK exposes host context for New through `newConversationMetadata`, frozen
with its creation identity across retries; bounded input/expanded-editor options;
domain transcript slots and submission readiness; and an intersection of host
file bounds with negotiated gateway limits. These are optional host settings,
not infrastructure that consumers must reimplement. Shared New retains other
conversations' unsent drafts. The SDK owns initial-title presentation.

`HandrailAssistantCloseGuard` also replaces Spartan's generic draft/discard/back
handler. Explicit flags select confirmation and work-in-progress blocking;
branding and a business-operation readiness flag stay in Spartan. It observes
account-wide SDK work, preserves drafts on Keep, clears them only after explicit
Discard, rejects duplicate or old-account close callbacks, and removes only its
own confirmation route even under unrelated navigation. Closing never issues
server cancellation. Standard account-retained views can close without this
optional discard policy.

The new actual SDK-backed Spartan UI/domain suite passes 55 cases and its real
application-shell launcher passes the focused context, history and Back test.
Cents' 30 and Mills' 128 integration compatibility cases pass against the shared
workspace options. The old custom-controller fixtures were retired; their prior
counts are historical evidence, not validation of this implementation. Shared
SDK checks separately validate minimal-host defaults and account/close lifetimes.
Receipts: `/tmp/spartan-shared-close-final-tests.log`,
`/tmp/spartan-shared-close-launcher-test.log`,
`/tmp/cents-workspace-options-tests.log`, and
`/tmp/mills-workspace-options-tests.log`.

Current adoption guidance is in the Flutter SDK's
`docs/mobile-assistant-adoption.md` and Spartan's rewritten
`docs/assistant-sdk-qualification.md`. This supersedes earlier ledger entries
that described Spartan's remaining custom mobile workspace. Dependency pins and
locks remain unchanged. These are explicit local-candidate source/widget checks;
no release, production data/configuration change or live Mobile Preview parity
is established. The overall goal remains active for remaining consumer/business
adapter work and final runtime/acceptance qualification.


The final Flutter SDK `make check` passes both fatal-info package analyses,
95 client tests and 88 widget tests, including the candidate JS protected-file
HTTP fixture. The added checks cover pre-admission work in another conversation,
remote unopened activity, cleared drafts under an expanded editor, account-owned
close dialogs under other routes, and system Back. Receipt:
`/tmp/flutter-close-workspace-final-check.log`.

A current Cents development Mobile Preview request through
`handrail_open_mobile_preview_browser` returned `preview_not_running`, classified
by the tool as `platform_blocker` with `app_failure_reproduced: false`. No browser
handoff was issued, no app was reproduced and no raw Flutter endpoint was used.
This does not block further local SDK/source work and does not establish that the
application itself failed. Normal preview qualification also needs the reviewed
committed SDK revision because consumer manifests still pin the older APIs.

## Shared legacy transcription lifecycle and retained files

Spartan's legacy multipart transcription service now delegates to the same SDK
helpers as the high-level gateway: `validateTranscriptionAudio`,
`createOpenAIAudioTranscriber`, `runRetainedTranscription`,
`createTranscriptionUsageRecorder` and `createAIRuntimeUsageDelivery`. Removed its
provider client/HTTP assembly, result parsing, retained-operation wrapper, deadline
and usage outbox scheduler. Host code retains configuration, authorization,
legacy operation/fingerprint identities, `{ text }` encoding and attribution.
Historical whitespace and outbox/evidence namespaces are preserved. The shared
environment resolver also treats blank credentials/scope as unconfigured and
uses the API URL fallback when the telemetry URL is blank.

The SDK deadline prevents an ignored/late provider result from completing a claim
while still recording incurred usage. Completed requests replay across service
recreation; changed input conflicts; uncertain outcomes cannot dispatch again.
The shared delivery worker coalesces startup/periodic flushes and stops new work
without deleting receipts or abandoning an in-flight acknowledgement.

The attachment audit reproduced three failing Spartan tests against the new SDK:
the host rewrote a current `ref_` as though it were an older `blob_` reference.
At that historical milestone SDK staging owned both formats without host rewrites.
The turn 36 unpublished cleanup removes its retired staging alias/fallback; see
[the current upload contract](trusted-history-and-attachments.md). The further extraction
adds `createConversationFileStorage` and removes Spartan's separate retention
transaction, metadata decoder, checksum reader and materialization loop. Spartan
supplies company/principal access policy, file content/type/size settings and its
original storage identities. Retained files survive upload consumption and
recreation; no existing namespace, blob identity or source history is migrated.
Default high-level staging retention remains unchanged.

SDK tests independently verify frozen upload bytes, whole-set validation before
consumption, immutable imports, tenant/principal isolation, access revocation,
checksum failure and rollback of bytes after a failed metadata write. Actual
Spartan tests additionally seed pre-upgrade staging, retained-file and
transcription records, and verify the canonical file HTTP route and provider
PDF/CSV/image resolution. The combined Spartan service/provider run passes all
41 cases in three files (`/tmp/spartan-shared-files-final-tests.log`). The earlier
32-case passing run is superseded, not additive. After the final file-bound checks, all 29 focused SDK cases pass
(`/tmp/shared-server-lifecycle-final-tests.log`) and all eight actual Spartan file
cases pass again (`/tmp/spartan-shared-files-final-bounds-tests.log`). SDK full
typecheck, normal build and scoped lint pass; Spartan
service/provider/test candidate compile and scoped lint pass. Final receipts:
`/tmp/shared-server-lifecycle-final-typecheck.log`,
`/tmp/shared-server-lifecycle-final-build.log`,
`/tmp/shared-server-lifecycle-final-lint.log`,
`/tmp/spartan-shared-files-final-compile.log` and
`/tmp/spartan-shared-files-final-lint.log`.

The current integration guide replaces stale dependency/source claims; the
September 11 retirement document is explicitly historical. Ordinary app pins and
lockfiles remain unchanged. Candidate tests use explicit temporary resolution,
not a local/file/workspace dependency or a separately packaged SDK. These newer
exports need a reviewed committed public SHA and matching lockfile before normal
consumer builds can use them. No release or production mutation was performed.

Remaining audit targets: Spartan's file-content policy and remaining presentation/
provider adapters; Mills' legacy transcription/live-call and mobile business
recovery integration; final current-source acceptance and available runtime
qualification. The subsequent Mills transcription/usage extraction below resolves the legacy
HTTP/result/timeout work identified here. The goal remains active for the final
current-source acceptance audit; these server checks do not establish production
parity.


## Mills shared transcription and live-call compatibility

Mills now uses `createOpenAITranscriptionRequest`, `createOpenAIAudioTranscriber`
and `runTranscriptionAttempt`, plus the shared usage environment resolver and
`createAIRuntimeUsageDelivery`. The attempt helper is also used internally by
`runRetainedTranscription`; it owns deadlines, usage-once fallback, result bounds
and late-result exclusion. Its lower-level form is for an endpoint that already
retains an SDK durable claim, as Mills does. No dummy claim or second identity
was introduced.

The existing household/user operation hash, request fingerprint, result envelope,
WAV alias, 4,000-character text limit, provider routing, error presentation and
legacy receipt projection remain in the Mills adapter. The SDK captures late
provider usage while preventing late text from completing a timed-out claim.
The live-call protocol and native household tools were inspected for shared-API
impact and retain their existing contract; this stage does not migrate or
silently change the separate live-call provider.

Validation passes:

- 27 SDK transcription/assistant/usage cases, including the smaller result limit,
  pre-abort, retained replay and late-usage protections:
  `/tmp/mills-transcription-sdk-final-tests.log`.
- 16 actual Mills transcription and durable usage cases:
  `/tmp/mills-transcription-candidate-tests.log`.
- Six selected actual Mills route cases (32 unrelated cases excluded), including
  a real shared transcription timeout, late provider reply and rejected retry
  with one physical dispatch: `/tmp/mills-transcription-routes-candidate-tests.log`.
- 18 Mills live-call compatibility cases:
  `/tmp/mills-live-compat-candidate-tests.log`.
- Eight Spartan transcription regressions:
  `/tmp/spartan-shared-attempt-regression.log`.
- SDK full typecheck, normal build and scoped lint; Mills and Spartan scoped
  candidate compiles; Mills scoped lint. Receipts:
  `/tmp/mills-transcription-sdk-final-typecheck.log`,
  `/tmp/mills-transcription-sdk-build.log`,
  `/tmp/mills-transcription-sdk-final-lint.log`,
  `/tmp/mills-transcription-candidate-compile.log`,
  `/tmp/mills-transcription-candidate-lint.log`, and
  `/tmp/spartan-shared-attempt-compile.log`.

The Mills checkout independently advanced to `7095a06`, incorporating the two
source edits during qualification. This run did not commit, push or deploy.
The manifest/lock still pin SDK `54d8a6d13fb98d0f9fa24ca464f002b694e5e96d`;
new SDK exports remain uncommitted candidate source. Normal consumption requires
reviewed committed Git revisions and matching lockfiles. The tests use explicit
temporary candidate resolution; they do not establish installed or production
parity. All checks completed and the goal remains active for the remaining
Spartan content/presentation-adapter review, Mills mobile recovery compatibility
and a requirement-by-requirement current-state acceptance audit.
