# Current authorization for tool execution retries

Use `toolAdmission` on `createAiApplication` and `createHandrailAssistant` when
current permissions must govern every execution attempt. The lower-level
`BoundedToolExecutor` option is `admission`. The exported
`ApplicationToolAdmission<TContext>` type is available from the root package,
`server/application`, and `server/assistant` entry points.

This is an opt-in compatibility seam. **Installing an SDK revision without
wiring admission does not repair authorization implemented only inside a domain
executor.** Discovery may use a stale principal snapshot; an allow policy does
not resolve that snapshot. The SDK cannot infer a consumer's identity resolver,
namespace rules, or operation permissions.

## Consumer contract

The hook receives `applicationContext`, the registered `definition`, cloned
`arguments`, `toolCallId`, resolved `executionKey`, optional trusted `location`,
and an `AbortSignal`. Return `{ outcome: "allow" }` or `{ outcome: "deny" }`.

A host-defined example (the resolver and operation catalog remain host code):

```ts
import type { ApplicationToolAdmission } from "@handrail/ai-assistant/server/application";

const admitNativeTool: ApplicationToolAdmission<NativeContext> = async input => {
  const { applicationContext: context, definition, arguments: args, signal } = input;
  signal.throwIfAborted();
  const principal = await context.resolvePrincipal();
  signal.throwIfAborted();
  if (!principal || principal.id !== context.principalId) return { outcome: "deny" };
  if (!principalBelongsToScope(principal, context)) return { outcome: "deny" };
  const operation = nativeOperations.get(definition.name);
  if (!operation || !namespaceAvailable(operation.namespace, principal)) return { outcome: "deny" };
  return { outcome: await operation.isAuthorized(principal, args) ? "allow" : "deny" };
};

const application = await createAiApplication({
  ...applicationOptions,
  toolAdmission: admitNativeTool,
});
// For SDK-owned provider/gateway applications:
const assistant = await createHandrailAssistant({
  ...assistantOptions,
  toolAdmission: admitNativeTool,
});
```

Resolve current identity on **each invocation**, including after application or
worker recreation. Do not cache an authorization verdict on an execution key or
trust `context.principal` as a current permission source. Compare the resolved
identity and account/tenant scope to trusted request context, check namespace
availability, and apply the same operation-specific authorization as dispatch.
Share a pure authorization helper with the domain executor; retain its dispatch
checks and transactional invariants to address changes between admission and
execution. For non-native tools, explicitly delegate to their current access
checks; do not deny or allow them accidentally through an incomplete catalog.

The hook must perform no mutation/provider dispatch or approval transition.
It cannot grant human confirmation. Explicit denial, exceptions, invalid
responses, cancellation and admission timeout fail closed with a generic tool
error. Its timeout is bounded by the executor's `timeoutMs`, separately from
the existing dispatch deadline; resolver implementations should honor the
provided signal. An admission failure is never stored in the execution ledger.

With admission configured, registry membership, the supplied discovery list,
and argument schema are checked before admission. The hook receives its own
argument copy so changing it cannot rewrite dispatch arguments or fingerprints.
Admission runs before completed-ledger access, in-flight sharing, dispatch
policy, durable `getOrCreate`, and approval claim/reuse. Valid admission then
continues through existing policy and approval rules. In-flight callers each
need admission; denying one caller does not cancel an already admitted caller.
This is an authorization check at admission time, not continuous revocation of
work already dispatched.

The SDK does not change ledger keys, fingerprints, uncertain claims, or receipts.
Authorized conflicts still fail, authorized exact retries retain the original
result, and uncertain outcomes cannot redispatch. A denied caller receives no
protected receipt and may receive denial before identity-conflict validation.
The host must continue binding keys to the account/conversation/turn; use the
existing scoped Postgres ledger. Direct ledger reads are trusted persistence
APIs, not authorization endpoints.

Wire the hook into every application assembly that can execute native tools,
including external/live approval runtime factories. `createHandrailAssistant`
passes it to its internal application; separately host-created applications
still require `toolAdmission` explicitly.

## Execution versus history

| Route/path | Current admission behavior |
| --- | --- |
| `application.executeTool`, application tool loops, native provider tools | Every tool execution attempt is admitted, including exact receipt replay and in-flight joins. |
| Authenticated `/capabilities`, `/turns/start`, `/turns/resume` | Transport creation can recover pending turns. Recoverable work reaches native tool admission if the provider/tool loop retries execution. New starts and resumptions retain durable identity checks and conversation authorization. |
| Repeated completed turn start/resume | Observes stored transport events; it does not execute a tool again. Authentication/conversation access govern that history. |
| `/synchronization` history read | Reads authorized canonical history; mutation permission loss alone does not redact previously authorized conversation content. Reconciliation/confirmed-approval continuation can independently initiate work, which must pass admission. |
| `/approvals/transition` | Authorizes the decision and proposal scope. Confirmed work resumption passes admission before execution claims or receipt reuse. A decision receipt is historical approval state, not authority to dispatch. |
| Explicit recovery workers | Trusted recovery context and conversation access are still required; any execution attempt passes admission. |

There is no public HTTP endpoint that directly accepts a raw ledger execution
key. Native runtime keys are derived from trusted scope, conversation, turn,
and provider tool-call ID. A pending turn after a receipt commit can still reach
an exact retry through authenticated recovery; this is covered by a deterministic
HTTP gateway regression. See [verification evidence](verification/execution-admission-2026-09-15/README.md).

## Required ERP follow-up

This SDK change is intermediate evidence for Owner Goal
`78ef936e-bf4b-4926-8dce-49904c8c0047`, task
`affc30b6-98d3-43a7-a895-3f5d407200bb`, item
`ee8f9c67-ac58-4e7b-9c67-f20954047ce8`. It does not establish that ERP is fixed.

After the authorized SDK finalization path publishes a real commit, commission
ERP adoption through that same Owner Goal:

1. Pin `https://github.com/c0x65o/handrail-sdk-ai-assistant-js` to the resulting
   full commit SHA. Synchronize `package.json`, `package-lock.json`, and
   `allowScripts`. Keep SDK compilation in the normal installation pipeline.
2. In native admission wiring, freshly call `resolvePrincipal`, reject missing
   or mismatched principals, enforce account scope and namespace availability,
   and call the mutation's `isAuthorized` before allowing admission. Share this
   logic with existing dispatch checks; use no duplicate executor or ledger.
3. Re-run real consumer regressions with actual application and Postgres ledger,
   including the removed `first-reopen` exact-key denial assertion for both
   `finance.period-close.prepare` and `finance.manage`. Cover recreation, stale
   and refreshed discovery, missing/mismatched identity, permitted replay,
   unchanged receipts/domain side effects, and HTTP authenticated recovery.
4. Verify the consumer's cookie binding, history authorization and approval
   behavior, then run its scoped checks. Serialize edits to accounting-period
   tests, native admission files, and dependency manifests with sibling work.

No ERP/mobile edits, deployment, credentials, or provider actions are part of
this SDK implementation request.
