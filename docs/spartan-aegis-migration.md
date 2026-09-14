> Historical qualification record. The September 13 owner decision discards old chats. Current Spartan code uses the shared workspace and SDK stores, with no history importer, legacy UI fallback, or old chat schema models. See the host `docs/aegis-handrail-ai-integration.md` and the disposable-history path in `docs/adoption-standard.md`; the earlier requirements below do not apply to that cutover.

# Spartan Aegis 0.2 migration and qualification record

Spartan consumes the same supported integration as Mills: the high-level
`createHandrailAssistant` server and endpoint-only
`HandrailAssistantLauncher`. Aegis remains Spartan's product name and domain
adapter; it is not a second SDK or UI implementation.

## Current composition

Production wiring constructs `createSpartanAegisAssistant` once in
`src/server/features.ts` and mounts its protected gateway at
`/api/aegis/handrail-ai`. `src/server/aegis/handrail-ai-gateway.ts` maps the
standard `ChatRequest` into the existing Aegis service request. The SDK owns:

- gateway negotiation and resource routing;
- synchronization, canonical activity, replay, cancellation, and durable turn
  state;
- scoped catalog/approval resource exposure through explicit migration seams;
- normalized usage receipt capture and the durable Postgres outbox;
- presence/activity delivery, including Spartan's existing Postgres pub-sub;
- browser workspace lifecycle, background turns, approvals, citations,
  Markdown, Copy, Stop, Retry, and automatic titles.

Spartan continues to own and test:

- opaque-session authentication and same-origin enforcement;
- company/principal/session derivation and cross-company denial;
- Aegis prompts, provider behavior, bounded transcript/tool policy, hosted
  search, citations, and request-scoped Handrail connector;
- role-filtered tool discovery, Zod validation, proposal staging, confirmed
  mutations, business audit, and existing Aegis records;
- protected attachment upload and resolution;
- provider/model configuration and the application database/pool lifecycle;
- Aegis name, orange theme, navigation, and the temporary legacy fallback.

The domain service still records `aegis_turn_activity` during the rollback
window. The high-level adapter disables the former generic live-activity and
durable-transport wrappers, so only the SDK publishes canonical gateway
activity and owns generic durability. Remove the domain rollback record only
after its observation gate closes.

## Standard browser surface

`src/client/features/aegis-assistant/HandrailAiAssistant.tsx` is a thin
`HandrailAssistantLauncher` composition. It supplies the endpoint, protected
request hook, stable client/device identities, theme, authorized uploader,
page text, and fallback. It does not implement a second runtime, synchronizer,
thread picker, approval panel, citation renderer, or title coordinator.

The default is multi-conversation. Closing the launcher never cancels a turn;
only Stop does. Attachment upload remains Spartan-owned temporarily because it
must resolve the existing authenticated binary route. The legacy Aegis button
remains a one-step rollback while the release and observation gates are open.
`AEGIS_HANDRAIL_AI_CLIENT=handrail_ai` is the standard default once the durable
gateway is available; `legacy` is the explicit client rollback.

## Telemetry contract

Handrail auto-provides the AI Runtime binding. Spartan calls
`usageFromEnvironment()` and derives authoritative organization, project,
service-environment, known-user, and session attribution from the trusted
binding plus authenticated actor. It does not inspect ordinary env inventory
to decide whether telemetry is available.

Every provider invocation, including unavailable usage on failed/cancelled
invocations, becomes a normalized receipt with stable turn, attempt, and
continuation identities. Capture resolves after the receipt is durable; a
best-effort flush, startup drain, interval worker, and graceful-shutdown flush
deliver it. Telemetry failure cannot fail the user turn. Retryable delivery
keeps the row pending, permanent rejection dead-letters it, and the receiver
deduplicates by `usage_receipt_id`.

Qualification includes a mounted high-level Aegis turn that checks the actual
Telemetry receipts endpoint and authoritative provider/model/tenant/user/
session/token fields. SDK tests separately prove startup drain, transient
retry, durable pending attempts, acknowledgement, and permanent-failure
handling. Handrail's AI Runtime report is the final runtime receipt proof.

## Recovery and multi-instance behavior

Spartan must not persist or reconstruct an opaque application session token at
boot. `recoverPendingOnContext` therefore performs a bounded recovery scan when
that trusted session is next authenticated. The existing Postgres notification
bridge is passed to the high-level assistant for cross-instance activity and
presence. Durable activity snapshots and polling remain convergence fallback
when notifications are delayed or dropped.

Shutdown order is: flush/stop the assistant usage worker, stop remaining app
services, close live pub-sub, then close the database pool.

## Rollback and removal

The former low-level gateway and legacy Aegis UI/routes remain reachable only
as bounded rollback paths. They must not receive new generic features. Rollback
selects the previous client/server path and immutable package pin; it does not
delete SDK tables or rewrite reconciled domain rows.

Do not remove the rollback path until all of these are true:

1. the real `@handrail/ai-assistant` 0.2 artifact is pinned by full commit SHA
   with a clean lockfile install;
2. package and real-consumer conformance gates pass;
3. representative roles preserve tool discovery, proposals, confirmations,
   hosted search, citations, attachment authorization, and provider policy;
4. reconnect, cancellation, restart recovery, multi-device convergence, and
   multi-instance pub-sub pass;
5. successful, failed, and cancelled receipt parity matches the Handrail report
   through the observation window;
6. a rollback rehearsal succeeds without data repair.

Only then delete the old custom client bootstrap, low-level generic gateway,
duplicate sync/activity/usage code, and their tests. Never delete Spartan's
domain authorization, Zod schemas, tool policy, provider policy, proposal/
confirmation authority, business audit, or retention rules as SDK cleanup.

## Checked evidence

- `tests/aegis-handrail-ai-ui.test.ts` proves the client uses the standard
  launcher and only Spartan-owned seams.
- `tests/aegis.test.ts` proves protected high-level capabilities, same-origin
  and authentication denial, a real PGlite durable turn, provider execution,
  and authoritative Telemetry receipt payload.
- `tests/aegis-handrail-ai-postgres-live-delivery.test.ts` proves Postgres
  cross-instance activity fan-out and listener cleanup.
- the SDK `test/server-assistant.test.ts` proves trusted-context recovery and
  usage worker startup/retry behavior.
- the SDK `test/postgres-assistant-foundation.test.ts` proves durable receipt
  enqueue, retry attempts, dead-lettering, and acknowledgement.

The tracked Spartan manifest and imports now use canonical
`@handrail/ai-assistant`, pinned to the reviewed 0.2.1 commit with a regenerated
lockfile. The UI repair described in the rollout qualification record must receive
its own reviewed immutable SHA before Spartan advances its pin.
