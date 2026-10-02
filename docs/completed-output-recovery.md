# Independent completed-output recovery

A provider adapter can corrupt an observation stream while the independently
committed execution checkpoint still contains valid final output. In Mills,
approval replay emitted the same Agent request/sequence zero with a refreshed
session attribution. The original stream remains invalid; successful execution
alone does not make it valid.

The optional trusted-server `ConversationTransport.readCompletedOutput` hook
reads the original job's immutable terminal checkpoint without start, resume,
approval admission, tool execution or model generation. Missing, uncertain or
non-completed sources return null. The hook must apply current authorization;
historical stream attribution is not authority. It is not a gateway operation.

After stored-output validation rejects a completed, lease-free durable turn,
the server may read that independent source once. It verifies turn/stream
identity, bounds the source to 10,000 frames and 1 MiB, snapshots it, and sends
it through the unchanged conversation runtime. Canonical prefix fingerprints,
sequence continuity, terminal evidence and ordinary CAS rules still apply.
Corrupt replacement output is rejected. Authorization and the original durable
document version are checked before every recovery append.

New canonical events carry `handrail_output_recovery` metadata with the source
reference, SHA-256 of the exact recovered source snapshot and original durable
version. Original frames, events, checkpoint and execution receipts remain
unchanged. Ordinary canonical replay makes subsequent reads idempotent.
Cancelled/failed/uncertain turns never take this completed-output path.

This is a source candidate based on
`d851e7a62a14754972adeb8be84ea64cddb567d6`, not a published revision. Mills's
adapter uses the existing Agent SDK checkpoint reader and an exact authorized
job binding; it does not call `turns.lookup` (which can answer approval waits),
`runtime.resume`, `wake`, `start`, or a tool. Agent remains at
`170ccf247d0de457ad76d1b8a5d116f9c16a5c66`.

The owning native pipeline must publish the AI SDK source before Mills adopts
its new public HTTPS full SHA with matching lockfiles and normal prepare/build.
Local source qualification, including real disposable PostgreSQL/Mills tests,
does not prove staging installation or recovery of the retained staging turn.
