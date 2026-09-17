# Server feedback integration — preparation, not live acceptance

The JS candidate provides `createFeedbackTools` from
`@handrail/ai-assistant/server/application` and the runnable host composition
[trusted-server-feedback.mjs](../examples/trusted-server-feedback.mjs). It uses
`createHandrailAssistant`, the existing provider transport, ToolPlugin, current
admission, durable approval, gateway and Postgres seams. It creates no listener,
queue, replacement assistant, model binding, migration or intake endpoint.
Only server text/application-gateway is qualified here. Browser/mobile clients
remain gateway clients; voice/realtime and new consumer adoption are excluded.

## Source authority and history

Read the published `handrail-ai-sdk-implementation-contract`, publication
`legacy-kb-revision:664f7487-aeda-476a-8aed-35d93426b07b`, and current source.
Its host identity, policy, persistence and credential boundaries apply. Its
`@handrail/ai` spelling and same-repository Flutter path are stale: this checkout
is `@handrail/ai-assistant@0.2.56`, with Flutter in the separate sibling repo.
The historical handoff's feedback-v2 adapter-composition KB wording was not
freshly verified. Installed MCP independently implements canonical HTTP clients;
it does not import the two reporter packages. Runtime configuration and canonical
discovery determine enablement, not the presence of an npm reporter package.

| Source | Observed version | Full public HTTPS Git pin |
| --- | --- | --- |
| Installed MCP | 0.2.1 | `https://github.com/c0x65o/handrail-mcp.git#eb879d767d05c7c2e15748f6fe7838294b980d82` |
| Previously inspected bug reporter | 0.4.50 | `https://github.com/c0x65o/handrail-sdk-bug-reporter-js.git#7dfb33f548448f864cf957f19d96f8b5a27bc787` |
| Previously inspected enhancement reporter | 0.3.46 | `https://github.com/c0x65o/handrail-sdk-enhancement-reporter-js.git#ec7cde72fe44b1cb3c6905d4a43d9629ec6ad2ce` |

MCP and `@modelcontextprotocol/sdk@1.30.0` remain locked dev dependencies for
qualification/example composition. The reporters are not installed here. No
dependency upgrade, runtime SDK dependency, publication or release is claimed.
The two request-scoped reporter server factories remain host integration options;
this example uses the installed MCP transport's actual exported server instead.

Original owner intervention, initial pause/resume, failed attempts and original
handoff remain authoritative history. Independent review
`e9d8ed1d-f4a1-4270-abcf-9d1864ffce56` tested executor fingerprint
`50f2ee9d0cb5fbf360d64aa317dac1ab42f52a3b78329b83a3f7524885259daa`
at HEAD `81564f969be0ccc2c3a38c3362388476918a4521`. Its 40 regressions and four
lifecycle probes passed; qualification was 9/1 and package execution omitted the
tracked `.env.example`. Those are historical outcomes, not this candidate's checks.
The old schema/cancellation repairs are already committed; they were not reapplied.
Current unrelated workspace changes are preserved and fingerprinted separately.

## Canonical contracts and the corrected fixture

Bug discovery requires schema version 1, matching project/environment and a
verified reporter. Enhancement discovery requires v1, enabled reporting,
`known_users_direct_session`, and matching capability/project/service environment.
Both submit tools are independently exposed only after successful discovery:
`handrail_bug_reporter_v1_submit` and `handrail_enhancement_reporter_v1_submit`.

Bug receipt validation requires `status: submitted`, matching `bugId` and
`response.bug_id`, the original `response.event_id`, and
`response.reporter_identity.verification_result === true`. Enhancement requires
`contract_version: v1`, `request.submission_kind: enhancement`, a nonempty
`request.id`, and boolean `replayed`. HTTP success is insufficient. Enhancement
receipts do not echo principal/scope/idempotency fields; none are fabricated.
Provider/client output retains only `{kind, reportId}`.

