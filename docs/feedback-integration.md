# Feedback integration qualification — 2026-09-17

This candidate repairs two demonstrated shared SDK gaps: MCP draft-07 tool
schemas now validate using their declared dialect, and cancellation during
discovery authorization or connection establishment stops subsequent work.
It does **not** establish a production feedback integration or real-model dev
acceptance. The canonical enhancement readback contract currently fails through
the pinned connector. No intake, model call, service, deployment, or project
configuration mutation was performed.

## Exact source and dependency evidence

| Package | Observed version | Public committed source |
| --- | --- | --- |
| `@handrail/mcp` | 0.2.1 | `https://github.com/c0x65o/handrail-mcp.git#eb879d767d05c7c2e15748f6fe7838294b980d82` |
| `@handrail/bug-reporter` | 0.4.50 | `https://github.com/c0x65o/handrail-sdk-bug-reporter-js.git#7dfb33f548448f864cf957f19d96f8b5a27bc787` |
| `@handrail/enhancement-reporter` | 0.3.46 | `https://github.com/c0x65o/handrail-sdk-enhancement-reporter-js.git#ec7cde72fe44b1cb3c6905d4a43d9629ec6ad2ce` |

These are source observations, not a compatibility-catalog or deployment
attestation. MCP is a dev dependency for the offline qualification; the two
reporters were source-inspected, not installed. MCP itself depends on
`@modelcontextprotocol/sdk@1.30.0` and `zod@4.4.3`. The qualification declares the
MCP SDK dependency directly because it imports `Client` and `InMemoryTransport`.
The package manager lock records the exact commit. No runtime dependency was
added to the provider-neutral SDK.

MCP exports `.`, `./client`, and `./server`. Its root exports
`createConnectorServer`, `loadFeedbackRuntime`, `resolveFeedbackConfig`, and
`FEEDBACK_TOOL_NAMES`. `createConnectorServer` returns a standard MCP `server`;
the example connects it to `Client` through `InMemoryTransport.createLinkedPair()`.
This is an actual supported in-process MCP transport, not a new endpoint.

Both reporter packages export `.`, `/server`, `/react`, and `/package.json`.
The bug server exports `createRequestScopedBugReporter(config).forRequest(context)`;
its resolver is invoked per policy/submission attempt. Enhancement exports
`createRequestScopedEnhancementReporter(config).forRequest(context)` asynchronously,
requires a current session resolver, and creates a request-local transport.
Both also export same-origin server handlers. Node requirements are >=18 for
the bug package and >=20 for enhancement/MCP; this SDK requires >=20.

### Guidance drift

The attached published feedback v2 KB says MCP composes independently installed
reporter server adapters. Committed MCP 0.2.1 instead implements independent
canonical HTTP transports, imports neither reporter package, and explicitly
tests that independence. Reporter absence as an npm package therefore does not
disable MCP tools; missing/disabled *runtime configuration* does. Resolve this
publication discrepancy before claiming compatibility with both contracts.
Do not add unused reporter dependencies to pretend package presence is checked.

The SDK implementation KB still names `@handrail/ai` and a same-repository
Flutter directory. Current source is `@handrail/ai-assistant@0.2.55`, and Flutter
is a separate sibling repository. Older direct Work Request intake guidance is
superseded for customer feedback. Moving Git examples in package READMEs are
superseded by the assignment's full-SHA public HTTPS dependency requirement.

## Identity, tools, receipts, and the concrete blocker

The model must never choose identity. MCP receives the authenticated current raw
application session only in trusted server configuration. Bug transport sends
it in `x-handrail-application-session-token`; enhancement transport sends it in
`x-handrail-application-session`. Credentials use server-side bearer headers.
Neither belongs in tool arguments, provider context, persisted conversation
events, diagnostics, or client responses. Do not put a session in the high-level
assistant authorization context: that context is cached and used in execution
scope derivation. Re-resolve current identity and authorization at execution and
before receipt replay; discovery alone grants no execution authority.

Canonical discovery is required independently for each reporter:

- Bug: exact project/environment, service-bound server configuration, and
  `schema_version: 1` policy with `reporter.identity_verified === true`.
- Enhancement: `contract_version: "v1"`, `enhancement_reporting.enabled === true`,
  authenticated `known_users_direct_session` principal, and matching capability,
  project, and service environment IDs.

