# Assistant cleanup acceptance and cutover boundary

Goal `06b47a97-7cd6-41b7-9040-6b88761094ce`, September 14, 2026, turn 38.
This is the current acceptance inventory for Mills Family Office, Spartan/Aegis
and Hitcents/Cents, including their three registered main mobile consumers.
The detached Mills mobile worktree is a review artifact, not another deployment.
The JS SDK and its declared sibling Flutter SDK are the shared implementation.

The local changes are reviewable. Overall acceptance remains incomplete because
the corrected JS source has not been released/adopted, required live/native
checks are pending, and production removal has not been performed or verified
by this goal.
The Handrail and native goals are both marked blocked after three consecutive
audits confirmed the same release/adoption, live qualification and production
approval dependencies. Source qualification remains recorded below; blocked does
not mean complete.
This document performs no release, database write or remote storage operation.

## Acceptance inventory

| Criterion | Current source and qualification | Remaining application boundary |
| --- | --- | --- |
| 1. Retire legacy implementations | The three web hosts use `createHandrailAssistant`; web/mobile use the shared SDK workspace/controller. Source checks find no retired transcript importer, recovery marker or old chat-table reader in active host source. Old schema declarations, seed chat records, routes and host UI/runtime bridges are removed. Turn 36 also removes SDK staging aliases and the unused timeline migration callback. | Installed/running older revisions and existing production rows remain until coordinated release/cleanup. |
| 2. Safe deletion and retention | SDK deletion seals conversation identities and removes disposable history/checkpoints/state, bound provider response content, catalog response copies and owned file references. Active/uncertain work and necessary audit/usage/effect evidence block unsafe removal or remain retained. Mills delegates catalog deletion and atomically removes owned attachment links, with durable cleanup only for exclusive, recognized media. Turn 36 qualifies bounded expiry, shared-byte preservation, atomic consumption and minimal expired-upload receipts for both staging policies. | New JS retention corrections are unpublished. Old/unmarked uploads, imported SDK copies, retired tables and remote chat-only objects require approved production inventory/removal. Local fake remote storage does not prove bucket deletion. |
| 3. Shared web/mobile behavior | Catalog/new/select/reopen, titles/previews, archive/restore/unread, drafts/Send/Retry/Stop, approvals, uploads/downloads, citations/Copy/activity, dictation and shared voice lifecycle live in SDK components/adapters. Existing host suites and captures qualify the common controls and retained domain views. Canonical timeline/approval/focus and hidden-picker restoration pass the turn 36 UI checks. | Real provider/audio and native-device checks remain. Cents's installed visual aggregate passes, with a recorded test-font Greek-glyph limitation; this is not pixel parity. |
| 4. Easy setup and retired-schema baseline | The source CLI scaffolds auth, protected routes, persistence/migration seams, diagnostics and the standard UI. A fresh public-15a install, clean reinstall, typed/build gates and owned native PostgreSQL runtime fixture pass. Verified fresh baselines preserve the original migration ledgers: Mills through 0098 (99 entries), Cents through 0095 (96), Spartan through 0140 (141), then supported non-destructive follow-ups. | Host auth/provider configuration remains deliberately host-owned. The baselines apply to empty databases only; they are not production purge scripts. Source/template and host deployment still require release. |
| 5. Actual dependency adoption | All three web hosts and the Flutter gateway fixture normally install public JS `15a3806c2595a3f93a87a768ad13293113f41b58`. All main mobile hosts install both packages from the declared Flutter repository at `50fe566d73f68b2beacc2a874dc9a038363b1509`. Full HTTPS SHA pins and matching installed locks were qualified in turn 35. No temporary alias establishes adoption. | Public 15a lacks the terminal-dismissal, atomic ordinary-admission, retention and final legacy-callback corrections. A new public committed JS revision and matching consumer installs/locks are required. The goal explicitly withholds release authorization. |
| 6. Documentation and regression evidence | Current adoption, scaffold, deletion/retention, host and Flutter guides distinguish installed/source/production state. Historical consolidation documents are labeled. The adoption checker accepts both worker-stop methods. The normal install/build owns SDK compilation. | KB publication is not proven by a repository edit. Final deployed evidence must identify exact SDK/host revisions, migration state, runtime receipts and remaining exceptions. |

## Retained host responsibilities

Mills retains household/session authorization, its protected object-storage
contract, financial review and trusted citation/navigation projection. Its mobile
history projection reads one canonical SDK document to supply domain cards; it
does not merge a second transcript. Its recorder is an SDK alias and its voice
engine delegates to the shared Flutter session. Spartan retains company/session
policy, ERP result/citation formatting and financial review. Cents retains route
context, business-result cards and its prompt limit while leaving standard
composer controls available.

