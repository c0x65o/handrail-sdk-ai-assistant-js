# Chat history performance and completion ledger

Goal: a shared production chatbot foundation for 30 consumer projects, across
JavaScript/React and Flutter. This is an implementation ledger, not a completion
claim. The active goal remains open until all six deliverables are verified.

## Baseline evidence (2026-09-16)

Hitcents production returned five conversation descriptors in approximately
9.75–10.08 seconds through its HTTP list route. Executing the same metadata SELECT
through the diagnostic SQL tool took 108 ms, including that tool's overhead;
this is not an isolated PostgreSQL execution-time measurement. Timed EXPLAIN was
rejected by the diagnostic tool's read-only policy.

One conversation had approximately 19,500 events and a saved projection whose
JSON was about 4.7 MB. That number describes server-side state, not a measured
browser response size. Baseline browser payload, parsing, rendering, and memory
measurements are still required.

The pinned SDK implementation awaited reconciliation and approval continuation
for every listed conversation before returning metadata. React additionally
followed every catalog cursor and preloaded up to 20 transcripts. Flutter already
pages its conversation picker, but `HandrailConversationSession._refresh` pulls a
full snapshot when history changes. Web runtime initialization replays events;
even checkpoint-backed stores subsequently scan history to hydrate transport
resume metadata. These latter paths still need replacement for bounded display
loading.

## Implemented locally

- List metadata returns without awaiting history reconciliation or approval
  recovery. Maintenance starts at a later task boundary.
- Maintenance wake-ups coalesce by tenant, owner scope, principal, session, and
  conversation. A process runs at most two jobs concurrently and retains at most
  128 pending jobs. Pending duplicates use the freshest request. Sessions are
  reauthenticated and ownership checked before history work starts.
  Wake-ups received during a running job coalesce into one subsequent pass and
  never execute concurrently for the same identity.
- Shutdown rejects new jobs, releases queued request credentials and drains
  running jobs. The queue is an optimization over durable records, not a new
  source of truth. Capacity overflow drops only a wake-up; another authorized
  read retries it. A persistent wake-up/recovery audit is still required to prove
  unattended approval recovery across restarts without depending on navigation.
- React loads the first catalog page for the current active/archived view and
  loads additional pages on scroll or an accessible button. Failed pages preserve
  existing rows and can be retried. Duplicate clicks coalesce; account/view/refresh
  generations discard stale responses. Catalog loading no longer preloads other
  transcripts by default. Explicit `preloadCount` remains supported.
- Titles triggered by queued catalog maintenance stay within its concurrency
  slot. Other existing completion/recovery entry points remain to be audited.

Current targeted evidence: 69 tests in conversation-maintenance,
server-assistant-catalog, server-assistant, server-assistant-recovery-authorization,
server-reconcile-conversation, application-gateway and react-conversation-history
passed with one worker. TypeScript typecheck
passed. These tests do not establish the full goal's performance budgets.

### Indexed display history and first storage benchmark

The next local slice adds an incremental PostgreSQL display projection, a
negotiated protected history endpoint, cancellable JavaScript and Dart resource
clients, and separate message/related-state paging. It does not yet switch the
React runtime or Flutter session away from their old full-history paths.

- The canonical append transaction updates only affected display entities;
  repeated token events in a batch write each changed entity once. Display reads
  use one SQL statement and never load canonical event payloads or checkpoints.
- Pages default to 30 records and a **64 KiB** UTF-8 budget (hard maximum 50 records
  and 256 KiB). SQL filters record content against the byte budget before transfer
  to the application. Oversized records use explicit, revision-pinned JSON content
  chunks; no silent text truncation or attachment bytes are introduced.
- Scoped cursors bind conversation, owner scope, view and clear generation, and
  retain an insertion fence while newer messages arrive. Clear retains canonical
  audit history and invalidates pages; deletion removes the display index and
  fences stale canonical writers. Projection state is not a model checkpoint.
- Pre-upgrade histories return `preparing` until bounded backfill catches up.
  The high-level assistant queues 100-event authorized steps; the persisted
  watermark resumes after restarts. A persistent preparation failure still needs
  explicit UI handling and the complete recovery audit is outstanding.
- Dart negotiates the same capability, validates page/content identities and
  revisions, enforces response byte limits before parsing, and cancels obsolete
  HTTP reads. Client/session rendering adoption is still outstanding.

See [API and migration contract](display-history-api.md) and the reproducible
[local benchmark artifact](display-history-benchmark.json). Node v22.23.1,
PGlite, one local connection, 30 measured reads after warmup:

