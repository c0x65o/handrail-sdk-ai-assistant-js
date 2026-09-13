# Shared assistant consolidation

Goal: `6f19391a-7545-4926-85bb-13761e8a404c`. This is the implementation and evidence ledger for making the optional SDK UI suitable for 35 projects. It is not a completion or deployment report.

The target ownership is SDK-managed assistant behavior with host formatting, business logic, and explicit feature settings. Cents must receive Spartan's sending experience by consuming the SDK, not by copying Spartan components.

## Feature ownership and remaining work

| Feature | Current evidence | Required end state / remaining work |
| --- | --- | --- |
| Send acceptance and editable next draft | SDK runtime emits `onAccepted` after durable admission; shared composer clears only that edit revision. Cents and Spartan now consume the same client workspace. Spartan's draft workaround is removed. | Spartan also verifies Stop requested before admission. Finish registered mobile and application qualification. |
| Composer focus, keyboard, Send/Stop | Shared Send focuses on activation only. Runtime cancellation is now the default, without a required host callback. Spartan DOM tests cover identical later drafts, failure/cancellation and focus. | Finish browser/consumer qualification and retain server cancellation semantics. |
| Attachment lifecycle | SDK owns per-conversation queues, admission cleanup, busy intake gates, drag feedback and codec-compatible capture. Cents uploads are enabled; Spartan's runtime/uploader/drop wrappers are removed. | Flutter now supplies the bounded picker, authenticated upload queue and retained retry identities; Cents and Spartan use them. Finish shared authorized saved-attachment display/download and remaining mobile adapters. |
| Approval settings | SDK owns the preference, per-request metadata and policy default. Cents uses it; Spartan retains its authorized domain policy. | Preserve domain review and mandatory approvals across consumer validation. |
| Authenticated STT | Web workspace and Flutter composer negotiate shared capture/transcription. Cents and Spartan use SDK controls; Mills uses the SDK recorder. Spartan's SDK raw route passes durable replay/account isolation tests. | Migrate Mills' remaining UI/legacy endpoint and retire multipart dispatch after installed clients and queued usage are handled. |
| Conversation management | Shared history owns active/archived/unread views, previews, stale selections, New identity, read recovery and archive/restore, including initial load and one initial empty-catalog creation attempt. Cents no longer bootstraps history in its client factory; endpoint launchers use the same controller. | Finish mobile adoption and remaining consumer/legacy fixture validation. |
| Transcript and activity | Shared timeline owns chronology, failures and scrolling. Optional UI shows bound approval details and saved statuses; domain render callbacks retain Spartan's cards. Cents activity is enabled. | SDK useBoundApprovalReview now owns domain review loading/retry/invalidation for Spartan and Mills; finish full consumer coverage. |
| Responses provider infrastructure | SDK owns native function correlation, HTTP/SSE networking, connection retries, physical usage receipts and normalized invocation replay. Default durable server assembly installs these; Spartan preserves only its existing identity scheme and domain preparation. | Review remaining legacy voice/upload server adapters and release migration. Recovered initial requests with no receipt stop safely. |
| Mobile | SDK Flutter owns admission callbacks, per-conversation drafts/files, bounded intake/upload/retry, Send/keyboard/editor behavior, and authenticated capture/transcription. Cents and Spartan use the shared composer; Mills uses the shared recorder. | Finish mobile upload/history/workspace and Mills UI consolidation; qualify committed pins and authorized previews. |
| Mills compatibility | Mills uses the SDK launcher, composer, preview and transcription controls; keyboard/submitted-draft/recorder/compact-CSS workarounds are removed. Its household history recovery and authorization remain. | Validate remaining legacy STT/live-call and household approval integration with mobile consumers. |
| Adoption documentation | `examples/minimal-shared-assistant.tsx` demonstrates endpoint-only adoption. This ledger documents shared ownership and release limits. | Finish migration instructions and validation evidence as remaining consumers are consolidated. |

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
- `conversationTimeline` and `ConversationTranscript` preserve original-question ordering across delayed decisions, imported identities, automatic completions and saved failures. The styled default consumes them. `renderApproval`, `renderConversationMessage`, `renderCompletedTool` and the legacy identity callback are supported formatting/business extension points.
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
