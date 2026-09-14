# Assistant cleanup goal progress

Goal: `06b47a97-7cd6-41b7-9040-6b88761094ce`.
Scope remains JS/React/server and Flutter SDKs plus Mills, Spartan/Aegis and
Hitcents/Cents web/mobile consumers. Overall completion is unproven.

## September 13 first autonomous continuation

Verified the native goal and durable Handrail goal are active. Current checkouts
show the earlier Mills legacy source removal is already present. Other work is
modifying shared React presentation and Mills UI concurrently; those edits were
preserved. This continuation focused on shared durable deletion.

Implemented the SQL history deletion fence, default catalog content cleanup,
SDK file cleanup, conversation-bound OpenAI continuation retention and focused
regressions. See [the exact deletion scope](conversation-deletion.md), including
what remains retained and why this is not a complete erasure claim.

Validation for this continuation: full SDK TypeScript check, scoped ESLint and
normal SDK build passed. The expanded run passed 73 tests across 13 files;
the final run passed 44 overlapping tests across four files, including all 17
new deletion SQL cases. Commands used Vitest with `--maxWorkers=1 --minWorkers=1`.
Logs: `/tmp/sdk-deletion-typecheck.log`, `/tmp/sdk-deletion-lint.log`,
`/tmp/sdk-deletion-expanded-tests.log`, `/tmp/sdk-deletion-final-tests.log` and
`/tmp/sdk-deletion-build.log`. This is SDK source qualification, not proof that
any deployed consumer has installed the changes.

## September 13 second autonomous continuation

Verified the native and durable Handrail goals remain active and kept the
objective's explicit release restriction. Project-scoped Coverage Q&A search for
human-answered assistant decisions returned no entries; no additional owner
requirement was inferred from that result.

Completed the next disposable-content retention step. OpenAI chat, title and
dictation provider operations now carry explicit conversation bindings. Deletion
blocks unfinished/uncertain provider work and converts completed responses to
minimal receipts. A restarted or stale request cannot parse deleted response
content or redispatch the provider. Dictation racing deletion gets a safe
unavailable-conversation response; audio usage evidence remains intact.

Catalog create/rename/clear/archive/restore receipts also contained duplicate
titles and metadata. Deletion now removes that content while retaining the keys
and fingerprints. Exact retries report `not_found`, changed requests conflict,
and permanent deletion remains idempotent. Business idempotency domains remain
unchanged. Transaction rollback restores the original catalog/provider results.

Also corrected the default catalog's false clear capability. Without a content
reset callback, clear is now explicitly unsupported and cannot report success
after merely updating a timestamp. The negotiated client/UI respects this
capability while retaining the other catalog actions. A shared safe content
reset remains outstanding; this capability correction does not implement it.

Final validation passed 82 tests in eight files, including 23 deletion SQL cases,
native title/transcription retention regressions and negotiated clear controls. Full SDK TypeScript,
scoped ESLint and normal build passed. Logs:
`/tmp/sdk-provider-retention-tests.log`,
`/tmp/sdk-provider-retention-typecheck.log`,
`/tmp/sdk-provider-retention-lint.log`,
`/tmp/sdk-provider-retention-build.log`. Vitest used one worker. PGlite is local
SQL qualification, not multi-instance PostgreSQL or real provider/audio evidence.

Corrected shared adoption guidance to include Mills' disposable-history decision
and the Flutter guide's stale instruction to preserve Mills reconciliation.
The Flutter adoption investigation also identifies a separate real-install
dependency constraint: Mills/Cents need a published compatible bug-reporter
revision before normal resolution with the tested Flutter assistant baseline.
That investigation and its pinned revisions require re-verification before any
adoption action. No dependency manifests/locks or release state changed here.

## Remaining acceptance work

1. Re-audit all registered consumers for old runtime/routes/schema/seed remnants.
   Earlier removal evidence is a starting point, not proof of current production
   state. Mills now has a qualified empty-database baseline; direct replay of its
   immutable historical chain still represents the old schema intentionally.
   Other consumers' fresh setup and existing production schemas remain to audit.
2. Finish retention of older unbound provider/continuation records and other
   chat-derived evidence without losing business dispatch/idempotency safety.
   Mills' source now uses the shared transaction and durable external-media
   cleanup; actual adoption/rollout remains. Seven native PostgreSQL concurrency
   cases are qualified locally; deployed runtime, provider and voice cases remain.
