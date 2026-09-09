# Tool recovery and failure feedback

Tool recovery is opt-in trusted application policy. Pass `toolRecovery` to
`createAiApplication`, or `recovery` to `BoundedToolExecutor`. Existing consumers
keep their behavior until they install a committed SDK revision and enable policy.
The maximum is one initial execution plus two recovery executions, regardless of
the configured value. The default elapsed budget is 30 seconds, each execution
has an 8-second deadline, and transient backoff starts at 250 milliseconds.
The application can choose shorter budgets or longer deadlines within documented
type/runtime bounds. An exhausted SDK operation returns a terminal tool result;
the host's provider loop must also retain its normal total-tool and time budgets.

The host declares each tool's effect and classifies errors into static public
codes and guidance. Never include raw exceptions, user prompts, credentials, or
business records in a `ToolFailure`. Unclassified exceptions stop with generic
guidance and a `bug` classification; this is diagnostic evidence, not a confirmed
root cause. Permission denials, cancellation, missing capabilities, and business
rules stop immediately. Transient failures can retry within budget. Respecting
`retryAfterMs` takes precedence over fitting another attempt into the budget.

For a failed read, `repairArguments` can resolve an identifier or return a new
candidate using authorized application data. Null, unchanged arguments, and
cycles stop recovery. Every candidate is schema-validated and authorized again
before dispatch. Recovery stays inside the executor's original execution ledger,
so replaying the same tool call returns its recorded outcome.

A write has no automatic argument repair. After a possibly applied failure,
`verifyWriteOutcome` must return either an authoritative completed receipt, proof
that the operation was not applied, or an unknown outcome. Only a transient error
with proof of non-application permits another write execution, using the same
`executionKey` and arguments. Missing proof stops with instructions to inspect the
receipt before repeating the operation. A timeout is not proof of non-application.
The host must enforce that key at the side-effect boundary, including after
process restarts. MCP adapters forward `executionKey` when present.

## Durable diagnostics and optional reporting

`record(summary, context)` runs once for an operation that experienced failure,
including a successful recovery. Copy only fixed metadata into a
`ToolIncidentOccurrence`: a stable occurrence ID, tool name, environment, SDK/app
versions, and the bounded recovery summary. Recording has its own one-second
budget; a slow or broken sink never replaces the business outcome. Hosts should
monitor their local database health independently because unavailable persistence
cannot guarantee delivery.

`PostgresToolIncidentStore` uses the existing migrated `handrail_ai_documents`
table, scoped by constructor-owned tenant and project/environment. It atomically
deduplicates occurrence IDs and groups incidents by scope, tool, environment,
SDK/app version, category, and code. It retains aggregate counts and a frozen
submission body for idempotent network retries. Unknown defects, missing
capabilities, exhausted/deadline failures, and uncertain write outcomes are
reportable immediately; other failures become reportable after three occurrences.
Permission denials, cancellations, and business-rule outcomes are recorded but
never automatically reported as defects.

Use `createToolIncidentDispatcher` with the store and an explicitly authorized
`ToolIncidentReporter`. Invoke `drain` from an existing authorized worker or session
lifecycle with a bounded abort signal. Failed deliveries remain pending, back off,
and stop after five attempts. A remote authoritative report ID is required before
marking delivery complete. One remote report is submitted per incident. Later
occurrence counts remain local; the existing MCP intake contract does not support
updating counts on an existing report. Store scope and remote idempotency must be
preserved across worker restarts and concurrent drains.

`createMcpToolIncidentReporter` maps to Handrail's canonical bug/enhancement
reporting tools when the host has those capabilities. Supply the authenticated
MCP call and a receipt parser for that server. An ordinary reporter callback can
be used without MCP. Reporter errors do not recursively generate incidents.
The SDK creates no global reporter credentials, cross-project authority, or
background process. Hosts remain responsible for retention of incident/event
records and for monitoring exhausted deliveries.

An optional `requestRepair` callback can hand a verified incident to an existing
development workflow. It runs only if the host separately supplies and approves
`authorizeRepair`, receives a stable idempotency key, and returns a verified work
request ID. Use that workflow to reproduce with fixtures, add regression tests,
review fixes, and release under existing policy. Neither model output nor a tool
failure grants permission to edit data, create work, commit, or deploy.

## Conversation UI and adoption

Recovery attaches a `handrail.tool_recovery.v1` JSON receipt to the final tool
result. External host executors can pass the same receipt to the tool activity
observer. The canonical projection and React tool activity display recovered
operations separately from unresolved failures, including after reload. A later
successful call to the same tool does not prove an earlier failed call recovered;
historical failures without explicit receipts remain failures.

For a shared rollout, first commit/release the SDK, then update each consumer's
public HTTPS Git dependency to the full approved SHA and regenerate its lockfile.
Keep compilation in the normal install/build pipeline. Enable host classification,
read repair, reporting policy, and lifecycle draining per application. Test one
consumer end to end before expanding the rollout. Installing a new SDK alone does
not grant it application-specific recovery knowledge or reporting authority.