SDK durable-turn reconciliation, pending-effect recovery, old receipt decoding
needed to prevent redispatch, and valid versioned wire/checkpoint handling remain
part of execution safety. They are not retired host transcript importers.
Removing those safety boundaries would violate the agreed outcome.

## Evidence and its limits

Turn 36 passes 80 retention/server/persistence cases, twelve native PostgreSQL
transaction/race cases and a separate 31-case timeline/React/launcher run. Full SDK
TypeScript, scoped lint and normal build pass. Package/adoption contracts pass
39 cases. The fresh generated public-15a host passes normal npm 12 install and
clean `npm ci`, both typed/build gates, static adoption and a native synthetic
runtime fixture with one provider call and one usage receipt. Owned clusters,
clients, listeners and pools are closed and removed.

Turn 35 installed host evidence remains applicable to unchanged feature source:
Mills web 187 selected cases, Cents web 152, and Aegis web 113/114. Aegis's unchanged
terminal-dismissal assertion remains failing against public 15a; the source fix
must be adopted before treating that host gate as green. Main mobile analysis and
release web builds pass: Mills 312 selected cases, Aegis 179 and Cents 96. The
Flutter client suite passes 138 cases against its normal public JS gateway.
The turn 36 host shutdown edits pass Mills full TypeScript and Spartan/Cents
server TypeScript checks against unchanged public 15a.

See [the chronological receipts](assistant-cleanup-goal-progress.md),
[fresh scaffold qualification](scaffold-qualification.md),
[the retention contract](trusted-history-and-attachments.md), and
[deletion boundaries](conversation-deletion.md). These local tests do not establish
real provider execution, audio playback, native devices or production erasure.

## Coordinated cutover still required

Release the corrected public JS source only with explicit authorization, then
perform normal HTTPS/full-SHA consumer installs with matching locks. Preserve the
separately qualified Flutter pin unless a new reviewed change requires it. Run the
previously failing mounted Aegis assertion and required host regressions against
the actual installed correction. Release the prepared web/mobile application
changes together with supported migration wiring and a tested rollback boundary.

Before destructive cleanup, stop old-runtime admission, drain/fence old workers,
settle active text/voice/provider/business work, and account for outstanding
signed upload URLs. Do not enable an old runtime that can recreate removed state.
Use the host-specific `docs/chat-legacy-removal.md` cutover inventories:

| Project | Declared database resource | Retired data and storage scope |
| --- | --- | --- |
| Mills Family Office | `1685f6fb-eca6-4983-b4c8-1549f3341d40` (`mills-family-erp-v4-db`), project `37110a84-c42d-474e-8aeb-9297d9d8e125` | Four retired transcript tables, obsolete attachment message linkage/trigger state, disposable catalogs/imported SDK copies and unbound historical provider content. Preserve active conversation/attachment schemas. Exclusive chat media belongs to bucket resource `da618c31-fd5e-4f9d-a18a-4a6aa4056019`, `mills-mills-family-erp-v4-production`. |
| Spartan/Aegis | `8a75490a-5cc8-4976-92eb-67d54bd9fd0f`, project `fd1c7a13-8910-4571-956c-a71ae47e0625` | Five retired `spartan.aegis_*` tables, imported copies in `public.handrail_ai_*`, old unbound provider/continuation content and exclusive chat files. Preserve active ERP/file/review data and execution evidence. |
| Hitcents/Cents | `c3f29225-e941-4a4f-81c5-160acf322eca`, project `0f617308-8c3a-4ad4-83e7-34b1fda024b3` | Three retired `hitcents_erp_app.cents_*` tables, imported copies in that schema's SDK tables and exclusive chat files. Preserve business data and required audit/usage/effect receipts. |

Each production SQL write requires native interactive Handrail database approval.
Use authorized storage capabilities for remote objects. Reinspect dependencies and
ownership on the approved turn; do not blanket-truncate SDK tables, rewrite
applied migration history, add startup purges, or use a migration/task to bypass
the approval boundary. Verify exclusive bytes are absent and shared/business files
remain, then qualify new history/reload, deletion, uploads, approvals and usage.

The exact live preview receipts are Mills turn 37, Cents turn 35 and Spartan turn 28:
`preview_browser_access_denied`, `boundary=platform_blocker`,
`app_failure_reproduced=false`, outside this Dev Chat's saved scope. No browser
opened. These rejections block those routes; they do not establish that every
possible live route is unavailable. Required authenticated web/mobile,
provider/audio and native qualification remain explicit rollout gates.
