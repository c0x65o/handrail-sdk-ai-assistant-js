# Retaining a host ownership table

Published in public JS SDK revision `5a0ebe520a9e6fde0b3a792f959a7a10e0a3de50`
(0.2.36). Mills' local checkout now installs this revision through public HTTPS
Git with a matching lock. This does not establish deployment or production cleanup.

New applications should use the default `postgresFromClient(...).forScope(...)`
catalog and SDK migrations. An existing application may need to retain a small
conversation ownership table because trusted authorization or business-file
foreign keys reference it. `PostgresConversationCatalog` can map its generic
catalog operations onto that table without a second catalog implementation.

## Storage contract

Supply trusted server configuration in the catalog's `table` option. For Mills'
ownership layout the mapping is:

```ts
const table = {
  name: "assistant_conversations",
  columns: {
    tenantId: "household_id",
    scopeId: "created_by_user_id",
    conversationId: "id",
  },
  deletedAtColumn: "deleted_at",
  identityFormat: "uuid",
  includeEventActivity: true,
} as const;
```

`schema` is optional. Unmapped columns keep their SDK names: `lifecycle`, `title`,
`created_at`, `updated_at`, `archived_at`, `version` and `metadata`. Identifiers
are validated and quoted; configuration cannot contain SQL expressions or come
from request data. Mapped columns must be distinct. Additional host columns need
defaults or nullability so the SDK can insert without app-specific SQL.

The host supplies its own additive migration for missing mapped columns. The
SDK does not alter arbitrary ownership tables. Keep foreign keys and ownership
constraints. Require a unique conversation identity within each tenant, positive
numeric versions, JSON object metadata, `active`/`archived` lifecycle, valid
timestamps, and an archive timestamp exactly when archived. The optional soft
deletion column hides retired rows without permitting identity reuse. A title
column may be nullable; a host requiring nonempty titles can use `prepareTitle`.

For UUID ownership columns, configure `identityFormat: "uuid"` and provide
canonical lowercase UUID tenant, owner and conversation IDs. PostgreSQL accepts
alternate spellings of UUIDs while SDK history keys are case-sensitive strings;
the catalog rejects those aliases instead of creating two histories for one row.
The default opaque format is for exact, case-sensitive text identity columns.

`includeEventActivity: true` makes get/list `updatedAt` and updated ordering use
the greater of the catalog timestamp and the latest SDK event's database write
time. It filters by both tenant and conversation and never trusts an event's
client-supplied `occurred_at`. Catalog versions still change only on catalog
mutations. This read policy does not change the ownership/storage claim.
Keyset sorting and comparisons use millisecond precision, matching the wire
cursor even when the database stores microseconds. This prevents repeated or
skipped rows at timestamp ties.

Catalog `scopeId(context)` must match the retained ownership column. Mills'
catalog owner is the authenticated user UUID; other SDK stores may retain their
existing household/user compound scope. Both belong to the trusted server auth
adapter. Never use a client-supplied owner or household as authenticated context.

## Domain hooks, shared behavior

The catalog owns pagination, create, get, rename, archive, restore, version
checks, idempotency and permanent deletion. It does not introduce a host route
set: supply it to the assistant gateway's `conversationCatalogFor` seam so the
existing SDK catalog routes and negotiated capabilities remain authoritative.
Clear still requires the safe content-reset callback described in
[conversation deletion](conversation-deletion.md).

`prepareTitle(title, authorizationContext, action)` is an optional synchronous
domain policy for create/rename, after authorization. It can redact identifiers
or supply a nonempty default. The SDK validates the resulting title and uses it
in the durable request fingerprint. Keep this policy deterministic and stable
across request retries; it must not call a provider or write external state.

`onMutation` supplies the transaction client, trusted authorization context,
tenant/owner/conversation IDs, action, idempotency key and previous/new versions.
Use its transaction client for required host audit records or updating host-only
attribution columns. It runs once per committed mutation and is skipped on an
idempotent replay. A hook failure or precommit authorization rejection rolls back
the catalog, SDK receipt and audit together. Do not persist the authentication
context, raw credentials or transcript text in audit records. Do not perform
network effects inside this callback.

