# Durable Responses execution

The optional server assembly owns reusable provider infrastructure as well as the UI.
`openaiResponses` used with `createHandrailAssistant` now handles native Responses
function-event correlation, bounded connection retries, physical usage receipts,
and retained normalized provider invocations. The app supplies authentication,
authorized tools, domain policy, instructions and provider settings.

## Default behavior

- A durable invocation is claimed in the authenticated tenant and owner scope
  before contacting the provider. A completed invocation replays its normalized
  events and original tool-call identities. An uncertain claim or a changed
  request fingerprint fails without another provider dispatch. A recovery whose
  initial invocation has no saved receipt also stops: it may predate this
  adapter, so redispatch could repeat provider work or discover different action
  identities. Review retained results and start a new request in that case.
- The default connection policy permits two attempts within the tool loop's time
  budget. `openaiResponses({ model, retry: { maximumAttempts: 1 } })` disables
  connection retries. A stream that has started is never retried automatically.
- Every physical attempt is captured through the existing durable usage sink
  before continuing to another provider attempt or executing a tool. Missing
  usage is recorded as unavailable. Cached and reasoning tokens remain subsets.
  Replay does not create new physical usage receipts.
- Storage must confirm the retained outcome before it becomes a successful
  terminal event. If retention fails, discovered tools do not execute.
- Request identity includes model, instructions, messages, tool schemas/results,
  continuation and generation settings. Changes fail closed on replay. Host
  attachment adapters remain responsible for immutable authorized references.

Provider replay preserves model/tool-call identities; the SDK tool execution
ledger and the host's domain idempotency boundary still govern application writes.
Hiding approval controls does not alter authorization or mandatory review.

The lower-level `createTransport` without a durable claim remains an ephemeral
adapter for existing callers. It does not provide durable replay or physical
attempt accounting. Production integrations should use `createHandrailAssistant`.

## Existing provider integrations

`@handrail/ai-assistant/server/assistant` exports:

- `retainProviderInvocation`: storage-independent normalized replay over a
  durable operation store, including `PostgresProviderOperationStore`. Supply an
  authenticated store, stable operation ID and request fingerprint.
- `createTrackedOpenAIResponsesRequest`: physical accounting and connection
  retries. Supply the authorized execution identity and durable receipt sink.
  `receiptPrefix` preserves an installed application's usage namespace.
- `createOpenAIResponsesRequest`: the built-in HTTP/SSE request adapter. Hosts do
  not need an OpenAI package to implement Responses networking.
- `createProviderToolLoopTransport.invokeProvider`: a per-invocation seam with
  trusted turn, iteration and durable claim identity. This avoids shared mutable
  request state across concurrent conversations.

Spartan uses these helpers with its original operation scope, hash inputs and
`spartan` usage prefix. Its remaining provider preparation selects authorized
history, resolves domain receipt contents, supplies instructions and blocks later
writes after a failed business action. The former host Responses stream bridge,
retry/receipt implementation, stream retention and OpenAI request client are gone.

These are candidate source changes. SDK consumers need an authorized full committed
HTTPS Git revision and matching locks before normal installed builds can use them.
Test-only candidate resolution does not establish deployed behavior.
