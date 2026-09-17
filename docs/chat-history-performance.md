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


### Approval crash recovery, trusted identity pages and idle resource retirement

The shared PostgreSQL adapter now atomically wakes decided approvals, repairs a
missing canonical decision event from the exact committed receipt, and retains
a cursor across 25-proposal repair pages. Current authorization precedes claim
and transcript access. Renewable leases, wake generations and the native effect
ledger preserve one effect across competing instances and later human retries.
Clear/delete cannot revive an old external/voice action. See
`recovery-discovery.md` for migration and custom-authority responsibilities.

The latest native PostgreSQL fixture records 90-byte recovery metadata at both
20k and 100k frames, with p95 3.09/1.93 ms. Its legacy single reads serialized
3.30/16.74 MB and took 99.57/450.61 ms. The artifact also verifies one winning
approval claim and that a newer committed decision survives an old ack. These
are local adapter measurements, separate from browser wire/render budgets.

A paged trusted identity source now visits up to 32 keys per tick, resolving
current identity again before each work page. It retries queue saturation and
supports identities beyond the legacy 128-context prefix. Background request
reauthentication uses a body-free GET capability check; it never replays send or
cancel admission/rate limits.

Server retention now keeps 32 idle execution contexts, with active requests,
construction and workers protected; 128 scope adapters; and 32 idle activity
channels with active subscribers protected. Idle contexts expire after a minute
at the next sweep. Recreated transports have distinct lease-owner generations.
The last activity observer releases its pub-sub listener, including connection
races. Activity HTTP streaming honors backpressure and caps each notification
queue at 256 envelopes, recovering through durable snapshots after overflow.

Validation after the lifecycle changes: 32 cases passed across approval restart,
worker ownership, activity/pub-sub teardown, paged trusted sources and idle
retirement; a separate 80-case run passed shared tool/approval execution, saved
input concurrency, application-session reconnect, realtime workspaces and voice
tool bridges. The final same-clock cache/worker/activity run passed 20 cases. All nine
high-level assistant cases pass, including retry after provider construction fails.
TypeScript, the package build, scoped ESLint and all three consumers' web/server
source contracts pass. Checks run sequentially with one test worker. The updated
consumer artifact records actual build version and compiler memory/timing.

The shared checkout advanced from `28ff2ad` to `81564f9` through another workspace
process during these checks, including some in-progress foundation files.
This goal run issued no commit, push, PR, deployment or production database
write. Its remaining working-tree changes require later authorized release;
no production behavior or live adoption is claimed here.

The overall foundation goal remains active. Next work is the concrete UI/consumer
qualification still listed in `chatbot-foundation-adoption.md`, including hidden
Spartan completion notifications and attachment-draft lifecycle review. Native
device and published-pin deployment checks belong to the later adoption plan;
they do not authorize a release from this goal.


### Hidden conversation completion and consumer data refresh

The SDK workspace now exposes `subscribeSettlements`. It derives notifications
from bounded execution controls for paged sessions and the existing canonical
state for older runtimes. Initial history, duplicate reads, generation resets and
older-page loads do not announce new completions. Fast terminal turns, approval
pause/resume, hidden chats and callback cleanup are covered. Delivery occurs
before idle runtime eviction and does not fetch messages or tool-result bodies.

Spartan's local integration uses these notifications to revalidate mounted ERP
data. The contract register accepts a general revalidation hint; it does not
claim a specific mutation succeeded. The older SDK fallback still observes
completed tool results and now keys its bookkeeping by runtime identity through
a WeakMap. SDK upgrade and app adoption remain later authorized steps.

Local qualification: 37 SDK session/workspace/bootstrap cases passed, with the
18 workspace/bootstrap cases rerun after final changes. Thirteen Spartan action
and resource-refresh tests passed, including an actual mounted contract page
that fetches its authorized data again after a background completion. The SDK
build/typecheck and scoped lint pass. All three consumer web/server source
contracts pass; Spartan's compile also includes the changed contract page and
resource-refresh tests. Dependency declarations and locks were not changed.