| Synthetic canonical history | First-page wire bytes | Local page p95 | SQL reads | JS heap allocation p95 |
| --- | ---: | ---: | ---: | ---: |
| 20,000 events / 200 messages | 59,008 | 6.415 ms | 1 | 678,160 bytes |
| 100,000 events / 1,000 messages | 59,012 | 4.630 ms | 1 | 662,704 bytes |

Each synthetic message has 100 text delta events and 8,000 characters, so the
byte budget returns seven complete messages in both cases. One-time backfill took
1.025 / 4.586 seconds (20 / 100 transactions of 1,000 events). Thirty simultaneous
reads of different tenant partitions with identical conversation/message IDs
returned only their own content; local total time was 71.931 ms. PGlite serializes
on one connection, so this is scope-isolation evidence, not a production capacity
claim. Production HTTP, browser rendering, Flutter memory and provider-context
preparation remain unmeasured by this benchmark.

The benchmark's peak process RSS was about 805 MiB. Investigation separated it
from retained JS state: the in-process database/WASM fixture already used about
528 MiB after schema setup and grew during bulk insertion of 120,000 canonical
events. GC-retained JavaScript heap stayed around 15–16 MB, with less than 0.7 MB
allocated by a page read. The artifact records memory at schema, seed, backfill
and read phases. This does not establish browser or Flutter cache bounds.

After directional anchors and changes were added, the benchmark also ran 15
reads per operation/history size. Older/newer anchor p95 ranged 4.901–6.308 ms;
recent-change p95 was 3.475 / 2.738 ms (8,562 / 8,566 wire bytes), and unchanged
polls returned 216 / 219 bytes. Every operation used one SQL statement. A 50 ms
local steady-state p95 smoke-test ceiling is enforced independently of byte,
record-count and query-count limits. This ceiling is not a production SLA.

Validation for this slice: all 128 tests across PostgreSQL, application gateway,
assistant, authorization and worker-ownership suites passed with one worker;
10 display-store/gateway tests passed again after SQL payload selection was
tightened. A subsequent legacy-writer regression also verifies content is hidden
while a clear is unprojected or an older server has left display rows after a
deletion fence. TypeScript typecheck/build passed. Dart client analysis passed
with fatal infos; all six new display-client tests and nine existing protected
attachment-download tests passed. This is scoped validation, not full completion.

## Requirements and outstanding evidence

| Deliverable | Current state | Required before completion |
| --- | --- | --- |
| 1. Cheap list and bounded recovery | Local list and queue implementation; regression coverage | Real phase timings, byte limits on metadata, overload/fairness, durable recovery/restart coverage, runtime cache bounds |
| 2. Partial transcript loading | Indexed projection, paged gateway/changes/controls, JS/Dart bounded controllers, standard React/Flutter sessions/transcripts, durable text drafts and positions | Complete related-state/oversized-content presentation, custom Flutter aggregate formatting, attachment draft recovery, bounded live resume metadata |
| 3. Complete chatbot experience | Existing components identified; list controls improved | Explicit feature matrix and end-to-end verification of streaming, stop/retry/reconnect, drafts, lifecycle, unread state, Markdown/code/citations, attachments, tools/approvals, voice, accessibility |
| 4. Correctness | Existing authorization/recovery tests retained and session-revocation test added | Clear/delete generation invalidation, concurrency and idempotency with partial history; prove provider context and canonical history remain independent |
| 5. Validation and scaling | 128 scoped server tests; typecheck/build; first 20k/100k storage and 30-scope benchmark | Incremental/live correctness, browser traces/render budgets, full Flutter tests, real concurrent database throughput, three consumer contracts |
| 6. Documentation and adoption | This ledger | Public API/migration docs, reproducible benchmark report, tested consumer adoption plan and exact release procedure |

## Next implementation boundary

Display history now has its own bounded, indexed message projection. It must
not masquerade as a complete canonical checkpoint or use arbitrary slices of
delta events as messages. Complete message records need the relevant turn,
tool/approval, attachment and citation references. Oversized content should have
explicit deferred-content handling; dropping text silently is not acceptable.

The API must expose stable keyset cursors bound to authenticated scope,
conversation and clear/delete generation, plus a canonical head revision for
incremental live updates. Older-page requests must not lose newer live messages
or reset the scroll anchor. Historical display paging is independent of server
provider-context preparation, authoritative turn admission, and durable recovery.

