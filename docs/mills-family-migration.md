# Mills Family ERP integration reference

This adapter removes generic AI transport, conversation, tool-loop, and UI glue without moving household domain authority into `@handrail/ai-assistant`. Mills keeps its Zod schemas, request-scoped session, household authorization, domain services, proposal persistence, confirmation side effects, and audit rules.

## Minimal tool hookup

Mills' existing `AssistantToolRuntime` is structurally compatible with `createMillsFamilyPlugin`; the ERP does not need to depend on SDK types in its domain layer.

```ts
import { createMillsFamilyPlugin } from "@handrail/ai-assistant/adapters/mills-family";

const millsPlugin = createMillsFamilyPlugin({
  runtime: createAssistantToolRuntime(dependencies),
  proposalToolNames: ["create_task", "update_asset"],
  policy: enforceAuthenticatedHousehold,
  propose: ({ proposal, applicationContext, toolCallId }) =>
    millsProposalStore.stage({ proposal, session: applicationContext.session, toolCallId }),
  presentationFor: (name, kind) => ({
    label: kind === "proposal" ? "Review proposed change" : name,
    rendererKey: `mills.${name}.${kind}`,
  }),
});
```

The explicit `proposalToolNames` list is a fail-closed catalog assertion. A declared proposal tool must return a proposal, and a read tool that unexpectedly returns one is rejected. The adapter has no confirmed-mutation callback: `propose` may only durably stage the unchanged Mills proposal. Mills' existing confirmation endpoint remains the sole mutation authority and must retain authorization plus idempotency checks.

The advertised JSON Schema is validated by the bounded Handrail executor before dispatch. Mills' runtime must still parse with its existing Zod schema and repeat household/role authorization at execution time. Tool definitions and client renderer metadata may cross the gateway; sessions, policies, executors, and proposal payload internals may not.

Read outcomes become application-tool outputs with normalized citations. Supply `citationRecords` when Mills needs richer or multiple sources; the default maps the existing single citation and converts internal application routes to safe opaque `mills:` locators rather than public URLs.

## Rollback-safe migration

1. Snapshot tool names for representative roles and compare the legacy runtime with `millsPlugin.registrations`. Block rollout on missing, additional, or role-inappropriate tools.
2. Run the same tool runtime through the plugin while the legacy provider loop remains authoritative. Compare normalized read outputs, citations, denials, and proposed payloads without executing confirmations.
3. Compose the protected server through `createHandrailAssistant`. Use
   `conversationCatalogFor`, `approvalStoreFor`, and `attachmentUpload: false`
   only as migration seams while Mills retains those authorities. Keep Mills
   stores primary; reconciliation reports identify divergence and never
   overwrite it.
4. Use `HandrailAssistantLauncher` as the default web surface with
   `presentation="page"` inside the existing drawer, Mills theme tokens, the
   protected request wrapper, and Mills' authorized uploader. Use
   `@handrail/ai-assistant/react/headless` only for a deliberately custom host
   experience.
5. Cut reads to the new durable stores only after event identity, ordering, proposal, attachment, and catalog reconciliation converges. Retain a per-tenant rollback switch through the observation window.
6. Delete legacy generic code only after production parity evidence. Do not delete Zod/domain schemas, authorization, proposal confirmation, audit, retention, or household-scoped persistence.

## Required qualification evidence

- Tool discovery parity for each representative household role and denial of cross-household access.
- Schema rejection both before dispatch and at the Mills runtime boundary.
- Proposal-only action tests plus exactly-once confirmation under retry, reconnect, and concurrent approval attempts.
- Image/PDF authorization and rendering, citation targeting, transcription/voice capability negotiation, copy/retry/Stop, and redacted error behavior.
- Starting and switching conversations during active streams; launcher Running, Done/unread, and Error transitions.
- Durable reconnect/cancellation, multi-device event convergence, distributed activity/presence, and multi-instance failover.
- Correlated diagnostics for gateway, provider/upstream/retry, tool/MCP, approval, persistence, attachment, activity, and presence failures without prompts, credentials, or private proposal data.

Record the legacy files and lines retired in the rollout report. Count only code made unreachable after the rollback observation period; shared adapters and retained Mills domain/security code are not removal. The Mills qualification seam must pin one immutable reviewed artifact and record its exact lockfile integrity; preserve the preceding reviewed artifact and the legacy routes for rollback until parity converges.

## 0.2 qualification record