The production public React build was exercised through a local synthetic HTTP
server. A hidden chat emitted exactly one settlement notification after three
control reads and made zero transcript requests, retaining zero messages. The
existing 20k/100k-equivalent render scenarios also passed: p95 selection-to-paint
56.4/47.1 ms, collected browser heap 5,884,124/5,659,880 bytes, maximum HTTP body
14,207/14,244 bytes, four idle sessions, ninety mounted-message cap and 0.15625 px
prepend-anchor drift. Single-chat and pending-inbox layouts passed at 320/390 px.
The updated artifact is `paged-workspace-browser-benchmark.json`. This measures
synthetic browser HTTP/render costs, not production app or database latency.

The browser run first failed because the runner's long temporary directory
exceeded Chromium's Unix socket path limit; a process-local `TMPDIR=/tmp` resolved
launch. It then exposed a benchmark click race: a newly prepended row appears
before the loading-finally update enables the next button. The script now waits
for the actual enabled button before clicking again, preserving the measured
viewport. The successful run closes its browser and local server.

The overall goal is still active. The next remaining local audit is attachment
and draft lifecycle, including aggregate retention under many unfinished drafts,
and the final complete consumer/feature matrix. No goal release action or
production database write was performed in this continuation.

### Flutter aggregate draft and transfer retention

The interrupted continuation was resumed from the existing workspace. The audit
found that empty controllers without durable storage were never eligible for
eviction, unfinished drafts had no shared file/text budget, and a host file
converter could copy attachment bytes again on each render and retry. Local
Flutter changes now evict empty idle editors, snapshot each selected file once,
and reject capacity-exceeding additions/replacements before changing the old
selection. Per-message negotiated validation remains in place.

Default account content budgets are 32 text drafts/snapshots, 64 KiB per draft
and 512 KiB total UTF-8 text; 64 files / 64 MiB; and two host upload futures.
Active send/save snapshots and cancelled-but-unsettled transfers remain counted
until the actual callback settles. Removing a file or acknowledging a send
cannot be used to evade the budget while its bytes are still held. Custom opaque
attachment models require `fileForAttachment` for byte accounting; their count
and concurrency are still bounded. These limits describe content, not total
process heap or buffers allocated by a host callback.

Text validation runs before edit revision changes, including direct controller
updates, restored text and explicit reload. A failed paste preserves the editor
and its admission identity. Capacity-blocked saved drafts remain stored and can
be reloaded after freeing space. The standard workspace announces the error in
a live region. Slow storage writes remain charged after editor disposal.

The final focused run passed 73 tests across draft lifecycle, attachment intake,
standard workspace and composer behavior, using one Flutter test worker. Scoped
analysis passed with fatal infos enabled. All three real mobile consumer source
entrypoints compile against the local SDK; the final qualification artifact is
`flutter-draft-retention-qualification.json`. One earlier command named a
nonexistent extra test file; its 28 existing tests passed, then the corrected
command and final combined run completed successfully. No failed app behavior
was inferred from that command error.

The goal remains active. Outstanding local work is the explicit browser/file
draft recovery audit and the final feature/consumer qualification matrix, plus
the canonical preparation and deferred related-content items already tracked
in the adoption document. Unsent native files still live only in account memory;
this change does not claim file reload persistence. Nothing was committed,
pushed, deployed or written to a production database by this continuation.

### Browser deletion cleanup and cross-tab fencing

The browser audit found no per-conversation erase path for IndexedDB drafts,
scroll anchors or pending sends after a successful server deletion. The local
SDK now validates the returned deletion identity/version before touching device
state, then erases all three rows in one transaction with a content-free deleted
identity marker. Writes from an older tab, late teardown saves and reopened
adapters cannot recreate those rows. Clear and archive retain their prior draft
semantics. Account erasure walks keys incrementally, including marker metadata.

The high-level catalog integrates cleanup and calls a combined store once.
Separate custom stores can implement the optional `eraseConversation` contract;
missing support is reported explicitly at runtime. A local failure after remote
success raises `ConversationLocalErasureError` with the confirmed result and a
device-only retry. The registry keeps the identity deleted, the workspace drops
its runtime, and the standard picker removes the row while presenting **Retry
device cleanup**. The retry does not issue another server mutation.

Local storage, bootstrap, registry, workspace and React picker checks passed 64
tests with one worker. TypeScript, package build and scoped lint pass. All three
web/server consumer source contracts compile against the built declarations.
An actual Chromium run using public built exports verified upgrade from schema
version 2, atomic rollback on a failed marker write, four rejected old-tab writes,
reload durability, scope isolation and explicit account erasure. The browser and
temporary local HTTP server close after the run. Its result is
`local-erasure-browser-qualification.json`; this is synthetic browser storage,
not an app/production reproduction or a database timing measurement.