The implemented projection updates incrementally as canonical events are
appended and supports a bounded, resumable backfill for existing histories.
The indexed revision changes feed is now implemented in PostgreSQL, the gateway,
the JS resource client and the Dart resource client. It has independent scoped
cursors, a stable catch-up fence, complete changed records, SQL byte limiting,
and citation-removal tombstones. Tests cover a record moving past the fence
during pagination, equal-revision tie handling, clear invalidation, mismatched
scopes/cursor types, oversized changes and metadata-only watermark advancement.
An ignored conflicting `message.created` event no longer incorrectly deletes
citations in the display projection; citation reuse in an atomic batch matches
canonical replay.

Bounded authoritative transport resume metadata remains outstanding for legacy
canonical runtimes, which still use whole-log `hydrateRuntimeMetadata`. Standard
negotiated display sessions do not fetch this metadata just to open a chat. Server-owned live canonical
projection now supplies running text to the display changes feed; see the live
projection and standard Flutter integration sections below. Its execution runtime
still hydrates canonical history once per worker and requires a separate audit.

Indexed message anchors now restore older saved positions and support navigation
back toward newer messages after eviction. Both controllers enforce independent
row/byte budgets. Standard React now uses the negotiated partial presentation described below.

Standard Flutter and React now negotiate bounded display. Older/custom gateways
retain their explicit canonical synchronization path.
Keep old gateway compatibility explicit; do not silently represent a partial
snapshot as a complete audit projection. Preserve in-flight turns while evicting
idle cached views, with drafts and scroll anchors stored separately from runtimes.

## Bounded window and browser validation (local)

JS and Dart controllers retain one selected window (defaults: 90 messages and
256 KiB serialized record content), cancel obsolete reads, coalesce navigation,
handle newer/older anchors, and acknowledge changes only after their final page.
Retained bytes exclude VM object overhead. Clear/forbidden responses evict text;
transient errors preserve it. The JS gateway also enforces a 30-second deadline,
response-byte bounds before parsing, and cancellation during credential/body reads.

The React display component provides upward/downward loading, message anchors,
bounded DOM, and empty/loading/error/retry/jump controls. Chromium at 390px
verified one initial request (20 messages), a 60-message test window cap, fast
switching, keyboard focus, contained width, zero-pixel prepend drift and
zero-pixel drift after a preceding bubble changes size. Estimated off-screen
heights initially caused a jump; the component now uses exact layout of a bounded
window and observes border-box changes for delayed media/layout adjustments.
This is a component test, not a production application or Mobile Preview test.

Separate frontend measurements, 12 selections each in a React development build:

| Synthetic source messages | Selection-to-paint p95 | Mean script time | Mean layout time | Browser heap after GC | Retained records / bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 | 31.90 ms | 1.639 ms | 0.582 ms | 3,658,496 | 20 / 7,100 |
| 1,000 | 31.90 ms | 1.576 ms | 0.645 ms | 3,700,772 | 20 / 7,124 |

Each selection made one synthetic page read. Heap includes React/Vite; the
fixture does not load canonical events, measure HTTP or exercise model streaming.
The storage benchmark above uses 20k/100k events for 200/1,000 messages. See
[browser artifact](display-window-browser-benchmark.json). The smoke-test ceiling
is 1 second per synthetic selection with strict request, retained-message and
DOM-count assertions. Production latency budgets and Flutter rendering/memory
measurements remain outstanding.

Latest slice: 36 tests passed across display storage/gateway/window/React and
client bootstrap; 12 Dart display-client/window tests passed; Dart fatal-info
analysis and TypeScript typecheck passed. Indexed anchors also cover directional
cursors, missing IDs, clear invalidation and tenant isolation. These measurements
preceded standard Flutter adoption described below. Consumer dependency pins
remain unchanged; no production improvement is claimed from local measurements.

## Server-owned live projection and Flutter display surface

The durable server worker now projects persisted stream frames into canonical
history while the turn is running. Previously server reconciliation deferred
text until terminal settlement, while web clients performed canonical writes
themselves and Flutter waited for saved snapshots. Paged display clients need
server-owned live writes independently of which browser is connected.

The projector reuses the runtime's protocol validation, canonical append conflict
handling and deterministic frame idempotency. It rechecks ownership before writes,
accepts at most one in-flight frame, and cannot start a provider. Frames are saved
durably before projection; a projection failure leaves them recoverable, stops
repeated per-token runtime construction, and does not convert successful provider
work into failure. Completion, lease loss and assistant projection shutdown clean
up the runtime. Terminal reconciliation remains the durable fallback.

