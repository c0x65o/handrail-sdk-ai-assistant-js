# Exact execution admission verification — 2026-09-15

Scope: JavaScript SDK only. Base checkout:
`a36d5dfa28600324b8a47200ef5e87e7d8b0d9ee` (newer than the reported ERP pin).
Owner Goal `78ef936e-bf4b-4926-8dce-49904c8c0047`, task
`affc30b6-98d3-43a7-a895-3f5d407200bb`, item
`ee8f9c67-ac58-4e7b-9c67-f20954047ce8`.

## Result and files

The SDK offers current, per-attempt `toolAdmission` before ledger reads,
durable receipt reuse, in-flight joins, or approval claims. Denials return a
generic error without retaining it or altering the original receipt. Admission
is opt-in; consumer wiring is required. See the
[consumer contract and ERP adoption instructions](../../tool-execution-admission.md).

Task-owned changes:

- `src/tools/executor.ts`: admission type, bounded fail-closed check before shortcuts.
- `src/server/application.ts`, `src/server/assistant.ts`: supported option forwarding and type exports.
- `test/tool-admission.test.ts`: fast receipts/in-flight operations, cancellation,
  timeout, exceptions, invalid admission output, identity conflicts and argument isolation.
- `test/tool-admission.integration.test.ts`: real application recreation and Postgres
  ledger, both reported permissions, stale/refreshed discovery, revoked/missing/
  mismatched principals, namespace access, permitted replay, tenant/scope isolation,
  unchanged receipts and SQL domain writes, uncertain completion and denied new keys.
- `test/server-tool-admission.integration.test.ts`: real gateway HTTP handlers,
  authenticated recovery, deterministic provider fixture, exact keys, authorized
  completed-turn/history retrieval, denied conversation history and diagnostics.
- `test/approval-execution.test.ts`: admission does not grant confirmation, claim
  a denied proposal, alter executed approval state, or redispatch approved receipts.
- `README.md`, `docs/tool-execution-admission.md`, this directory: integration and evidence.

Unrelated attachment/composer/saved-conversation changes appeared during this run
and were preserved, including an additional export at the end of
`src/server/assistant.ts`. They are not part of this authorization repair.
No version bump, commit, push, PR, deployment, ERP edit, or queue/database mutation
was performed by this worker. SQL writes below are confined to disposable tests.

## Failing before

The initial direct regression failed with `is_error: false` after revocation.
For retained evidence, the three changed implementation files were temporarily
replaced with their unmodified `git show HEAD:<path>` contents; regression files
were kept, then implementation changes were restored in a `finally` block.
The new option is inert on that original implementation.

```sh
npx vitest run test/tool-admission.integration.test.ts test/server-tool-admission.integration.test.ts --testNamePattern='rechecks|allowed=false' --maxWorkers=1 --minWorkers=1
```

Exit 1: **3 failed, 1 skipped**. Both `finance.period-close.prepare` and
`finance.manage` exact-key denials received success. The authenticated HTTP
recovery case also recorded success when it should have recorded denial.
See [before.log](before.log). This is reproduction against actual source,
not a mock ledger or a simulated authorization implementation.

## Passing after

```sh
npx vitest run test/tool-admission.test.ts test/tool-admission.integration.test.ts test/server-tool-admission.integration.test.ts test/tool-executor.test.ts test/approval-execution.test.ts test/application-assembly.test.ts test/application-gateway.test.ts test/application-gateway-synchronization.test.ts test/server-assistant.test.ts test/server-assistant-recovery-authorization.test.ts test/server-assistant-worker-ownership.test.ts test/server-approval-pause.integration.test.ts test/postgres-tool-ledger.test.ts test/postgres-tool-ledger.integration.test.ts test/postgres-durable-recovery.integration.test.ts test/server-provider-replay.test.ts test/tool-recovery.test.ts --maxWorkers=1 --minWorkers=1
```

Exit 0: **117 passed in 17 files**. See [after.log](after.log).
After adding an explicit host-diagnostic assertion for the existing history
error mapping, the HTTP tests passed again:

```sh
npx vitest run test/server-tool-admission.integration.test.ts --maxWorkers=1 --minWorkers=1
```

Exit 0: **2 passed**. See [http-diagnostics.log](http-diagnostics.log).

```sh
npm run typecheck
```

Exit 0; repository TypeScript check includes new test and public option types.
See [typecheck.log](typecheck.log).

```sh
npm run check:package-contract
```

