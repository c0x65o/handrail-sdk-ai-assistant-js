# Chatbot foundation: local qualification and adoption

This work is not released. The AI Chatbot group includes the JS/Flutter SDK,
Hitcents ERP, Mills Family Office and Spartan Cyber ERP. Dependency declarations
and lockfiles remain unchanged. No commit, push, PR, deployment or production
database write is authorized by this goal.

## Cause and resulting contract

The measured Hitcents list delay was approximately 9.75–10.08 seconds for five
conversations, while its metadata SELECT took 108 ms through diagnostics. The SDK
list handler awaited per-conversation reconciliation and approval recovery. The
4.7 MB measurement was one saved server state, not a measured browser response.
Transcript length and recovery work therefore mattered even with a short list.

The local implementation separates metadata, complete display messages, related
activity, execution controls and canonical history. The SDK mounts the protected
routes. Apps supply identity, authorization, domain formatting and declared
persistence; they should not add an extra full transcript or approval-group read
after the SDK opens a paged conversation.

Defaults are 30 messages and 64 KiB per initial page, 90 messages / 256 KiB retained
per selected transcript, and a separate 90-record / 256 KiB related-activity
window. Four idle sessions are retained by the standard workspace. Running and
pending sessions retain observation within their existing registry limits.
Oversized message text opens explicitly in one 8,192-code-point section. These
are content and record limits, not an assertion about total process heap.

See [the API and migration contract](display-history-api.md),
[storage benchmark](display-history-benchmark.json),
[browser component benchmark](display-window-browser-benchmark.json) and
[the implementation/validation ledger](chat-history-performance.md).

## Consumer contracts checked locally

The JS script `scripts/check-consumer-contracts.mjs` compiles real consumer
entrypoints and their imported source against the SDK's built public declarations.
It overrides TypeScript resolution only for that compiler invocation. It does not
install an SDK or change a consumer configuration. Recorded results are in
[consumer-contract-qualification.json](consumer-contract-qualification.json).

| Consumer | Web/server source contract | Mobile source contract | Integration changes |
| --- | --- | --- | --- |
| Hitcents | Pass: drawer/client and native gateway | Pass: SDK adapter and sheet | No source change required by these compiles |
| Mills | Pass: assistant runtime and gateway | Pass: repository and screen | Domain projection takes presentation fields and observes display changes; single-chat policy preserved |
| Spartan | Pass: assistant UI and gateway | Pass: repository and screen | Narrow web UI types; mobile projection consumes loaded activity and avoids full approval hydration in paged mode |

Spartan's web formatting/notification tests pass against the existing installed
pin. Its 25 scoped mobile tests pass against the local Flutter SDK, including an
actual negotiated paged session: loading another activity page refreshes domain
cards with no canonical snapshot or full approval-group request. Mills' existing
history/review/repository tests also pass against the local SDK.

The Flutter repository provides `tool/check-consumer-contract.mjs` for frontend
compiles and `--test` runs. It uses a temporary compiler package map and the
consumer's existing dependency graph, runs without pub resolution, and cleans up
its temporary files. The original pubspec and lockfile stay intact. This is
source qualification, not proof of a published dependency installation or a
device build. No unpublished SHA is substituted into an application dependency.

Example source checks, after building the JS SDK:

```sh
node scripts/check-consumer-contracts.mjs "$MILLS_REPO" tsconfig.json \
  src/client/assistant/MillsAssistantRuntime.tsx \
  src/server/assistant/handrail-ai-gateway.ts
```

From the Flutter SDK repository:

```sh
node tool/check-consumer-contract.mjs "$FLUTTER_SDK" "$SPARTAN_MOBILE_REPO" \
  lib/src/aegis/aegis_sdk_repository.dart lib/src/aegis/aegis_conversation_screen.dart
node tool/check-consumer-contract.mjs "$FLUTTER_SDK" "$SPARTAN_MOBILE_REPO" \
  --test test/aegis_sdk_repository_test.dart test/aegis_sdk_projection_test.dart
```

