# Bounded display history (local implementation)

The display projection is separate from the canonical event log, checkpoints,
provider context and durable turn state. It must never be passed to canonical
replay as though it were a complete checkpoint. The React and Flutter adoption
work is still in progress; adding these server routes does not itself change
existing clients' loading behavior.

## Storage and migration

`PostgresAiPersistence.migrate()` includes additive `handrail_ai_display_heads`
and `handrail_ai_display_records` tables and indexes. Run the SDK migration before
starting upgraded writers. This is a deployment prerequisite, not an instruction
to change a production database during the current local-development goal.
Existing records are untouched by schema installation.

Canonical writes through `PostgresConversationEventStore` and canonical events
passed to `PostgresAiPersistence.appendEvents` update the display index in the
same transaction. The projector loads only affected message/turn/tool/approval/
citation records. Multiple token deltas in a batch update the in-memory entity
and write that entity once. Generic, noncanonical events have no display contract.

Older logs require a resumable backfill. `PostgresConversationDisplayHistory`
requires an authenticated tenant, owner scope and conversation authorization
callback. `backfill(conversationId, maximumEvents)` processes at most 100 events
by default (maximum 1,000), persists a watermark and returns `hasMore`. It uses
the canonical append lock so concurrent live appends cannot overtake the index.
Page reads never replay or backfill history. They return `status: "preparing"`
and no partial records until the index catches the canonical head.

The high-level assistant queues small authorized backfill steps when a history
page is preparing. These share the bounded maintenance queue and reauthenticate
between steps. Restart or queue overflow loses only a wake-up; the next authorized
page request resumes the persisted watermark. Canonical turn/approval recovery
remains a separate mechanism and still needs the goal's complete restart audit.

## Gateway

Related state can be loaded with `view: { type: "context", messageIds: [...],
turnId?: string }`. It follows the retained messages' turn references and returns
turns, tools, approvals, budgets, citations and cited source records in one bounded
page. At most 100 message IDs are accepted, within the gateway's existing 8 KiB
request envelope. Duplicate references are normalized and cursor identity covers
the complete normalized view. Use `nextCursor` for further activity; never assume
that one related page contains every historical tool or approval.

Negotiate `capabilities.displayHistory.version === 1`. Older servers omit this
capability. The authenticated POST route is `<mount>/conversations/history` and
uses the existing `conversations` authorization action. It does not initialize a
provider transport, resume a turn or reconcile history on the request path.

```json
{
  "operation": "page",
  "input": { "conversationId": "chat-id", "limit": 30 }
}
```