3. Finish adopting shared feature surfaces and consolidate generic mobile wiring.
   Mills' local catalog now supports archive/restore. Qualify all named features across Mills,
   Aegis and Cents against the actual installed SDK revisions. Preserve domain
   policies. The existing default clear operation also needs content-reset work.
4. Finish and qualify clean-install route/auth/persistence/migration setup,
   diagnostic and scaffold behavior across the remaining scope. Mills' baseline
   is locally qualified; this does not establish rollout or other hosts' setup.
5. Align JS/Flutter consumers through full public HTTPS Git SHAs and locks from
   the correct repositories. A local SDK build is not consumer installation.
   The persisted objective explicitly prohibits release actions; no release or
   production writes were performed in this continuation.
6. Replace stale shared/host guidance and run conformance, browser/mobile and
   deployed-runtime qualification. Do not infer live audio/provider behavior
   from unit/widget tests. Use declared authorized preview routes.

Prepare the coordinated production cutover and obtain the required native
interactive database approval before data removal. Do not mark the overall goal
complete while source, actual dependency adoption, runtime qualification or
production cleanup remains incomplete. This turn makes code/test progress; it
is not a blocked-audit turn.

## September 13 third autonomous continuation

Reverified both goals and the current source. The preceding retention turn made
code/test progress. This continuation addressed Mills' fresh database schema and
leftover attachment linkage; it also makes progress and is not a blocked audit.

Mills' normal migration command now installs a verified baseline only on empty
databases. The baseline preserves the business/native SDK schema from 99 original
migrations while omitting four retired chat tables, two enums, the old attachment
message column and message-specific triggers/functions. Installation atomically
records the original prefix and a separate baseline-origin receipt. Existing
schemas and prior migration rows remain untouched. New migrations continue
through ordinary Drizzle behavior. A non-mutating 0099 snapshot boundary prevents
future generation from reintroducing automatic destructive legacy cleanup.

Removed Mills' unused attachment message field/read and its obsolete modeled
constraint/index predicate. New attachment readiness uses the retained media and
canonical SDK authorization paths. The fresh schema retains file protection and
enforces immutable household/conversation/media ownership. Existing production
linkage/trigger removal is still an explicitly approved cutover step.

Qualification: 31 gateway tests passed against the actual fresh baseline; five
baseline tests passed for business schema parity, unchanged historical install,
future migration/replay, tamper rejection/rollback, non-empty refusal and current
snapshot alignment. Native PostgreSQL 15 CLI checks also passed on disposable
fresh/historical databases: fresh installation/repeat retained exactly 100 ledger
entries, while the historical public schema dump and original 99 ledger entries
were unchanged, with only the non-mutating boundary added. All scratch PostgreSQL
processes created for this work were stopped. No project database was used.
Full Mills TypeScript, scoped ESLint, normal server compilation, Drizzle ledger
checks and whitespace checks passed. Runtime-source searches found no remaining
references to the four retired tables or the old attachment message linkage.

See Mills `docs/fresh-database-baseline.md` for the contract, maintenance command,
cutover limits and log locations. This does not install the unpublished SDK
deletion candidate into Mills or complete consumer/runtime/production cleanup.

## September 13 fourth autonomous continuation

Reverified the active native/Handrail objectives and bounded working-project
access. Preserved unrelated presentation edits and the goal's explicit release
restriction. This continuation makes additional SDK source/test progress; it is
not a blocked-audit turn.

Added a trusted PostgreSQL catalog table mapping so retained business ownership
tables do not require another generic catalog implementation. It supports
canonical UUID ownership columns, keyset pages, archive/restore, the shared
permanent-delete transaction and soft-deletion filtering. Added deterministic
host title policy and a transactional audit hook. Failed audit/precommit auth
checks roll back ownership, history, deletion fence and durable receipts.

New catalog creation claims a minimal tenant/conversation ownership identity
across mapped/native catalogs. Conflicting table/owner claims cannot acquire or
read the same identity; SQL filters those claims before pagination limits.
Mapped storage identity participates in idempotency fingerprints. Retained
ownership claims contain no title/transcript. Older unregistered catalog copies
still require the coordinated disposable-chat cutover.