## Local acceptance and later adoption checks

The requested local SDK implementation and regression qualification are complete.
[The acceptance map](chatbot-foundation-qualification.md) connects the six requested
deliverables to implementation, tests and benchmarks. The final machine-readable
record is [chatbot-foundation-final-qualification.json](chatbot-foundation-final-qualification.json).
This supersedes earlier progress notes that called the broader audit open.

| Area | Locally qualified | Later adoption/optimization boundary |
| --- | --- | --- |
| Display and related activity | Bounded complete messages, stale cancellation, anchors, virtualization, explicit large content, paged pending inbox and verified approval review | Custom app placement and domain formatting |
| Sending and recovery | Streaming, stop/retry/reconnect, durable admission, exact receipts, approval restarts, competing leases, graceful drain, authorization and account isolation | Deployed failover/network qualification for each environment |
| Local state | Durable text/files and positions, bounded ownership, exact admission cleanup, deletion fences and expired-upload correction | Host encrypted storage/logout policy and custom upload adapter adoption |
| Canonical execution | Separate canonical input and display, bounded provider text policy, safe concurrent-change revalidation, one unchanged checkpoint read | Cold canonical decode/prior-file catalogs still scale with saved state |
| Scale | 20k/100k event fixtures, real PostgreSQL 30-connection isolated workloads, HTTP bytes, production React rendering/heap and offscreen Flutter VM/render budgets | Physical-device frames and actual production workload capacity |
| Compatibility | Full JS/Dart/Flutter suites and all three web/server/mobile source contracts | Published full-SHA installs with matching locks, migration and authorized deployment |

Spartan's web resource-refresh integration now uses the SDK workspace settlement
notification. It revalidates mounted data when background work settles without
reading hidden tool bodies; the contract register accepts that general
revalidation hint. Initial saved history and older-page loads do not trigger it.
The previous completed-result hook remains the compatibility fallback for older
SDKs. Runtime-keyed weak bookkeeping prevents one account's old chat identity
from leaking into another account's fallback observer. Local source changes
still require future authorized SDK dependency adoption.

Flutter draft retention is now qualified locally, including storage failure and
callbacks that outlive the editor. Defaults are eight idle editor instances,
64 KiB per text draft, 32 retained text drafts/snapshots with 512 KiB total UTF-8
content, 64 selected files / 64 MiB across the account, and two concurrent host
upload futures. Empty idle editors can be evicted without a storage adapter.
Rejected edits and file replacements preserve the existing work and expose a
capacity error. Pending sends, slow saves and cancelled uploads stay charged
until their actual callbacks settle. A selected file is converted to immutable
upload metadata/bytes once, preserving exact retries without repeated render-time
byte copies. These are retained-content budgets, not a total heap limit.

Text uses the account's durable draft store. Native unsent file persistence is
now available through the optional `HandrailKeyValueAttachmentDraftStore`, backed
by host encrypted metadata and binary callbacks. The standard workspace/factory
restores the selected conversation, persists upload identity before network work,
and reuses ready references after recreation. Unconfigured hosts retain the
existing account-memory behavior. Each app still needs explicit encrypted-adapter
configuration and native qualification when it adopts a published SDK SHA.
See `flutter-draft-retention-qualification.json` for the focused tests, analysis
and three real mobile source compiles. No dependency pins or locks were changed.

Browser deletion cleanup now runs after a validated server deletion response.
The standard IndexedDB adapter atomically removes that chat's pending intent,
draft, files and position and retains only its immutable deleted identity. Old tabs
cannot recreate the rows; unrelated chats and account/API scopes remain intact.
The runtime registry and picker treat a device cleanup failure as an already
completed remote deletion, and the shared picker offers a device-only retry.
Custom stores must implement `eraseConversation`; custom deletion UI should
handle `ConversationLocalErasureError`. The API document records the version-4
IndexedDB upgrade and rollback restriction. Local Chromium qualification is
recorded in `local-erasure-browser-qualification.json`; it does not use an app
preview or production data.

