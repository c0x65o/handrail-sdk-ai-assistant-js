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

Display errors use `resourceError.domain: "display_history"`, with
`invalid_input` (400), `not_found` (404), `stale_cursor` (409), or
`content_changed` (409). Requests are capped at 8 KiB. Responses are private and
noncacheable. Never accept a tenant or ownership scope from the request body.

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
properties and disposes the latter with its authenticated lifetime. These are
currently additional presentation facilities: the existing runtime still uses
canonical synchronization pending the separate runtime integration.

`ConversationDisplayTranscript` from the React entry point takes the controller,
selected conversation ID, complete-message renderer, and optional explicit
deferred-content renderer. It provides foreground polling, older/newer scroll
loading, keyboard-accessible load/retry/jump controls, message-based anchoring
and delayed layout anchoring. DOM size is bounded by the retained window; it does
not estimate off-screen heights. Its default cache holds at most 32 anchors.
An account-scoped position store can replace it; the default is not durable.
It never manufactures a partial canonical `ConversationState`.

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
