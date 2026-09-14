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

High-level `openaiResponses` now enables the shared PDF capability by default
(`DEFAULT_ASSISTANT_DOCUMENT_INPUT`: up to two PDFs per message, 20 MiB each, subject to
the application's negotiated upload/storage limits). Set `document_input: false`
for a model or host that does not accept documents, or supply the existing
descriptor to choose supported formats and tighter limits. Explicit descriptors
keep their previous behavior. The lower-level provider still requires an explicit
descriptor and trusted resolver; it does not assume SDK storage exists. This
default fixes the case where an application uses the complete assistant but its
picker rejects PDFs because no host document descriptor was supplied.

Staging issues the protocol's `ref_…` content-reference grammar. The unpublished
cleanup follow-up removes the earlier `blob_…` staging alias and fallback lookup.
Old upload retries report missing content and cannot restage it under the same
identity. Hosts use a new upload key for new content. Account/conversation checks
still protect current references. This source removal does not erase old bytes:
old staging records remain for the separately approved disposable-data cutover.
Retained business-file blob keys are a different storage contract and unchanged.

Durable attachment events contain presentation metadata, not an authorization
grant or provider content reference. A host constructing saved provider history
must resolve those references using its trusted storage; do not synthesize a
content reference from a client identifier.

## Protected saved files in the optional web UI

The high-level assistant now provides `GET attachments/content` with
`conversationId` and `attachmentId` query parameters. Every request goes through
the application authorizer (`attachment_download`), the conversation catalog,
and the account/tenant-scoped attachment metadata store. Responses validate the
stored MIME and byte count and use `no-store`, `nosniff`, and download disposition.
Opaque IDs and staged content references are never public URLs.

This is advertised as `attachmentDownloads: { maximumBytes, url }` independently
of the upload capability. `attachmentUpload: false` hides new uploads without
removing access to existing files; server `attachmentDownloads: false` disables
the read handler explicitly. Older gateways omit this capability and clients
must not guess a URL. Custom staging stores may implement the optional
`getByAttachmentId` lookup; the standard PostgreSQL store supports it without a
schema change.

`createHandrailAiClient` exposes the negotiated `attachmentDownload` function.
`HandrailAssistantWorkspace` supplies it to the default saved-file renderer
automatically, so a minimal host needs no extra download state. The shared reader
uses the host's protected request/fetch adapter, rejects cross-origin negotiated
URLs and redirects, limits streamed bodies, and observes cancellation/deadlines
through authentication, fetch and body reads. Host callbacks must still observe
their signal to release their own resources.

The UI previews supported raster images, reauthorizes each Download activation,
deduplicates clicks, exposes safe retry text, and aborts/cleans up temporary URLs
on account, conversation or attachment replacement and unmount. Explicit host
`renderMessageAttachment` or `resolveAttachmentUrl` adapters retain precedence
for legacy storage; `loadAttachment` is the protected binary override for that
same shared UI. This does not move legacy host blobs into SDK staging.

Downloads preserve the configured staging retention. The default is **one hour**;
expired, deleted and consumed bytes are unavailable even if their message
metadata remains in history. Neither reading nor rendering extends expiry or
revives content. Applications needing longer retention must configure their
storage contract explicitly. The Flutter client's default workspace also
negotiates protected saved downloads; package adoption requires its own reviewed
committed revision and lockfile.

### Retained conversation files

`createConversationFileStorage` from `@handrail/ai-assistant/server/assistant`
provides the shared lifecycle for applications that retain conversation files
after temporary uploads are consumed. Supply trusted tenant/principal identity,
`authorizeConversation`, content policy and size/type settings. It owns bounded
staging, whole-request reference validation, immutable retention, checksummed
reads and restart/replay behavior. Authorization is checked before and after
materialization/download, including replay. Saved files survive staging expiry.

The September 14 source correction makes blob allocation and staging admission
atomic. Retaining a file, consuming its upload and binding the staging metadata
to the actual conversation also commit together. Any failed write rolls back
both changes. Conversation deletion removes the saved copy and its linked staging
metadata, while preserving other registered SDK references to shared blobs.
PostgreSQL infinite expiry is sent as text and cast by the database so postgres.js
does not attempt to convert it through an invalid JavaScript Date.

There is no retained-file `import` API. Mills, Spartan/Aegis and Hitcents/Cents do
not preserve or import old chats. Removing that API does not erase historical
records; old unmarked staging, imported copies and business references require the
explicit, approved cutover inventory. Do not infer ownership from matching text.

The optional `identity` settings control upload/saved scopes, blob keys and lock
namespace. Freeze a deployed consumer's current settings. Spartan already uses
SDK defaults; switching back to its retired identities would strand new files.
Its adapter supplies format/size/access policy and protected downloads only.

Applications using this adapter must start one service-level
`startPostgresConversationFileStagingCleanupWorker` from
`@handrail/ai-assistant/persistence/postgres` after normal persistence setup, and
await `stop()` before closing the database. Use the same trusted
`maintenanceScopeId` for uploads and the worker (default upload partition:
`conversation-files`). This is a service lifecycle hook, not a worker per request.

```ts
const fileExpiry = startPostgresConversationFileStagingCleanupWorker({
  persistence,
  maintenanceScopeId: "conversation-files",
  // Omit tenantId only for a service authorized for all tenants in this partition.
  tenantId: trustedTenantId,
  onResult: ({ removed, blocked }) => diagnostics.fileExpiry({ removed, blocked }),
  onError: () => diagnostics.fileExpiryUnavailable(),
});
// During service shutdown, before closing persistence:
await fileExpiry.stop();
```

The worker has no immediate startup sweep. Its bounded timer/explicit `flush()`
collects only expired temporary records carrying the new SDK retention policy.
It rechecks row versions and conversation/blob locks before removal. Saved copies,
other tenants/partitions, shared references, unmarked historical uploads and
malformed records are preserved. Diagnose nonzero `blocked` counts; cleanup must
not guess a malformed target. Expiry continues when no one uploads another file.

These September 14 lifecycle corrections, worker and import removal are now
public SDK 0.2.37 at `15a3806c2595a3f93a87a768ad13293113f41b58` (verified against
the public Git repository on September 14). That commit appeared externally
while this goal run was qualifying source; this run did not publish it.
All three web consumers now normally install this public revision with matching
locks. Aegis wires one service-level worker and its seven attachment cases qualify
expiry, shutdown and linked deletion. Application typed compiles/builds and
static adoption gates pass; the separate terminal-approval regression still
blocks full installed-server approval qualification. Source and local tests do
not establish deployment or production data removal.

## Current consumer qualification

Mills, Spartan and Cents web normally install public JS 0.2.37 at full SHA
`15a3806c2595a3f93a87a768ad13293113f41b58`; their main mobile clients normally
install public Flutter `50fe566d73f68b2beacc2a874dc9a038363b1509` with matching
locks. Full mobile analyses/release web builds pass; Mills has 312, Aegis 179 and
Cents 96 selected passing cases. Cents's unchanged visual gate now passes.
Mills has removed its custom dictation
route in favor of SDK conversation-bound transcription. Historical notes about
pending adoption from `1f2e381c2fe96c79108850ebcbab7b98954a5d3f` are superseded by
[the current progress record](assistant-cleanup-goal-progress.md).

The retained-file suite verifies atomic failures/retries, authorization, expiry,
shared bytes and linked deletion. `scripts/check-postgres-conversation-files.mjs`
adds native PostgreSQL races using a disposable cluster and the real postgres.js
driver. It accepts no existing database connection. This does not establish live
provider execution, production file removal or web/mobile audio behavior.


## Ordinary upload admission follow-up (unpublished source)

The generic PostgreSQL bundle now commits upload bytes and metadata in one
transaction. It captures bytes and scalar identity before waiting for the pool;
storage-agnostic staging also captures input before asynchronous storage. A failed
metadata claim rolls back new bytes. A lost commit acknowledgement reports
unavailable without deleting potentially committed content; an exact retry reads
the original durable upload identity. Success diagnostics occur only after the
commit is acknowledged. Three regressions failed before the fix; 52 related
staging/deletion/foundation cases now pass, including lost-acknowledgement replay.
Full TypeScript, scoped lint and normal build pass. The owned native PostgreSQL
checker passes eight cases, including failed admission rollback/concurrent retry,
deletion-before-admission and a lost commit acknowledgement. The five existing
retained-file races also still pass. Logs: `/tmp/sdk-js-turn35-staging-*`.

This source is newer than installed public 15a. Existing old uploads require the
separately approved cutover; neither admission nor replay adopts unmarked rows.

## Ordinary upload expiry (unpublished source)

`postgres(pool)` and `postgresFromClient(client)` now mark newly admitted ordinary
uploads with retention version 2 and a trusted `attachmentMaintenanceScopeId`
(default `assistant-uploads`). Use a distinct partition when independently
operated services share SDK tables. These records reference actual conversations;
the retained-file adapter above uses a separate version 1 policy and lifecycle.

`createHandrailAssistant` owns one expiry worker per assistant service when the
PostgreSQL adapter provides it. The default interval is 60 seconds, batch size
100, with no immediate startup sweep. Configure `attachmentCleanup` to change
the interval/bounds, or set it to `false` when an explicitly owned SDK scheduler
uses `persistence.startAttachmentCleanupWorker()` instead. Custom persistence
implementations own their lifecycle. Await `assistant.stopBackgroundWorkers()`
before closing SQL; the stable `await assistant.stopUsageWorker()` alias also
joins attachment cleanup and remains compilable against the frozen public SDK.
Stopping does not cancel admitted turns. Hosts still drain their active work and
flush usage through the existing shutdown contract.

The bounded `cleanupPostgresAssistantAttachmentStaging` helper accepts the trusted
maintenance partition, optional tenant and principal scope, and a returned cursor.
A principal scope requires its tenant. Omit a tenant only from a service authorized
for every tenant in that partition. The bundle's `attachments.cleanupExpired()`
uses the same checks, restricted to its trusted tenant/principal. Workers coalesce
concurrent flushes, advance past blocked records and resume their scan after its
end. No request data selects the maintenance partition.

Expiry takes the conversation and blob locks, refuses active text/voice,
unfinished tools/providers and pending approvals, then rereads metadata/version
and verifies the exact blob lease. Malformed history blocks that conversation;
temporary database failures remain unavailable errors. Expiry removes only
validated, expired version 2 metadata and unreferenced bytes. Changed leases,
shared business references, old/unmarked/version 1 records and unresolved work
remain intact. History, checkpoints, voice read state, usage and effect receipts
are unchanged. Safe diagnostics report `staging_cleanup_blocked` or
`staging_cleanup_unavailable` without file content or raw storage errors.

Metadata removal retains an `attachment.expired` idempotency receipt containing
hashed upload identity/fingerprint and version/status only. An exact old retry
returns `expired`; changed input conflicts, including after service restart.
The PostgreSQL `consume()` operation also commits consumption and guarded byte
removal together, preserving bytes referenced by a business attachment. Rollback
restores the original metadata and receipt state if deletion fails.

Turn 36 qualification passes 80 cases across seven files, full TypeScript,
scoped lint, normal build and twelve native PostgreSQL concurrency/admission
cases. The native fixture stops and removes its own cluster. These source
changes require a new public committed SDK revision and normal consumer adoption;
installed public 15a does not contain them. This evidence does not establish
live provider/audio execution or approved removal of old production objects.

The same unpublished follow-up gives version 1 retained-file staging the minimal
expired-upload receipt. Stage admission and expiry share the original upload
identity lock; expired retries cannot allocate replacement bytes, even when they
wait behind a concurrent sweep. Retained saved copies remain readable through
their existing references. New uploads use new keys. The retained-file worker
also advances past blocked batches, including malformed database keys, while
preserving the public cleanup result shape. Scan positions never authorize
deletion. A shared regression run and the native PostgreSQL retry race qualify
these paths; installed public 15a does not contain these follow-ups.