This is **not** a bounded execution runtime: initialization still hydrates canonical
state once per active worker. Active-worker limits, indexed resume metadata and
provider-context preparation still need work. Display pages remain independent
of that state. Shutdown stops the live projector; it does not claim to stop all
provider work. The complete durable-worker shutdown/recovery audit remains open.

Targeted tests cover live text with no browser runtime, completion after projection
shutdown, replay without duplicate text, simultaneous projector conflicts, revoked
write authorization, clear fencing, and conflicting duplicate protocol frames.
The durable hook test proves frames are saved before the backpressured callback,
callback failure preserves the retained result, and cleanup runs once. The four
runtime/cancellation/citation/context suites passed 79 tests; 56 distinct tests
passed across the server/recovery/projection/durable suites including the new
regressions. TypeScript typecheck passed.

Flutter now exports a separate `HandrailDisplayTranscript` connected through
`HandrailDisplayWindow.uiBinding`. It supplies bounded exact row layout, upward
and downward paging, delayed-layout scroll anchoring, loading/error/retry states,
jump-to-latest and per-chat message positions. A storage interface supports durable
account-scoped anchors; the default memory cache holds 32 chats. Tests cover
switching accounts during a pending read, cancellation, row bounds and anchor
stability. Six new Flutter display widget tests and 13 existing transcript widget
tests passed; 13 Dart display-resource/window tests passed. Dart and Flutter
analysis with fatal infos passed. These are scoped component checks, not a full
Flutter suite or device performance measurement at that stage. Standard Flutter
session/default-transcript integration is described below. No full
canonical snapshot is manufactured from a display page. See the Flutter repo's
`docs/display-history.md` for the usage and remaining limitations.

## Adoption constraints

### Bounded turn-control API

The next session-integration prerequisite is implemented in PostgreSQL, the
gateway and JS/Dart clients: a separately negotiated scalar control response for
active/latest/requested turns. It uses one indexed SQL read, with no full turn
payload, checkpoint or event body. A regression test replaces a turn payload with
100,000 retry entries and verifies that the control result and database transfer
remain below 2 KiB / 3 KiB respectively. Summaries are updated transactionally;
legacy controls are prepared in bounded, resumable, authorized maintenance steps.
Tests cover clear, deletion, scope isolation, authorization after reads, Unicode
error truncation, requested-turn identity and invalid/future/contradictory states.

Current validation: 23 display-storage/gateway/control tests passed with one
worker, plus 16 server/catalog/high-level compatibility tests. All 16 Dart
display-control/history/window tests passed; Dart analysis with fatal infos,
TypeScript typecheck and SDK build passed. The interrupted Dart test fixture used
the wrong constructor argument (`headers`); it now uses `protectedHeaders`, and
the protected-request and cancellation cases run successfully.

The standard Flutter and JavaScript sessions now negotiate these controls and use
bounded pages for display. Explicit custom canonical runtimes retain their original
contract. Server execution memory and saved provider resume remain outstanding.

### Standard Flutter integration

The account controller/default transcript now uses scalar controls, newest-page
selection, upward paging, bounded message retention, citations and tool result
rendering. Related-state queries cover the retained message window and reject
stale responses. Switching chats cancels obsolete reads and drops hidden message
pages; background turns retain scalar observation. Idle sessions have a four-entry
cache. The existing account/API-scoped encrypted key-value adapter supplies a
32-chat durable scroll journal automatically. The displayed view is explicitly
partial; canonical admission still uses the correct empty-log/null revision and
exact requested-turn verification. Account disposal closes waits and evicts state.

Real Flutter HTTP integration now has an explicit local-SDK mode backed by PGlite
and the production PostgreSQL adapters, without dependency/lockfile changes. It
caught and verified fixes for empty-log admission, live tail following without a
mounted widget, turn/message association in the partial view, and account-close
wait outcomes. Its approval fixture now mirrors authoritative proposal expiry
instead of constructing contradictory canonical data. All 17 HTTP scenarios pass
against the local SDK with real PostgreSQL adapters. The longer-history case opens
30 messages, retains at most 90 while paging, leaves scrolled-up content in place
on append, checks actual response bytes against 65,536 + 1,024 bytes, and performs
zero snapshot reads for display. A separate canonical read still returns all
201 messages. This is an in-process test database behind actual local HTTP, not
production network latency or a Flutter device memory measurement.