`onRead` preserves domain audit for successful get/list operations. It receives
the SQL client and trusted scope, with a conversation ID only for get. Missing
identities are not reported as successful reads. Audit failure prevents returning
the descriptor/page, and the SDK rechecks authorization after the callback.
As with mutation audit, never persist credentials or transcript content.

`permanentlyDeleteContents` handles remaining host-only relationships before
the catalog row is removed. Enqueue external blob cleanup durably in that SQL
transaction, then process it after commit. SDK history, deletion fencing and SDK
attachment cleanup are already performed by the catalog. Preserve shared or
business files and required effect/usage receipts. Live or uncertain work blocks
deletion rather than being assumed finished.

## Identity safety and cutover

All SDK history remains tenant/conversation keyed, independent of catalog table.
New catalog creation claims a minimal `catalog_identity` document under that
identity while holding the shared conversation lock. A second mapped/native
catalog or different owner cannot acquire it. The claim contains only the owner
scope and a hash of storage configuration; no title or transcript. It survives
permanent deletion with the deletion fence. Catalog reads hide rows whose claim
belongs to another configured table or owner. Keyset filtering happens in SQL
before the page limit, so hidden rows do not break pagination.

Mapped catalogs include storage identity in idempotency fingerprints. Reusing a
key across different table mappings conflicts instead of returning a descriptor
from the old storage. Use one stable, explicitly configured table/schema/column
mapping per catalog. Changing its spelling or configuration is an intentional
cutover, not a cosmetic change.

Existing unclaimed rows in the configured table remain readable. A mapped
catalog also rejects an identity already present in the native catalog. It
cannot discover arbitrary unregistered host tables. Before adoption, inventory
older catalogs/imported copies and settle their identities through the approved
disposable-chat cutover; do not run two old/new writers over overlapping IDs.
This API neither imports old chats nor performs a startup data purge.

## Qualification and remaining adoption

`test/postgres-catalog-table.integration.test.ts` exercises real local PGlite
transactions, retained UUID ownership foreign keys, archive/restore, stable
pages, soft-deletion filtering, scope isolation, title policy, exactly-once audit,
mutation/deletion rollback, transcript removal, identity conflicts and alias
rejection. Existing default catalog, deletion and native-title tests also run.
The separate native PostgreSQL fixture qualifies seven cases with independent
connections and the postgres.js JSON contract. After the normal SDK build, run:

```sh
node scripts/check-postgres-catalog-concurrency.mjs /absolute/path/to/node_modules/postgres
```

It requires locally installed PostgreSQL tools (defaults to
`/usr/lib/postgresql/15/bin`, override with `SDK_POSTGRES_TEST_BIN`) and an existing
postgres.js test client. It creates its own temporary cluster, disables TCP,
uses synthetic data, and stops/removes the cluster in cleanup. It does not read
`DATABASE_URL` or accept a project database. No application SDK dependency or
lockfile is replaced by this fixture.

The native driver check found that serialized JSON parameters could be encoded
twice by postgres.js. The SDK now casts these parameters through `text` before
`jsonb` across its stores. Fresh writes/readback and effect replay work with a
plain transactional driver adapter, without host SQL rewriting or row decoding
repairs. Previously malformed stored values still require the planned approved
cutover; this is not a startup repair. Local checks do not establish deployed
worker, provider or browser behavior.

Mills' local candidate now supplies additive lifecycle columns, shared gateway
wiring, transactional domain hooks and durable external-file cleanup. These
have not been deployed. A tested public HTTPS Git SHA plus matching lockfile
must replace its installed SDK pin before ordinary consumer builds can use them.
Local source or a temporary test alias does not establish installed adoption.
The goal's explicit release restriction and native production database approval
remain applicable; no schema/data cutover is executed by this mapping.
