# Shared SDK hardening evidence — f37d4e44

Locally verified on 2026-09-09. Work request: `f37d4e44-d799-4a64-b552-678b9930d806`.
Baseline and final HEAD: `4e2d91d9535be8529289214817464e6bdcc650df`, package `@handrail/ai-assistant@0.2.23`.
The starting worktree was clean on `main`, matching `origin/main`; no merge, rebase, or index lock was present. The worker's deferred synchronization required no Git repair. Changes remain uncommitted and unstaged.

The supplied recovered audit evidence was `c288c55a-d150-4ca2-8f5c-aacefb8312a5`, task input `sdk-evidence-recovery:7380d527-2b63-478b-b820-3f71cc30eea7`. This work used the two reproduced defects described in the request and current SDK source. It did not restart the audit or require its unmounted files. Mills' unsupported catalog declaration is supplied reference evidence, not a consumer checkout verified in this run.

## Exact change identity

[implementation.patch](implementation.patch) contains only the two implementation files and two regression files, excluding this evidence directory. It is the full-index binary Git diff against HEAD for the three tracked files followed by the no-index diff from `/dev/null` for the new test. It can be reviewed or applied to the baseline with Git; there is no new commit SHA.

Patch SHA-256: `397d0ea8f96ce51e9a03098db9b02a63979b3d6ee21c10c9ebba4cc6e920c3e0`.

| File | Resulting Git blob SHA-1 | Resulting content SHA-256 |
| --- | --- | --- |
| `src/server/assistant.ts` | `a6e40f2f02514e90b3b917b2b73f1dc55e1e387a` | `dea5ace488f96ae3d0018608c2196192da86b8568592aea5c9b69b613707634d` |
| `src/conversation/runtime-registry.ts` | `7cc94a66ce7c223605693aa1a711c28a793e4740` | `9ae3cbfa871a26a160cca1c2dc6eecfd90e1cdb0a84b3ba0b8a222ff1d2a46c6` |
| `test/conversation-runtime-registry.test.ts` | `6573279c5c1031020ee72e05a874a2fcb6b24d84` | `efd02e948c133816975c63b9f2067b9f94bdd8b4e7ea74e2a7eef026f949b584` |
| `test/server-assistant-catalog.test.tsx` | `e86b658dec28c2126a3decf45ec9601189d3d16d` | `83181519dc45a63cb744292d8cb8ea802866e13276721abf47e1062ed69f13e9` |

## Behavior and compatibility

- `src/server/assistant.ts`: remove the all-supported catalog declaration. Compose a gateway per request, capture the context from the existing gateway authorizer, and resolve catalog capabilities only after authentication. Overlapping transport resolution cannot share another request's context. Fresh negotiation sees current host support and unsupported reasons even when the authenticated identity and cached transport are unchanged. Catalog mutations still delegate with the authorization context supplied by the gateway; a forged body context cannot replace it. SDK-owned Postgres and supported custom-host behavior are retained.
- `src/conversation/runtime-registry.ts`: retain a live runtime inside the archive lifecycle entry while the host operation is pending. Host rejection restores that same runtime; successful archive destroys it once and removes the entry. Concurrent opens, releases, and lifecycle mutations remain gated. Disposal destroys the retained runtime immediately; later host success or rejection cannot destroy it twice or resurrect it. Existing pending-construction invalidation, fresh construction, other lifecycle operations, and permanent-delete tombstones retain their behavior.
- Wire version, public exports, package version, dependency files, authorization policy, approval semantics, provider projection, and Flutter source/contracts are unchanged. The lower-level gateway and client adapters already propagate the capability object; no new wire field or public API was added.
- All five negotiated mutation flags and unsupported reasons are checked through `createHandrailAiClient`. The existing React picker lifecycle buttons are also rendered from those negotiated values and checked as disabled/enabled. The existing `ConversationPickerRenameForm` does not disable itself from the rename capability; that separate UI limitation is recorded, not changed by this bounded task. The corrected rename flag/reason is available to existing client/host capability handling.
- Existing clients need fresh negotiation to receive changed capability data. Capability discovery remains descriptive; host operation authorization is still authoritative.

Byte-for-byte unchanged relative to baseline: `src/transports/application-gateway.ts`, `src/server/openai-responses.ts`, `src/tools/executor.ts`, `src/adapters/spartan-aegis.ts`, `test/package-contract.test.mjs`, `package.json`, `package-lock.json`. This preserves the provider workaround and per-request approval path; no consumer workaround or legacy UI/data was removed.

## Regressions and verification

All expensive checks ran sequentially. Vitest used exactly one worker (`--maxWorkers=1 --minWorkers=1`). No dependencies or consumers were installed/upgraded.

1. **Failing before:** the final two regression files were copied into an isolated `git archive HEAD` source tree in the worker temporary directory, with the existing `node_modules` linked. Working source was never reverted. Command:
   ```sh
   npx vitest run test/server-assistant-catalog.test.tsx test/conversation-runtime-registry.test.ts --root /opt/handrail/.handrail/codex-runs/5286739c-5900-4991-96f2-a35730a908fd/tmp/sdk-hardening-baseline --maxWorkers=1 --minWorkers=1
   ```
   **5 failed, 12 passed (17 total), exit 1**, as expected. Failures: unsupported negotiation incorrectly reports all actions supported; archive unavailable/version conflict destroys the live runtime; both pending-archive disposal scenarios destroy it before host completion. [Raw baseline log](baseline-regressions.log).
