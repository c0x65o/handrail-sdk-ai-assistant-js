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
| 2. Partial transcript loading | Indexed projection, paged gateway and changes feed, JS/Dart bounded controllers, React display component with tested anchors | Standard React runtime and Flutter session/widget adoption, durable position/draft integration, related-state presentation, bounded live resume metadata |
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

Bounded authoritative transport resume metadata remains outstanding. It still
comes from whole-log `hydrateRuntimeMetadata` on web. The next integration also
needs live text presentation: Flutter's current `_observe` saves checkpoints
without applying text, and high-level server `reconcileFor` skips text projection
while a durable turn is pending/running. Polling the new changes feed alone would
therefore still wait for terminal reconciliation to display the answer. Address
this with authorized live canonical projection or a bounded stream overlay with
correct resume/deduplication; preserve existing approvals and terminal receipts.

Indexed message anchors now restore older saved positions and support navigation
back toward newer messages after eviction. Both controllers enforce independent
row/byte budgets. Standard UI/runtime adoption remains outstanding.

After that server contract exists, replace Flutter's repeated full-snapshot path
and web's initial full replay with the negotiated display-history capability.
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
| 200 | 33.60 ms | 1.554 ms | 0.631 ms | 3,573,052 | 20 / 7,100 |
| 1,000 | 31.70 ms | 1.483 ms | 0.619 ms | 3,611,048 | 20 / 7,124 |

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
cursors, missing IDs, clear invalidation and tenant isolation. These controllers
are not yet wired into standard runtime/session ownership, so consumers still
use their full-history path. No production improvement is claimed from these
local component measurements.

## Adoption constraints

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
