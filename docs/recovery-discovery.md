# Bounded recovery discovery

Recovery discovery now prefers `DurableApplicationTurnStore.scanRecoveryCandidates`.
A candidate contains only conversation/turn identity and lease metadata, never
retained requests, provider state or event frames. `recoverTurn` checks the
current authorizer before loading the complete record, then checks the current
record/lease before the existing claim CAS. A candidate can skip a known live
foreign lease; it cannot grant permission or ownership.

Both built-in stores implement metadata discovery. Custom stores may retain the
older `scanRecoverable`/`listRecoverable` interfaces as a compatibility fallback,
but those interfaces still hydrate complete documents. They should implement the
new method to receive the same payload and authorization-order guarantees.

`recoverPendingPage({ limit: 25, cursor, signal })` inspects at most one bounded
page and returns `{ started, cursor, deferred? }`. The cursor keeps the initial immutable
upper fence. Schedulers can release their concurrency slot, obtain fresh
authorization and continue the cursor in another task. Aborting a page during an
authorization lookup prevents subsequent document loading and claim dispatch;
it does not cancel work that was already admitted. A full page of denied or live
leased identities may return no starts and a continuation cursor.

`recoverPending(limit)` retains its existing explicit full-scan behavior: it
continues past denied/leased identities until it starts at most `limit` turns or
exhausts the fenced scan. With an optional shared `DurableRecoveryWorkerPool`, it
also returns when execution capacity is exhausted. The limit bounds starts and
individual pages, not total authorization lookups or wall-clock duration.

## Assistant scheduling and shutdown

The high-level assistant now uses the page API in background tasks. Transport
construction and capabilities responses no longer await recovery. Defaults are:

- Two concurrent discovery tasks, each inspecting at most 25 metadata identities.
- Four recovered executions across all contexts of one assistant instance,
  configurable with `recoveryConcurrency`. A slot is acquired before loading the
  saved request and released after worker/observer cleanup. This cap covers
  recovery, not foreground turn admission or arbitrary host-created transports.
- At most 256 retained tasks (turn and approval discovery per authorization identity). Request wake-ups expire after
  60 seconds without renewed authenticated traffic. Only URL and headers
  are retained, at most 32 KiB per request; transcript and upload bodies are never
  retained by this queue. Fresh authorization uses a GET credential envelope with
  action `capabilities`, then verifies the saved identity and conversation access.
  It must not replay turn admission, consume a request body or charge a send rate limit.
- Fresh authentication and matching tenant/scope/principal/session before every
  page; conversation authorization is checked again before each saved body load.
  Role changes resolve a new transport instead of reusing a previous role's tools.
- Continuations yield and move behind other scopes. Exhausted scans repeat after
  15 seconds while authorization remains current, so an expired worker lease can
  be discovered without another browser action. Capacity-deferred pages retry
  after one second, without advancing past an unclaimed identity. When the very
  first page is deferred, retry starts a fresh bounded scan.

`recoveryContexts` is also polled every 15 seconds, independently of usage
reporting. It must reconstruct server-trusted contexts; it must not restore
persisted user tokens. The legacy iterable handles at most 128
contexts per source call. Larger installations use `recoveryContextSource` below. Interactive overflow is retried by a
later authenticated request. Queue state is an optimization: saved turns and
leases remain the restart source of truth. Explicit `assistant.recoverPending`
reauthenticates retained wake-ups and applies its start limit across all scopes,
instead of recovering from every cached historical authorization context.

Hosts should stop admitting HTTP requests, then await
`assistant.stopBackgroundWorkers()` before closing persistence. It rejects new
SDK requests with 503, stops discovery/usage timers, releases queued credential
envelopes, joins in-flight scans and usage writes, and drains admitted workers
while canonical projections remain alive. Worker monitors and observers are
joined before it resolves. Repeated stop calls are supported. This does not
cancel user intent or release a lease while a provider is still executing.
Graceful drain waits for the provider to finish; a host-enforced process timeout
still relies on durable lease expiry and the next authorized recovery process.

Each high-level assistant instance now adds a random instance identity to its
lease-owner derivation. A configured `workerId` is a logical name, not a unique
live lease owner: process IDs and names can repeat across pods or rolling
restarts. The competing-instance test uses identical names and contexts and
verifies that only the original worker runs, while cancellation from the peer
still reaches it through durable state. Low-level transport callers must supply
their own unique live `workerId`.