Planner/reviewer inspected actual Handrail `enhancement-reporting.js` at
`bc7258425feeda51633b7b140304873f074abfd0`, SHA256
`8e43bfaa3efc608ab6f7d5d0e89fc2fbf4d4f6485083a4987f2315a7bdcaa8f8`.
At lines 874–878 the owned flat `publicRequest` gains `contract_version: v1`.
The corrected HTTP fixture models that source projection; the historical
unversioned response remains a negative test. **Neither fixture executes the
actual platform service/route nor proves release, platform recovery or live intake.**
Preserve repair `6ab5086a-96e4-4ce9-90a6-b4ec7b9312ab`, WR
`be7b9a53-993a-476e-a1a4-7f910dcb5e25`, and manifest proposal
`f961fa8e-db70-4388-9e3a-5bf298c98fe0`. This candidate does not bypass their gates.

## Host composition and responsibilities

Import `createFeedbackGateway` into an existing authorized Node host and supply:

- `assistant`: existing provider adapter/wrapper and exact model, migrated
  `PostgresAssistantPersistence`, authenticated `authorize`, conversation and
  approval authorization, normal diagnostics and lifecycle configuration.
- `feedback.binding`: a non-secret immutable identity for the exact
  project/environment/service binding; `enabled(kind)` returns strict booleans.
- `feedback.authorize`: resolve current principal, scope, reporting permission,
  conversation access and current revocations on every invocation/replay.
- `feedback.resolveIntent`: read the original durable explicit user intent from
  trusted history for the given conversation/turn/kind. It must not use provider
  call IDs or allocate a new identity on retry. Multiple requests in one message
  require separate durable host intent identities. No fixture identity is a
  production implementation of this host-owned mapping.
- `resolveCurrent`: resolve the current raw session and reporter tuple from
  trusted server storage, verifying principal/tenant/scope. No raw session belongs
  in the cached assistant context. The example projects the authorization context
  and opens/closes an actual MCP session for each operation; only definitions
  survive plugin installation. Server enable flags must be literal booleans.

Mount `.handle` or `.express` behind existing authentication, origin/CSRF checks,
rate and request-size limits. Clients must save their canonical user message and
turn through normal SDK synchronization before starting the provider turn. Keep
host-selected confirmation controls: this feedback plugin always requests review
through existing SDK approvals. Reporting never grants remediation/deployment
permission. Stop the assistant's background workers on host shutdown.

The lower-level `createFeedbackTools` returns `plugin`, `admission`, and the
protected host `reconcile` function. Install **both** plugin and admission.
When combining other tools, route their admission to their existing policies;
this feedback admission denies unknown tools. No credential-bearing connector
should be cached in a plugin. Catalogs are installed per authenticated assistant
context; newly enabled reporters require host reconstruction of that context.
Current disablement/admission is checked again even with an older catalog.

## Stable intent, frozen payload, uncertainty and recovery

The SDK derives a digest from binding, tenant, scope, principal, conversation,
durable host intent and feedback kind. It removes `event_id`, `idempotency_key`
and `external_conversation_id` from the model-facing schemas and derives those
fields server-side. Payloads are frozen using existing Postgres CAS documents;
changed content under the same intent fails closed. No raw credential, session,
HTTP envelope or remote error is stored in these documents.

`PostgresAiPersistence.getOrExecuteTool` commits the existing durable admission
claim before HTTP dispatch. Completed minimal receipts replay across plugin
recreation and provider call-ID changes. Cancellation, timeout, invalid receipts,
transport failure and crashes leave admission intact without a completed receipt.
No automatic redispatch, lease expiry, claim deletion or new retry identity is
allowed. Host storage retention must preserve these claims and frozen payloads
for as long as duplicate prevention is required; conversation deletion must not
silently erase them. Storage encryption/retention/migrations remain host-owned.

The pinned connector creates its own HTTP timeout signal. Local AbortSignal or
MCP close does **not** cancel remote HTTP, which may complete after local failure.
Closing a UI remains observation-only. Enhancement's separate remote lifecycle
cancel tool is not exposed by this composition and is not invoked by local Stop.