Latest validation: all 181 Dart client tests pass against the locked published
gateway fixture (one local-SDK-only history test skipped); all 173 Flutter widget
tests pass. The local-SDK HTTP run passes all 17 tests separately. Dart and Flutter
analysis with fatal infos, TypeScript typecheck/build, and 40 scoped display,
control, durable-transport and server-live tests pass. Expensive checks ran
sequentially with one test worker. Neither SDK dependency pins nor lockfiles were
changed, and no release action was taken.

This is not complete Flutter feature qualification. Aggregate `contentBuilder`
formatting still uses the old scroll surface; full deferred-record metadata and the
full related-state/approval paging experience need work. Actual device memory,
frame timing, consumer builds and all remaining goal evidence are still required.

### Standard JavaScript/React integration

Negotiated control support now selects the bounded server-owned session for
standard single/multiple conversation bootstrap. React reads a separate
`ConversationPresentationState`; its partial window cannot be assigned to a
canonical `ConversationState` or checkpoint. Existing canonical runtimes still
satisfy the UI presentation contract and custom event stores preserve their path.
The default transcript uses newest-page selection, upward scrolling, a 90-message
retention bound and jump-to-latest. Switching suspends and evicts hidden bodies;
the standard workspace retains four idle sessions. Running/submitting sessions
retain scalar observation within the existing registry bounds.

Admission captures immutable input before async work and journals the original
mutation/start identities before network writes. Exact retries, completed-turn
reconciliation, callbacks that dispose the account, separate cancellation and
observation, stale reads and permission revocation have regression coverage.
An account/API-scoped IndexedDB pending store supports reload recovery, atomic
multi-tab conflict checks, compare-and-delete acknowledgement and bounded storage.
The default memory fallback is explicitly not durable. The standard transcript
surfaces retained sends for retry; host account teardown owns durable store close
and optional erasure.

The standard React preset is tested through negotiated resource clients against
200 messages: initial 30 rows, scrolling capped at 90, no full history/approval-list
read, bounded serialized response bytes, and isolation while switching chats.
A separate integration uses the real high-level assistant, gateway and PostgreSQL
adapters in PGlite. It verifies running streamed text, exactly one completed turn,
preserved canonical history, no client snapshot/resume read, and bounded display
responses. This uses Fetch Request/Response in-process, not production HTTP timing.

Validation for this integration: the 46-file React/client regression run passed
392 of 396 cases. Four stale expectations (eager/all-lifecycle catalog reads,
background polling activation and the already-supported DOCX MIME type) were
updated to their intended contracts; the 60-case focused rerun passed, including
every previously failing file, storage/session tests and the standard paged UI.
All three server-live gateway scenarios passed, including the new PostgreSQL
session test. TypeScript typecheck, SDK build, and the Vite public-consumer check
passed after integration. Checks ran sequentially with one test worker.

Outstanding in this path: full related-state/approval qualification, oversized
attachment/tool/approval metadata, attachment draft recovery, richer reconnect/retry
qualification, actual browser memory/paint profiling of the standard workspace,
and all three consumer contract builds. The new presentation types require
consumer compilation before adoption. No performance or completion claim is based
solely on mocked UI timing.

### Durable text drafts and position integration (local)

Standard React sessions now restore/save text drafts and scroll anchors through
an account/API-scoped local store. The browser IndexedDB adapter upgrades its
pending journal and implements both services; without an explicit durable store,
bootstrap uses bounded account-lifetime memory. Flutter's encrypted key-value
pending adapter exposes the same draft behavior through its standard UI binding.
Both stores bound text to 32 drafts, 64 KiB each and 512 KiB total. Revision checks
prevent one writer from silently replacing another. Draft and position reads are
separate from transcript/provider history.

Tests cover late restoration versus typing, account transitions, exact-edit
admission clearing, conflicting writers, quota failures, flushes at teardown,
schema upgrade and saved-position selection with one indexed page. React never
renders the previous account's draft while effects update bindings. Flutter
discard/reopen waits for the previous clear and evicts safely saved idle editors.
Standard surfaces show restore/error/retry states and flush when hidden.

Validation: 111 scoped JS/React tests passed, including standard presets and
composer regressions; TypeScript typecheck/build and public Vite consumer check
passed. Chromium retained the 60-row fixture cap and zero-pixel prepend/delayed
layout drift; the browser artifact above records this rerun. All 179 Flutter
widget tests passed. The full Dart run against the local JS build passed 185 of
186 tests; the attachment fixture's incomplete persistence mock and four-byte
PDF prefix were corrected, and that scenario passed against real PostgreSQL
adapters afterward. These source-qualification fixtures do not change dependency
declarations or establish consumer adoption.