The first integration run exposed two test-fixture errors (spying on a frozen
runtime and omitting a required picker idempotency key). Both were corrected;
the final 64-case run passed. IndexedDB version 3 is additive, but old SDK code
that explicitly requests version 2 cannot reopen an upgraded database. The API
and adoption docs therefore require a compatible SDK for application rollback,
preserving stored pending intent. No dependency installation or release occurred.

The goal remains active. The browser composer audit also confirmed that its
current per-mount file ownership releases unsent selections on conversation
switch/unmount. Retaining and recovering those selections is the next unfinished
part of the durable-draft work; this deletion fix does not claim to solve it.

### Browser attachment ownership and reload qualification

The next local change resolves that composer ownership gap for the standard
SDK upload path. File selections now belong to `client.attachmentDrafts`, outside
the React mount and transcript runtime cache. IndexedDB v4 separates immutable
binary sources from bounded metadata, saves the source and exact upload key
before upload, and restores completed references without uploading again.
Ready-reference updates and account quota scans do not read/rewrite source blobs.

Account limits are 32 nonempty file drafts, 64 selected files and 64 MiB of unique
retained source content, plus two actual host upload futures. Removed/cancelled
sources remain charged while captured storage writes or upload callbacks still
retain them; aborting a callback does not prematurely admit more work. Storage
transactions enforce the same persisted file/count/byte limits across tabs.
Failed writes/conflicts retain selections and expose retry or explicit saved
replacement. Confirmed deletion now atomically erases file metadata and blobs
with the existing pending/text/position state and durable deletion marker.

Validation used one Vitest worker: the final eight-file run passed 136 tests,
including full-queue cross-tab replacement, immutable memory source identity,
and blocking file intake while restoring saved selections. SDK typecheck, build
and scoped lint passed. All three
consumer web/server source contracts compiled against the local public SDK
declarations, with zero errors. The largest graph was Spartan (1,912 source
files, approximately 1.33 GB RSS), checked sequentially; this is compiler memory,
not chatbot client memory. No package declarations, lockfiles or releases changed.

`attachment-draft-browser-qualification.json` records real Chromium using the
built client, standard React workspace, IndexedDB and local HTTP upload. A PNG's
original bytes and upload key survive seven chat switches, runtime cache eviction,
reload, and an intervening account scope. Exactly one HTTP upload occurs; another
account sees no files. Explicit removal survives a further reload. Browser/server
errors: zero. The separate erasure browser fixture now verifies five rejected
old-tab writes, including files, plus byte/key reload, v2 upgrade, atomic rollback
and account erasure. These fixtures close their browsers and local servers.

The adapter seam for custom authorized uploads is additive. Mills' existing
queue override and fresh upload-stage keys still need the documented source
adoption; omitted durable stores in the three apps remain memory-only. Native
Flutter file reload and process-loss reconciliation of exact admitted local
draft identities remain open. This milestone does not complete the overall goal
or establish deployed behavior.


### Browser exact draft receipts across process loss

The durable admission journal previously recorded server mutation/start
identities but relied on a mounted composer's callback for local cleanup. A
process exit after confirmed admission could therefore leave accepted text/files
in the next process's draft. The standard composer now captures an exact stored
text version and stable file IDs before admission and persists a device-only
origin receipt with the pending submission. It is excluded from all server
request bodies. Confirmed replay cleans those exact identities before journal
acknowledgement, preserves newer local/cross-tab work, and retains the journal
when device cleanup fails. Text and file cleanup are independently idempotent.
File cleanup uses metadata and exact Blob-key deletion, not source hydration.

The focused nine-file regression run passed 129 tests with one worker. Coverage
includes process reconstruction, partial cleanup failure, same-text newer drafts,
typing and file selection during blocked cleanup, cross-tab conflicts, uncertain
server admission, malformed receipts, metadata-only IndexedDB cleanup and atomic
rollback. Receipt-bearing journals use version 2; version 1 remains readable and
cannot claim a receipt. Old clients reject version 2 rather than dropping it.

