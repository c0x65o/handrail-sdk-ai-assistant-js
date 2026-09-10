# Durable execution identity — SDK publication handoff

Validated 2026-09-10 UTC (2026-09-09 America/Chicago). Work request
`aae7d842-4a79-4019-acf1-c279c43b5de0`; parent
`f37d4e44-d799-4a64-b552-678b9930d806`.

## Repository and evidence boundary

Starting and final HEAD: `4e2d91d9535be8529289214817464e6bdcc650df`, branch
`main`, package `@handrail/ai-assistant@0.2.23`. `git status --porcelain=v2 --branch`
showed `+0 -0`; read-only `git ls-remote origin refs/heads/main` returned that same
SHA. No index lock, merge, rebase or unfinished Git operation was present. The
worker's deferred synchronization did not require repair. Existing uncommitted
work was preserved without reset, stash, commit or push.

`handrail_current_context` succeeded and confirmed this SDK work request. Spartan
is read-only contextual scope. Its checkout is not mounted; `/opt/handrail/repos`
contains only the Handrail checkout tree. Available source-read tools target the
active project or Handrail source, without a cross-project selector. The requested
Spartan files `docs/qa/usage-capture-f9ae2856/README.md` and `sdk-seams.txt` were
**not accessible or read**. Their text/path was requested while SDK work continued.
The qualification patch SHA-256
`480868d6adfacfd9affaa38b8a18a779427db4357c8644ad414cb8f2dbc59039` is supplied task
evidence, not independently verified here. Those qualification tests reproduce
defects; they are not assumed to implement fixes. Review of that source evidence
remains a handoff qualification item. This change is based on the supplied defect
description and directly inspected SDK code.

Prior child `5924027e-35ff-4b99-8713-c85e41133a0b` capability/archive work is
byte-for-byte preserved. Its saved patch still hashes to
`397d0ea8f96ce51e9a03098db9b02a63979b3d6ee21c10c9ebba4cc6e920c3e0`, all four files
match the previous [hardening manifest](../sdk-hardening-f37d4e44/README.md), and
`git apply --reverse --check` passes for that patch.

## Change and compatibility

The existing successfully claimed durable attempt is passed as a frozen
`{ conversationId, turnId, attempt }` snapshot in the optional second argument to
`ConversationTransport.startTurn`. `createApplicationTurnTransport` exposes a
frozen copy as `ApplicationTurnExecutionContext.durableExecution`. The persisted
attempt is one-based; the tuple is scoped to the configured turn store. No latest
record lookup is used for callback attribution.

Both canonical adapters and the activity adapter preserve the argument. The
high-level cancellation wrapper already preserves `startTurn`. HTTP adapters do
not serialize it. Standalone callers and one-argument delegates remain valid;
standalone application execution receives no durable identity. Durable execution
ignores caller-provided execution context and request/body identity fields.

No allocator, retry orchestrator, schema, HTTP field, package version, dependency,
approval or provider projection change was made. Stable logical turn, mutation
and idempotency keys remain intact. The full combined diff was inspected, including
prior pending changes. [unchanged.sha256](unchanged.sha256) records protected files
verified byte-identical to HEAD, including the gateway, provider adapter,
`src/tools/executor.ts` (`strict: false`), retry/receipt schemas, PostgreSQL adapter,
package manifest and lockfile.

[Compatibility and receipt guidance](../../durable-execution-identity.md) explains
forwarding custom server adapters, the identity namespace, physical retry versus
recovery ordinals, continuation attribution and normalized receipt v1 mapping.
Spartan's awaited per-physical-invocation capture, retry classification, unavailable
usage fields, and Mills integration verification remain parent-task follow-up.
No consumer, database, queue, deployment or publication was changed.

## Exact change identity

- [implementation.patch](implementation.patch): this task's six source files, three
  test files and compatibility document, excluding prior work and QA artifacts.
  SHA-256: `8c0b924637015b350971f446c5cde4061431a661f54b4f5c41d5acec5ffcbed4`.