The browser's standard SDK uploader now has account-owned file drafts. This fixes
the previous composer cleanup that removed selections on chat switch/unmount.
`attachment-draft-browser-qualification.json` exercises the real standard React
workspace, account-scoped IndexedDB, and local HTTP upload: one upload across
switches, transcript-cache eviction and reload, exact source/key preservation,
account isolation, and explicit removal surviving reload. Storage and owner tests
also cover quota rollback, cross-tab replacement, callback settlement, and late
send admission after an account change. These are local synthetic proofs.

All three inspected web integrations currently omit durable `pendingStore`
configuration; omission intentionally provides account-memory retention only.
For later adoption, construct one `IndexedDBApplicationConversationPendingStore`
per stable authenticated account AND API endpoint, pass it to the client/launcher,
and dispose the client before closing it. Account changes must replace both.
Apply the host's logout erasure policy explicitly; never use a token as the scope.
Hitcents and Spartan already use the standard SDK uploader and will obtain owned
file drafts through the new client after the authorized SHA/lock upgrade.

Mills currently passes a custom `uploaderForConversation`. Convert its existing
authorized upload route into `attachmentUploadAdapter` so draft ownership and
queue limits stay in the SDK. Preserve its sole-conversation policy and stricter
intake limits. Its current upload function creates fresh intent/completion keys;
the adoption must carry the SDK's exact selection key through both stages and
qualify server replay, rather than claiming reload idempotency from the browser
alone. The additive adapter seam is implemented/tested in this SDK; this change
does not modify the installed Mills route or dependency pin.

The browser process-loss boundary now has an exact device-origin receipt. The
standard composer saves the persisted text revision and stable file IDs with
pending admission; a restarted client removes only those identities after
confirmed replay. Newer edits, even identical text or file bytes, remain. Failed
cleanup keeps the original journal and offers retry without changing server
mutation/start identities. Real Chromium qualification covers interrupted file
cleanup, reload, newer text/file edits, and successful exact replay; no local
receipt reaches server bodies. Local journal version 2 is required for receipts;
old version-1 journals remain readable. Older SDKs reject version 2, so preserve
pending journals and use a compatible client during rollback. See the API guide
for headless/custom store integration. Flutter now shares version-2 origin
receipts and account-owned replay cleanup. Its optional native attachment store
now makes source bytes and ready references durable. Metadata-only accepted
cleanup works without opening the originating chat; permanent deletion fences
late writers. Store writes use revision comparison, so competing editors or
uncertain commits require explicit reload instead of replacing unseen work.
The Flutter repository's `docs/native-attachment-draft-qualification.json` records
source-level tests and consumer compiles. Physical-device encrypted-store
qualification is a later adoption obligation.

Provider-input audit: Hitcents' `native-request.ts` already keeps at most twenty
historical text messages / 24,000 characters. Mills calls the shared saved-turn
preparer with the same defaults, plus its document limits and text redaction.
Spartan keeps thirty input messages through `AEGIS_MAXIMUM_INPUT_MESSAGES`, with
its own authorized file materialization. These policies are independent of the
display window and must stay independent. The shared preparer now avoids a second replay when the canonical head is unchanged,
uses a streaming equality token instead of whole-transcript JSON, and detaches
selected text from parsed checkpoint backing storage before asynchronous host
callbacks. Changed heads still receive full admission/history revalidation.
Replay reads are paged and cancellable. Historical redaction is a pure callback
and stops once the configured message quota is filled. Current input remains
required and prior file identities remain available.

See `provider-preparation-qualification.json` and the repeatable benchmark script.
Cold canonical loading and the complete prior-file catalog still scale with
retained state; these costs are separate from bounded display reads. Further
indexed provider-context/catalog work must preserve the admitted input, file
authorization and concurrent-change semantics. Visible browser pages are never
used as a substitute for canonical model input.