Successful responses use the existing `{ "ok": true, "value": ... } envelope.
Pages include `generation`, `revision`, `canonicalRevision`, `activeTurnId`,
`records`, `nextCursor` and `status`. The default view is `{"type":"messages"}`.
Messages are complete records (all accumulated text and attachment references),
returned oldest-first within the newest page. Pass `nextCursor` to load the next
older page. No checkpoint, event log, processed-ID list or file bytes are included.

Each record has `kind`, `id`, `revision`, `turnId`, `bytes`, `value`, and
`deferred`. Fetch related progress/approvals using
`view: {type: "turn", turnId}`; it pages turn, tool, approval, budget and tool
citation records. Fetch message citations with
`view: {type: "citations", messageId}`. Citation source IDs resolve through the
content operation below. Page related records lazily for visible messages;
also inspect `activeTurnId` when work is active without a new assistant message.
Related records and messages have independent cursors.

Cursors are opaque and bind tenant, owner scope, conversation, view and clear
generation. Their insertion fence prevents new messages appearing unexpectedly
in older pages. Existing records may reflect newer updates: merge by kind/ID and
record revision. A clear changes the generation; discard all cached pages from
the old generation. Permanent deletion seals the identity and removes the index.

The maximum page size is 50 records; default is 30. A page document defaults to
a 64 KiB UTF-8 budget. Callers may request `maximumBytes` between 8 and 256 KiB.
Individual records over 32 KiB are deferred before PostgreSQL transfers their
content to the application. A smaller page budget may defer a smaller record.
`value: null, deferred: true` is an explicit content placeholder, never an empty
message. The client should offer an accessible explicit expansion/download.

```json
{
  "operation": "content",
  "input": {
    "conversationId": "chat-id", "generation": 0,
    "kind": "message", "id": "message-id", "revision": 412, "offset": 0
  }
}
```

Content replies contain `encoding: "json-text"`, `text`, `revision` and
`nextOffset`. Concatenate chunks before parsing the complete JSON record.
Offsets count Unicode code points, not UTF-16 units or bytes. Chunks contain at
most 8,192 code points. A referenced record whose revision is not known (for
example a citation source) may omit `revision` only on its first chunk; pin the
returned revision for subsequent chunks. A changed record returns
`content_changed`, requiring a fresh read rather than concatenating versions.
Clients must not automatically reconstruct every oversized record in memory.

For a text-only large-message reader, separately negotiate
`displayHistory.messageText === true` and send `format: "message-text"` with
`kind: "message"`. The reply uses `encoding: "plain-text"`; text parts are joined
with blank lines, with no attachment bytes or serialized record metadata. The
high-level assistant enables this capability. Custom gateways must explicitly
set `displayMessageText: true` only when their scoped store supports the format.
The legacy default remains `json-text`; clients must not assume support from
`displayHistory.version` alone.

Plaintext chunks use the same pinned revision and Unicode offsets. Nonterminal
chunks contain exactly 8,192 code points, so readers can navigate backward
without retaining previous sections. React's standard transcript and Flutter's
standard display widget retain a single section for one expanded message, with
explicit navigation, close, error/retry and changed-version reload. They cancel
obsolete reads and never auto-download oversized content. The PostgreSQL text
extraction parses/aggregates the explicitly selected record inside the database;
its server work may grow with that one message. It is not performed for list or
initial-history requests. This text reader does not yet supply deferred
attachment/citation metadata or expand oversized tool/approval records.

Display errors use `resourceError.domain: "display_history"`, with
`invalid_input` (400), `not_found` (404), `stale_cursor` (409), or
`content_changed` (409). Requests are capped at 8 KiB. Responses are private and
noncacheable. Never accept a tenant or ownership scope from the request body.

## Related activity retention

Standard JS and Flutter sessions merge explicit related-page reads into a separate
90-record / 256 KiB serialized activity window. Record kind/ID and revision prevent
duplicates and stale replacements. The changes feed updates or removes retained
records. Live first-page refreshes preserve older loaded activity for an unchanged
message/turn view. Exceeding the bound exposes a Show latest activity action;
changing the retained message set or active/latest turn starts a new related view.
This does not promise that every historical approval or citation is initially loaded.

To remain inside the 8 KiB gateway request limit, sessions group long message IDs
into context views of at most 2 KiB each, including the active/latest turn in the
first group. Additional groups, like additional pages, load only on demand. Each
cursor belongs to one exact group; it cannot be reused with another set of IDs.
The combined activity window still has one count/byte budget across all groups.

## Message anchors

A message page may replace `cursor` with an indexed anchor:

```json
{"operation":"page","input":{"conversationId":"chat-id","limit":30,"anchor":{"messageId":"saved-message","generation":0,"direction":"newer","inclusive":true}}}
```

Anchors are restricted to the messages view and mutually exclusive with cursors.
`inclusive: true` restores the saved message at the start (`newer`) or end
(`older`) of the window; the default is exclusive. Reads use the message primary
key and bounded ordered index lookup, not offsets or traversal through prior
pages. Missing anchors return `not_found`; clears return `stale_cursor`. Cursors
retain direction and insertion fence. All pages return chronological display
order, including pages fetched toward newer messages.

After eviction, request older messages using the first retained message as an
exclusive `older` anchor; request newer messages using the last retained message
as an exclusive `newer` anchor. Persist message ID, generation and pixel
displacement for scroll restoration, not a page-number offset.

## Live changes

Use the same route with `operation: "changes"` and
`input: {conversationId, generation, afterRevision, cursor?, limit?, maximumBytes?}`.
Start from the revision of a loaded page. Responses contain the same scoped
head metadata and bounded records plus `throughRevision`. Follow change cursors
only while actively catching up, keeping `afterRevision` unchanged. Advance the
live watermark to `throughRevision` only when `nextCursor` is null and the
response is `ready`. History cursors and change cursors are not interchangeable.

Changes contain complete current records, ordered by revision/kind/ID, rather
than token event slices. Repeated changes to a record coalesce. An update that
occurs during multi-page catch-up can move past that request's revision fence;
the next poll after `throughRevision` includes it. Apply a record only if its
revision is newer than the cached record. `deleted: true, value: null` is an
explicit tombstone (for example, a pending citation removed when its target is
resolved as a user message). Never fetch content for a tombstone. Clear still
invalidates the entire generation. This feed reads the canonical projection;
live provider frames need canonical projection or a separate bounded stream
overlay before clients can rely on it for token-by-token presentation.

## JavaScript client and validation

### Bounded execution controls

Gateways advertise `displayHistory.control: true` when the history resource also
supports `{"operation":"control","input":{"conversationId":"...","turnId":"..."}}`.
`turnId` is optional and verifies a particular admitted turn, including a completed
turn outside the visible page. `createApplicationGatewayDisplayHistory().control`
returns a distinct `ConversationDisplayControl`, never a partial canonical state.
Custom gateways opt in with `displayControl: true` and must provide `control()`
for every scoped store. Older/custom stores remain compatible without opting in.

The response contains the generation and canonical/display revisions, plus up to
three scalar turn summaries: active, latest and requested. A missing requested
turn is `null`. Each summary has an ID, revision, status, remote-running flag and
an optional bounded error. Message IDs, retry arrays, tool results and attachment
contents are excluded. Error messages are explicitly marked `messageTruncated`
when longer than 256 Unicode code points. The response has a 32 KiB hard budget.
Both clients validate conversation/turn identity and reject contradictory status,
missing controls and future revisions before exposing the data to a session.

PostgreSQL computes summaries in the same append transaction as display records.
Steady-state control reads use one indexed statement and never select the full
turn payload or checkpoint. A partial index finds the latest admitted turn by
first revision rather than repeatedly scanning old turns. Another partial index
tracks legacy turns missing summaries. `backfillControls(conversationId, limit)`
repairs at most 10 turns by default (maximum 50) under the append/deletion lock;
the high-level assistant queues those steps after history preparation. Preparation
may parse a legacy turn body inside the database; that one-time cost is separate
from steady-state reads. Null summaries provide a durable restart watermark.

Unprepared controls return `preparing`, with no turn summaries. Clients must wait
or retry; this must never be interpreted as permission to send a second turn.
Canonical admission still arbitrates races after a ready control response.
This API does not alter model context, replace admission writes, or claim bounded
SSE replay. Standard session/runtime adoption remains in progress.

`createApplicationGatewayDisplayHistory({baseUrl, fetch, protectedRequest})`
provides `page(input, signal?)`, `changes(input, signal?)` and
`content(input, signal?)`. Aborting a selection
request does not cancel a running assistant turn. Keep display cancellation and
authoritative turn cancellation separate.

The client limits response bytes before decoding, validates page envelopes,
rejects cross-conversation responses, and cancels pending credential resolution
and response-body reads. The read deadline defaults to 30 seconds; the factory
accepts `historyTimeoutMilliseconds` (1–300,000). Redirects are rejected.

`ConversationDisplayWindow` from the client entry point owns one selected
conversation and one in-flight read. Defaults: 30 messages / 64 KiB per page,
90 retained messages / 256 KiB serialized record content. The latter is a content
budget, not JavaScript object overhead. Older navigation evicts newer off-screen
records and vice versa. `select`, `loadOlder`, `loadNewer`, `jumpToLatest`,
`refresh`, and `retry` never fetch every page. One change-feed page is read per
refresh; its watermark advances after the final page. Clear/access revocation
evicts visible text; transient errors preserve it for retry. Dispose on logout.

`createHandrailAiClient` exposes negotiated `displayHistory` and `displayWindow`
properties and disposes the latter with its authenticated lifetime. When a gateway
advertises `displayHistory.control: true`, standard single/multiple-conversation
assembly uses `ApplicationConversationSession` through a read-only presentation
runtime. An explicit custom runtime/event store retains the canonical path; older
gateways remain compatible. Single mode still creates no registry or catalog UI.

`ConversationDisplayTranscript` from the React entry point takes the controller,
selected conversation ID, complete-message renderer, and optional explicit
deferred-content renderer. It provides foreground polling, older/newer scroll
loading, keyboard-accessible load/retry/jump controls, message-based anchoring
and delayed layout anchoring. DOM size is bounded by the retained window; it does
not estimate off-screen heights. Its default cache holds at most 32 anchors.
An account-scoped position store can replace it; the default is not durable.
It never manufactures a partial canonical `ConversationState`.

The standard `ConversationProvider`/`StyledChatPreset` now selects this transcript
automatically for a negotiated session. The session owns selection, polling and
abort lifetimes, so the component does not launch duplicate initial reads or
polling. Only the selected session retains message bodies. The standard workspace
keeps four idle sessions; running/submitting sessions retain scalar observation
and stay within the existing registry capacity. Related activity is a separate
bounded page. Standard approvals read that page rather than polling the complete
proposal group. Pagination of all related activity and oversized-content expansion
remain under qualification; initial bounded pages are not a complete approval log.

### Presentation API and durable send retry

React hooks and UI callbacks use `ConversationPresentationState`, a read-only
contract also satisfied by canonical stores. `partial: true` identifies a loaded
window. It has no processed-event IDs, replay cursor, or canonical checkpoint.
Presentation actions return `ConversationPresentationTurnResult` (turn identity,
status and optional error), rather than inventing a transport checkpoint. Code
that requires canonical audit/model state must use an explicit canonical runtime
or server store. `applyEvent/applyEvents` reject read-only presentation stores.

The session captures input before awaiting anything, retains the original
admission and start identities before writing, and verifies a specific admitted
turn through scalar controls. A lost reply is retried with identical content and
IDs. Stream frames wake projection reads; they are never appended by the browser.
Local observation disconnect and authoritative cancellation remain separate.
The standard transcript offers **Retry saved message** for retained intent.

For browser reload recovery, provide the account/API-scoped IndexedDB adapter:

```ts
import { createHandrailAiClient } from '@handrail/ai-assistant/client';
import { IndexedDBApplicationConversationPendingStore } from '@handrail/ai-assistant/browser';