- [combined.patch](combined.patch): all 14 changed implementation/test/guidance
  files against baseline, including the four preserved prior files, excluding QA
  artifact directories. SHA-256:
  `5280ce72399b8f96ba2a1e0fe9fb6caf14d23ec2d68790ed7c76313178bb3089`.
- [files.sha256](files.sha256): exact content SHA-256 for those 14 files.
  [git-blobs.txt](git-blobs.txt): their exact resulting Git blob SHA-1 values.

Patches were generated with `git diff --full-index --binary HEAD -- <tracked
paths>` followed by `git diff --no-index --full-index --binary -- /dev/null <new
path>` for each new file (the latter exits 1 for a valid difference). No index or
commit was created. Both patches pass `git apply --reverse --check` in this
workspace. The combined patch was also checked and applied to a separate pristine
`git archive HEAD` tree; all 14 resulting files are byte-identical to the reviewed
workspace. See [publication-check.log](publication-check.log). QA logs/manifests
are evidence accompanying the patch, not included recursively inside it.

## Verification commands and results

All expensive checks ran sequentially. Every Vitest invocation used one worker.
No external database service or provider network was used. The new takeover test
runs against the existing in-memory durable store and against
`PostgresDurableApplicationTurnStore` using the repo's PGlite pattern, real SDK
migrations, JSONB documents and transactional CAS. It verifies persisted claim
increments and callback identity through the actual store adapter. PGlite does
not establish multi-process/network PostgreSQL operational behavior; no external
PostgreSQL server or consumer integration was qualified.

1. `npm run build`: **exit 0**, SDK source and declarations compile using
   `tsconfig.build.json`. Generated declarations expose the optional seam on the
   existing entry points. [build.log](build.log).
2. `npm run typecheck`: **exit 0**, includes final source and tests using
   `tsconfig.json`. [typecheck.log](typecheck.log).
3. Combined focused verification: **234 passed / 23 files, exit 0**.
   Includes all 17 prior focused hardening regressions, canonical/recovery guards,
   provider tool loops, per-request approvals and standalone compatibility.
   [verification.log](verification.log).

   ```sh
   npx vitest run test/durable-execution-identity.test.ts test/durable-canonical-start.test.ts test/application-turn-transport.test.ts test/durable-application-transport.test.ts test/assistant-activity-transport.test.ts test/application-gateway.test.ts test/application-gateway-synchronization.test.ts test/retry.test.ts test/usage.test.ts test/server-assistant-catalog.test.tsx test/conversation-runtime-registry.test.ts test/server-assistant.test.ts test/server-assistant-context.test.ts test/runtime.test.ts test/client-bootstrap.test.ts test/conversation-workspace.test.ts test/react-conversation-picker.test.tsx test/react-conversation-picker-static.test.ts test/react-styled.test.tsx test/tool-executor.test.ts test/application-approval-wait.test.ts test/openai-responses-tools.test.ts test/openai-responses-tool-loop.integration.test.ts --maxWorkers=1 --minWorkers=1
   ```
4. `npx vitest run test/durable-execution-identity.test.ts --maxWorkers=1 --minWorkers=1`:
   **6 passed, exit 0**, rerun after a type-only mock declaration cleanup for lint.
   Covers initial/recovery identity, late old callback, frozen identity, stable
   logical inputs, active-lease recovery refusal, terminal start/resume/recovery,
   forged HTTP fields and standalone/durable cancellation/disconnect.
   [final-regressions.log](final-regressions.log).
5. Scoped lint: **exit 0**. [lint.log](lint.log).

   ```sh
   npx eslint src/transports/types.ts src/transports/durable.ts src/transports/application-turn.ts src/sync/durable-application-adapter.ts src/presence/assistant-activity.ts src/server/application.ts test/durable-execution-identity.test.ts test/durable-canonical-start.test.ts test/application-turn-transport.test.ts src/server/assistant.ts src/conversation/runtime-registry.ts test/server-assistant-catalog.test.tsx test/conversation-runtime-registry.test.ts
   ```
