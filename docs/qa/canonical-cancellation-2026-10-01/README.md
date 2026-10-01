# Canonical cancellation source qualification

Observed on 2026-10-01 UTC for work request
`ea26c227-9bf6-57d4-804f-d2a1b8a350c9`. Destination: the shared AI gateway used by
Mills web and Flutter. This is an uncommitted source repair on JS `main`, based
on public AI 0.2.63 `79c1d5644845630b74d347874acb13b27ca7c873`. It does not publish,
install into Mills, deploy, or complete original outcome
`9fd48d7e-2e9d-49e7-976d-b852efe42b72`.
The [source manifest](source-manifest.json) records the base commit and hashes
of the uncommitted implementation, tests, dependency locks and adoption guide.

## Findings and repair

The mounted Mills cutover README, live client projection, ledger, provider
failure and cleanup evidence were read alongside its Agent/native provider,
composition, host and runtime tests. They establish a cancelled durable turn
and Agent job with an acknowledged Stop while a fresh display remained running.
This is distinct from the previously repaired delegate Stop delivery failure.

The installed public Agent checkpoint reader reconstructs stream frames; Mills
supplies the current context's attribution. Repeating the same start identity
after a session refresh reproduces strict duplicate-frame rejection, the live
projection diagnostic, and the stale running display on the published gateway.
The mounted evidence has no raw live stream frames, so this is a reproduced
mechanism, **not proof of the exact original live trigger**.

The source repair separates a durable cancellation acknowledgement from output
validation. It appends the canonical cancellation through revision CAS only
after checking current authority, the unchanged settled durable version, no
lease and valid canonical history. Invalid output remains rejected. Paged
history now detects stale nonterminal controls using scalar durable metadata
and retries the canonical reconciler, including in a fresh process after an
interrupted terminal write. No display status override or history rewrite is
used. The pre-start Stop fallback also rechecks conversation authorization.

See [mechanism and public adoption instructions](../../canonical-cancellation-projection.md).

## Qualification and retained results

| Check | Result and evidence |
| --- | --- |
| Published AI 0.2.63 gateway, current public Agent, real PostgreSQL | **Reproduced failure:** ordinary assertion sees `running`, expected `cancelled`, after durable/Agent cancellation. [Baseline](baseline.txt) intentionally exits 1. |
| Candidate gateway + real Agent/Runner/native approval/ledger/PostgreSQL | **5/5 pass:** quota failure then Stop; interrupted cancellation; completion; interrupted completion; unknown effect then Stop. Every case passes fresh JS and pinned Dart client/control reads. [Results](agent-postgres-clients.txt). |
| Original Stop delivery regressions | **3/3 pass:** original job identity, disconnected/fresh-process Stop, completed result preservation. [Results](agent-stop.txt). |
| Focused gateway/runtime/durable/reconciliation/authorization/PostgreSQL suite | **191 distinct tests pass across the initial run and focused recheck.** Initial run: 190 pass, one fixture missing its authorized catalog entry fails. That fixture now creates the conversation and asserts revoked access cannot mutate it; its 21-test file passes on recheck. [Initial results](focused-tests.txt), [recheck](canonical-start-recheck.txt). |
| Pre-start authorization investigation | Pre-fix real PostgreSQL fixture returned success to denied callers; retained [failure evidence](pre-fix-isolation.txt). Candidate cases reject another user, revoked rights and another conversation before any cancellation fact is saved. |
| Typed JS source | `npm run typecheck` and `npm run build` both exit 0. [Typecheck](typecheck.txt), [build](build.txt). |
| Scoped lint | Changed TS/MJS implementation and tests pass ESLint. [Output](lint.txt). |
| Pinned Dart fixture | Normal public Git install; `dart analyze --fatal-infos` passes and formatter reports zero changes. [Analysis](dart-analyze.txt), [format](dart-format.txt). |
| Dependencies | Manifest, npm lock, installed npm lock and deduplicated Agent AI resolution verified; Dart lock matches the public SHA and package path. [Pins](pin-validation.json), [installed tree](installed-pins.txt). |

The five integration cases use disposable PostgreSQL 15 with a non-superuser
fixture role and loopback HTTP. Only the model response/quota failure and
external business IO are simulated. Native approvals, effect reconciliation,
Agent/Runner, durable persistence, gateway, canonical/display projections and
client code are real. The changed-session start is deliberately conflicting;
completed cases use stable attribution. No live provider call, actual reminder,
notification, feedback submission or other external effect occurs.

Each approval/resume case retains exactly one synthetic effect. Two adapter
dispatch entries include the initial approval gate; they do not represent two
external mutations. Duplicate Stop preserves the saved identity. Canonical
prefix event IDs and payloads remain unchanged, revisions stay contiguous, and
the unknown effect receipt stays unknown. Interrupted cancellation and
completion recover through a separate gateway process whose provider start
and resume functions throw if invoked.

Additional focused regressions cover concurrent reconciliation, a lost
successful append reply, stale durable versions, competing/expired leases,
Stop racing approval/admission/completion, revoked authority, cross-user and
conversation isolation, missing completion evidence, partial failed output,
usage/citations, and ordinary controls avoiding durable bodies/canonical replay.
No protocol validation was relaxed. The original Stop publication was retained.

Expensive checks ran sequentially: Node integration concurrency 1; Vitest
minimum/maximum workers 1; TypeScript and ESLint heap cap 4096 MiB. Commands for
the real PostgreSQL fixtures are in the
[fixture README](../../../test/fixtures/agent-cancellation/README.md).

## Remaining owner workflow

1. Avery diagnoses its native commit-message service failure and publishes the
   versioned source through the native workflow. All work here is uncommitted;
   there is no repaired public SHA yet.
2. Install that exact public HTTPS full SHA into the original Mills composition
   with matching locks, retained Agent/Flutter pins and normal prepare/build.
   Inspect original frame attribution in its owning context if necessary; that
   evidence was unavailable in the mounted redacted artifacts.
3. Verify the **same retained** conversation
   `e49f8851-bc6b-47c1-ac8a-0a9412eaca51`, turn
   `turn_efb8c811-8fb4-452f-a0c2-c501927612a7`, through authorized history reads,
   without another Stop or manual rewrite. Native web/Flutter UI QA and full
   owner-goal acceptance remain open.

No Mills or Agent source was edited and neither runtime was accessed. The
linked Flutter checkout remains clean on its pre-existing
`fix/preview-composer-accessible-name` branch at
`94c44925d78e3b3479a8039597984be3b0f95ec6`; its startup branch-policy mismatch is
preserved for the owning workflow, not repaired by switching shared work. No
Flutter implementation change is indicated; qualification used the independently
installed requested public client pin. No Handrail/Mills database or queue
state, commits, pushes, PRs, deployments, credentials, accounts or roles were
changed; database writes were confined to the disposable local fixtures.
