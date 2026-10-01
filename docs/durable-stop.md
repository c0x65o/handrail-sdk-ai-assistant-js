# Durable Stop delivery

Explicit Stop is a durable, authorized mutation. Closing observation never sends
it. The gateway acknowledges `cancellation_requested` after retaining the request;
that acknowledgement alone does not mean the delegate has stopped.

The existing durable worker owns delivery, including after an approval wait has
released its observer. A failed observer also cannot block a later Stop when
the record retains evidence of delegate admission. Stop moves that wrapper back
to recoverable `pending`
state without approving or starting anything. It sends the original mutation,
idempotency key and reason to the saved delegate turn ID in the same conversation.
Concurrent retries use CAS and preserve the first cancellation identity. A later
approval/resume cannot clear Stop. A completed observed result stays completed.

Before first dispatch the wrapper records `delegateStartAttempted`. A retained
false value proves that cancellation can settle without admitting delegate work.
After dispatch, a saved delegate ID must receive authoritative cancellation. The
worker records `cancellation.acceptedAt` only after the capability acknowledges
`cancellation_requested` or `already_terminal`, or after proving that no delegate
dispatch occurred. An actual cancelled observation
also proves settlement. Accepted Stop settles the wrapper's cancellation contract;
it does not manufacture delegate checkpoints or undo completed business effects.

Delivery errors, unsupported cancellation and acknowledgement timeouts leave
`pending`, `terminal: null` and the original cancellation for the existing bounded
recovery scanner. They do not spend the execution retry budget into a false
terminal. The acknowledgement deadline is the configured lease duration (15s by
default). The worker renews its lease during admission and Stop delivery, fences
writes with the claim attempt, and rechecks `authorizeRecovery` before claiming
or delivering Stop. Delegates must also check current authority and handle retries
of the same cancellation safely, including after an uncertain response.

If admission was attempted but its response and delegate ID were lost, the
existing generic transport API cannot safely discover that ID. The wrapper keeps
Stop pending and emits `cancellation_pending`; it never replays start merely to
look up a job. The owning host must reconcile the original admission using its
retained binding/evidence. It must not invent an ID, approve a wait, or repeat an
uncertain effect. The reported Agent approval-wait case already has a saved ID
and recovers automatically, including in a fresh process.

The optional fields fit existing version-1 JSON records; no DDL change is needed.
Old records with no attempted flag are treated conservatively if they have
previous claims and no delegate ID. Upgrade workers sharing a store together:
old workers can still incorrectly terminalize Stop. Previously terminalized
records from the old bug are not silently reopened; their delegate outcome needs
explicit reconciliation before any authorized repair. Consumer adoption must use
the eventual published full Git SHA and matching lockfile.