## Later release procedure (requires separate authorization)

1. Review and freeze the locally tested SDK source. Preserve the acceptance
   artifacts and rerun relevant checks if the source changes. Record benchmark
   environment, connections, wire bytes, render costs and retained heap separately. Synthetic single-connection PGlite
   timing must not be presented as production concurrency.
2. Commit/release both SDK repositories only after authorization. Resolve the
   actual public HTTPS Git full commit SHAs. Use those exact frozen revisions in
   each target's dependency declaration and regenerate its matching lockfile.
   Never use a file, workspace, archive, registry, branch, tag or invented pin.
   Keep SDK compilation in the ordinary install/build pipeline.
3. Apply the additive display migrations through the approved deployment/database
   workflow for each declared resource. Preserve canonical tables. Backfill is
   bounded and resumable; preparing history must remain visibly preparing. Do not
   disable authorization or run production SQL from this local-development goal.
4. Qualify server capability negotiation and mixed-version clients. Existing
   clients retain their supported canonical endpoints. New clients choose bounded
   sessions only when the required display/control capability is advertised; old
   servers keep the documented fallback. Roll out servers before relying on new
   client capabilities, including the separately negotiated message-text reader.
5. Adopt in Hitcents as the measured multi-chat case, then Mills with its
   single-chat restriction, then Spartan with domain approvals and background
   notifications. For each, exercise account changes, old/running histories,
   scroll restoration, uploads, approval decisions, clear/delete, voice/realtime
   and interrupted sends on web and mobile. Use declared preview/deploy targets.
6. Expand toward 30 projects only after the same repeatable contract and budget
   gates pass. Monitor list/history/control latency, payload bytes, recovery queue
   saturation, projection lag and client memory independently. Preserve canonical
   state and the additive schema during rollback; clients can fall back through
   capability negotiation when supported.


## Pending inbox qualification (local continuation)

The scalar pending indicator and indexed `pending_approvals`/`approval` views
are implemented in the shared server. React's standard preset and Flutter's
standard workspace expose an independent, on-demand inbox. Explicit navigation
retains one page, and review remains bound to canonical proposal versions and
argument references. Older servers do not advertise the new feature.

Focused storage/gateway/session/React tests cover old pending decisions, cursor
scope, resolution, clear, deferred records, held reads and account replacement.
Flutter client tests cover discovery, hash-bound review, durable decisions,
paging, cancellation and chat changes; widget tests cover a 390px layout and
review-before-confirmation. Chromium exercises the production public React build
at 320px/390px, with no extra transcript pages. TypeScript and scoped Dart
analysis pass. All three web/server consumer source contracts were recompiled
against the built public declarations and passed after this addition. These checks do not qualify oversized structured review or each
application's custom approval surface. Custom Flutter hosts should place
`HandrailPendingApprovalInbox(binding: controller.approvals.uiBinding)` outside
the scrolling transcript during future authorized adoption. Dependency pins and
production data are unchanged by this continuation.


## Bounded approval review qualification (local continuation)

Standard web/Flutter approval review now supports one verified argument section
at a time, explicit acknowledgement, scoped cancellation, version checks and
compact decision receipts. Native uncertain decisions retain their exact intent
through restart. The real Dart-to-JavaScript gateway test uses PostgreSQL stores,
oversized hash-bound tool arguments, a lost decision response and subsequent
execution advancement before replay. Existing custom review/permission callbacks
remain authoritative.

See `approval-review-qualification.json` and
`approval-review-browser-qualification.json` for scoped test/compile evidence.
The production React browser fixture at 320px and 390px used a maximum 33,325-byte
section and a 222-byte decision receipt, retained one section and made no full
review-pair or extra transcript-page reads. These are local fixtures, separate
from the production latency observation and database benchmarks. This closes the
standard oversized-review gap. The final acceptance map above records the
subsequent full regression and recovery audit. No dependency pins, lockfiles, production data or deployments changed.
