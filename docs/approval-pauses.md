# Approval pauses without deadlines

Local source change; coordinated JS server/React/Flutter release and consumer
adoption are still required. No production data has been changed.

A pending approval has no deadline. New proposals store `expires_at: null`;
legacy timestamps on still-pending proposals no longer affect reads, decisions
or execution. Read operations never write an automatic expiration. Already
expired historical proposals and decision receipts remain historical terminal
records; this change does not approve or reactivate them. Deprecated timeout and
expiry-attribution options are ignored. Authentication, execution budgets and
worker leases remain independent of a human's approval request.

The default provider loop saves the proposal and returns `waiting_for_approval`.
The durable turn keeps its original request, provider receipts, checkpoints and
pending tool-call identities, releases its lease and closes the observation.
Canonical state clears `active_turn_id` and `remote_may_still_be_running` for the
paused turn. React and Flutter treat it as resting: no busy/Stop state or error,
and a comment can be sent without deciding, replacing or deleting the proposal.
Large formatted details stay collapsed under the shared disclosure policy.

Only a saved explicit confirmation or rejection wakes a paused turn. Current
conversation access is checked before resumption, then normal tool permissions,
reviewed argument binding and execution ledgers apply at dispatch. Repeated
requests return their immutable decision receipts; repeated execution reuses the
same effect identity. Provider invocation receipts replay completed requests
without another physical call. A human pause does not spend the crash-recovery
attempt budget. An approval arriving during a newer running message waits for
that message to settle. Authorized catalog/sync reads repair a restart between
canonical admission and durable wake-up; undecided work is not recovered.

Custom server provider transports must propagate the pending result instead of
holding a promise open or turning it into an error/synthetic tool result.
`createAssistantToolRuntime.awaitApproval` is now a single authorized lookup /
proposal creation / decision resolution. `createProviderToolLoopTransport`
recognizes its `external_approval_required` result and ends the invocation.
The high-level assistant supplies the durable wake-up logic. Applications using
only lower-level transports must install an equivalent trusted decision handoff.

Live-call authorization is separate. This change does not grant execution after
a voice lease ends, reopen a remote call, or synthesize spoken output. Mills'
custom live transport currently treats a pending result as an error/end-control
condition and has no closed-call approval handoff. That adapter needs coordinated
qualification before adopting the changed low-level callback for live execution.
The text gateway flow is qualified; live provider/audio behavior is not claimed.

Rollout must update the server and parsing clients together: older SDK clients
may reject nullable expiry or the new turn status. Keep public HTTPS Git full-SHA
pins and matching lockfiles. No migration or production SQL is required for the
JSON-backed SDK schema, and no startup purge or history rewrite is introduced.

Regression evidence covers the real SDK gateway/client against isolated PGlite:
request approval, stop observing execution, send a comment, recreate the server,
confirm/reject, replay an exact decision and retain one effect. A second case
approves while a newer message is still running. Durable tests cover multiple
human pauses with one allowed crash attempt. Store and UI cases cover old dates,
no deadline, stale versions, immutable arguments and revoked permissions. These
are local fixtures, not production/provider/audio qualification.

The local React regressions also cover a resting composer, no Stop button,
screen-reader announcement and no decision from typing. Flutter client/widget
tests and analyses pass after updating the old expiry expectation; Mills' 41
focused review/runtime tests and Spartan's 19 approval tests pass against their
existing installed SDK pins. Both host typechecks pass. These host checks cover
their source changes, not adoption of this unpublished SDK candidate.
