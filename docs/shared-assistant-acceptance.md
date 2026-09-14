# Shared assistant local acceptance

> Historical consolidation qualification. The later disposable-history decision
> removed Mills' legacy recovery guard and adapters from current source. Retained
> history requirements below no longer describe the current cleanup objective.
> See [current cleanup progress](assistant-cleanup-goal-progress.md) and
> [deletion/retention](conversation-deletion.md) for the remaining work.

Goal `6f19391a-7545-4926-85bb-13761e8a404c`, reviewed September 13, 2026.
Scope: AI Chatbot group — Handrail AI Assistant SDK, Spartan Cyber ERP,
Hitcents ERP/Cents and Mills Family Office, including their registered mobile
consumers. This record covers the requested local implementation, qualification
and documentation. It does not establish production parity or authorize release.

## Cause and resulting ownership

The earlier optional UI did not own the complete experience. Spartan supplied
composer/draft, voice, file and history infrastructure outside the SDK, while
Cents disabled approval/activity/file controls and replaced the microphone slot
with a character counter. Installing the package therefore did not reproduce
Spartan's behavior.

The shared React workspace now supplies that experience, and the endpoint
launcher delegates to it. Flutter supplies a combined workspace with shared
account, composer, history and transcript controllers. Cents and Spartan consume
these surfaces. The SDK also owns reusable server dispatch, transcription,
usage evidence, file staging/retention and content validation. Hosts retain
branding, route context, domain result/approval cards, authorized business
operations, provider/feature settings and adapters for existing saved identities.

## Acceptance review

| Requested criterion | Implemented boundary and evidence |
| --- | --- |
| 1. Reusable features live in the SDK; minimal adoption is documented | `HandrailAssistantWorkspace`, `HandrailAssistantLauncher` and Flutter's combined workspace own common UI/controller behavior. Shared server helpers replace generic host HTTP, transcription deadlines/replay, usage scheduling and file retention/validation. `examples/minimal-shared-assistant.tsx` demonstrates endpoint, authenticated request, branding and flags only. `docs/adoption-standard.md` and the Flutter adoption guide document host seams. |
| 2. Shared sending behavior | Runtime admission triggers revision-specific draft clearing; later edits, including identical text, survive completion, failure, cancellation and conversation changes. Next text remains editable while submission/file intake is separately gated. Send activation restores focus; response events do not steal it. Shared Enter/Shift+Enter, duplicate prevention and Send/Stop controls are covered by SDK runtime/React tests and actual Spartan/Cents/Mills UI tests. Spartan's bespoke web composer/hooks and mobile composer/controller were removed. |
| 3. Approval, STT, files, history and transcript | Shared approval preferences are frozen into each submitted request and read by authorized server confirmation policy. Hiding controls grants no permissions; domain authorization and mandatory review remain authoritative. Shared authenticated capture/transcription inserts into the current draft and owns retry/cancellation/cleanup. Shared queues, protected saved downloads, archive/restore, unread filtering, titles/previews, Markdown/citations/copy, tool activity, failures and recovery are implemented in SDK APIs/default UI. Tests cover account/conversation isolation and durable replay. |
| 4. Cents adoption | `CentsDrawer.tsx` uses the shared workspace; the character count occupies `renderComposerActions`, leaving microphone and approval/attachment controls available. Native runtime uploads are enabled and standard provider transcription is negotiated. Branding, route context, the 2,000-character limit and `CentsResults` remain host concerns. Cents mobile uses the shared combined workspace. The actual web component/browser fixture validates admission, focus, editable next draft, keyboard sending, shared controls, history and exact PDF upload/send/download. |
| 5. Cleanup, preservation and validation | Spartan's generic composer/upload/voice/history coordinators are removed; content validation now uses `createAttachmentContentValidator`. Saved namespaces and legacy file references remain compatible. Mills uses shared draft/dictation/transcription/usage handling while retaining its household recovery authority. Scoped compiles, SDK tests and actual consumer suites pass; browser qualification and the Mobile Preview limitation are recorded below. Historical rollout records are labeled as such. |

## Final business-adapter review

Spartan's remaining web message/tool renderers format business content, including
ERP citation navigation and canonical legacy file URLs; common transcript
behavior is available in the default SDK UI. Its provider adapter prepares
company-authorized history and expense receipts, applies ERP write/review policy,
and preserves existing invocation identities around SDK execution. Its file
policy now contains format/size settings and branded errors only; the shared
validator implements signature/type checks and safe filenames.

Mills mobile retains its `mills_history_recovery` guard. Opening a session does
not retry a saved request while that marker is present. Send, explicit retry and
proposal decisions each check the canonical guard. An HTTP reconciliation success
cannot clear it; the SDK must synchronize the canonical resolution. This is a
business/data-compatibility rule, not a second generic conversation runtime.
Mills' separate live-call protocol was checked for shared-API compatibility and
preserves its existing contract.

