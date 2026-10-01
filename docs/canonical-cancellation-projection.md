# Canonical cancellation after output projection failure

An explicit Stop has two durable facts: the request and the delegate's
acknowledgement. The durable writer settles cancellation only after delivery is
known. Browser observation, output projection and execution settlement have
separate lifetimes.

Previously, terminal reconciliation always replayed the complete saved output
through the conversation runtime. A conflicting duplicate frame interrupted
both live projection and this fallback. Repeated authorized history reads then
retried the same invalid output, leaving a cancelled job displayed as running.

Reconciliation still validates output and preserves its valid prefix. If that
validation fails, it reports `conversation_output_projection/invalid_stored_output`.
Only a settled cancelled durable record with a saved Stop acknowledgement and
no lease can independently append its canonical `turn.cancelled` fact. The
reconciler checks the durable version, current authorization, canonical history
and terminal agreement, and uses the existing revision CAS with a stable event
identity.

Paged display-history reads previously bypassed terminal reconciliation, unlike
legacy snapshot reads. Control, page and changes now inspect at most three
authorized turn identities (active, latest and explicitly requested) against
scalar durable statuses. A mismatch invokes the canonical reconciler and then
reads the derived display records again. This also repairs valid completion
whose projection write was interrupted. Ordinary polling does not hydrate
durable request/output bodies or replay the canonical log. Interrupted writes
and lost replies can recover in a fresh gateway process without a provider
invocation, scheduler or database migration.

The Stop fallback also rechecks conversation authorization before reading
canonical history. A delegate's `not_found` can represent denied authority; it
must not become a successful terminal response through the pre-start fallback.

This does not accept conflicting frames, rewrite saved events, alter provider
checkpoints, re-execute tools or resend Stop. Completed results and uncertain
effect receipts remain unchanged. A requested but unacknowledged Stop remains
uncertain. Successful output still requires valid stream evidence; a corrupt
completed response is not made successful by this cancellation repair.

## Provider binding invariant

Every replay of a `(request_id, sequence)` must contain identical frame data,
including `response.started.attribution`. The regression reproduces the reported
symptoms when a provider reconstructs that start frame using a refreshed session
instead of its original attribution. Hosts must retain historical attribution
for the admitted job while continuing to authorize every operation using the
current principal and permissions. Historical attribution is never authorization.

The retained Mills ledger and logs prove the live cancellation/display mismatch,
but the mounted evidence does not include its raw frames. Session-attribution
drift is a reproduced mechanism supported by the inspected host binding, not a
verified diagnosis of that exact retained live stream. Avery must inspect those
frames and address any Mills binding change in its owning repository.

## Public consumer adoption

The source patch is intentionally uncommitted. There is no new public SHA yet.
Avery owns diagnosis of native publication, the versioned commit and push. The
already published AI 0.2.63 commit must not be replayed as a new publication.

After the native publication receipt provides the new full 40-character AI SHA:

1. In the original Mills composition, replace only the AI dependency with
   `git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#<new-full-AI-SHA>`.
   Update its exact `allowScripts` Git identity as required by Mills's npm policy.
   Preserve the existing scoped override:
   `"handrail-agent-sdk": { "@handrail/ai-assistant": "$@handrail/ai-assistant" }`.
2. Keep Agent at
   `git+https://github.com/c0x65o/handrail-agent-sdk.git#4b10d0156e4337fbcba95fe91520ec41aaf6eb58`.
   Keep Flutter client/widgets at
   `https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter.git`, ref
   `5b75c071f2926ca6b34e887088987b2d98c0662c`, and their existing package paths.
   This repair changes no Flutter protocol or source.
3. Use Mills's Node 22.23.1/npm 12.0.2 install pipeline to refresh its lock,
   followed by clean `npm ci` with normal prepare/build scripts. Verify the root
   manifest, lock, installed lock, and `npm ls @handrail/ai-assistant
   handrail-agent-sdk` agree, including Agent's nested AI resolution. Every SDK
   resolution must use the public HTTPS repository and the exact full SHA.
4. Run Mills's scoped compile and original composition regression. Upgrade all
   workers sharing that durable scope through Avery's authorized workflow.
5. Read the **same retained conversation/turn** through the normal protected
   history/control endpoints. Verify canonical and display revisions, cancelled
   status and `remoteMayBeRunning=false`, the existing acknowledgement, one
   retained effect, and unchanged event identities. Do not send another Stop or
   rewrite history to make this check pass. Independently verify native web and
   Flutter using Avery's QA workflow.

Source qualification and the disposable fixture do not establish Mills adoption,
deployment, or acceptance of the original owner outcome.