This does not establish durable unsent file selections, a strict aggregate bound
for exceptional in-progress Flutter draft/upload work, browser deletion cleanup,
or process-crash guarantees for an unfinished local write. Those remain explicit
qualification items; neither app dependency pins nor production behavior changed.

### Oversized message text (local)

The high-level gateway now separately advertises `displayHistory.messageText`.
An explicit text reader uses the existing authorized content operation with
`format: "message-text"`, returning one revision-pinned section of at most 8,192
Unicode code points. Standard React and Flutter transcripts offer Read message,
previous/next, close, retry and changed-version reload. Only one message reader
is expanded and one section is retained; opening a transcript does not fetch it.
Chat/account changes, closure and deletion cancel or invalidate old reads.

The database extracts text only for the explicitly requested message. This
selected-record JSON parsing/aggregation can scale with that message's size;
it is separate from the bounded list/initial-page path. The plaintext reader
does not assemble canonical record JSON or inject attachment bytes. Normal
messages retain Markdown, citations and attachment presentation. Complete
oversized attachment/citation metadata and oversized tool/approval presentation
remain outstanding; the text reader alone is not the entire deferred-record UX.

Local evidence: PostgreSQL integration checks exact Unicode text, scoped access,
revision conflicts and bounded content replies. React component tests cover
single-reader retention, aborts, safe text, errors and navigation. Chromium
records zero automatic content reads, 8,192 retained characters and narrow-screen
navigation in the browser artifact. Flutter widget tests cover the same reader
lifecycle; Dart HTTP qualification uses the real high-level gateway/PostgreSQL
stores, verifies no full snapshot read, and rejects old content after permanent
deletion. The fixture's catalog does not enable Clear; generation invalidation is
covered separately by PostgreSQL integration tests. None of these are device
memory measurements or production latency claims.

### Bounded related activity and cancellation (local)

Both standard sessions retain an activity window independently of message pages:
at most 90 tool/approval/citation/source/turn records and 256 KiB serialized data.
Loading earlier activity merges by kind/ID and revision instead of replacing the
previous page. The changes feed updates/removes already retained activity. A live
refresh merges the latest page without resetting an unchanged message/turn view.
If navigation or updates evict records, the UI explicitly offers Show latest
activity. Context changes, permission loss, clear and account disposal discard
old activity. Transient page failures are visible and retryable.

Long context identifiers now split into <=2 KiB reference groups with the active
turn first. Later groups and pages load only through the activity action, leaving
room for the maximum opaque cursor and chat identity in the 8 KiB request. Group
cursors stay bound to their exact view. No endpoint or dependency change is needed.
Flutter completes per-read cancellation handles and removes them after polling;
completed history reads no longer retain listeners on account/selection futures.

Validation: 31 focused JS protocol/session/window cases passed; the standard
React preset plus reader/session run passed 24 cases. Dart history/window/session
checks passed 24 cases; both Flutter transcript suites passed 24 cases. All 18
HTTP submission scenarios passed against the local JS build and real PostgreSQL
adapters. These include lifecycle, exact admission/retry, cancellation, saved
intent and large content. Tests run sequentially with one worker. Full pending
approval discovery beyond loaded activity, deferred metadata and device memory
profiling remain separate qualification work.

### Consumer contract qualification (local)

Real Hitcents, Mills and Spartan web/server integration entrypoints compile against
the local SDK's public declarations. All three mobile SDK adapter/screen pairs
compile against local Flutter source without changing pubspecs, pins or locks.
Spartan web needed narrow display-only type contracts. Mills and Spartan mobile
now format loaded state without requiring a canonical document class, and observe
a separate display presentation version so paging refreshes domain cards.
Spartan's partial mobile projection no longer hydrates the entire approval group.

Spartan web's 11 affected formatting/notification cases pass with its installed
pin. Its 25 scoped mobile cases pass with local SDK source, including negotiated
paging with no full snapshot or approval-group read. Mills' 10 existing
history/review/repository cases plus both projection cases pass; the new case
keeps single-chat mode and follows older messages without a canonical replay.
The SDK's 25 history/window/session cases and Dart analysis pass after adding the
presentation version. These do not establish device builds or production timing.