Native postgres.js qualification exposed double encoding of already serialized
JSON parameters, which Mills currently works around in host code. SDK-owned SQL
now casts those parameters through text before jsonb across persistence, catalog
and incident stores. A plain transactional postgres.js adapter now reads back
nested state and effect receipts and replays without redispatch or host rewriting.
Existing malformed rows are not rewritten by this source change.

Validation: full SDK TypeScript, scoped ESLint, normal build and 113 tests across
20 files passed with one Vitest worker. Eight new mapped-catalog SQL tests cover
lifecycle, pagination, ownership/FKs, audit rollback, history deletion, global
claims and canonical IDs. A standalone native PostgreSQL 15 fixture passed JSON
readback/effect replay plus five independent-connection concurrency cases:
competing owners, competing storage tables, deletion versus late append,
admission versus deletion, and competing expected-version renames. The fixture
observes actual database lock waits, accepts no project connection, and closes
its disposable cluster. An initial diagnostic attempt left a fixture after an
unhandled rejection; that exact owned cluster was stopped and removed, and the
fixture's failure cleanup was corrected before the final passing run. No project
SQL/storage writes or dependency/release actions occurred.

Logs: `/tmp/sdk-catalog-mapping-typecheck.log`,
`/tmp/sdk-catalog-mapping-lint.log`, `/tmp/sdk-catalog-mapping-build.log`,
`/tmp/sdk-catalog-mapping-final-tests.log` and
`/tmp/sdk-catalog-native-concurrency.log`. Reproduction and storage contracts are
in [postgres-catalog-mapping.md](postgres-catalog-mapping.md).

Next source work: Mills still uses its bespoke catalog adapter and installed old
SDK pin. Prepare its additive lifecycle/metadata columns, shared catalog gateway
wiring, minimal domain audit hooks and durable external-media cleanup. The new
SDK APIs require an eventually authorized public committed SHA and matching
consumer lock. No temporary alias or local source fixture establishes adoption.
Continue the remaining JS/Flutter consumer, generic feature, clean-install and
retention work from the full acceptance list. Native local SQL concurrency is
additional evidence, not deployed provider/audio/browser qualification.

## September 13 fifth autonomous continuation

Reverified the native goal, durable goal and bounded access at turn start.
The previous turn completed mapped-catalog and JSON/concurrency work and is
classified as progress. This turn also changes source and qualification evidence;
there is no blocked-audit streak.

Prepared Mills' retained-table adoption module in
`src/server/assistant/handrail-sdk-catalog.ts`. It delegates generic catalog
operations to the SDK and retains live-session/household/user checks, title
redaction, actor attribution and read/mutation audit. A required host file-cleanup
callback prevents silently omitting that integration. Additive migration 0100
provides lifecycle, archive timestamp, metadata, constraints and an owner index.
It preserves earlier migrations, business foreign keys and the fresh baseline;
it performs no legacy purge. A corresponding model snapshot/down script is
prepared, with no database deployment.

Added the SDK `onRead` audit hook, which runs only for a successful get/list,
checks access before returning data, and prevents a successful response if the
audit fails. This keeps Mills' read audit without another catalog implementation.
Full SDK typecheck, scoped lint, normal build and 13 focused tests passed.
Logs: `/tmp/sdk-catalog-read-audit-{typecheck,lint,build,tests}.log`.

Mills candidate qualification passed full TypeScript checking, server compilation
and nine tests (four catalog plus five baseline/schema cases). Scoped lint and
Drizzle checks passed. The helper uses explicit temporary source aliases, emits
server output only into its removable fixture directory, and verifies unchanged
package/lock hashes. It neither installs a local SDK dependency nor establishes
actual adoption. Logs: `/tmp/mills-sdk-catalog-candidate-check.log`,
`/tmp/mills-sdk-catalog-lint.log`, `/tmp/mills-sdk-catalog-drizzle-check.log`.

The ordinary installed-pin typecheck was also run and fails at the new `table`
option with consequent missing hook types. The current Mills pin does not contain
these APIs. This explicit unfinished build/adoption dependency is recorded at
`/tmp/mills-sdk-catalog-installed-typecheck.log`. No fallback, copied SDK runtime,
manifest substitution, commit or release hides it.

