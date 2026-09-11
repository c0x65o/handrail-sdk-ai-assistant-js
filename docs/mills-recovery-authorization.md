# Mills recovery authorization fix (unpublished)

Prepared against published SDK commit `932411cecdee486d6e12284ccb31921597e1192f`. The change is local and uncommitted. No package dependency has been redirected to the worktree. Mills must consume an authorized published full Git SHA and matching lockfiles before this fix applies to its runtime.

The high-level assistant creates durable-turn stores at tenant scope, while authenticated execution contexts may represent different users in that tenant. Context startup and explicit recovery previously scanned those retained turns without checking the current conversation catalog. A fixture with two users in one household reproduced the wrong user claiming a pending turn and changing its state.

`createDurableApplicationTransport` now accepts an optional `authorizeRecovery` callback and checks it before claiming or dispatching a recovered turn. `createHandrailAssistant` supplies its current authoritative catalog lookup, including a host-supplied catalog when configured. Denied ownership leaves the record untouched. A failed lookup cannot dispatch the work; authorized recovery remains available after the lookup recovers. Existing lower-level consumers retain their current behavior unless they configure the callback.

`test/server-assistant-recovery-authorization.test.ts` verifies both persistence and host catalogs against shared tenant event/turn stores. It checks that another user's record, version, attempts and canonical events stay unchanged, that database lookup failure leaves work pending, and that each owner later recovers exactly their own turn. The role/session worker-ownership fixture now registers its owned conversation explicitly.

Validation: full SDK TypeScript check passes. Forty-seven tests across recovery authorization, worker ownership, high-level assistant, durable transport, execution identity and canonical admission pass with one worker. Logs are under `/tmp/mills-chat-retirement/`. The pre-fix regression log records two failures demonstrating the issue.

This is a prerequisite for Mills retirement, not evidence that the full migration is complete. Provider/history replacement, live audio, deployment and live acceptance remain separate work. Paged recovery now addresses the denied-row starvation case described below. Consumption still requires the authorized published Git revision and matching lockfiles.

## Paged recovery

A denied row previously consumed the scan limit, so 25 pending rows belonging to other users could hide the current user's pending work indefinitely. The durable transport now uses optional `scanRecoverable` pages when the store supports them. Both SDK stores implement that contract. PostgreSQL uses immutable `(scope_id, record_id)` keysets and an initial upper key; updates or completions cannot shift an offset and skip work. New high keys wait for a later pass. The generic single-page `listRecoverable` contract remains available for existing consumers.

`recoverPending(limit)` starts at most `limit` eligible turns. Denials and live leases do not exhaust that work limit. Each database page has at most `limit` rows, but reaching eligible work can require authorization checks across the tenant's pending backlog; startup latency therefore depends on that backlog. No schema change or user-record rewrite is required.

The high-level authorization fixture places 26 other owners ahead of the current user and still recovers only that user's turn. `test/postgres-durable-recovery.integration.test.ts` verifies actual SQL keyset behavior, equal turn IDs in different conversations, row updates between pages, a later high-key insertion, cross-tenant isolation, bounded starts and unchanged denied rows. The context-startup test now observes the paged scan entry. Validation logs use the `sdk-recovery-pagination-*` prefix under `/tmp/mills-chat-retirement/`.

Final validation for the combined authorization and pagination changes: 61 tests pass across nine files; full TypeScript and scoped ESLint pass. Both the PostgreSQL fixture and high-level authorization cases run with one worker. `git diff --check` passes. All changes remain local and unpublished.