`reconcile` can verify a saved enhancement receipt through the supported owned
v1 lookup, with current authorization before and after readback. It never accepts
a model-provided report ID and never writes another submission. A completely lost
response has no authoritative report ID: MCP has no supported lookup by original
`event_id`/`idempotency_key`. Such recovery fails closed with
`feedback_reconciliation_required`, identifying the missing authoritative
intent-to-report lookup. Do not infer identity from list/search or resubmit to
recover an ID. The bug submit receipt is verified, but its separate lookup
projection has not been qualified by this SDK assignment; authoritative bug
readback fails closed with `feedback_bug_readback_contract_required`. These are
concrete remaining contract dependencies, not permission questions.

## Verification route and limits

Use the ordinary writable JS repository, preserving tracked
`templates/standard-react-node/.env.example`; do not alter packaging checks or
platform file filters. The matching installed lock is required. Run sequentially:

```sh
npm run build
node -e "import('./dist/server/application.js').then(m => { if (!m.createFeedbackTools) throw Error('missing export') })"
npm run typecheck
npm run check:package-contract
npm run check:examples
node --test --test-concurrency=1 test/feedback-contract-qualification.test.mjs test/feedback-gateway.integration.test.mjs
npm test -- --maxWorkers=1 --minWorkers=1 test/mcp-connector.test.ts test/mcp-schema.test.ts test/tool-executor.test.ts test/tool-plugin.test.ts test/tool-incidents.test.ts test/server-assistant.test.ts test/tool-admission.test.ts test/tool-admission.integration.test.ts test/server-tool-admission.integration.test.ts test/postgres-tool-incidents.integration.test.ts test/server-assistant-recovery-authorization.test.ts test/assistant-tool-runtime.test.ts test/response-feedback.test.ts
```

The gateway test imports the exact runnable factory, uses the actual provider
adapter with a deterministic request function, the actual installed MCP with an
HTTP boundary fixture, and existing migrated disposable PGlite persistence. It
checks request-to-tool-to-approval-to-receipt composition without a model call or
intake. PGlite proves the exercised Postgres SQL/CAS/admission behavior; it is not
an external PostgreSQL server or a platform route test. Retained candidate-bound
command receipts identify passes, failures, later drift and unrun checks.

## Later native dev acceptance — still pending

No services, deploy targets or runbooks are declared. Do not invent endpoints,
credentials, runtime names or a live command. The existing parent must provide:

1. Exact declared authorized dev host/service environment, native operation and
   fresh preview, protected route, candidate hash, runtime/dependency identities,
   exact provider/model and tool-capable wrapper, approved budgets, server-only
   credential resolution and graceful shutdown ownership.
2. Current verified Known User sessions, host durable intent mapping and scoped
   persistence, conversation/approval authorization, revocation and isolation
   policies. Keep raw sessions out of all evidence.
3. Exact bug tuple (`HANDRAIL_BUG_REPORT_` ENABLED, API_URL, PROJECT, ENV, TOKEN,
   SERVICE_ENV_ID, TRANSPORT) and enhancement tuple (`HANDRAIL_ENHANCEMENT_REPORTER_`
   ENABLED, API_URL, VERSION, PROJECT_ID, CAPABILITY_ID, SERVICE_ENV_ID, TOKEN),
   strict enable parsing, canonical discovery and supported receipt readback.
4. Verify the separately owned actual enhancement route/repair/release gates;
   qualify the bug readback projection if using a bug for live proof. Supply a
   supported authoritative intent-to-report recovery capability before attempting
   uncertain-write recovery; otherwise retain the precise fail-closed dependency.
5. Review actual Bug/Enhancement Automation and shipping policy before intake.
   A DEV QA label alone is not an automation hold. Preserve ordinary approval
   gates and authorize the consequences of canonical intake through the parent.
6. Run one truthful explicitly labeled DEV QA bug **or** enhancement through the
   real model and authenticated gateway, retaining exact candidate/runtime/model/
   tool/intent identity and authoritative receipt/readback. Both contracts retain
   regression coverage. Inspect provider, client events, persistence and diagnostics
   for credentials; fixtures cannot replace native acceptance evidence.

No live model/intake, service provisioning, linked-app/platform edit, configuration
change, commit/push/PR, publication, deployment or consumer adoption is performed
or authorized by this preparation. Legacy UI/data remain intact. Worker completion
and retained artifacts do not grant parent-stage or release acceptance.
