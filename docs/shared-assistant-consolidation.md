# Shared assistant consolidation

Goal: `6f19391a-7545-4926-85bb-13761e8a404c`. This is the implementation and evidence ledger for making the optional SDK UI suitable for 35 projects. It is not a completion or deployment report.

The target ownership is SDK-managed assistant behavior with host formatting, business logic, and explicit feature settings. Cents must receive Spartan's sending experience by consuming the SDK, not by copying Spartan components.

## Feature ownership and remaining work

| Feature | Current evidence | Required end state / remaining work |
| --- | --- | --- |
| Send acceptance and editable next draft | SDK runtime now emits `onAccepted` after durable message/turn admission. Shared composer clears only the submitted edit revision and ignores stale conversation callbacks. | Consume the updated SDK and remove Spartan `use-aegis-composer.ts`. Validate actual installed consumers. |
| Composer focus, keyboard, Send/Stop | Shared textarea remains editable during sending; shared Send focuses it only on activation. Existing Enter/Shift+Enter/IME handling and Send/Stop primitives remain in use. | Replace Spartan `AegisChatComposer.tsx` with standard composition and verify browser interactions. |
| Attachment lifecycle | Shared composer releases submitted attachment resources at admission and blocks paste, picker, and drop intake during an active turn. | Consolidate remaining Spartan uploader/runtime/drop wrappers into SDK behavior. Enable Cents attachments through the authenticated server contract; its current server advertises `attachmentUpload: false`. |
| Approval settings | SDK exports the shared control and request metadata helpers. Spartan binds the preference to its server execution context. Cents hides the control and uses direct authorized execution. | Provide standard configured UI/request wiring; connect Cents policy to the selected mode while preserving domain authorization. |
| Authenticated STT | Shared `useComposerTranscription`, styled control, negotiated HTTP client, authorized gateway handler and `openaiTranscription` server adapter now exist. The standard endpoint launcher configures them from capabilities. `renderComposerActions` separates counters from voice overrides. | Migrate Spartan/Mills server/client wrappers and enable Cents through the shared path. Remove unnecessary recorder wrappers. Preserve existing live-voice adapters where applicable. See `transcription-ui.md`. |
| Conversation management | SDK now has `useConversationHistory`, `ConversationHistoryPanel` and a default endpoint-launcher sidebar. Active/archived views, unread filtering, bounded preview hydration, stale-selection protection, read recovery and archive/restore are shared. Archived workspace rendering disables the composer and approval buttons. | Migrate host sidebars. Consolidate legacy compact-picker orchestration, verify theme/CSP bundling and preserve app-specific header formatting. |
| Transcript and activity | SDK has Markdown, citations, message actions, tool activity and approval primitives. Spartan has custom transcript/activity composition; Cents explicitly hides tool activity. | Consolidate reusable orchestration, preserving host domain-specific action/result renderers. |
| Mobile | Shared Flutter composer exists, with host-owned sessions, voice, approval and attachment adapters in registered applications. | Audit and consolidate equivalent reusable behavior; verify real pinned consumer builds and authorized previews. |
| Mills compatibility | Mills uses SDK launcher plus local keyboard, voice and approval integration. Its worktree has independent ongoing startup/history changes. | Preserve those changes; replace overlapping generic behavior only after validating shared equivalents. |
| Adoption documentation | This ledger records current ownership. | Deliver a minimal runnable consumer example and document defaults, flags, authorization and supported extension points. |

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
- Compact catalog presentation now uses `useConversationHistory` too. The exported preset CSS includes history styling, including when a host bundles it under a strict CSP. The old duplicated catalog mutation/load implementation is removed. Compact selection still needs its archived read-only binding brought into the common workspace wrapper.
- The default server policy for tools declaring approval mode `policy` reads `handrail_approval_mode` from the durable admitted request. Missing/invalid context fails closed; application and plugin authorization runs first; mandatory `always` approvals remain mandatory. Custom server approval policies remain supported. A real tool-executor regression covers concurrent per-turn preferences, missing/invalid metadata, denied operations and mandatory review.
- A Cents file-only test found that `message.created` rejected the composer's empty content array. The runtime now records one empty text part alongside the attachment events. This preserves the event contract and fixes headless and UI callers. A runtime replay regression covers the admission.
- Cents locally uses the new client workspace and enables native uploads and policy-controlled writes. Its obsolete history shell, dummy uploader, hidden-activity flag and voice-slot counter are removed. Its branding, route context, domain results and prompt limit remain. See the Cents repository's `docs/cents-shared-ui-candidate.md` for evidence and release prerequisites.
- SDK history/launcher/styled/server suites passed after consolidation (46 tests across those four suites). Runtime and standard-composer suites passed after file-only admission/drop guards (46 tests). These totals overlap previous runs and are not cumulative unique coverage. New source builds passed; final typecheck/lint and consumer refinements are still being checked.
- The Cents component passed 11 candidate tests. Its gateway fixture passed required/automatic approval, replay/usage/account-isolation and cancellation/deadline cases against local PGlite and fixture HTTP. The earlier unconfirmed-write expectation timed out correctly once confirmation became the default; the fixture now exercises confirmation explicitly. No provider credentials or production database were used.
- `examples/minimal-shared-assistant.tsx` shows the endpoint UI with host authentication and branding. It does not require a host composer, recorder, history controller or approval preference state.
- Final checks for this stage: SDK `npm run typecheck`, `npm run build`, examples typecheck and scoped ESLint passed. Cents browser and server candidate compiles passed. The 11 Cents component tests also passed with the full-features case under React Strict Mode. Its normal Git-pinned browser compile correctly fails on the unpublished `HandrailAssistantWorkspace` export (and the test fixture's new transcription capability export); package/lockfile remain unchanged. A source-path candidate pass is not an installed-pin pass.
- An existing `scripts/check-cents-web-ui.ts` can validate the actual Cents component, application CSS, CSP and authenticated SDK gateway against synthetic identity/provider/PGlite. It still expects the retired New-chat labels and must be adapted to this candidate before being rerun. Its older saved results do not validate this change.

Next implementation step: finish shared action-review/transcript composition and attachment display/download behavior; migrate Spartan and delete its validated workarounds, then finish Mills compatibility and mobile behavior. Review uploader lifetimes under Strict Mode and compact archived selection. Consumer validation must separately establish that the actual pinned installation consumes the reviewed revision. Do not replace the remaining objective with the already-passing SDK/Cents subset.

## Repository and release boundaries

At the start of this goal turn, the SDK already had independent changes in `src/react-styled/index.tsx` and `test/react-realtime-launcher.test.tsx`; `docs/adoption-standard.md` also changed independently during the turn. Mills has independent startup/history edits. Preserve these changes and review provenance before any release operation.

Application dependencies must use the public HTTPS SDK Git repository, full committed SHAs and matching package-manager lockfiles. No file/workspace/tarball dependency or manual package installation may substitute for the supported install/build pipeline. Do not claim end-to-end completion while consumer adoption or validation is still pending.