The expanded `attachment-draft-browser-qualification.json` adds a real Chromium
reload after admitted-file cleanup is interrupted, then edits new text and adds
a new file before retry. Only the accepted file is removed; new work survives a
further reload without extra upload. Both server admissions are identical and
contain no device receipt. The browser script explicitly awaits IndexedDB
predicates: Playwright's function polling treated async Promises as truthy and
initially caused a premature failing assertion. That test synchronization issue
was corrected; it was not evidence of an SDK attachment-cleanup failure.

SDK typecheck, build, scoped lint and all three consumer web/server source
contracts also pass. Consumer compilation is sequential; the largest graph remains Spartan
(1,913 source files, about 1.35 GB RSS), not runtime chat memory. No dependency
declarations or locks changed.

These are local synthetic results, not application adoption or deployed behavior.
Native Flutter file persistence/receipt parity and the remaining feature matrix
are still open; the overall goal remains active.


### Flutter exact draft origin recovery

Flutter's pending journal had the same gap between server admission and local
composer cleanup. The client/session now accepts an immutable device origin,
persists receipt-bearing submissions as version 2, and awaits exact cleanup after
confirmed admission before journal acknowledgement. It preserves version-1
recovery and excludes origin metadata from gateway/provider bodies. The standard
workspace uses an additive service without changing existing structural send
signatures; its account-owned composer registers cleanup outside the view.

Text cleanup serializes with storage writes, preserves newer edits (including
identical text), refuses to overwrite another writer, and flushes edits captured
during cleanup before disposal completes. File cleanup matches stable upload
selection identities, preserving a removed-and-readded identical file. Pending
selection references are released after confirmed cleanup; in-flight callback
reservations remain charged until settlement. This is not native file-byte
persistence: unsent native files still need the remaining durable adapter work.

Focused client/storage/session tests pass against the locked public JS gateway;
the explicit local JS source qualification also exercises bounded display and
large-text routes. The real gateway restart test injects a device failure after
partial cleanup, recreates the account controller, preserves a newer same-text
draft and starts the original turn once. Captured HTTP admissions are identical
and contain no receipt. Lost admission responses do not invoke cleanup; lost
start replies replay it idempotently. Widget tests cover exact capture, view
closure, account teardown, cross-tab conflicts, typing during cleanup, and newer
same-file selections. The test's initial stall came from crossing Flutter's fake
and real async zones; explicit scheduler pumping resolved the qualification wait.

Both Dart packages pass analysis, and all three real mobile integration source
contracts compile sequentially. Evidence is recorded in the Flutter repository's
`docs/draft-origin-qualification.json`. No dependency declarations/locks, app
configuration, commits or deployments changed. Native byte persistence, provider
preparation memory work and the broader final feature audit remain unfinished.


### Native Flutter file drafts and metadata-only recovery

The remaining native file gap was in the account composer: it retained selections
only in memory even though accepted submissions already had exact local receipts.
The Flutter client now includes an optional scoped encrypted-storage adapter with
separate immutable sources, versioned metadata and a durable cleanup journal.
Its standard composer restores only the selected chat, persists identity/source
before upload, and saves ready references without rereading or rewriting bytes.
Admission recovery removes only exact accepted IDs without loading file content.
Confirmed permanent deletion records a tombstone before source cleanup; late
writers cannot resurrect the deleted chat. Interrupted writes, uncertain commits,
cleanup failures and other writers preserve the authoritative saved revision.

Limits are 64 files / 64 MiB / 32 nonempty chats and a 256 KiB metadata manifest.
New/staged sources and outstanding cleanup count against storage quotas. Removed
selections remain in composer memory budgets while a storage callback holds them.
Stop during a pending source save prevents later network upload and preserves the
same selection key for retry. The standard workspace announces restore/save
failures, offers safe retry or explicit saved-file replacement, and blocks sending
until recovery is resolved. The host supplies encryption and atomic metadata
replacement; cross-isolate/process hosts need a transactional store implementation.

The focused source qualification passes 71 composer/draft/workspace tests and 31
client store/local-JS-gateway tests. These include account isolation, store
recreation, one binary write per source, metadata-only ready updates/recovery,
concurrent editor conflicts, slow storage budget accounting, disposal joins,
selected-chat hydration, and exact admission replay after interrupted cleanup.
An additional 47 controller/deletion/draft/journal tests cover deletion replay
after native cleanup failure. The wire fixture uses a supported CSV document; a
plaintext document fixture was correctly rejected by the protocol before it could
exercise cleanup and was corrected. Both Dart packages pass analysis. A 320-pixel,
2x-text storage-error test exposed composer overflow; bounding the composer with
a scroll view keeps recovery controls reachable while retaining transcript space.
Background cleanup and lifecycle flushing now leave unopened file drafts unhydrated. Mobile consumer compilation receipts
and test boundaries are recorded in Flutter's
`docs/native-attachment-draft-qualification.json`.