The new Mills module is still not connected to the production gateway; its file
callback test double proves composition only. Next, implement durable cleanup of
host attachment links and chat-only media, preserving every business/shared
reference and guarding in-flight/signed uploads. Then wire the factory through
the gateway, remove old generic catalog store methods/pagination, and qualify
actual gateway behavior against the candidate. Existing protected uploads use
Mills `ObjectStorage.deleteUploadObject`; saves to business documents copy to new
objects. Current metadata deletion leaves `media_objects`/remote bytes behind.
Any old signed upload intents or unresolved writes must be accounted for before
declaring remote deletion final. The broader JS/Flutter, consumer-install,
runtime and production cutover requirements remain intact.

## September 13 sixth autonomous continuation

Reverified native/durable goals and bounded access at turn start. Both remained
active with the exact full objective. The prior turn made source progress and
this turn also completed substantial source/qualification work; there is no
blocked-audit streak. No commit, push, PR, publication, deployment, project SQL
write or remote object mutation occurred. Concurrent UI changes were preserved.

Implemented the SDK's postcommit external-file queue and worker in
`src/postgres/conversation-file-cleanup.ts`. The enqueue operation requires the
sealed conversation inside the authorized SQL transaction. Jobs bind a trusted
service partition, tenant, immutable object and fingerprint. Draining validates
host ownership/deployment policy, serializes workers with row locks, retries
uncertain idempotent deletes with timeout/abort and backoff, and removes target
content from completed receipts. Invalid targets remain blocked for diagnosis.
The worker joins flushes and drains its bounded active batch on stop. It never
inventories/purges old chats at startup.

Mills now wires the shared catalog factory into its actual assistant gateway.
Removed the generic `handrail-conversation-catalog.ts` adapter and host list,
create, rename and catalog-only delete store methods. Retained domain ownership
reads, file/provider authorization and financial review integrations. The SDK
catalog now supports optional event-write activity and millisecond keyset
precision, preserving Mills' trusted recent-activity ordering without host
pagination. Client-supplied event timestamps cannot reorder the catalog.

Mills' deletion callback removes chat attachment links transactionally, retains
every shared/business/unrecognized media object, deletes only exclusively owned
canonical media rows, and queues their remote bytes. It scrubs disposable upload
and old catalog response copies but preserves request identities and business
receipts. Current assistant uploads no longer generate unused signed storage
URLs; authenticated PUTs durably record conversation-bound dispatch before
writing storage and hold ownership locks. Unknown write outcomes prevent both
redispatch and conversation deletion. Worker startup/shutdown is wired into the
application; safe diagnostics expose counts, not keys or provider details.

Qualification:
- Full SDK typecheck/build, scoped lint and 43 focused tests passed. Four further
  SQL pagination/activity cases brought the mapped-catalog suite to 13 cases;
  these and the four default catalog cases passed with a fresh typecheck/build.
- The owned PostgreSQL 15 fixture passed the native postgres.js JSON contract and
  seven independent-connection concurrency cases, including postcommit queue
  visibility, competing file workers, and upload dispatch versus deletion. It
  stopped/removed its disposable cluster; no project connection was accepted.
- Mills source-candidate typecheck/server compile and 88 tests passed: 34
  assistant, 34 real gateway, seven file/catalog, three gateway auth, five domain
  ownership and five baseline cases. Generic catalog client/archive/restore/
  reopen and mid-read reauthorization checks moved from permissive unit doubles
  into the real migrated gateway fixture. A final seven-case run exercised file
  deletion through the actual HTTP gateway; full candidate typecheck/compile and
  scoped lint passed again. Shared/business bytes remained in the fake store.
- The first broad candidate run exceeded 6 GB because it bypassed Mills' reusable
  database template. Its verified owned processes were stopped. The candidate
  runner now uses the established shared-fixture harness, and isolates file-owned
  and fresh-database tests in separate processes. Final checks use one worker.
- The ordinary installed-pin typecheck was rerun and **fails**: the old public
  SDK lacks the mapped catalog, cleanup exports and bound/deleted provider APIs.
  This is an explicit release/adoption build dependency. Manifests/locks stayed
  unchanged; temporary validation aliases are not installed-consumer evidence.

Logs: `/tmp/sdk-file-cleanup-typecheck-final.log`,
`/tmp/sdk-file-cleanup-expanded-tests.log`, `/tmp/sdk-catalog-activity-tests.log`,
`/tmp/sdk-catalog-activity-{typecheck,build}.log`,
`/tmp/sdk-file-cleanup-activity-{lint,native}-final.log`,
`/tmp/mills-sdk-catalog-wiring-check-v2.log`,
`/tmp/mills-file-cleanup-gateway-final.log`,
`/tmp/mills-file-cleanup-wiring-lint-final.log`,
`/tmp/mills-sdk-catalog-installed-typecheck-final.log`.

