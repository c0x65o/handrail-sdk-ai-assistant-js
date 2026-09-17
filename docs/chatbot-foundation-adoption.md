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

## Feature qualification still required before completion

The goal remains active. Passing source contracts does not establish the complete
chatbot experience or production scaling.

| Area | Implemented and locally exercised | Remaining qualification/work |
| --- | --- | --- |
| Display | Newest page, upward/forward navigation, anchors, stale cancellation, bounded windows, Flutter viewport body virtualization, explicit large text | Full deferred attachment/citation/tool/approval presentation; custom aggregate Flutter formatting |
| Related activity | On-demand paging, revision merge, removal, byte/count bounds, long-ID request groups, visible restart, paired citation presentation across page boundaries; indexed pending inbox in standard React/Flutter surfaces | Oversized structured approval review; custom consumer inbox placement; deferred source reader |
| Sending | Streaming wake-ups, exact durable intent, stop, retry, requested-turn controls, account isolation | Expanded reconnect/worker-restart matrix and background domain-change notifications |
| Local state | Scoped durable text drafts, compare-and-swap, scroll positions, teardown flushes | Unsent file reload recovery, exceptional aggregate upload/draft bounds, browser deletion cleanup |
| Canonical execution | Display is separate from canonical admission, checkpoints and model input; indexed recovery discovery, fresh authorization per bounded batch, shared four-worker recovery cap, fair scheduling, durable approval wake-ups, paged trusted-scope discovery and graceful worker drain | Provider-context policy/memory bounds; context-cache retirement and broader forced-restart qualification |
| Scale | Synthetic 20k/100k storage tests, real PostgreSQL 30-connection workload over 1.8M events; standard production React workspace HTTP/render/memory metrics, Flutter offscreen render/VM memory budgets | Native device frame qualification; expanded mixed activity/writer workloads |
| Adoption | Three web/server contracts and three mobile entrypoint compiles | Full consumer behavior matrix, published-pin install/build checks and authorized release |

One concrete background audit item: Spartan's web resource-refresh hook observes
completed tool records. Hidden paged sessions release their bodies and primarily
observe scalar controls. Completion notification must remain reliable without
requiring a hidden full transcript. This behavior must be qualified before adoption.

Provider-input audit: Hitcents' `native-request.ts` already keeps at most twenty
historical text messages / 24,000 characters. Mills calls the shared saved-turn
preparer with the same defaults, plus its document limits and text redaction.
Spartan keeps thirty input messages through `AEGIS_MAXIMUM_INPUT_MESSAGES`, with
its own authorized file materialization. These policies are independent of the
display window and must stay independent. Remaining memory work is in canonical
replay/preparation: the shared preparer currently copies all message metadata and
serializes the full before/after message state for concurrent-change detection,
and its complete prior-file catalog grows with retained attachments. A bounded
replacement must preserve exact admitted input, file authorization and concurrent
change detection; taking the visible browser page as model input would be wrong.

## Later release procedure (requires separate authorization)

1. Finish the open feature and scaling checks above, and freeze the tested SDK
   source. Record benchmark environment, concurrent connections, wire bytes,
   render costs and retained heap separately. Synthetic single-connection PGlite
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