This is local source work. Consumer pins, locks and configuration are unchanged;
apps must configure their encrypted adapter and qualify it on physical devices
when adopting a later published full SHA. The overall goal remains active:
browser text retention, provider-input memory work and the final feature audit
are still outstanding.


### Browser editor retention and account-owned draft recovery

The saved-draft store already bounded persisted content, but browser editors
could retain an oversized paste until a later write rejected it. Pending save
and send callbacks also held older text outside that budget. Controllers and the
standard hook now validate before retention, preserve the previous text/edit
identity on rejection, and expose a separate accessible input error. One owner’s
identical text shares a reservation; older captured values remain charged until
their actual callback settles, even after acceptance, unmount or disposal.

Limits are 64 KiB UTF-8 per value, 512 KiB / 32 distinct values per scoped store,
and 128 reservation references. A character-count precheck refuses very large
pastes without allocating another encoded copy. Initial text, async restore and
explicit reload use the same checks. New typing captured during accepted-message
cleanup now finishes saving before disposal releases its editor.

A related lifetime bug tied text ownership to transcript runtime eviction. A
failed save could be lost while navigating enough chats. The standard bootstrap
now shares an account-owned `ConversationDraftWorkspace`: failed/uncertain edits
remain outside the transcript cache, reopening reuses their revision owner, and
clean unused editors use an eight-entry cache. All live/closing owners have a
separate 64-entry metadata cap. Confirmed permanent deletion forgets the owner
while scoped storage fences late writers. Transcript caching remains at four
idle sessions; draft recovery does not pin old message windows.

Qualification passes 120 tests across seven scoped suites, normal build, full
TypeScript, scoped lint and all three consumer web/server source contracts.
Chromium exercises the built public client/React workspace and real IndexedDB.
Ten rejected 1 MiB pastes retain the prior text and saved revision; collected heap
changes from 4,256,340 to 4,638,056 bytes (about 0.36 MiB growth, below the 8 MiB
warmup budget). Measured fill/rejection durations are 223–386 ms including browser
automation input. It also proves an accepted send stays budgeted until release,
failed text saves survive transcript eviction, recovery preserves newer text/files,
and account isolation and ready-upload reuse remain intact. The qualification
server now declares UTF-8 explicitly so accessible messages are decoded correctly.

The separate paged-workspace rerun keeps selection-to-paint p95 at 54.7/55.7 ms for
20k/100k-equivalent histories, with 5.86/5.98 MB collected heap, at most 90 rendered
messages, four idle sessions, and at most 14,244 HTTP body bytes. Only one catalog
page loads initially. These are synthetic browser measurements, not a production
latency estimate; database and provider costs remain separate.
`browser-text-retention-qualification.json` contains the evidence, limits and
latest consumer compilation receipts. No dependency pins, locks, commits or
deployments changed. Provider-input preparation memory and the final feature audit
remain open; the full goal is still active.

### Provider preparation: duplicate replay and retained checkpoint text

The saved-turn preparer previously loaded canonical state twice, serialized all
messages for equality, cloned every message record, and scanned all file records
for each message. It now checks the append-only canonical head after fresh
authorization. An unchanged head avoids the second replay; a changed head keeps
full replay/admission validation and compares a streamed SHA-256 equality token.
The token length/type frames canonical fields and preserves UTF-16 identity,
including lone surrogates, without allocating a full transcript JSON string.

Selection now uses linear input/file indexes, avoids argument spreading over
large histories, clones only provider-relevant values, and hands only selected
text plus the prior-file catalog to asynchronous resolution. Pure historical
redaction callbacks stop after filling the message quota. Required current input
and selected old files retain their existing rules. Replay reads use 128-event
pages and observe cancellation, including late completion of a held read.

