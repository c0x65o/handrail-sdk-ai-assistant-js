# Settled actions and steady transcript following

Work request: `6fbeac6e-8144-5474-949d-c990acd55a84` (2026-10-01).

The intended usable outcome is Mills mobile and web showing active assistant
work without persistent full-size executed cards, with a steady jump control.
This change prepares both shared SDKs. Mills adoption and native QA remain with
Avery's existing integration/release workflow; SDK tests do not accept that outcome.

## Presentation contract

- Canonically executed, rejected and expired proposals move into a collapsed
  **Action history** disclosure. Opening it renders the original card and host
  business wording. Canonical records are never removed or rewritten.
- Flutter's structural binding also accepts settled `finished`/`completed`
  presentations and locally flagged expired pending items. An explicitly
  selected inbox proposal still renders in full.
- Pending confirmations, confirmed-but-not-executed actions, executing actions,
  failures, unknown states and unresolved decision/error evidence remain visible.
  Approval gates, review requirements, permissions and execution are unchanged.
- History starts closed on reload and resets on conversation/account scope
  changes. Duplicate snapshot delivery does not reopen it.
- Scroll-follow state now distinguishes reader movement from layout and SDK
  anchor/tail adjustments. Once paused, downward scrolling must actually reach
  the tail (two-pixel rounding tolerance), or the reader must choose Jump to
  latest. Crossing the former 48/64/72-pixel thresholds cannot repeatedly mount
  and unmount the control. Paged web also pauses on upward wheel/touch/keyboard
  intent before the next layout frame.
- No jump animation, theme, business mutation, platform, Agent engine, or Mills
  source change is included.

## Consumer analysis

Read-only Mills mobile inspection confirms `lib/screens/assistant_screen.dart`
uses `HandrailAssistantWorkspace`, supplying an approval title formatter. The
shared approval view is mounted in its transcript tail. Mills web uses the shared
launcher with `MillsNativeApprovalCard`; it inherits the shared transcript history
presentation. The existing cream/clay theme remains supplied by Mills.

## Qualification

Exact commands, outputs and log hashes are in
`settled-transcript-qualification.json` here and in the Flutter repository's
`docs/settled-transcript-qualification.json`.

The Flutter regression fails against the unmodified base for cards and both
scroll implementations, then passes with the patch. The full widget suite passes
240 tests. Scoped client tests use the repository's existing HTTP boundary
fixture to exercise permission vetoes, lost/duplicate saved decisions, uncertain
receipts, conversation switching and sign-out. These do not prove database or
provider persistence and do not execute real tools.

Web checks include focused React tests, TypeScript typecheck, normal SDK build,
and a Vite-built public SDK fixture in Chromium. For each of full and paged
transcripts, 27 away frames keep the control present, 24 pinned frames keep it
absent, and jumping returns to zero pixels from the tail. History opens and is
collapsed after reload. The fixture uses synthetic read-only data and cannot call
a business provider. The browser harness is reproducible with:

```sh
npm run build
node scripts/check-settled-transcript-browser.mjs
```

`HANDRAIL_TEST_CHROMIUM` may select an installed Chromium binary. This worker used
a shorter writable `TMPDIR` for Chromium's Unix socket path. Flutter's shared SDK
cache was read-only; checks invoked its installed `flutter_tools.snapshot` through
the installed Dart binary with `FLUTTER_ALREADY_LOCKED=true`. Dependencies were
resolved using normal `pub get --enforce-lockfile` into a writable task cache;
lockfiles did not change.

One existing web test expected two “Waiting for approval” headings although the
unchanged preset renders one. That failure was reproduced against the unmodified
source and its stale expectation was corrected. The existing rejected-card test
now opens Action history before checking the saved status.

## Delivery and exact adoption procedure

The worker leaves source changes **uncommitted**. Handrail owns version bumps,
commit and push. No PR, commit, push, deployment, queue/database mutation, or live
vehicle update was performed. Local Flutter `main` was fast-forwarded to preserve
all four already-committed feature-branch changes and resolve the branch-policy
mismatch. No work was reset, stashed or discarded.

Inspection bases (these **do not contain this fix**):

| Repository | Version before Handrail bump | Base full SHA |
| --- | --- | --- |
| JS | `@handrail/ai-assistant` 0.2.65 | `f2c591f630fdbb547ebfb94859f4acdd6a77b55e` |
| Flutter | widgets 0.1.1; client 0.1.26 | `94c44925d78e3b3479a8039597984be3b0f95ec6` |

After Handrail supplies the newly published full SHAs and resulting versions,
Avery freezes those revisions for this adoption. Do not substitute the bases
above, a branch, tag, tarball, registry, file dependency or local workspace.

In Mills web, set `JS_SDK_SHA` to the **new published 40-character JS SHA**, then:

```sh
npm install --save-exact "git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#${JS_SDK_SHA}"
npm ci
```

Keep the resulting `package.json` and `package-lock.json` together. The Git
package's existing `prepare` hook performs normal SDK compilation.

In Mills mobile, replace both Git `ref` values in `pubspec.yaml` with the **same
new published full Flutter SHA**:

```yaml
handrail_ai_widgets:
  git:
    url: https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter.git
    ref: <new published full Flutter SHA>
    path: packages/handrail_ai_widgets
handrail_ai_client:
  git:
    url: https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter.git
    ref: <same new published full Flutter SHA>
    path: packages/handrail_ai_client
```

Run `flutter pub get`, retain `pubspec.lock`, verify both resolved Git refs match
that SHA, and run `flutter pub get --enforce-lockfile` plus the existing consumer
checks/build pipeline. No separate SDK packaging/publishing step is needed.

Remaining acceptance: Avery adopts the actual post-agent revisions, then checks
the original vehicle/review scenario on the native Mills Assistant using safe
fixtures or retained history, tests streaming/keyboard/manual scrolling and
reload/reconnect, and verifies pending/uncertain/failed actions remain reachable.
Production/TestFlight delivery stays with the separately authorized existing
release workflow. This worker has no native production runtime acceptance or
published fix SHA to report before Handrail's post-agent step.
