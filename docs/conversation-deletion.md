# Conversation deletion and retention

September 13, 2026 implementation, published through public JS SDK revision
`5a0ebe520a9e6fde0b3a792f959a7a10e0a3de50` (0.2.36). Mills, Cents and Aegis web
checkouts have installed that revision with matching locks. Production rollout/data removal
and the separately described Flutter deletion source remain unfinished.

The PostgreSQL catalog previously deleted only its catalog row unless the host
supplied its own contents callback. The default assistant bundle did not supply
that callback. A removed conversation could therefore leave transcript events,
runtime snapshots and file bytes behind. Deleting rows without fencing writers
would also let a delayed request recreate state under the removed identity.

## Current implementation

`PostgresConversationCatalog.permanentlyDelete` now performs its SDK cleanup in
the same transaction as the ownership/version check, catalog removal and durable
idempotency result. It rechecks authorization before commit. Its host cleanup
callback also participates in this transaction; enqueue external object cleanup
there rather than deleting remote objects before SQL commits.

The SDK cleanup:

- refuses pending/running durable turns, live calls without confirmed termination,
  pending native approvals, canonical remote-running work, unresolved started
  tools, unfinished conversation-bound provider operations and unreadable replay;
- validates ended-call evidence and checks every associated voice-tool partition,
  including calls beyond the first page; hangup alone cannot settle an already
  dispatched tool, and running/unknown activity outcomes block deletion;
- writes a minimal permanent identity marker to the existing documents table;
- removes canonical events, checkpoints, text turn/synchronization state,
  conversation activity and explicitly conversation-bound OpenAI continuations;
- replaces completed, conversation-bound provider results with minimal purged
  receipts, retaining the request fingerprint and completion time but no result;
- replaces saved create/rename/clear/archive/restore catalog responses with
  deletion markers, removing their duplicate titles and metadata while retaining
  the original request keys and fingerprints;
- removes SDK attachment references and blobs with no other SDK attachment
  reference, serializing shared-blob collection with reference admission;
- prevents late event, text-state, checkpoint, activity, attachment, approval,
  bound provider-operation and voice-call admission from recreating state under
  that conversation identity;
- removes a newly allocated staging blob when a deletion fence definitively
  rejects its metadata admission; and
- retains a minimal catalog ownership/storage claim without title or content;
- removes voice read acknowledgements while retaining bounded call/tool outcome
  receipts (identity, name/status/timestamps; no audio, transcript or business result);
- rejects reuse of the same conversation identity across catalog owners or after
  deletion. Exact deletion retries retain the original idempotent result.

The built-in OpenAI provider now binds continuation records to the conversation.
Custom providers can use `continuation.forConversation(conversationId)` or the
optional `conversationId` constructor setting. A bound reader rejects records
with absent/different binding; it never guesses ownership from request text.
Older unbound records need deliberate cleanup or explicit migration before an
upgrade that must preserve their replay behavior.

Built-in OpenAI chat, generated titles and dictation also bind their durable
provider operations to the conversation. Custom integrations must use
`PostgresProviderOperationStore.forConversation(conversationId)` (or the optional
fourth constructor argument) for these operations to participate in deletion.
The operation identity remains claimed after its response is purged: replay
throws `PostgresProviderOperationDeletedError` without parsing a result or
dispatching the provider again. A changed fingerprint still conflicts. A started
or uncertain operation prevents deletion; an expired lease or request timeout is
not evidence that the external work ended. Transcription requests that race
deletion receive the same safe unavailable-conversation response as a missing
catalog entry. Usage evidence remains intact.

Catalog mutation retries after deletion return `not_found`; changed requests
using an existing key still conflict. The permanent-delete receipt remains
replayable and contains only the conversation identity and deleted version.
Other idempotency domains, including business actions, are left intact.

`deletedVersion` identifies the removed descriptor and equals the accepted
`expectedVersion`; permanent deletion does not create a new catalog descriptor.
PostgreSQL already follows this contract. A newly qualified local correction
makes the in-memory catalog match it; that correction is not part of public
`5a0ebe5`. Flutter's new reviewed-deletion helper validates the exact receipt and
retains an unresolved request rather than accepting an older in-memory response
that increments the version. See the declared Flutter SDK's
`docs/conversation-deletion.md` for journal/restart/UI behavior and adoption limits.

