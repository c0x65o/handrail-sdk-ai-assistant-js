# Trusted history and attachment preparation

The high-level `openaiResponses<TContext>` provider accepts two optional host
callbacks while retaining the SDK provider loop, approvals, execution ledger,
continuation and usage recording.

- `prepareRequest` receives the request, authenticated context, conversation ID,
  turn ID, mutation ID and cancellation signal. It runs once before provider
  work. Use it to check fresh ownership and construct input from saved history.
  Throwing stops provider dispatch; authorization errors remain classified and
  internal error text is not exposed. The SDK stops waiting when cancellation or
  the active deadline fires, even if a host callback has not settled; late results
  never resume provider dispatch. The host must still observe the signal and
  close its own resources.
- `attachmentResolver` receives an attachment reference, authenticated context,
  conversation ID and cancellation signal. Return its actual `media_type` and
  bytes only after checking account, conversation, message and file ownership.
  References are not authorization. The adapter checks returned media type and
  byte length before sending provider input, and observes cancellation after
  resolution. Pending resolution also stops being observed on cancellation, and
  late results do not reach the provider. Images retain protocol limits; documents retain configured MIME,
  count and byte limits.

Without a host attachment callback, the high-level provider uses SDK attachment
storage and its stored media type. This supports images, PDF and configured
spreadsheet formats without labelling every file as PDF. An existing explicit
synchronous image `resolveAttachment` option retains its behavior. The older
lower-level document resolver remains supported for other SDK consumers.

Durable attachment events contain presentation metadata, not an authorization
grant or provider content reference. A host constructing saved provider history
must resolve those references using its trusted storage; do not synthesize a
content reference from a client identifier.

Historical `message.created` events with `source.type = "import"` are inserted
by their original timestamp. Equal timestamps preserve insertion order, and
ordinary live arrivals are not reordered. Promoting an imported attachment
placeholder preserves its attachments. Existing message IDs are never
overwritten, so importers must reconcile saved user mutation IDs and reply/turn
links before importing. Do not deduplicate messages by equal text or infer that
importing history authorizes executing a recorded tool or proposal.

## Mills integration status

The same pending revision also fixes title usage capture: once provider usage
has been reported, a failed durable capture cannot be replaced by an unavailable
receipt under that identity. Generation fails without renaming or repeating the
external request after restart. `server-conversation-titles.test.ts` covers the
delayed capture failure and preserves the reported token values.

These additions are prepared in the SDK worktree after published revision
`1f2e381c2fe96c79108850ebcbab7b98954a5d3f`; they are not published or consumed by
Mills yet. Consumption requires an authorized publication followed by a public
HTTPS Git dependency pinned to the resulting full commit SHA and matching
lockfile. No local or vendored dependency is needed or permitted.

Tests cover stored image/PDF/CSV/XLSX projection, resolver ownership and byte/type
checks, retained synchronous image behavior, trusted preparation context and
redacted failures, chronological imports, placeholders and duplicate replay.
Provider-loop and high-level assistant recovery/ownership suites provide
regression checks. These are local fixture checks, not evidence of live provider
access or completion of Mills' history migration.
