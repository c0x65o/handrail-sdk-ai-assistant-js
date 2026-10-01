# Durable Stop source qualification

Intended delivery: the shared JS gateway/transport must propagate explicit Stop
to Mills's original admitted Agent job after native approval observation ends.
This is SDK source qualification for Avery's subsequent published-pin adoption;
Mills candidate activation and independent web/Flutter QA remain held.

## Repair and authority

`src/transports/durable.ts` now records the dispatch boundary, reopens a stopped
approval wait for cancellation delivery, and calls the admitted delegate by its
saved ID without starting or approving work. The original cancellation identity
survives concurrent retries, unavailable/uncertain responses, and restart. An
acknowledgement receipt gates cancellation settlement; delivery failures stay in
the existing recovery scan without exhausting into a false terminal. Ownership
is renewed during admission/delivery and fenced by owner plus claim attempt.
Current scope is checked before claiming and delivering. Completed observations
remain completed. No wire endpoint, app scheduler, Agent engine, or SQL schema
was added.

The regression covers pre-start Stop, native approval/no observer, duplicate and
conflicting Stop, approval-resume races, confirmation/rejection after Stop,
permission revocation, cross-conversation isolation, live and expired leases,
unavailable/throwing/timeout/unsupported cancellation, lost acknowledgement,
uncertain admission, failed observation followed by a fresh authorized Stop,
and completed effects/results. The final focused run includes all 15 cancellation
matrix cases. See
[delivery semantics and limits](../../durable-stop.md).

## Reproduction and results

All expensive commands were run sequentially; Vitest used one worker.

| Check | Result / evidence |
| --- | --- |
| Frozen public AI SDK `97cb53daa35a0ce1bb06c3563e795e94371b17d2`, actual gateway → Agent → PostgreSQL | **Failed as expected from the reported bug**, ordinary failing test, not `it.fails`: Stop HTTP 200 does not cancel the original waiting job. [Baseline output](baseline.txt). |
| Candidate public exports, actual Agent/Runner with PostgreSQL 15 | **3 passed**: no-observer Stop; persisted Stop with unavailable delivery followed by a fresh Node process; completed native effect/result preserved. [Output](agent-postgres.txt). |
| Focused JS transport, gateway, synchronization, approval, client, recovery and server tests | **134 passed in 17 files**. [Output](focused-tests.txt). |
| TypeScript and build | `npm run typecheck`, `npm run build`; see [compile output](compile.txt). |
| Focused lint | Passed; [output](lint.txt). |
| Flutter client against candidate built JS using the existing explicit fixture override | **39 passed, 2 failed**. Stop-before-admission, failed-Stop retry, observation cleanup, approval decisions and isolation pass. [Output](flutter-candidate.txt). |
| Flutter baseline comparison of both failures | **Both also fail against public AI SHA 97cb53d…**. [Output](flutter-baseline.txt). |

The Flutter failures are existing assertions at
`submission_gateway_test.dart:857` (immediate user-message history) and `:926`
(attachment user-message lookup). They are retained as failures, not waived or
counted as passing. The Dart/Flutter repository was not edited. It remains clean
on `fix/preview-composer-accessible-name`; the startup `branch_policy_mismatch`
was not bypassed by switching or discarding that branch.

The Agent fixture uses the ordinary public Git installation of Agent 0.1.6 at
`f6eb0ef10af89a8ecaea0707610d7709483eaa49`, with a matching fixture manifest/lock.
Model responses and the external business effect are simulated; admission,
Runner, native approvals, effects, canonical client/gateway, PostgreSQL and
process reconstruction are real. Valid controlled tool schemas are used. The
fixture follows Mills's inspected composition and `nativeDecision('stop')` but
is not the entire Mills application or its complete tool catalog. See the
[reproducible fixture](../../../test/fixtures/agent-cancellation/README.md).

## Handoff and remaining qualification

- The JS base HEAD and hashes of the exact candidate source/tests are in
  [source-evidence.json](source-evidence.json). Changes are uncommitted; Handrail
  owns version bump, commit and push. No deployment was performed.
- Avery must verify native publication, install the eventual full public AI SHA
  and repaired Agent SHA with matching Mills locks, then rerun the original
  Mills expected failure as an ordinary passing test. The current source fixture
  does **not** prove installation of that future SHA.
- The Agent full-schema repair remains the separate assignment. The existing
  Mills candidate remains disabled; complete catalog, deployed DEV behavior,
  tools/reminders/watches/follow-through, and independent web/Flutter parity
  remain obligations of the original outcome.
- A start whose response and returned delegate ID are both lost stays pending
  for authoritative binding reconciliation. It is never replayed speculatively.
  Historical wrapper terminals produced by the old bug are not reopened without
  evidence. Workers sharing durable state should upgrade together.
- The owning Flutter workflow retains its branch-policy mismatch and the two
  baseline-reproduced history fixture failures. Neither was expanded into this
  cancellation repair.