`deletePostgresConversationHistory` is also exported for a retained host catalog.
Its authorization callback is mandatory. It is only the history/sealing portion;
compose it with catalog and file cleanup in the same SQL transaction. It does
not turn an application-specific catalog into the default SDK catalog.

Hosts with separately partitioned voice state must include that partition in the
same authorized deletion transaction. The host cleanup hook now receives the
trusted authorization context so it can recheck permission when composing a
second `deletePostgresConversationHistory` call. Never persist or log that context.
Mills uses this to seal both its household text partition and the existing
`mills-realtime:<environment>` voice partition; no call identities are migrated
or guessed. Either both commit or both roll back.

`PostgresRealtimeToolActivityStore.record` and `markRead` now re-read their call
under the same conversation lock used by deletion. This prevents a stale active
call read from admitting activity after hangup/deletion, and prevents late read
acknowledgements from recreating removed presentation state. Finishing an already
started tool after hangup remains allowed before deletion. These display checks
supplement business execution/approval ledgers; a display status never substitutes
for resolving an uncertain external business outcome.

## Deliberately retained and still outstanding

Deletion does not blindly remove approval/business audit, tool effects,
provider-operation receipts, usage delivery/admission, audio usage evidence,
ended voice-call receipts, or catalog idempotency results. New conversation-bound
provider receipts lose their result content during deletion. Older unbound
provider/continuation records, content in other retained evidence and host-owned
external media still need explicit handling. Never infer record ownership from
the result text. This change is not a claim of complete erasure of every
chat-derived record or completion of the broader cleanup goal.

Mills' local source now composes this catalog with its retained ownership/media
tables, live session authorization, business review and file ownership. It adds
archive/restore and a durable external-file cleanup worker, qualified against the
installed public JS pin. Host deployment and live qualification remain open.
Mills' shared mobile source candidate is separate from installed Flutter adoption.
Turn 33 replaces its host transcription route with the installed SDK route;
web and both mobile sources submit conversation ID, duration and stable capture
identity. New completed dictated text is removed with its conversation, while
unfinished provider claims still block deletion and usage evidence survives.
Old unbound `mills-transcriptions` records require separately approved inventory
and cleanup; source adoption does not identify or erase them. Clear is now advertised only when
the catalog has a `clearContents` implementation. Without one, it reports
`supported: false, reason: "not_implemented"` and refuses the mutation after
authorization instead of falsely returning `cleared`. A reusable shared content
reset would need its own contract for active writers and stale clients; it is
currently unsupported. Permanent deletion must not be presented as reusable clear.

Before rollout, drain old workers that do not honor the deletion fence and settle
active work. No startup purge or database migration performs the disposable-data
cutover. Production writes require native Handrail database approval. A source
release alone does not remove existing legacy tables, chats, imports or files.

## Aegis custom provider binding

The September 14 turn 32 host correction uses the existing public `forConversation`
APIs for Aegis' retained provider invocations and continuation reads/writes,
including expense-receipt continuation reads. Tenant/owner scopes, operation IDs
and request fingerprints are unchanged. The binding is resolved from the
server's asynchronous execution context, not a caller-provided request field.
New completed response copies therefore participate in SDK deletion; unfinished
claims block it. Another conversation's content, usage and business ledgers remain.

This does not retroactively bind unbound old records. A recovery that encounters
an unbound or mismatched provider receipt fails closed without changing its key,
adopting the record or dispatching work. Drain old workers and settle these cases
explicitly during the approved cutover. Installed-SDK host integration fixtures
prove new content cleanup and existing receipt preservation; the host correction
still requires an authorized release. No production content was deleted.

## External file cleanup

`enqueuePostgresConversationFileCleanup` records a job inside the authorized
deletion transaction after the SDK conversation fence exists. The host must
first detach every reference and establish that the object is exclusively chat
owned. Shared/business objects must remain. Keys must be immutable and never
reused, including after deletion. No remote effect happens before SQL commits.
Jobs use the existing SDK documents table and a trusted service partition,
separate from per-user authorization scopes.