See [the adoption plan](chatbot-foundation-adoption.md) for reproducible source
checks, qualification gaps and the later authorized public-SHA release procedure.
The goal remains active; source compatibility does not resolve the listed
background notification, recovery, provider-context, deferred-state or scale work.

### Release boundaries

The JS SDK, Flutter SDK, Hitcents, Mills and Spartan are the in-scope repositories.
Mills retains its single-conversation mode. All three web apps currently declare
JS SDK commit `ddc41882977cc9a76766625659534ba1b4a02963`.

No dependencies or production deployments have changed. Consumer dependencies
must use the public HTTPS Git repository, full published commit SHA, and matching
lockfile. Do not point consumers at a worktree, tarball, branch or invented SHA.
Validate unpublished changes through SDK-local tests and consumer contract
fixtures, then record the separate commit/adoption/deployment steps needed to
make the result live. The current objective explicitly excludes those release
actions and production database writes.

### Real PostgreSQL concurrency and activity ordering

`node --expose-gc scripts/benchmark-display-postgres.mjs /absolute/path/to/pg/lib/index.js /absolute/path/to/postgres/bin`
uses an already installed test driver and creates its own disposable private Unix
socket cluster. It accepts no database URL and changes no dependency pins. The
cluster is stopped and removed after the benchmark. Build the SDK first.

The recorded PostgreSQL 15.19 run uses default durable commits, 64 MiB shared
buffers and 30 distinct backend connections. Fifteen 20k-event and fifteen
100k-event histories share record/owner IDs across isolated tenant partitions
(1.8M events). Ten concurrent bursts produce 300 list and 300 initial-page reads:
list p95 13.263 ms / at most 1,225 serialized envelope bytes; page p95 37.767 ms /
at most 59,111 bytes. Pages include two authorization queries plus one bounded
projection query; lists use one metadata query. The driver does not read canonical
payloads on either path. Scope markers, foreign-owner rejection and cross-tenant
cursor rejection are checked. Full results and query plans are in
`display-history-postgres-benchmark.json`.

Separate 20k/100k steady-state p95 values are 1.115/1.593 ms for lists and
3.474/4.141 ms for pages. At 100k events, the old unindexed activity-timestamp list
read takes 299.108 ms, versus 1.633 ms with the added activity index (individual
before/after reads, not p95). EXPLAIN shows event scans replaced by bounded index
lookups. PostgreSQL may choose a small sequential display-table scan for the 200
message fixture; the 1,000 message fixture uses the ordered message index and
primary-key lookups. No forced planner flags are used.

Retained Node heap is 9.30/8.72 MB after preparing the two sizes, and 9.11/11.03 MB
before/after concurrency; maximum process RSS is about 118 MiB. A separate sample
of the postmaster and 30 client backends has 156,295 KiB proportional set size;
that excludes background workers and OS cache. Local regression ceilings are
50 ms steady-state p95, 500 ms concurrent p95, 32 MiB prepared Node heap and 16 MiB
retained heap growth across concurrent rounds. Timing excludes HTTP middleware,
production networking and client rendering. Concurrent projection fixtures are
copied from the two real backfills; this is not a concurrent-writer/recovery test.

The partial presentation now also prevents orphan citations across activity page
boundaries and source deletion, while exposing an unresolved count and a visible
notice. Delayed activity reads cannot resurrect records removed by a newer changes
page, including when scalar turn controls have not advanced. JS and Dart regression
cases cover both paths. Hitcents' recovered 29 mobile SDK/sheet tests all passed;
its pending-intent assertions now distinguish legitimate persisted drafts from
unacknowledged submissions. Dependency pins and lockfiles remain unchanged.

### Standard React workspace: production bundle and HTTP

`node scripts/check-paged-workspace-browser.mjs` builds the public SDK exports in
production mode and drives `HandrailChatWorkspace` in Chromium against a local
synthetic HTTP server. `HANDRAIL_TEST_CHROMIUM` selects an existing browser;
`HANDRAIL_WORKSPACE_BROWSER_REPORT` optionally saves its JSON report. No app login,
provider or production route is used. The fixture contains Markdown, code blocks
and varying message heights, and exposes only bounded protocol pages.

For 200/1,000 messages (the display sizes of the 20k/100k event fixtures), twelve
chat switches have selection-to-paint p95 52.2/46.8 ms. Mean scripting is
30.47/29.20 ms and layout 3.29/2.79 ms per selection. Collected browser heap is
5.87/5.88 MB, including the production React/SDK assembly. Opening loads one
five-item catalog page and one thirty-message page, plus small control/context
requests. Switching and scrolling do not eagerly fetch remaining catalog pages;
only the selected chat retains messages, with four idle sessions and ninety DOM
messages as hard bounds. Scroll prepend drift is 0.15625 pixels in both runs.