MCP's config parser also accepts `1`, `yes`, and `on`; the enhancement KB requires
literal `true`. A future host must parse the server enable value strictly before
passing configuration. Missing fields, a missing session, or failed canonical
discovery must expose no corresponding submission tools. The optional feedback
readiness tool is not permission to submit.

Tool definitions come from actual MCP discovery. The submit operations are
`handrail_bug_reporter_v1_submit` and
`handrail_enhancement_reporter_v1_submit`. Their v1 names are compatible with
the feedback v2 composition name. Bugs use server-derived `event_id` (8–160
characters); enhancements use `idempotency_key` (1–255) and
`external_conversation_id` (1–512). Freeze the payload with the durable user
message/intent before dispatch. A provider tool-call ID is not durable intent.
Each distinct intent needs its own identity, including within one conversation.

Authoritative source evidence was read through Handrail source tools at observed
HEAD `f55b1a9f9b7167cdfb34b0ae479b212963e2a245`; retained source content hashes
identify the actual read bytes, which are stronger evidence than HEAD alone in
a dirty checkout:

- `src/server/services/mobile-bug-reports.js:5267`: submit returns `bug_id`,
  `event_id`, `reporter_identity`, and optional grouping evidence. MCP wraps this
  as `{status: "submitted", statusCode, bugId, response}` and adds `connector`
  metadata to the MCP structured content. HTTP success or `status: submitted`
  alone is not a verified receipt. Match `bugId` to `response.bug_id`, the frozen
  event ID, and verified reporter provenance; retain a minimal identifier view.
- `src/server/services/enhancement-reporting.js:626,790`: submit returns
  `{contract_version: "v1", request, replayed, assessment, assessment_warning}`.
  `request.id` is the canonical enhancement ID, with `submission_kind:
  "enhancement"`, status, terminal flag and other presentation fields. It is
  **not** an Assistant Bridge request or an intake-submission ID. That projection
  does not echo identity/scope/idempotency fields; do not invent them.
- `src/server/api/enhancement-reporting.js:92` and service line 874: owned lookup
  returns `publicRequest` directly, without a `contract_version` field. MCP
  `src/feedback-clients.js` requires that field on every enhancement response.
  The reproducible result is `feedback_transport_contract_mismatch` on canonical
  lookup. The offline acceptance assertion remains failed; no wrapper is forged
  to make it pass. Connector/API owners must reconcile the versioned response
  contract before this integration can safely use authoritative readback.

MCP's feedback HTTP transport creates its own timeout controller and its tool
handlers do not forward MCP cancellation into it. Closing a client is therefore
not proof the remote effect stopped. Uncertain writes must retain their frozen
identity/body and reconcile using an authorized canonical receipt/readback
contract. Never allocate a new intent merely because a response was lost.
In-flight cancellation and lost-response reconciliation remain unqualified.

## Runnable offline preparation and its limits

Run from this repository using Node >=20 and the matching lock:

```sh
npm ci --include=dev --cache "$TMPDIR/npm-cache" --no-audit --no-fund
npm run typecheck
npm run check:package-contract
npm run check:examples
npm run build
node --test test/feedback-contract-qualification.test.mjs
npm test -- --maxWorkers=1 --minWorkers=1 test/mcp-connector.test.ts test/mcp-schema.test.ts test/tool-executor.test.ts test/tool-plugin.test.ts test/tool-incidents.test.ts test/server-assistant.test.ts test/tool-admission.test.ts test/tool-admission.integration.test.ts test/server-tool-admission.integration.test.ts test/postgres-tool-incidents.integration.test.ts test/server-assistant-recovery-authorization.test.ts test/assistant-tool-runtime.test.ts test/response-feedback.test.ts
```

`npm ci` is a reproduction instruction, not a claim it was executed in this run.
The retained command receipts describe actual installs/checks. This worker used
its writable repository and cache; no private network namespace was required.
Previous Vite EROFS and localhost EAI_AGAIN receipts remain historical failures.

[The offline example](../examples/feedback-contract-qualification.mjs) composes
actual `createAiApplication`, `ToolPlugin`, execution admission, and a
request-scoped MCP session using the installed connector and an injected HTTP
fixture. It exercises both submit tools with explicitly labeled DEV QA fixture
content, independent enablement, current host authorization, user isolation,
exact replay/conflicting retries, invalid receipts, remote errors, pre-dispatch
cancellation, cleanup, and minimal output/diagnostic redaction. The fixture is
only an HTTP boundary, not a database or canonical idempotency implementation.
It never reads runtime credentials or calls a live endpoint.