`drainPostgresConversationFileCleanup` processes a bounded batch. It validates
the stored fingerprint and calls the host's required `parseTarget(value,
tenantId)` policy before dispatch. That policy must validate tenant, deployment
bucket and canonical key; a JSON target is not authority by itself. Invalid
targets are blocked for explicit diagnosis. Row locks with `SKIP LOCKED`
serialize workers. Failures and timeouts remain durable with bounded backoff,
and dispatch receives an abort signal. Raw provider errors are not saved.

The host's `deleteFile` must be idempotent. A lost remote acknowledgement or SQL
commit may repeat the same immutable-key delete; this queue must never execute
financial/business effects. After success its minimal receipt drops the target
and conversation ID. Pending/blocked records retain the target needed to finish
cleanup. Do not purge them while bytes remain uncertain.

`startPostgresConversationFileCleanupWorker` supplies startup/flush/stop helpers,
joins overlapping flushes and waits for the bounded current batch on shutdown.
Its default batch size is one with a 15-second dispatch deadline. Hosts retain
provider configuration and safe diagnostics. Starting the worker drains only
previously authorized jobs; it does not scan or purge old conversations.

Mills now uses its authenticated PUT endpoint without creating unused signed
storage URLs. A conversation-bound provider-operation receipt is committed
before a PUT is dispatched. Deletion refuses started/uncertain writes, and
late uploads cannot recreate a sealed conversation's objects. Old workers and
any previously issued signed URLs remain cutover dependencies: fence/drain them
and establish outcomes before declaring old object removal final.

## Retained-file staging expiry (unpublished source)

The shared retained-file adapter now commits staging admission atomically with
its new blob. Materialization commits the saved copy, upload consumption and
`retainedConversationId` binding in one transaction. Deletion removes both saved
and bound staging metadata under the same conversation fence, collecting only
unreferenced SDK blob keys. The original provider/business/usage receipts remain
subject to the safety rules above.

`cleanupPostgresConversationFileStaging` and
`startPostgresConversationFileStagingCleanupWorker` collect expired temporary
uploads carrying the new versioned retention policy. The trusted service
partition and optional tenant bound the scan. They do not sweep on startup,
adopt old rows, expire saved copies, delete shared references or call external
storage. Use one worker per service and await shutdown before closing SQL.
Malformed marked rows are reported blocked for review and remain untouched.
See [retained-file setup](trusted-history-and-attachments.md#retained-conversation-files).

These source corrections are newer than public `5a0ebe5` and are not yet installed
in Aegis. Its future adoption must include the worker lifecycle. Previously
unmarked uploads/imported copies still require the approved cutover; there is no
migration or automatic purge of those records.

## Qualification

`test/postgres-conversation-deletion.integration.test.ts` uses an isolated PGlite
SQL database with real commit/rollback. It checks scoped removal, retained
receipts, deletion replay, active text/voice refusal, pending approval refusal,
revoked authorization rollback, ownership/version rejection, late writes,
shared/exclusive bytes, bound continuation cleanup and failed host callbacks.
It also checks provider-result removal, cross-conversation/tenant isolation,
unfinished/uncertain provider refusal, restart/replay safety and rollback of
purged receipts; catalog response removal and refusal to replay a deleted
descriptor; and preservation of unrelated business receipts. Native title and
transcription tests verify that the built-in
adapters bind their receipts and remove generated/dictated text; the transcription
case retains usage evidence and exercises a request racing deletion.
PGlite checks do not prove concurrency. The separate
`scripts/check-postgres-catalog-concurrency.mjs` fixture now checks native
PostgreSQL with independent connections: competing owner/storage claims,
deletion versus a late append, pending-turn admission versus deletion, and
competing expected-version renames. It creates and removes its own empty
cluster and accepts no existing database connection. This local evidence does
not establish deployed worker/provider/voice behavior; rollout qualification
still must drain old workers and exercise the actual runtime.

The external-file suite additionally checks transaction rollback, immutable job
identity, service/tenant separation, provider failure and lost acknowledgements,
SQL rollback after remote deletion, target validation, timeout/abort, worker
joining and shutdown. Native PostgreSQL checks also prove postcommit visibility,
competing worker serialization and upload admission versus deletion. These use
fake remote storage; they do not establish production bucket deletion.

See [the goal progress record](assistant-cleanup-goal-progress.md) for exact
validation runs and log locations. These tests establish local source behavior;
they do not qualify real provider execution or deployed consumers.

The retained-file suite also checks failed staging/consumption rollback, linked
metadata removal, idle expiry after restart, concurrent sweep deduplication,
malformed-target refusal and preservation of shared references/other tenants.
The native `check-postgres-conversation-files.mjs` fixture verifies competing
materializations, expiry discovery racing consumption, expiry locking before
retention, deletion fencing late retention, and deletion waiting for retention to commit. Its real postgres.js check caught
and now protects the infinite-expiry encoding needed for saved files.