Compatibility routes still used by installed clients are thin adapters to shared
helpers. They preserve saved hashes, envelopes and usage receipt identities;
removing those routes before a deliberate client/data migration would invalidate
existing consumers. New projects use the standard gateway directly.

## Qualification evidence

Counts below identify separate runs, not a grand total; some suites overlap.
The chronological [implementation ledger](./shared-assistant-consolidation.md)
contains the detailed fixtures, earlier failures and their fixes.

- Final content extraction: six SDK content/retention tests and 41 actual Spartan
  attachment/provider/transcription tests pass. SDK full typecheck, normal build
  and scoped lint pass; Spartan scoped source/test compile and lint pass.
  Receipts: `/tmp/shared-content-tests.log`,
  `/tmp/shared-content-spartan-tests.log`, `/tmp/shared-content-typecheck.log`,
  `/tmp/shared-content-build.log`, `/tmp/shared-content-lint.log`,
  `/tmp/shared-content-spartan-compile.log` and
  `/tmp/shared-content-spartan-lint.log`.
- Shared sending: 82 focused runtime/composer/primitives cases; broader React
  qualification passed 266 cases. Actual Spartan DOM tests cover identical later
  drafts, admission failure, Stop before admission and focus; Mills' shared
  component qualification passed 51 cases. These are recorded in the ledger.
- Authenticated files and Cents integration: 112 SDK attachment/gateway/provider/
  persistence/styled cases, 14 cancellation cases, and 24 actual Cents auth/
  gateway/runtime/modal cases pass, with scoped browser/server/test compiles.
  `/tmp/cents-protected-download-final-tests.log` records the Cents run.
- Shared transcription/usage: 27 SDK cases, 16 Mills service/usage cases, six
  selected actual Mills route cases, 18 Mills live-call compatibility cases and
  eight Spartan transcription cases pass, with SDK and host typed compiles.
  The ledger's Mills transcription section records each receipt.
- Flutter SDK: fatal-info analysis for both packages, 95 client tests and 88
  widget tests pass (`/tmp/flutter-close-workspace-final-check.log`). These
  include minimal-host/responsive history and shared account/close behavior.
- Actual mobile consumers: 55 Spartan UI/domain cases plus the application-shell
  launcher case, 30 Cents cases and 128 Mills compatibility cases pass. Receipts:
  `/tmp/spartan-shared-close-final-tests.log`,
  `/tmp/spartan-shared-close-launcher-test.log`,
  `/tmp/cents-workspace-options-tests.log`,
  `/tmp/mills-workspace-options-tests.log`. The final Mills recovery audit is
  additionally checked in `/tmp/shared-acceptance-mills-recovery.log`.
- Actual Cents web component and authenticated gateway fixture: Chromium at
  1280×900 and 390×844, light/dark, with inspected screenshots, no page errors
  or CSP violations, and exact protected PDF download. Its report is
  `/opt/handrail/.handrail/codex-runs/cb7aa3b3-4d22-4da1-b60c-502ca6ab5d84/tmp/cents-web-check-smYLZA/report.json`.
  This uses synthetic account/provider/PGlite with explicit candidate resolution;
  it does not measure real microphone transcription accuracy or production login.
- Authorized Cents development Mobile Preview returned `preview_not_running`,
  classified by Handrail as `platform_blocker`, with
  `app_failure_reproduced: false`. No browser handoff was issued and no raw
  Flutter listener was used. Mobile behavior is qualified by the SDK and actual
  consumer widget/integration tests; live preview qualification remains a release
  verification step when the declared preview is available.

## When this applies and release handoff

The requested local candidate is reviewable. Ordinary installed dependencies do
not include all uncommitted SDK helpers. Tests used explicit temporary compiler/
test resolution; no local/file/workspace/tarball dependency was installed and no
separate SDK packaging step was used. Normal compilation remains the SDK's
install/build pipeline.

The September 13 snapshot (`/tmp/shared-assistant-final-workspace.json`) records
matching public HTTPS Git pins and lockfiles: Cents/Spartan web use JS revision
`54d8a6d13fb98d0f9fa24ca464f002b694e5e96d`; Mills web independently advanced to
`5dce3fb247c26e58626c698efd66efc1f8a40fb7`. None contains the complete uncommitted
candidate. Mobile pins still resolve historical `flutter/` paths in the JS
repository; the active Flutter source is in the declared sibling SDK repository.
Other actors advanced consumer checkouts during this goal; this run did not
commit, push, open PRs or deploy those changes.

A later authorized release must commit/review the JS and Flutter SDK candidates,
then update consumer public HTTPS dependencies to those full committed SHAs with
matching locks. Flutter pins must target the declared Flutter repository's
`packages/handrail_ai_client` and `packages/handrail_ai_widgets` paths. Run ordinary
consumer install/build and the relevant regression suites against those pins,
then validate the available authenticated web/mobile environments before rollout.
No production data or project configuration was changed by this work.