Exit 0: `npm run build` succeeded, then **31 package-contract checks passed**,
including compiled entry-point imports and package contents. See
[package-contract.log](package-contract.log).

```sh
npx eslint src/tools/executor.ts src/server/application.ts src/server/assistant.ts test/tool-admission.test.ts test/tool-admission.integration.test.ts test/server-tool-admission.integration.test.ts test/approval-execution.test.ts
git diff --check
```

Both exit 0. Scoped lint has no findings; see [lint.log](lint.log).
All expensive checks ran sequentially with one Vitest worker. The complete
repository test suite was not run; the executor, application, gateway, durable
persistence, provider replay, recovery and approval suites above cover this repair.

## HTTP reachability and persistence evidence

The local provider boundary uses `openaiResponses` with an injected deterministic
stream, emitting `first-reopen`. No network provider, API key or persistent
service is used. The fixture runs the actual `createHandrailAssistant.handle`
Fetch HTTP gateway under `/api/cents/sdk`, backed by `postgresFromClient`,
`PostgresAiPersistence`, `PostgresToolExecutionLedger`, the native tool runtime,
conversation events, and the durable turn store.

A real `createAiApplication` first commits a successful domain write and receipt.
The fixture retains a pending turn and canonical admission events representing
the crash window after receipt commit but before turn/result projection. Its
exact execution key matches the native runtime's SHA-256 of scope, conversation,
turn and call ID. The newly assembled assistant has no prior application or
execution promise. An unauthenticated capabilities request is denied with 403
and never opens the provider. An authenticated GET creates the transport,
recovers the pending turn, and executes the provider's exact tool call.

Before the change, this HTTP-reachable retry exposes the success again. With
admission, a revoked caller gets an error in the canonical result and the
provider continuation contains no protected receipt. A permitted caller gets
the receipt, with one SQL domain row and one unchanged receipt in either case.
A repeated completed `/turns/start` reads retained events and opens no provider
or tool admission. `/synchronization` can read saved success after mutation
permission loss when conversation access remains authorized.

Source trace:

- `src/transports/application-gateway.ts`: authenticates before transport resolution;
  start/resume routes can create a transport, capabilities resolves one directly.
- `src/server/assistant.ts`: `transportFor` performs authenticated-context recovery;
  `authorizeRecovery` and native `authorizeLocation` check conversation access.
- `src/transports/durable.ts`: nonterminal recovery/start/resume can restart the
  delegate; completed starts/resumes only observe stored events. Approval resumes
  retain the original turn and increment the fenced attempt.
- `src/server/assistant-tool-runtime.ts`: derives scoped exact keys and calls
  `application.executeTool`; approved continuation also calls that boundary.
- `src/tools/executor.ts`: admission precedes `ledger.get`, `#operations`,
  policy/approval execution, approval receipt reuse and `ledger.getOrCreate`.
- `src/postgres/index.ts`: this checkout's Postgres ledger has no `get` method;
  its durable `getOrCreate` returns an existing result without calling the domain
  executor. Thus repairing only the optional fast read would be insufficient.
- `/approvals/transition` authorizes decision state and resumes confirmed work;
  decision/history receipts are distinct from tool execution authorization.

## Limits and unrelated findings

- Uses the repository's existing **PGlite 0.5.4** pattern: PostgreSQL SQL,
  migrations, real transactions, JSON serialization, fingerprints, claims and
  receipt tables. No hand-written database fake, live server, or external
  multi-process Postgres concurrency test was used. Application recreation is
  exercised over the retained SQL database; an OS crash itself is fixture-seeded.
- These Fetch-handler tests prove SDK HTTP reachability, not ERP cookie middleware
  or deployed runtime behavior. ERP still requires pinned adoption, native
  admission wiring and fresh consumer verification (including `first-reopen`).
- Admission checks current rights at attempt entry. It does not revoke work
  already admitted or retract content already stored in authorized history.
  Keep transactional/domain checks and independent conversation access rules.
- A pre-existing history response mapping converts a thrown catalog `forbidden`
  error into HTTP 503 `unavailable`. The fixture verifies the host diagnostic
  cause and absence of protected content. This mapping is unchanged and is a
  separate follow-up, not a failure of execution admission.
- `handrail_current_context` was absent from available tools. A required log
  diagnostic lookup returned an ERP-scoped stopped service with no log lines,
  not evidence about this SDK-only in-process fixture. The fixture's own host
  diagnostics establish the history error cause. No runtime action was taken.