const pendingStore = new IndexedDBApplicationConversationPendingStore({
  scope: `${apiEndpoint}|${opaqueAuthenticatedAccountId}`,
});
const client = await createHandrailAiClient({
  baseUrl: apiEndpoint,
  pendingStore,
  conversations: { mode: 'multiple', clientId, authorize: () => 'allow' },
});
// On account teardown, unmount its UI, then:
await client.dispose();
pendingStore.close();
```

The endpoint-only `HandrailAssistantLauncher` accepts the same `pendingStore`.
Use a stable opaque account identity and endpoint partition, never a token. The
adapter stores user content as browser-local IndexedDB data; host policy controls
whether logout erases it via `eraseAccount()` before close. `close()` alone retains
uncertain sends for later authenticated recovery. Transactions arbitrate tabs,
compare exact acknowledgement content, and enforce 32 pending conversations / a
4 MiB scope budget without evicting ambiguous sends. An omitted adapter uses
bounded account-lifetime memory and does **not** survive reload.

### Drafts and saved positions

That same IndexedDB adapter implements `ConversationLocalStateStore`. Standard
negotiated sessions use it automatically for unsent text and message/generation/
pixel anchors; a custom account-owned `localStateStore` can be passed separately.
The database upgrades its existing pending-send journal without replacing saved
intents. It stores at most 32 nonempty drafts, 64 KiB UTF-8 per draft and 512 KiB
of total draft text per account/API scope. Filling the journal reports an error;
it never evicts unsent text. Positions have a separate 32-chat bound.

The standard composer restores text asynchronously, preserves typing that starts
before restoration finishes, and clears only the edit actually admitted by Send.
Writes coalesce with a 250 ms debounce and flush on view teardown/page hiding.
Cross-tab writes compare opaque revisions atomically. A conflict preserves the
editor and offers retry or explicit replacement with the saved draft. Storage
errors are visible and do not silently replace text. `client.dispose()` waits for
captured local flushes; close the adapter afterward. Abrupt process termination
before an asynchronous write completes cannot be guaranteed durable.

Scroll restoration requests one indexed page around the saved message; it does
not fetch every preceding page. A changed clear-generation falls back to the
latest page. Draft storage contains text only, not attachment bytes or transcripts.
Selected files remain account-owned in memory; admitted attachment references
are part of the separate durable submission journal. Attachment-selection reload
recovery and browser deletion cleanup still require qualification.

Run the synthetic component browser fixture with
`TMPDIR=/tmp node scripts/check-display-window-browser.mjs`; set
`HANDRAIL_TEST_CHROMIUM` to an installed Chromium path when needed.
`HANDRAIL_DISPLAY_BROWSER_REPORT` optionally saves JSON results. This is not an
application preview.

`scripts/benchmark-display-history.mjs` runs after `npm run build` with
`node --expose-gc scripts/benchmark-display-history.mjs`. It measures synthetic
20k/100k-event histories, bounded backfill, database round trips, serialized
wire bytes, page latency and Node heap allocation. Thirty concurrent reads of
isolated tenant partitions verify equal conversation/message IDs do not cross
scopes. PGlite uses one local connection; this is not evidence of production
PostgreSQL concurrency, production HTTP latency, browser rendering or Flutter
memory. Those checks remain separate deliverables.

## Activity timestamp index and partial citation presentation

The additive schema also includes `handrail_ai_events_activity` on
`(tenant_id, conversation_id, created_at DESC)`. Host catalogs using
`includeEventActivity: true` require this index: without it, computing each row's
latest database write time can scan its whole event history, even though only
small metadata is returned. The local PostgreSQL benchmark records before/after
plans and 30 concurrent scopes in `display-history-postgres-benchmark.json`.
Creating an index on an existing large table is a migration cost, not a read cost.
Plan the migration in the later authorized release; ordinary `migrate()` index
creation may lock concurrent writes. A host-managed concurrent index build can
install the same named index before normal SDK migration. No live migration has
been performed for this work.

Related records can land on separate pages or be evicted by the bounded window.
JS `ConversationPresentationState.unresolvedCitationCount` and Flutter
`document.state['display_history']['unresolvedCitationCount']` report loaded
citations whose sources are not loaded/inline. Presentation exposes only citations
with a retained source; loading another activity page makes newly paired citations
visible, and removing/evicting a source withdraws the reference. The raw bounded
related cache still retains the pending citation. Standard transcripts explain
that some sources are not loaded. This does not fetch every activity page or
change canonical citation history. Deferred source expansion remains separate.

## Pending approvals outside the loaded transcript

Servers advertising `displayHistory.pendingApprovals: true` support two additional
page views: `{ type: "pending_approvals" }` and
`{ type: "approval", proposalId }`. The first uses the indexed current `pending`
status, independent of message-window references. It retains the existing page,
byte, owner-scope, generation and keyset cursor rules. Expiration is represented
by canonical status; a timestamp alone never silently removes a pending action.
The second returns only that proposal and its referenced tool, subject to the
same deferred-record rules. It does not load the proposal's entire turn.

The scalar control response adds optional `hasPendingApprovals`. Absence means
an older server; clients must negotiate the capability before requesting these
views. The indicator is false while projection preparation is incomplete and
uses an indexed existence lookup rather than a count or transcript scan.

The standard React preset exposes a pending-approval entry point even while
reading older messages. Opening retains one 30-record/64 KiB inbox page; opening
a selected review allows at most two records and 128 KiB. Navigation replaces
pages. Closing or switching cancels reads. Headless callers can use
`ApplicationConversationSession.readApprovals()` and the exported
`ConversationPendingApprovals` primitive. Existing approval decisions still use
canonical expected-version and idempotency validation; display pages never grant
execution permission. Opaque argument references must match the fetched tool's
identity and argument hash before confirmation is enabled.

Additive migration `handrail_ai_display_pending_approvals` is a partial index on
approval records with canonical pending status. It requires no transcript replay
or new per-record backfill column. As with other schema indexes, a future large
production installation can prebuild the same index concurrently under its
normal authorized migration procedure. No production migration was run here.

Oversized proposal/tool records remain explicitly deferred. The UI explains
unavailable/incomplete review and disables confirmation; full deferred structured
review remains follow-up work, not an implicit full-history download.
