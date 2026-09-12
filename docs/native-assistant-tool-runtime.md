# Native tool runtime for trusted live delegation

`createAssistantToolRuntime` is exported from `@handrail/ai-assistant/server/assistant`. It is the same implementation used by `createHandrailAssistant` for provider tool execution and approval waits. A trusted live transport can use it with the SDK application, execution ledger, approval coordinator and conversation event store instead of maintaining a second proposal/execution loop.

## Host contract

Construct the application with `createAiApplication`, the authorized domain plugins, a durable tool execution ledger and `createApprovalExecutionCoordinator`. Bind the coordinator to the same scoped proposal/event stores supplied to the runtime. The standard opaque argument binding is `assistantToolArgumentReference(arguments)`; both the reviewed reference and execution reference must match it. Configure current authorization and approval policy on the application and coordinator. This factory does not install a ledger or grant authorization on an otherwise unprotected application.

Supply authenticated `context.scopeId`, `application`, `events`, `proposalStore` and the required `authorizeLocation(location, signal)` callback. That callback must revalidate the current account/tenant and conversation ownership and the active server-owned text turn or durable live call. Neither a browser field, a provider tool argument nor a transcript establishes an execution location. Call the runtime only after the trusted live control connection is ready and its durable lease is authorized. Use a stable location and provider tool-call identity on reconnect; never mint a new execution key to retry an uncertain effect.

`definitions` comes from native application discovery. `execute(call, signal, location)` uses native policy, argument validation, bounded execution and the durable ledger. If it returns `external_approval_required`, `awaitApproval({ ...location, call, signal })` creates or reattaches the native proposal and waits for a decision through the SDK approval API. That API must remain authenticated and enforce the host's review rules. Spoken agreement or an interrupted utterance is not an approval decision.

The high-level assistant supplies catalog authorization. Lower-level live hosts supply their own current call authorization and session-revocation checks. All event and proposal stores must use the authenticated partition; the factory does not infer a tenant from conversation IDs.

## Cancellation and recovery

Approval reattachment loads the original immutable proposal and expiry, validates the original arguments and identities, and reuses the original creation event. A concurrent observer does not create another approval or execute a second effect. A retained terminal decision remains readable after its original deadline. Conflicting identities, arguments or creation events fail closed.

Cancelling an approval observer throws without writing a fabricated terminal tool result or deciding the pending proposal. An authorized observer may later reconnect. Revoking access prevents a waiting observer from dispatching. Cancellation before dispatch, including work waiting for a concurrency slot, prevents executor invocation.

The runtime opts into `preserveDispatchedResultOnCancel` on the bounded executor. Cancellation still reaches the domain executor, but an outcome returned after dispatch and before the existing tool deadline is retained in the ledger, approval settlement and tool event stream. A completed backend change therefore remains completed even if the voice connection stops. Direct users of the lower-level executor retain its existing default cancellation behavior unless they explicitly enable the option.

The deadline still bounds an executor that ignores cancellation. A timeout or lost process does not establish that an external effect was rolled back. Hosts must use durable execution evidence and domain idempotency/reconciliation for uncertain outcomes; they must not start the same mutation under a new identity. No claim is made that this option captures arbitrary results returned after the deadline or after process termination.

The runtime records tool and approval facts only. It does not fabricate user text, complete a conversation turn, report spoken/playback success, close a remote live session or finalize audio usage. The transport owns transcript events, session lifecycle and usage accounting, and must distinguish those outcomes from backend execution. Optional activity updates are presentation evidence, never the execution receipt.

## Verification

`test/assistant-tool-runtime.test.ts` covers retained ledger results, changed arguments, confirmation/rejection replay, foreign/stale locations, revoked authorization, cancellation before and after dispatch, queued cancellation, expired terminal results, bounded deadlines, interrupted approval waits and concurrent observers. The existing assistant, executor, approval, worker recovery, catalog and Responses suites continue to exercise the shared path. Publication and adoption of a public full-SHA dependency are required before this API applies to an application consuming a prior SDK revision.

### PostgreSQL approval receipts

A recreated application must be able to read an already executed approval's result without admitting another execution. `ToolExecutionLedger.lookup` is an optional asynchronous, read-only receipt API used after the approval coordinator authorizes reuse; the existing synchronous `get` fast path remains supported. PostgreSQL implements lookup with the same tenant, application scope and hashed argument binding as dispatch. A missing result does not create a claim. A retained claim without a receipt remains uncertain, and changed or missing argument bindings fail closed.

The native runtime's PostgreSQL regression recreates the application, persistence adapter and ledger after confirmation and verifies the same successful result, one domain effect, one recorded result event and the original executed proposal. The SQL ledger integration also covers foreign scopes, missing receipts, uncertain claims and legacy unbound receipts. This addition must be published and adopted through a public full-SHA dependency before it applies to a consumer pinned to 0.2.28 / `3831380d73eab6c617533df6b43c84a980bc84bf`.
