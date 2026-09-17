# Shared chatbot foundation: local acceptance

This document maps the requested SDK foundation to local evidence. The companion
`chatbot-foundation-final-qualification.json` records the final regression gates.
These are source and fixture checks, not a deployed-production certification.
The rollout procedure remains in [chatbot-foundation-adoption.md](chatbot-foundation-adoption.md).

## Required behavior and evidence

| Requested outcome | Implemented contract | Main local evidence |
| --- | --- | --- |
| Fast conversation list | Metadata-only, cursor-paged catalog; recovery is not awaited by list; no eager thread/page hydration | `server-assistant`, `postgres-catalog-table.integration`, `conversation-picker`, real PostgreSQL benchmark |
| Fast selection and older history | Complete-message projection, newest bounded page, stable cursors, upward navigation, scroll anchors, cancellation, bounded selected/idle windows | `postgres-display-history.integration`, `application-display-history`, `application-session`, React production browser fixture; Dart display session/window tests and Flutter render benchmark |
| Large content without giant initial responses | Explicit bounded text/structured-record sections; attachment references instead of bytes; related activity and pending approvals page independently | Deferred-record and approval-review qualifications; actual PostgreSQL projection and Dart-to-JS gateway tests |
| Streaming and interrupted work | Observation resumes saved turns; stop/retry use exact identities; ambiguous sends retain their journal; definite pre-admission rejection preserves editable drafts and releases only that send journal | Runtime cancellation, durable transport, server live gateway/provider replay, JS application session and Dart session/controller suites |
| Expected presentation | Standard loading/empty/error/retry states, lifecycle actions, unread updates, jump-to-latest, Markdown/code/citations, attachments, tool and approval controls | React/Flutter component suites, standard workspace browser fixture, mobile widget suite; consumer domain adapters remain authoritative |
| Drafts and account changes | Account/API-scoped durable stores, exact accepted-origin cleanup, scroll position, bounded text/file retention, deletion fences, stale-request cancellation | Browser attachment/local-erasure qualifications; Dart native attachment/draft and controller tests |
| Safe approval recovery | Version/hash-bound review and compact receipts; durable wakes, scoped authorization, lease/CAS deduplication, saved decision recovery | `postgres-approval-recovery.integration`, `server-approval-pause.integration`, `server-tool-admission.integration`, approval-review qualification |
| Running turns and canonical integrity | Display projection never substitutes for canonical model input; current admission remains required; checkpoints, clear/delete and concurrent updates retain their fences | Durable canonical start, provider context/replay, PostgreSQL display/deletion and sync suites |
| Shared background lifecycle | Bounded worker/context ownership, paged trusted-scope discovery, fresh authorization, restartable indexed recovery, graceful drain | Durable recovery, worker ownership, idle contexts, recovery context source and shutdown tests |
| Voice/realtime compatibility | Existing voice/realtime interfaces and saved voice state preserved | Full JS and Dart/Flutter suites include voice, realtime, transcription, audio usage and WebRTC cases |
| Three consumer contracts | Real Mills, Hitcents and Spartan web/server/mobile source compiled against the local public SDK; Mills remains single-chat | Consumer contract qualification and recorded consumer tests in the adoption ledger |

## Measurements are separate

The original production observation was 9.75–10.08 seconds for five list rows;
the direct metadata query took 108 ms. Sequential recovery inside listing caused
work unrelated to the number of rows. The 4.7 MB value was saved server state,
not a captured browser response.

`display-history-postgres-benchmark.json` uses a disposable PostgreSQL 15 cluster
with durability enabled. At 20k/100k events, list p95 was 1.115/1.593 ms and initial
page p95 was 3.474/4.141 ms. Serialized list/page envelopes stayed around 1.2 KB / 59 KB.
Thirty real connections exercise isolated scopes representing 1.8M events. Those
adapter timings exclude HTTP/auth/network and must not be added to browser data
as a production latency estimate.

`paged-workspace-browser-benchmark.json` separately measures local HTTP bodies,
production React selection-to-paint, script/layout work, DOM count and collected
heap. Only the selected chat loads a page; initial messages are 30, retained
messages at most 90, and idle sessions at most four. Flutter's offscreen renderer
records analogous loaded/mounted counts and VM memory in its own repository.
Neither offscreen tests nor Chromium constitute physical-device frame results.

Provider preparation has its own policy and qualification. The default historical
text policy is twenty messages / 24,000 characters plus admitted current input.
The optimized preparer reads an unchanged canonical checkpoint once, avoids a
whole-history serialized equality copy, and releases parsed backing storage before
host callbacks. Its cold canonical decode and full prior-file identity catalog
still scale with canonical history. This is explicitly outside the constant-cost
list/initial-display path; display pagination never truncates model context.

## Boundaries for later adoption

- Existing canonical histories need the additive display migrations and bounded,
  resumable backfill. A not-yet-ready projection returns an explicit preparing
  state. The steady-state display benchmarks exclude that one-time migration.
- Host authorization, account/API namespaces, logout erasure policy, encrypted
  native storage callbacks and domain review/formatting remain app responsibilities.
  The SDK supplies the shared controllers, storage interfaces and standard UI.
- Custom aggregate approval UIs can keep stricter domain permission/review loaders.
  The standard bounded approval reader does not bypass those callbacks.
- Graceful shutdown joins admitted provider work; a host process deadline can
  terminate a stalled provider. Durable records support recovery after restart.
- Public full-SHA installation, matching consumer lockfiles, device qualification,
  production latency and deployment require a later authorized adoption/release.
  Local compile overrides do not claim a published SDK installation.

These boundaries distinguish the requested local SDK deliverable from future
consumer deployment. Indexed cold model-context catalogs, broader production load
shapes and physical-device profiling remain follow-up optimization/rollout work;
they are not hidden claims in the bounded list/display measurements.