6. Negative control, with the new test copied into an isolated `git archive HEAD`
   tree and the existing `node_modules` linked: **4 failed, 2 passed, exit 1**.
   All four failures report missing durable execution identity; standalone
   compatibility checks pass. [baseline-regressions.log](baseline-regressions.log).

   ```sh
   npx vitest run test/durable-execution-identity.test.ts --root /opt/handrail/.handrail/codex-runs/e3aa47aa-5749-47e9-a6e1-b2741be30ff2/tmp/sdk-identity-baseline --maxWorkers=1 --minWorkers=1
   ```
7. `git diff --check`, reverse patch checks for both new patches and the prior
   hardening patch, `sha256sum -c docs/qa/durable-execution-aae7d842/files.sha256`
   and `sha256sum -c docs/qa/durable-execution-aae7d842/unchanged.sha256`:
   **exit 0**. Clean-tree combined patch application and content comparison:
   **passed**, as recorded above.

Initial intermediate results are retained: the first 37-test run had one failure
because a pre-existing exact spy assertion needed the new optional context;
[transport-tests-initial.log](transport-tests-initial.log). After adjustment,
[transport-tests.log](transport-tests.log) records **68/68 passing** before the
additional standalone cancellation case. Initial lint found two unused typed mock
parameters; the mock now uses a typed `vi.fn` declaration. The first baseline
setup encountered this worker's older Python `tarfile.extractall` API rejecting
`filter='data'`, followed by Vitest finding no files; extraction was corrected
with explicit path validation before the actual negative control. These are not
remaining failures. Reported resource peaks for failed test runs were 930–987 MiB
with PGlite, zero swap and zero OOM kills (the empty setup run used 104 MiB).

The prior hardening evidence records unrelated realtime UI and Spartan limit
package-contract expectation failures. Those unchanged checks were not rerun in
this scoped task and are not claimed fixed. No full-suite qualification is claimed.

## Git publication handoff (not executed)

The tested content is ready for SDK review, with the unavailable Spartan evidence
review explicitly pending. Public origin is
`https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git`. There is **no new
published commit SHA** yet; consumers pinned to baseline cannot receive this fix.
The combined patch is the reproducible publication candidate, including prior
capability/archive repairs. Do not publish only the new seam and accidentally
omit those pending fixes.

A separately authorized maintainer should first obtain/reconcile the named
Spartan evidence and inspect these patches. On this preserved workspace, verify
the manifest, reverse patch applicability and current upstream state, then stage
the 14 manifest files plus both QA evidence directories for the reviewed commit.
The paths can be staged explicitly as follows; none of these publication commands
were executed by this worker:

```sh
git add -- src/transports/types.ts src/transports/durable.ts src/transports/application-turn.ts src/sync/durable-application-adapter.ts src/presence/assistant-activity.ts src/server/application.ts src/server/assistant.ts src/conversation/runtime-registry.ts test/durable-execution-identity.test.ts test/durable-canonical-start.test.ts test/application-turn-transport.test.ts test/server-assistant-catalog.test.tsx test/conversation-runtime-registry.test.ts docs/durable-execution-identity.md docs/qa/durable-execution-aae7d842 docs/qa/sdk-hardening-f37d4e44
git diff --cached --check
git diff --cached --stat
git commit -m "Preserve durable execution identity and SDK capability/archive fixes"
```

Use the authorized normal Git review/push workflow to publish that commit to the
approved ref; do not force-push or discard intervening changes. If rebasing onto
new upstream content is necessary, rerun the scoped checks and regenerate hashes.
Record `git rev-parse HEAD` and verify the identical full SHA with `git ls-remote`
after publication. Give the Spartan follow-up that **published 40-character SHA**,
this compatibility guidance and test evidence. Its separately scoped consumer
upgrade must use the public HTTPS Git URL pinned to that full SHA and update the
matching package-manager lockfile. SDK compilation remains in the existing
`prepare`/normal install-build pipeline; no registry publication, tarball, branch
or tag dependency, separate packaging step, consumer upgrade or deployment is
part of this task.