2. **Passing after / relevant suites:**
   ```sh
   npx vitest run test/server-assistant-catalog.test.tsx test/server-assistant.test.ts test/server-assistant-context.test.ts test/application-gateway.test.ts test/application-gateway-synchronization.test.ts test/conversation-runtime-registry.test.ts test/runtime.test.ts test/client-bootstrap.test.ts test/conversation-workspace.test.ts test/react-conversation-picker.test.tsx test/react-conversation-picker-static.test.ts test/react-styled.test.tsx test/react-realtime-workspace.test.tsx test/tool-executor.test.ts --maxWorkers=1 --minWorkers=1
   ```
   **159 passed, 1 failed (160 total), exit 1**. All **17 focused regression tests passed**, including all five failures above. All **158 tests across the other 13 files passed**; the extra realtime UI file had one pass and one pre-existing failure. [Raw verification log](verification.log).
3. `npm run build`: **passed, exit 0**; compiles SDK source and declarations with `tsconfig.build.json` into ignored `dist/`.
4. `npm run typecheck`: **passed, exit 0**; checks SDK source plus tests with `tsconfig.json`. [Log](typecheck.log).
5. `npx eslint src/server/assistant.ts src/conversation/runtime-registry.ts test/server-assistant-catalog.test.tsx test/conversation-runtime-registry.test.ts`: **passed, exit 0**. [Log](lint.log).
6. `node --test test/package-contract.test.mjs`: **30 passed, 1 failed (31 total), exit 1**. All public ESM exports resolve. The unchanged Spartan limit expectation fails as detailed below. This existing check includes `npm pack --dry-run --json --ignore-scripts`; no package was created or published. [Log](package-contract.log).
7. `git diff --check` and `git apply --reverse --check docs/qa/sdk-hardening-f37d4e44/implementation.patch`: **passed**. The saved patch matches the final source and tests. Final implementation and test diff inspected. Source/wire changes do not affect Flutter contracts, so Flutter validation was not run, as requested.

The new tests use SDK `InMemoryConversationCatalog` and `InMemoryConversationEventStore` with a real `createConversationRuntime` for post-rejection synchronization and observation. They exercise a real catalog optimistic version conflict and retry. Deferred host/factory calls and injected provider/SQL boundaries are narrow test seams; no SQL persistence, real Postgres dialect, provider network execution, or consumer integration is claimed. Existing approval and tool-executor tests passed.

## Existing failures and access limits

- `test/react-realtime-workspace.test.tsx:27`: expects accessible label `two idle 1 voice call with unread results`; actual label is `two 1 voice call with unread results` (the separate `data-turn-status` remains `idle`). Reproduced unchanged in the isolated baseline using the same command with that test file and `--root` above: **1 failed, 1 passed**, exit 1. [Baseline realtime UI log](baseline-realtime-ui.log). No realtime UI changes made.
- `test/package-contract.test.mjs:83`: expects `SPARTAN_AEGIS_TOOL_LOOP_LIMITS.maxTotalToolCalls === 75`, while `src/adapters/spartan-aegis.ts:123` specifies **150**. Both files are byte-for-byte identical to baseline HEAD; neither belongs to these fixes. The package-contract suite is therefore not wholly green.
- Handrail MCP read tools, including `handrail_current_context`, were unavailable in the active tool catalog. The named `handrail-ai-sdk-implementation-contract` published revision 1 was neither attached in full nor found in the repository, and could not be fetched without those tools. It was **not read**, and compliance with that unavailable document is not asserted. Current `package.json` exports, `src/client/index.ts`, server/runtime implementations, and `docs/platform-contracts.md` were inspected instead. No historical `@handrail/ai` migration guidance was applied.
- No unusual resource consumption or OOM was observed. Recorded peaks: typecheck 831 MiB, focused baseline 281 MiB, combined Vitest 339 MiB, baseline realtime UI 284 MiB, package-contract 583 MiB; reported swap and OOM-kill counts were zero. Nonzero test exits above are assertion failures.

## Publication and parent-task boundary

This is a local uncommitted SDK patch, not a released or consumer-adopted fix. There is no new public Git SHA for consumers to pin. No commit, push, PR, deployment, package publish, database mutation, or queue mutation was performed. Package/version/lockfile remain at baseline.

A separately authorized release step must commit and push the reviewed SDK changes to the public HTTPS Git repository before consumers can adopt an immutable full SHA with matching lockfiles. Compilation stays in the existing `prepare`/normal install-build pipeline; no separate registry publication or packaging step is needed. Consumers pinned to baseline `4e2d91d9535be8529289214817464e6bdcc650df` do not receive this local patch.

Spartan per-invocation usage durability and attempt attribution, subsequent Mills integration verification, and actual consumer adoption remain outstanding parent-task work. The unchanged test mismatches and unavailable KB revision remain explicit qualification limits; they were not folded into this bounded implementation.