Fresh-process memory qualification found another retention source: strings
parsed from checkpoint JSON could retain that entire serialized backing string.
Selected provider text now receives independent UTF-16 storage. Identical output
hashes prove the benchmark's provider messages/catalog did not change. On local
20k/100k represented-event checkpoints, preparation p95 changed from 45.97/290.92
ms to 35.92/225.25 ms, with one checkpoint/tail read instead of two. Provider bodies
are 16,389 bytes in both cases. Collected heap retained during a delayed business
context callback changed from 3.38/16.85 MB to about 24 KB. Thirty isolated scopes
using identical conversation IDs retained about 1.60 MB while callbacks waited.
These are synthetic local preparation measurements, not database/provider/network
or production capacity results; cold canonical decode remains history-dependent.

Run `npm run build`, then `HANDRAIL_PREPARATION_REPORT=docs/provider-preparation-qualification.json
node --expose-gc scripts/benchmark-saved-conversation-request.mjs`. Each case uses a
fresh process and the recorded real Git baseline with current shared dependencies.
The benchmark gates unchanged provider output, checkpoint/read count, body bytes
and paused-callback retained memory. The complete prior-file catalog still grows
with saved attachments. Indexed canonical context/catalog work and the broader
feature audit remain open; this is not a full-goal completion claim.

Validation for this preparation change: 153 tests across nine suites pass with
one worker, including canonical admission, durable provider replay and tool-loop
integration. Normal build, full TypeScript, scoped lint and diff whitespace checks
pass. No consumer dependency declarations, locks, releases or production state
were changed.

### Deferred structured-record inspection

The canonical/display split already deferred oversized tool/source/approval
records, but the standard surfaces left most of those placeholders without a
reader. A separately negotiated `recordText` capability now exposes formatted
record sections through the existing authorized content endpoint. SQL returns at
most 8,193 code points (including the lookahead); the API/UI retain 8,192. The
client never reassembles all sections or inserts them into transcript/model state.
Both React and Flutter expose an explicit reader for deferred related records;
the React pending inbox also exposes inspection of its selected review pair.
Selection/revision changes hide cached details and cancel pending reads.

Inspection deliberately does not confer approval. Verified bounded structured
approval review/decision remains open, as do custom-host adoption and the broader
restart/consumer behavior audit. The format is additive, capability-negotiated,
and local until a later authorized SDK SHA and consumer adoption.

The reader qualification passes 73 JS tests (seven suites), 17 Dart client tests,
27 Flutter widget tests, and 20 Flutter-to-local-JS gateway integration tests.
TypeScript build/typecheck, scoped lint, Dart analysis and Flutter analysis pass.
Chromium exercises the built public React workspace at 320px and 390px: zero
eager detail requests, explicit 8,192-code-point sections, literal HTML-like text,
no horizontal overflow, and no extra transcript page for approval inspection.
`deferred-record-browser-qualification.json` records the browser evidence; scoped
consumer compile receipts are recorded separately with the qualification.


### Final local foundation acceptance

The final audit passes 2,465 JavaScript tests in 225 files, 226 Dart client tests,
220 Flutter widget tests and 31 package-contract tests. TypeScript typecheck/build,
scoped ESLint and full Dart/Flutter analysis pass. Tests run sequentially with one
worker. All three consumer source contracts pass; mobile entrypoints were compiled
again after the final session/controller fix.

The audit found a real paged-send error: a definitive rejected admission was being
presented as uncertain/retryable. JS and Flutter now release only its exact send
journal, preserve drafts/files and allow correction without provider dispatch.
Network ambiguity still keeps the original identity. Recovery after restart and
failed local journal cleanup are exercised. Old test fixtures were updated for
graceful shutdown, explicit legacy capability negotiation and account-owned file
drafts. The browser/server composer fixture now uses real Node primitives.

Memory sampling traced the full JS test peak to seven embedded PostgreSQL WASM
instances in the approval restart matrix. Reusing one database with separate
tenants preserves its seven cases and reduces that fixture's peak process RSS to
829,384 KiB. This test-runner metric is separate from production
Node/PostgreSQL and browser/Flutter memory measurements.

See `chatbot-foundation-qualification.md` for the current acceptance map and
`chatbot-foundation-final-qualification.json` for final commands/results. Earlier
progress notes that call the audit open are superseded. Release, public-SHA
dependency adoption, production migrations and device/deployed qualification remain
later authorized work. No release or production data change is part of this result.