## PostgreSQL migration and rolling writers

The additive schema includes `durable_status`, `durable_lease_owner` and
`durable_lease_expires_at` scalar columns on `handrail_ai_documents`, plus partial
indexes for recovery and missing metadata. Candidate SELECTs do not reference
`payload`; PostgreSQL need not decompress each retained body to identify work.
The payload is unchanged and remains authoritative for claims and execution.

A BEFORE INSERT/UPDATE-of-payload-or-kind trigger updates these fields atomically
with document writes. This also covers an older SDK writer during rolling
adoption: terminal transitions disappear from the recovery index and newly
pending work reappears without a second asynchronous metadata write.

Existing rows have null status. `backfillRecoveryMetadata(limit)` prepares at
most 10 rows by default (maximum 100), with row locks and SKIP LOCKED. It returns
only the affected-row count; body data never crosses the SQL boundary. Metadata
preparation does not change document versions, timestamps, payloads or canonical
events. The null status is a restart-safe watermark. Discovery performs one small
preparation step per page and leaves remaining legacy identities discoverable;
authorized recovery may still encounter a legacy terminal record until its
metadata is prepared. Steady-state discovery does not read stored bodies.

Migration installs schema/trigger/indexes but does not replay all transcripts.
Future production rollout must apply the authorized migration before running
new code. Large installations can prebuild the indexes concurrently under their
normal migration process. No production migration or data repair was run during
this local development work.

## Local regression evidence

Tests cover immutable cursor fences while rows finish/new work arrives, tenant
isolation, denial before body loads, leased-worker skipping, payloads that vary
fivefold, bounded metadata response size, resumable legacy preparation and
updates from writers that know only the original payload columns. A 60-identity
fixture verifies that 25-candidate tasks yield across denied pages before reaching
an authorized turn, and cancellation during authorization prevents dispatch.
Thirty isolated in-memory contexts verify the shared four-worker limit, no saved
body loads for capacity-deferred contexts, later recovery and graceful drain.
Scheduler tests cover fairness, expired/changed authorization, held lookups,
coalescing, explicit drain serialization and shutdown. High-level tests cover
startup without usage reporting, denied prefixes, changed roles/sessions and
capabilities returning before a held recovery scan finishes.

The disposable native PostgreSQL check records adapter costs separately in
[recovery-postgres-benchmark.json](recovery-postgres-benchmark.json):

| Retained frames | Legacy serialized bytes / one read | Metadata bytes / p95 of 10 reads |
| --- | --- | --- |
| 20,000 | 3,304,875 / 99.57 ms | 90 / 3.09 ms |
| 100,000 | 16,744,880 / 450.61 ms | 90 / 1.93 ms |

The script also verifies two real competing lease/CAS workers execute once,
locked legacy preparation uses SKIP LOCKED, repeated migration preserves a saved
record, and a terminal writer after discovery prevents stale dispatch. Two real
competing approval claimants obtain one lease; a new committed decision survives
acknowledgement by an older claim. These
are synthetic local adapter measurements, not browser wire bytes or production
latency. The legacy timing has one sample per size. The fixture includes large
retained arrays but never sends them to a provider.

After `npm run build`, reproduce with an existing driver and local PG binaries:

```sh
node --expose-gc scripts/check-recovery-postgres.mjs \
  /absolute/path/to/pg/lib/index.js /usr/lib/postgresql/15/bin
```

The script creates, stops and removes its own local cluster and accepts no remote
database URL. Provider-input/memory qualification remains separate from this recovery work. These are not claimed by the
discovery and graceful-drain tests.


## Durable approval wake-ups

The additive migration creates `handrail_ai_approval_recovery`, its lease/ready
index and a bounded legacy-backfill cursor. A trigger queues a conversation in
the same transaction as a native approval decision/execution transition, including
writes from an older SDK version. Canonical decision events also wake host-owned
approval authorities. List responses do not wait for this work.