The 0.2 candidate moves Mills server composition to the high-level
`createHandrailAssistant` path. The SDK owns the generic gateway,
synchronization, durable turn wrapper, canonical activity lifecycle, presence,
and durable AI Runtime usage outbox. Mills' transitional provider adapter keeps
the existing provider behavior, Zod/domain validation, request-scoped Handrail
connector, household policy, proposal persistence, citations, and confirmed
mutation execution.

Mills cannot reconstruct an opaque user session token after restart and must
not persist it. The SDK therefore recovers pending work when that trusted
session scope is next authenticated. Hosts with safely enumerable
service-scoped contexts may also provide `recoveryContexts` for boot-time
recovery.

The browser now renders `HandrailAssistantLauncher` directly. The former
758-line `MillsHandrailAiWorkspace` and its 352-line component test are removed,
along with most custom client bootstrap and synchronization code. These are
qualification-source reductions, not a production retirement claim: the
legacy selector and server path remain available until the immutable 0.2
artifact is pinned and the observation gates close.

The checked-in Mills manifest and imports now use canonical
`@handrail/ai-assistant`, pinned to the reviewed 0.2.1 commit with matching
lockfile metadata. The UI repair described in the rollout qualification record
must receive its own reviewed immutable SHA before Mills advances its pin.

## Settled history and resumed approval context (October 2026)

The shared activity projection distinguishes canonical rejected/expired approvals
from execution failures using the turn, tool-call and tool-name association.
It leaves error-shaped provider receipts intact. Conflicting execution evidence,
actual failures and unfinished calls continue to require attention. The standard
React card retains its bound details in collapsed history and can read a missing
tool/proposal pair through the existing authorized display session when revealed.
The Flutter client and widgets permit version-bound read-only inspection after a
decision; only pending proposals remain eligible for decisions.

Mills web still needs a small custom-renderer change. At Mills web commit
`770a14829ef660e055136a09ef9ab884dace6174`,
`src/client/assistant/MillsNativeApprovals.tsx:44` returns only a tool name and
status for every non-pending proposal. Its existing `MillsPendingApprovalCard`
loader at line 61 already renders the saved record and patch. Reuse that loader
and disclosure for settled cards, show the saved status, and render the Confirm /
Reject controls and confirmation prompt only for `status === 'pending'`.
Do not fabricate review arguments from message text or issue a decision when
opening history. `src/server/assistant/handrail-approval-review.ts:42` already
permits settled reads, verifies the exact version and argument digest, redacts
the response and reauthorizes after IO; no endpoint or audit store is needed.
The mobile host's existing `_loadSharedApprovalReview` in
`lib/repositories/sdk_assistant_repository.dart:718` has the same read-only
contract and does not restrict reads to pending proposals.

The reported final prose calling A pending after B was rejected has a separate
model-input boundary. Source inspection establishes the following path; the
specific QA model invocation was not replayed or inspected:

- `src/server/assistant/agent-provider.ts:159` and `:166` add
  `scope.tools.withApprovalContext` when constructing initial Agent input.
  That shared helper describes only unresolved **earlier** proposals and is
  not a live source of truth inside a saved Agent checkpoint.
- The installed Agent SDK pin
  `408a84231fcdb9fedc23e90fc88c280f9fbcc7f0`,
  `dist/server/agent-runtime.js:147`, only calls `host.input` when there is no
  saved run record. Resumption reuses retained input.
- The per-invocation hook in Mills `agent-provider.ts:169` refreshes authorization
  and attachments, but does not refresh approval statuses. Agent SDK invokes
  this hook at `dist/server/agent-runtime.js:274`, including resumed calls.
- Mills `src/server/assistant/agent-host.ts:196` already includes the current
  tool's canonical `native_approval` in its result. Shared runtime regression
  tests confirm A remains executed, B remains independently pending/rejected,
  and restart/replay does not repeat A's execution.

The minimal host remedy is to add a bounded, freshly authorized canonical
approval-status snapshot in `prepareModelInput`, covering the saved approvals
relevant to that run, including settled A as well as B. Associate entries by
proposal/turn/tool-call identity and explicit status; include no argument or
secret payloads. Treat the snapshot as current data that supersedes old status
prose, while preserving the checkpoint's tool calls, outputs and execution
identities. Merely calling the pending-only helper again cannot correct an old
claim about a now-settled A. Do not strip or rewrite messages using regex.
Qualify this host change with A confirmed, B pending across restart, then B
rejected, asserting the final model input has A executed and B rejected.

These host changes and Mills adoption/native QA are follow-up work. Neither
Mills checkout nor any saved QA proposal is modified by this SDK repair. Resolve
the new public full SHA for each SDK after the owning commit/push pipeline; the
pre-repair pins are not delivery pins for the uncommitted changes.
