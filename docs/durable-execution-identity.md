# Durable execution identity and usage attribution

`createApplicationTurnTransport` exposes an optional
`ApplicationTurnExecutionContext.durableExecution` snapshot:

```ts
interface DurableTurnExecutionIdentity {
  readonly conversationId: string;
  readonly turnId: string;
  readonly attempt: number; // one-based persisted durable claim ordinal
}
```

The tuple identifies one execution within the configured durable turn store.
Namespace it with the existing authoritative tenant/project/environment/store
scope when deriving cross-tenant receipt IDs. It is not a provider request ID.
The initial successful claim has attempt 1; a recovery claim has attempt 2, etc.
Claims that are cancelled or fail preparation may consume an ordinal without
invoking a provider. Do not interpret this ordinal as a billable invocation count.

The durable wrapper captures the existing persisted attempt after successful
claim and dispatch validation. It passes a frozen snapshot in the optional second
argument to `ConversationTransport.startTurn(input, context)`. The application
adapter copies and freezes that identity for its execution callback. It never
loads the latest turn record to attribute a callback: an old worker's late usage
belongs to its original attempt, even after a replacement completes the turn.
No allocator, persistence schema, lease policy, or retry policy is added.

## Compatibility and adapter placement

- `StartTurnInput`, request data, turn/mutation/idempotency IDs, HTTP payloads and
  protocol versions are unchanged. The new argument is trusted server context,
  separate from request data. The durable wrapper ignores incoming execution
  context and constructs its own from its claim. Body or request fields named
  `durableExecution`, `attempt` or `context` cannot override it.
- Existing one-argument callers and delegates remain valid. Standalone application
  execution has no `durableExecution` unless a trusted in-process caller supplies
  context. Do not manufacture a durable attempt for standalone execution.
- In-process forwarding wrappers must forward both arguments:
  `startTurn: (input, context) => delegate.startTurn(input, context)`.
  The SDK's `qualifyDurableApplicationTurnStarts`,
  `guardCanonicalTurnExecution`, and `createAssistantActivityTransport` preserve
  it. The high-level assistant's cancellation wrapper spreads the durable
  transport without replacing `startTurn`.
- HTTP gateway/client adapters intentionally do not transmit this server context.
  A remote gateway or a custom one-argument wrapper between the durable wrapper
  and application executor cannot deliver it; keep that execution path in-process
  and update custom forwarding wrappers when adopting the seam.
- Provider-specific/direct/managed transports may ignore this optional argument.
  This change only supplies the application execution context; it does not add
  provider usage capture to those implementations.
- Retained terminal start/resume/recovery observes the existing result without a
  new claim or execution. Disconnect remains an observation action. Authoritative
  cancellation still uses the existing signal/capability path.

The types are available from `@handrail/ai-assistant/server/application` and the
existing root transport exports. No runtime symbol or package export path is added.

## Mapping physical invocations into normalized receipt v1

Spartan's scoped follow-up should capture this snapshot at executor entry and
carry it into every provider operation. `executeWithRetry` already calls its
operation with a one-based `RetryAttemptContext.attempt`, starting at 1 for each
call to `executeWithRetry`. That callback ordinal describes a provider retry only
when each operation callback performs exactly one provider invocation. Hidden
provider-SDK retries or multiple invocations inside a callback need their own
capture at the actual invocation boundary; the durable ordinal cannot detect them.

A collision-safe identity recipe using only existing receipt fields is:

1. Keep `conversation_id`, `turn_id`, `logical_request_id`, and mutation/idempotency
   identities stable according to their existing logical-operation semantics.
2. Within that logical request, retain the existing zero-based continuation index
   (0 for the initial request; increment for tool/provider continuations).
3. Derive `attempt.id` from a versioned, unambiguously encoded tuple of trusted
   scope, logical request ID, durable execution tuple, continuation index and
   retry callback ordinal. Hash the tuple to fit the existing identifier limits.
   Set `attempt.index` to callback ordinal minus one. This is a local retry index;
   it may repeat across continuations and recovery executions. The full ID carries
   the disambiguating scope; do not invent an arithmetic flattened global ordinal.
4. Derive `continuation.id` from that attempt ID and the continuation index, with
   `continuation.index` set to the existing continuation index. Derive a stable
   `usage_receipt_id` for that physical invocation. Receipt-write retries reuse
   the exact same identity, start timestamp and captured evidence.

For example, `(durable=1, continuation=0, retry=1)`, `(1,0,2)`, `(1,1,1)` and
`(2,0,1)` are four different physical invocation identities. Their logical request
can remain the same. A late callback for the first tuple stays `(1,0,1)` after the
fourth tuple starts. Replaying its receipt write must deduplicate, while none of
the other three receipts should collide. The ID recipe is follow-up guidance,
not an SDK schema addition or a new allocator.

Capture and await one durable usage write for each actual invocation outcome,
including failures and late completion after cancellation; do not record only
an aggregate after `executeWithRetry` returns. Keep capture-write failures outside
provider retry classification so retrying persistence cannot invoke the provider
again. Use the existing retry failure categories and distinguish non-retryable
failures, retry exhaustion, cancellation and disconnection from successful work.
Use `{ status: "unavailable" }` for absent quantity/cost evidence, preserving an
explicit reported zero. Do not infer missing usage or cost from a successful
terminal result. These behaviors, the exact host identity recipe, and awaited
capture remain Spartan implementation work. Mills integration verification also
remains outstanding; this SDK change does not qualify either consumer.