Discovery reads scalar identities, not proposal arguments or saved transcripts.
It checks current conversation access before claiming a 30-second renewable
lease or reading a saved body. Repair handles at most 25 pending canonical
proposals per pass, saving its progress. A committed native decision receipt
repairs a missing canonical audit event using the original idempotency key,
actor, time, reason and version; recovery does not decide again. The current
proposal, immutable decision fields, argument reference and canonical creation
must all match. A later retry of the original human decision reconciles normally.

The queue coalesces decisions by conversation. Each wake has a generation, so an
older acknowledgement cannot remove a newer decision. Failed or blocked work
retries after 15 seconds. Resumed provider turns share the four-worker recovery
cap. Stop aborts new dispatch, joins lease renewal and releases the claim. A hard
process death instead relies on lease expiry. Clear removes the wake and current
canonical proposals; permanent deletion removes it atomically and prevents
re-enqueueing the deleted identity. Retained old receipts cannot revive cleared
external/voice actions.

Native PostgreSQL and PGlite tests cover rollback, concurrent claims, lease
replacement, new decisions during repair, bounded backfill, a 28-decision repair
across queue recreation, revoked/different accounts and restart between decision
commit and audit append. Both confirmed and rejected decisions resume once, with
respectively one and zero tool effects. No production migration was run.

A custom `approvalStoreFor` authority must persist its own decisions and retry
appending their canonical events. The SDK cannot repair a host-private receipt
that it cannot inspect; once the canonical decision exists, the shared wake-up
and resumption path applies. All three scoped consumer gateways currently use
the built-in native approval store.

## Paged trusted identity source

`recoveryContextSource` takes precedence over `recoveryContexts`:

```ts
recoveryContextSource: {
  async page({ cursor, limit, signal }) {
    // Return up to limit stable server-owned keys and the next opaque cursor.
    return trustedAccounts.page({ cursor, limit, signal });
  },
  async resolve(key, signal) {
    // Consult current account/service access. Return null when revoked.
    return trustedAccounts.authorizeRecovery(key, signal);
  },
}
```

Each tick reads at most 32 keys and retains only its source cursor. Each queued
page resolves the key again and verifies tenant, scope, principal and session
before accessing saved work. Role changes create a fresh execution context.
Queue saturation retries the same source page; end-of-scan restarts at the
beginning, and a process restart also starts fresh. The host should use stable
keyset order with a scan fence so a changing account catalog does not starve
later keys. Keys (1,024 characters) and cursors (4,096) are bounded metadata and
must not contain credentials. SDK shutdown aborts and joins the source call.
Tests cover 161 identities, revocation/role refresh, held reads, queue pressure,
invalid pages and recovery beyond the legacy 128-identity prefix.


## Idle server resource retirement

The assistant retains at most 32 idle execution contexts and retires idle
contexts after 60 seconds (checked once a minute). Active HTTP operations,
transport construction and admitted workers protect their exact context. Role
or session changes still construct different transports. A recreated transport
has a new live lease-owner generation; it cannot claim a prior live lease merely
because the trusted context or configured worker name matches. Idle retirement
removes provider/tool/application references together. Failed provider/plugin
construction is removed immediately so the next authorized request can retry. In-flight observations
finish against durable state; retirement does not cancel their saved turn.

Scope persistence adapters use a 128-entry working set. They own no separate
connection; saved usage and decisions remain in PostgreSQL. Larger unattended
installations must supply the trusted identity source so evicted scopes with
pending work are revisited. Usage flushing takes a bounded snapshot of cached
adapters instead of iterating a map that concurrent requests can reorder.

Activity channels have a separate 32-idle-channel working set and protect live
subscribers. The last subscriber releases its pub-sub listener, including a
subscription still connecting. Worker progress resolves the current channel at
publish time, so an idle channel's recreation cannot detach later listeners from
an older transport. Shutdown closes and joins these subscriptions. New channel
instances have distinct delivery identities even within the same millisecond.

Activity HTTP streaming honors read backpressure. Each local subscriber retains
at most 256 notification envelopes; a stalled subscriber closes at that limit
and resumes through the existing durable snapshot/poll path. Slow connections
cannot shift that backlog into an unbounded HTTP stream buffer. Notifications
are not canonical events and their closure does not discard saved messages,
approvals or turns. Tests exercise held subscription teardown/reopen, snapshot
failure cleanup, stalled HTTP consumers and active-worker survival through 40
other cached contexts.