The example is not a real-model assistant or production persistence adapter.
Its one-message identities and in-memory execution ledger are test-only. Local
replay proves the SDK execution boundary, not duplicate-free canonical intake.
No provider input, client route, persistence, approval-resume, transport loss,
post-dispatch cancellation, or live receipt readback is accepted by these fixtures.
Existing diagnostic incident reporting (`createMcpToolIncidentReporter` and its
dispatcher) stays separate: explicit user feedback is not a diagnostic incident,
and incident submission never independently authorizes repair or deployment.

## Cached lifecycle and supported surface

`createHandrailAssistant` caches tool support, assembled applications, and provider
transports using tenant/scope plus a digest of the authorization context. Its
background-worker shutdown is not a generic plugin/session disposer. A raw-session
MCP connector created by cached plugin installation could outlive the request.
This inspection does not justify changing generic cache/disposal semantics.
The offline composition is deliberately request-scoped and closes in `finally`.

The later integration target is authenticated **server text/application gateway**
with the existing provider transport and persistence/approval boundaries.
Browser, React Native, and Flutter remain gateway clients. Voice/realtime,
direct provider remote-MCP, UI redesign, legacy persistence changes, and new
consumer adoption are excluded until separately qualified. No feedback tools or
partial feedback instructions should appear on those excluded surfaces.

## Native dev continuation prerequisites and execution recipe

The previous inventory reported no declared runtime or runbook and no configured
dev Known Users mapping. This assignment did not provision one or establish
runtime readiness. The native runtime owner must supply exact existing host and
runbook identities and obtain any missing scope through the normal parent task.

1. Resolve the connector/API readback incompatibility, cancellation behavior,
   and published adapter-composition drift. Publish compatible source through
   the separately owned normal path; then pin the reviewed full SHA/lock here
   and rerun the failing qualification. Do not release the connector from this
   SDK repository or bypass readback with direct Work Request creation.
2. Select the existing authorized dev host, service environment, native task
   command, and protected text/gateway route. None is assigned by this document.
   Supply a provider binding and exact model ID/version with tool-call support,
   provider wrapper, approved limits, and server-only credential resolution.
   **No live model has been selected or called here.** Record provider/model IDs
   and candidate hash in later sanitized runtime receipts.
3. Supply current verified Known User sessions for two independent users; host
   authentication, tenant/conversation ownership, origin/CSRF/rate limits, current
   tool admission, approval policy, and credential revocation checks. Preserve
   required confirmation through existing approval infrastructure.
4. Verify exact dev bug tuple (`HANDRAIL_BUG_REPORT_ENABLED`, `API_URL`, `PROJECT`,
   `ENV`, `TOKEN`, `SERVICE_ENV_ID`, `TRANSPORT`, all under `HANDRAIL_BUG_REPORT_`)
   and enhancement tuple (`ENABLED`, `API_URL`, `VERSION`, `PROJECT_ID`,
   `CAPABILITY_ID`, `SERVICE_ENV_ID`, `TOKEN`, under
   `HANDRAIL_ENHANCEMENT_REPORTER_`). Keep all values on the trusted server.
   Record safe runtime binding identities separately; never retain tokens.
5. Inspect native Bug Automation, Enhancement Automation and shipping policy
   before intake. An explicit DEV QA label is not an automation hold. The later
   test must be authorized for any consequences of canonical intake; reporting
   itself grants no repair, commit, or deployment authority.
6. Complete the request-scoped real-provider composition with durable, scoped
   frozen intent/payload and receipt storage using the existing host persistence
   pattern. Attach supported MCP tools through existing plugins/admission, not
   a replacement assistant, queue, or intake implementation. On timeout or
   cancellation retain uncertain state for reconciliation.
7. Execute explicit authorized dev bug and enhancement requests through that
   real model and authenticated route. Save model/tool/intent/candidate identity,
   validated canonical receipt and principal-scoped readback. Exercise exact
   retries, changed-payload conflicts, revocation, cross-user access, disabled
   reporters, errors, cancellation and cleanup. Independently inspect provider
   requests, client events, persistence, and diagnostics for credential leakage.

There is no truthful live command line yet: model, native runbook, host, route,
sessions, policy and readback compatibility are unresolved prerequisites. The
commands above are exact offline commands only. A later native run must retain
its exact command and fresh identities rather than substitute invented endpoints
or claim fixture output as real acceptance.