Next independent source work remains the full JS/Flutter consumer and generic
feature audit, safe reusable-conversation Clear/reset, and remaining chat-derived
retention. The seventh-turn section below supersedes the scaffold/setup status.
Revisit older unbound
records, unknown media and signed/old-worker upload exposure during coordinated
cutover; current queue completion is not proof those old bytes are gone. Public
committed SDK adoption, the declared Flutter dependency constraints, actual
provider/audio/browser checks, and approved production cleanup remain separate
requirements. The objective explicitly withholds release authorization, and
production SQL requires native interactive approval. Do not mark the goal
complete or claim 100% while those requirements remain.

## Seventh autonomous turn: clean setup and a new-history concurrency defect

The same full Handrail/native goal was reverified active; bounded goal access
remains working-project scoped. SDK Coverage Q&A search returned no human
answers. No release, SDK publication, project database or storage writes occurred.
Unrelated changes remain preserved. The original complete JS/Flutter and
Mills/Spartan/Hitcents scope has not been reduced.

### Setup source and actual public Git installation

- Replaced the three-file composition-only template with a complete typed
  React/Vite/Express host: manifest, build configuration, supported SDK imports,
  standard launcher, explicit SDK migration, environment doctor, safe structured
  diagnostics, host identity/CSRF seam, empty denied domain tools and pool/usage
  shutdown. Default auth returns `host_auth_not_configured`; no development login
  or trusted-header shortcut is shipped. Migration is explicit, never a startup
  purge. The host must still supply authenticated sessions and business policy.
- Scaffold resolves public Git HEAD once and writes a full SHA, or honors an
  explicit frozen 40-character revision. It refuses nonempty targets and does
  not install dependencies or mutate databases. npm/gitignore templates are
  packaged under ordinary filenames and copied as dotfiles so npm's package
  filters cannot silently drop their configuration.
