# Integration migration

The integration conveniences are additive. Existing low-level runtime,
transport, gateway, React primitive, and CSS-variable APIs remain supported.

## Recommended migrations

- Replace high-level `runtime` configuration with
  `conversations: { mode: "multiple", ... }` without changing its event-store
  factory or authorization policy.
- For applications that never expose threads, use `mode: "single"` and consume
  `client.conversation`; remove local registry/workspace assembly.
- Replace independently assembled principal, attribution, profile, tool, and
  presence objects with `createAssistantGatewayAuthorizer`. Keep profile fields
  minimal and server-resolved.
- Move preset color/radius/font overrides into `theme` when typed configuration
  is useful. Existing CSS variables continue to work and override defaults.

## Intentionally deferred boundaries

- Authentication schemes, user/profile databases, authorization and retention
  policy remain application-owned; the SDK coordinates their outputs but
  cannot infer them.
- Model context is explicit rather than automatic. The SDK will not disclose a
  principal or profile to a provider unless the host places approved fields in
  `model` and uses them in its provider adapter.
- Styled and standalone React Markdown now use optional UI peers (`react-markdown`
  and `remark-gfm`). Install them in web consumers; they are not required by core,
  client, server, or headless consumers.
- Replace host Markdown parsers with `HandrailMarkdown` from `react/markdown` or
  the Flutter `handrail_ai_widgets` library. Tables and other formatting are
  maintained in the SDK. Keep host themes and navigation callbacks; see
  [the shared Markdown contract](./markdown-rendering.md).

## Usage outbox delivery retention

The candidate retains `usage_outbox` documents with status `delivered` after
acknowledgement. Pending/failed version-1 documents remain readable; no SQL table
change is required. Delivered rows preserve receipt identity and immutable usage
for replay deduplication. Do not purge them while durable turns or other retained
sources can replay those receipts. Previously deleted acknowledgements cannot be
reconstructed locally; the telemetry receiver must still deduplicate receipt IDs.

Upgrade every worker sharing an outbox scope to this implementation together.
Older SDK workers do not understand delivered documents when capturing a replayed
receipt. Keep the legacy assistant mode available, but do not roll an SDK worker
back over these documents without a compatibility patch. Hosts continue to run
SDK schema migrations through their own deployment process; this candidate does
not apply migrations or deploy itself.

## Tool execution admission and crash recovery

The candidate's Postgres ledger commits a `tool_execution` document before
calling a tool, then writes its completed result in a separate transaction.
Previously the ledger held one transaction around the callback. An external
change could commit while that transaction rolled back, allowing a later worker
to repeat it. The new claim prevents that repeat for the same tenant/tool-call ID.

Claims use the existing version-1 documents table; no table alteration is
required. Existing completed ledger results remain readable. Upgrade all SDK
workers sharing a ledger scope together: older workers ignore these claims and
must not execute against a scope containing uncertain claims. Retain the claim
and result for as long as the originating work can be replayed. Switching the
application UI to legacy remains supported; running an old SDK worker against
new execution claims is a separate compatibility concern.

If a claim exists without a completed result, a competing/recovering worker gets
`PostgresToolExecutionUncertainError` instead of dispatching again. The original
worker can still finish and publish its result. After a crashed worker, the host
must reconcile the actual domain outcome before further mutation work; the SDK
cannot infer whether an external service committed. Do not delete a claim or
assign a new call ID merely to retry an uncertain mutation. This is protection
against repeated dispatch for a stable ID, not a claim of transactional atomicity
across the SDK and every external service. Domain authorization, transaction
semantics, stable intent identity, and recovery evidence remain host-owned.

Automated evidence includes real PostgreSQL-compatible transactions through
PGlite (`test/postgres-tool-ledger.integration.test.ts`) and fault-injection tests
for rollback, lost admission/completion acknowledgements, and competing workers.
PGlite is a pinned development dependency, not a production database dependency.

## Immutable tool retry identity

`BoundedToolExecutor` now binds a tool-call ID to the exact tool name and JSON
arguments before consulting a cached or concurrent result. Object property order
does not change identity; array order and argument values do. It snapshots the
arguments before asynchronous authorization and rejects identifiers that would
otherwise be truncated into another call's ID. Changed calls receive an error
without another dispatch or reuse of unrelated result data.

`ToolExecutionLedger.get` and `getOrCreate` accept an optional
`requestFingerprint`. Built-in ledgers reject a different or missing fingerprint
for an already bound ID. Custom ledgers must retain and compare that binding too;
accepting the new argument in TypeScript alone is not proof of implementation.
The Postgres adapter stores a SHA-256 digest in the existing execution claim,
keeping raw arguments out of the claim. This does not broaden the ledger's
scope: hosts must still choose the correct tenant/principal scope and stable
intent identity for recoverable work.

Old completed entries without a binding remain available through the legacy
unbound lookup and `getToolResult`. They cannot establish that a new bound
execution request matches the old call, so bounded execution refuses to reuse
them. Drain older active tool runs before upgrading workers, or reconcile their
original requests and results through the host's trusted recovery process.
Never erase an old result and rerun the mutation to fill in its missing binding.

The default Postgres persistence bundle now separates ledger keys by its
`scopeId`. The high-level assistant additionally supplies an `executionKey`
derived from scope, conversation, turn, and provider tool-call ID when the
provider supplies the call's location. It preserves the provider's original ID
in protocol results. Custom provider transports must supply conversation/turn
location to `tools.execute` to get that separation. Call IDs must remain unique
within a conversation's canonical history.

Standalone `BoundedToolExecutor` callers can supply their own stable
`executionKey`; executors receive it in their context for domain idempotency.
Without one, the legacy tool-call-ID key remains in effect. Context identity and
authorization still belong to the host. New scoped keys do not migrate old
unscoped entries: drain or explicitly reconcile all historical active tool work
before the upgrade, rather than resuming it under newly scoped keys. Where a
lookup still addresses an old unbound record, the binding check refuses reuse.