Browser Resource Timing verifies actual completed response body sizes: maximum
14,207/14,244 bytes, versus transfer sizes including headers 14,507/14,544 bytes.
Cancelled reads with no completed body are counted separately, not called zero
payload successes. The singleton workspace also passes width/focus checks at
320 and 390 pixels with thread navigation suppressed. At both widths the pending
approval inbox also opens, pages and reviews an old action with zero additional
message-page requests. Full results are in
`paged-workspace-browser-benchmark.json`. Regression ceilings are 1s per selection,
32 MiB collected browser heap and 64 KiB per HTTP body. These synthetic HTTP and
render measurements are separate from PostgreSQL timings; do not add them to
claim a measured production latency. Streaming, voice, uploads and Flutter frame
behavior are not exercised by this browser benchmark.

### Flutter viewport body retention

The sibling Flutter SDK now mounts only viewport-adjacent message bodies and
keeps measured placeholders for offscreen rows. The prior bounded ninety-record
Column still retained expensive Markdown and semantics for every row and failed
a local warm-RSS limit. VM allocation profiles confirmed that this was retained
isolate memory as well as process RSS, not simply the canonical history size.

The final offscreen benchmark uses the actual account controller, session and
standard widgets with mocked HTTP. It retains ninety complete records, mounts
eight message widgets and caches four sessions. For 200/1,000 source messages,
selection-plus-pump p95 is 222.3/115.8 ms and warm isolate-heap growth is
74.0/66.0 MB; this includes debug VM/framework/test overhead. Warm RSS grows
106.1/99.4 MB. See the Flutter SDK's `docs/display-history.md` and
`docs/display-render-benchmark.json` for commands, exact samples and bounds.
These are host offscreen render measurements, not native-device frame timing.
All 25 transcript tests pass after virtualization, including actual overscan-row
height changes above the visible anchor; assertions now distinguish retained
records from mounted message bodies. Width-change anchoring and jump-to-latest
remounting are covered, including a fix that explicitly resumes following after
the user presses Jump to latest.

### Recovery discovery and background lifecycle

Recovery metadata now has indexed scalar status/lease columns with an atomic
trigger that also covers older payload-only writers. Legacy preparation is
bounded and resumes from null metadata; discovery does not serialize saved
requests or retained frames. The local native PostgreSQL measurements in
`recovery-postgres-benchmark.json` show 90-byte discovery at 20k and 100k retained
frames, with p95 2.31/2.13 ms. The legacy single-read baselines serialized
3.30/16.74 MB and took 89.63/449.37 ms. These are adapter measurements, not browser
wire or production timings. Actual PG concurrency verifies one execution from
two competing recovery workers and rechecks a terminal writer after discovery.

The assistant no longer awaits recovery while constructing its transport.
Authenticated wake-ups run at a later task boundary, in two discovery tasks with
25-candidate pages. Authorization refreshes between pages; a shared pool admits
at most four recovered executions across contexts before loading saved requests.
No-slot work stays durable and is retried without skipping its identity. The
queue retains at most 128 credential envelopes for 60 seconds without fresh
traffic, coalesces updates, yields across scopes and rejects expired lookups.
Startup recovery now runs independently of usage reporting. See
`recovery-discovery.md` for exact host-source limits and graceful-drain semantics.

Shutdown rejects new SDK requests, stops timers, joins recovery/usage/maintenance,
drains admitted workers with projections alive, and joins observer/lease monitors
before persistence can close. It preserves user intent and does not promise to
force-stop an unresponsive provider. Repeated shutdown calls share one promise.

Lease owners also include a random assistant-instance identity. Previously,
identical worker names/PIDs and authorization contexts could collide across
replicas. A two-instance fixture now proves the peer cannot reclaim a live turn,
and can still cancel the original worker through the durable cancellation record.

This continuation passed 70 unique scoped regression cases across recovery,
worker identity, assistant authorization/catalog, usage and persistence contract
suites. TypeScript compilation and the package build pass. All three consumers'
web/server entrypoints compile against the built public declarations; the fresh
results are in `consumer-contract-qualification.json`. No dependency pin, lockfile,
release or production database change was made for this continuation. Approval
wake-ups after a crash, old context-cache retirement, provider memory, and the
remaining adoption matrix still need work; this does not complete the goal.