- Real installation caught the old template's incorrect `openaiResponses`
  import and npm 10's HTTPS-to-SSH lock rewrite. The scaffold now requires a
  compatible Node and npm 12.0.2+ (pacote's HTTPS fix). It explicitly allows
  root Git dependencies and grants SDK compilation to the exact Git source/SHA
  in `allowScripts`; matching only the package name does not authorize a Git
  dependency's build in npm 12. esbuild has its own script permission. No global
  npm upgrade, SDK tarball installation, source alias or packaging step was used.
- Final unmodified generated fixture
  `/tmp/handrail-clean-scaffold-217786b0-7-final-source` resolved public commit
  `5d9387c1a07b4b131cbc65ce273a5d1f6faf035b`, version `0.2.35`. Both a fresh
  `npm install` and `npm ci` compiled the SDK normally; typed client/server and
  production build passed. Manifest, lock root and installed `resolved` match
  the exact public HTTPS SHA. Source adoption check passed. These receipts
  establish the scaffold source and installation/build, not unpublished feature
  adoption. The published CLI/template itself is still the old revision.
- Static adoption checks now reject a different/missing/non-Git resolved SHA,
  linked SDK nodes, conflicting dependency groups, nested legacy nodes and
  duplicate canonical SDK copies. Results explicitly say
  `static-source-and-lockfile-only` rather than claiming runtime parity.

### Runtime investigation and source correction

`scripts/check-scaffold-install.mjs` imports only the generated composition and
its installed public SDK. It accepts no database URL, creates its own native
PostgreSQL cluster, runs the generated migration twice, and exercises real
Express authentication, 401/403, user+tenant isolation, live permission changes,
new send/history, new server+pool+client reload, archive/restore and usage delivery
after a synthetic outage. Provider/auth/usage fixtures never enter product
source. Every invocation closes its clients/listeners/pools and removes the
owned cluster. It performs no real provider or audio work.

Some public-pin runs passed those checks, but others failed first send with an
internal error. **The public baseline is not considered fully runtime-qualified.**
Investigation found `PostgresConversationEventStore.read()` returning its event
page and head from separate statements in a READ COMMITTED transaction. A new
append between those statements can make replay report a false revision gap.
The native concurrency fixture now commits exactly in that interval and failed
before the fix (`latestRevision` 2 versus the page's 1). The source uses one SQL
statement/snapshot for page and head; the regression passes, and the subsequent
read sees the concurrent event. Empty/tail pages and numeric pagination are
covered too. This changes no production schema or data.

The public-pin fixture intentionally retains its checks; do not disable recovery,
add timing workarounds or alias a local SDK to call adoption complete. A committed
SDK containing the correction and a fresh installed runtime run remain a release
dependency. See [scaffold qualification](./scaffold-qualification.md).

### Validation receipts

- SDK full typecheck/build passed. The targeted SQL/history/title/deletion and
  public-adapter run passed 42/43 initially; the remaining assertion was an
  unrelated stale example/public-limit distinction and was corrected without
  changing runtime limits. Both Spartan adapter suites then passed (4 tests).
  Public adapter/package expectations now match the committed 150-call limit;
  the standalone historical example retains its separate 75-call setting.
- Native JSON contract plus eight PostgreSQL concurrency cases passed, including
  page/head, ownership, deletion fencing, admission, rename, external file jobs
  and upload exclusion. All disposable clusters were removed.
- CLI/package contract: 38 tests passed, including packed template assets and
  immutable dependency checks. Scoped SDK/template/script ESLint and whitespace
  checks passed before the final documentation-only updates.
- Clean final-source install, clean `ci`, typed compile/production build and
  exact-lock static adoption passed. No consumer repository manifest/lock was
  upgraded. Vite reports the standard assistant bundle above its default 500 KB
  warning threshold; this is not a runtime or mobile performance qualification.
- Mills full candidate typecheck/server compile and 41 selected real gateway/
  catalog/file cases passed against the updated SDK source. The runner verified
  unchanged manifest/lock hashes. It used one worker and the established shared
  database template, then an isolated file fixture. This is source qualification,
  not a replacement for the still-failing ordinary installed-pin build.
  Log: `/tmp/mills-event-page-candidate-check.log`.

Logs: `/tmp/sdk-clean-scaffold-final-source-{install,ci,check,adoption}.log`,
`/tmp/sdk-scaffold-package-tests-complete.log`,
`/tmp/sdk-spartan-adapter-tests-complete.log`,
`/tmp/sdk-event-page-{typecheck,build,tests}.log`,
`/tmp/sdk-event-page-concurrency-{before,after}.log`,
`/tmp/sdk-scaffold-event-page-lint-complete.log`. Earlier public runtime successes
and intermittent failures remain in `/tmp/sdk-clean-scaffold-runtime-v*.log`
and `/tmp/sdk-clean-scaffold-{repeat,diagnostic}-*.log`.

### Remaining full objective

Continue generic JS/Flutter behavior and registered-consumer audits, safe
reusable-conversation Clear/reset, older unbound chat-derived retention, remaining
host composition/doc contradictions and coordinated cutover preparation. Actual
public committed pins/locks, declared Flutter dependency adoption, authenticated
web/mobile/provider/audio qualification and approved production data/storage
cleanup are still required. Preserve business/auth behavior and audit, usage and
execution/idempotency evidence. Do not mark this goal complete or claim 100%.

## Eighth autonomous turn: voice deletion and delayed activity

Reverified the same native and Handrail objectives, both active, and current
bounded working-project access. Human-answered assistant Coverage Q&A search
returned no entries. No release, dependency-pin change, project database write
or storage write occurred. This turn makes source/test progress; it is not a
blocked-audit turn and does not narrow the full objective.

Three gaps were found and corrected in local source:

- Confirmed voice hangup did not establish that an already dispatched tool had
  finished. Deletion now validates every ended call and every associated tool
  partition, including later pages, and refuses running/unknown outcomes or
  unreadable termination evidence. Canonical business execution and approval
  checks still apply; display activity is not a business-outcome ledger.
- Voice activity previously read call state before writing without the deletion
  lock. `PostgresRealtimeCallStore.withConversationLock` now provides a storage
  transaction boundary, and activity/read-acknowledgement writes recheck the call
  beneath that lock. A stale active-call read cannot recreate activity after
  hangup/deletion. Existing tool completion after hangup remains possible before
  deletion. Call/tool outcome receipts remain; presentation read acknowledgements
  are removed. No external dispatch occurs inside this storage callback.
- Mills voice records use `mills-realtime:<environment>`, separate from household
  text history. Its shared catalog callback now receives trusted authorization
  context and seals both partitions in the same SQL transaction, rechecking the
  current session policy. Active voice or unfinished tools roll back text, catalog
  and file cleanup together. Existing environment namespaces/call identities are
  preserved. A release must drain old workers that do not honor these fences.

Validation: SDK full TypeScript, normal build, scoped ESLint and 42 tests passed
(26 deletion, three voice, 13 mapped-catalog cases). Native PostgreSQL JSON
qualification plus nine independent-connection cases passed. The new native
case pauses the initial active-call read, ends/deletes through another connection,
then verifies that the delayed activity writer is refused and no activity row
appears. The owned cluster was removed. Logs:
`/tmp/sdk-voice-deletion-{typecheck-final,tests-final,build,lint,native}.log`.

Mills full candidate typecheck/server compilation passed. The initial run passed
34 gateway and 34 assistant cases; its catalog run exposed test spy state shared
between cases. After isolating that spy, the final candidate run passed all eight
catalog and 18 native live-tool cases, including rollback while voice/tools remain
active, both deletion fences, retained call receipts and blocked late admission.
Scoped ESLint and whitespace checks passed. Logs:
`/tmp/mills-voice-deletion-candidate.log`,
`/tmp/mills-voice-deletion-candidate-final.log`,
`/tmp/mills-voice-deletion-lint-final.log`.
Candidate aliases remain source qualification only. Installed dependencies and
locks are unchanged; actual committed SDK adoption and live voice/provider/audio
qualification remain outstanding. No global inventory of other environment
voice partitions or physical production removal is established by these tests.

Continue the remaining full acceptance work listed above, including reusable
Clear/reset, older unbound chat-derived retention, JS/Flutter registered consumers,
generic behavior, documentation and coordinated cutover. Source progress does not
satisfy the pending publication/adoption, authorized runtime and production cleanup
requirements. Do not mark the goal complete or claim 100%.

### Eighth-turn mobile follow-up

Clear/reset investigation found a concrete Mills mobile mismatch. The "Clear
assistant" action actually performed permanent deletion and automatically
retried a newer catalog version after conflict. The UI/repository now explicitly
name deletion and capture the reviewed ID/version. A changed version reloads for
review and requires another confirmation. A dialog cannot authorize deletion
after account replacement or permission loss.

Confirmed deletion now evicts the target's local session/projection/workspace
entry and exact saved pending intent, even when the view cancels after dispatch
or the same conversation was reselected. A local deleted-identity set rejects
delayed reads and filters stale list results. Different selected conversations
remain intact. Lost/mismatched replies retain the existing retry/validation
contract. Backend durable fences and permission checks remain authoritative.

Mills mobile scoped Dart analysis passed for the two source and four affected
test files; 130 screen/route, repository, deletion and domain-review tests passed
with one worker. This run used actual installed public Flutter pin
`d574ea74d675666ebd4ea27f0fa0a13bae2a13df`, with no package aliases or manifest/lock
changes. Logs: `/tmp/mills-mobile-delete-analyze-final.log` and
`/tmp/mills-mobile-delete-tests-final.log`. The system `dart` launcher initially
refused its unrelated `/opt/flutter` Git ownership; using the declared Handrail
Flutter SDK executable worked without changing Git trust or global configuration.
The first analysis found new formatting/type-inference lints, corrected before
the final passing analysis. No preview, provider, audio or production data work
occurred.

The shared reusable Clear contract still retains the same catalog identity and
advances its version. Current JS/Dart write requests do not carry a content-reset
generation, so deleting history then reopening that identity can admit old-tab
or delayed work. Do not enable default Clear with the permanent-deletion helper,
silently substitute a newly allocated conversation ID, or call a timestamp-only
update a reset. A safe reset needs coordinated wire/client/persistence fencing.
The default remains explicitly unsupported pending that work.

The declared Flutter SDK has shared history/controller/workspace components,
but its account controller still lacks shared permanent-deletion orchestration;
Mills still has a substantial generic history/controller shell. Consolidating
those while preserving its domain review/files/voice is independent unfinished
source work. The full JS/Flutter/consumer, retention and rollout objective remains
active; this follow-up is additional progress, not a blocked-audit turn.
