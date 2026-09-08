# Handrail AI Assistant adoption standard

This document is the canonical implementation and Knowledge Base source for
installing `@handrail/ai-assistant` in Handrail-hosted applications. Every host
uses the same package, server boundary, browser contract, telemetry path, and
conformance gate. Product-specific code is limited to trusted identity/context,
domain tools and policy, provider configuration, persistence inputs, and visual
branding.

Status: this file is the reviewable source intended for publication to the
Handrail Knowledge Base. Repository acceptance does not itself prove KB
publication; [`rollout-qualification.md`](./rollout-qualification.md) records
the current evidence, external gates, and eventually the published entry ID
and revision.

## Package identity and compatibility

The canonical package is `@handrail/ai-assistant`. It replaces
`@handrail/ai` beginning with `0.2.0`; `@handrail/chat` is a separate human-chat
and realtime-messaging product and must never be used as an alias.

Production hosts pin the approved repository URL and a full immutable commit:

```json
{
  "dependencies": {
    "@handrail/ai-assistant": "git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#<40-character-sha>"
  }
}
```

Old immutable `@handrail/ai` commits remain valid for rollback. A host changes
the dependency key, imports, and lockfile in one change; mixed package names are
invalid. From a checkout of this repository, preview or apply the mechanical
rename and then run the adoption gate:

```sh
node scripts/adopt.mjs migrate-package /path/to/host
node scripts/adopt.mjs migrate-package /path/to/host --write
npm install --package-lock-only
node /path/to/sdk/scripts/adopt.mjs check /path/to/host
```

The migration command does not invent an SDK source, change a lockfile, or
convert application architecture. Review its JSON plan before `--write`.
For a new integration, `handrail-ai-assistant scaffold <empty-directory>`
copies the standard React + Node composition templates without overwriting any
existing file. Implement the marked host seams and move the reviewed files into
the application source tree.

## One supported architecture

```text
standard web UI                 custom web/native UI
HandrailAssistantLauncher       headless client/hooks
             \                    /
              protected application gateway
                         |
             createHandrailAssistant
              /       |          \
       host auth   domain tools   provider configuration
                         |
       SDK Postgres replay, approvals, attachments, usage outbox
                         |
            auto-provided Handrail AI Runtime binding
```

The required server entry is `createHandrailAssistant` from
`@handrail/ai-assistant/server/assistant`. It owns protocol routing, capability
negotiation, bounded continuation, durable turns/replay/cancellation,
synchronization, attachment staging, SDK approvals, activity/presence, and
usage capture. Use `postgres(pool)` from the persistence entry and
`usageFromEnvironment()` from the usage-control entry. A host that can safely
enumerate server-trusted service scopes supplies `recoveryContexts`, then calls
`recoverPending()` and `flushUsage()` at startup. A host that depends on an
opaque user credential must never persist or reconstruct it for boot recovery;
the SDK instead recovers that durable scope when it is next authenticated
(`recoverPendingOnContext` defaults to true). Every host calls `flushUsage()`
and `stopUsageWorker()` during graceful shutdown.

Applications using `pg.Pool` call `postgres(pool)`. Applications that already
own a conforming transactional `PostgresSqlClient` call
`postgresFromClient(client)`; they must not copy the SDK store bundle.

The host remains authoritative for:

- authentication and server-derived tenant, principal, session, and scope;
- model-visible context and redaction;
- provider credentials, model choice, and provider-specific policy;
- domain tool schemas, validation, authorization, and side effects;
- existing proposal/confirmation/audit boundaries when they are retained;
- PostgreSQL pool operation, migrations, backups, encryption, and retention;
- theme tokens, product name, and application navigation.

Do not maintain a second generic gateway, synchronization implementation,
usage receipt queue, cancellation protocol, or browser conversation runtime in
a host. A legacy adapter may dual-write during a bounded migration window, but
it stays outside the reusable server boundary and is removed after parity and
rollback gates pass.

`conversationCatalogFor` and `approvalStoreFor` are migration seams for a host
whose existing catalog or confirmation authority must remain canonical (as in
the Mills pilot). They do not authorize a new project-specific protocol or
generic store. Document the retained authority, test it through the high-level
gateway, and remove the seam only when the domain data itself is deliberately
migrated. The default for a new project is the SDK Postgres catalog and approval
store.

## Standard UI offering

The default web experience is `HandrailAssistantLauncher` from
`@handrail/ai-assistant/react/styled`. It is endpoint-driven and owns client
negotiation, catalog hydration, multi-conversation runtimes, background turns,
attachments, presence, activity badges, smart transcript following, semantic
Markdown, citations, Copy, Stop, Retry, conversation-grouped Confirm/Reject
approval review, automatic first-completed-turn titles, accessible status, and
cleanup. Canonical scoped styles are
injected by default, including during loading and failure fallback. Set
`includeStyles={false}` only when the application injects
`StyledChatPresetStyles` once at a higher boundary.

Every standard host supplies only:

- `endpoint` and its existing cookie/CSRF-aware `protectedRequest` hook;
- a product title and trigger label;
- stable `clientId` and `deviceId` where available;
- typed theme tokens, renderer plugins, and documented slots;
- optional approval, citation, voice, empty-state, and footer content;
- `presentation="page"` when the application already owns the drawer/page
  shell; the default `launcher` presentation otherwise; and
- `uploaderForConversation` only when a migrating host retains an authorized
  application-specific upload route.

Automatic title generation and persistence belong to `createHandrailAssistant`.
`openaiResponses` supplies the title provider by default; a custom provider
supplies only `generateTitle`. The server starts generation after canonical
completion and repairs eligible imported history when its catalog is read.
It uses optimistic catalog writes, durable dispatch claims, and separate usage
receipts. Title failures never fail the conversational answer.

Styled and headless React surfaces share `useConversationTitles` to refresh
labels and support older generate-only gateways. Do not put title requests in
application Send/Enter handlers or copy a title coordinator into a host.
`autoTitle={false}` disables that React observer; `automaticTitles: false`
disables automatic generation on the server. See
[conversation titles](./conversation-titles.md) for placeholder configuration,
provider hooks, durable failure semantics, and consumer migration.

The standard is multi-conversation by default. Use the single-conversation
`HandrailChat` composition only for a product requirement that prohibits thread
creation or switching, and record that decision in the host integration file.
Use `@handrail/ai-assistant/react/headless` for React Native or a materially
custom workflow. A headless host owns presentation but must preserve the same
capabilities: background work independent of visibility, near-bottom transcript
following, Jump to latest, semantic safe content, attachment intake, activity,
citations, Copy, explicit Stop, Retry, errors, keyboard/focus behavior, and
narrow/wide layouts. Styling preference alone is not a reason to fork the UI;
use theme tokens, slots, and renderer plugins.

Closing presentation never cancels an admitted turn. Only Stop performs
authoritative cancellation. Unknown tool renderer keys use safe generic output;
renderers never accept raw HTML.

## Telemetry and usage

Handrail supplies `HANDRAIL_AI_RUNTIME_*` values through its service-runtime
binding. Ordinary project environment-variable inventories are not evidence
that this binding is absent. `usageFromEnvironment()` is the only standard
constructor; hosts must not copy its HTTP contract.

The SDK writes one normalized receipt per provider invocation to its
scope-bound Postgres outbox before delivery. Stable receipt, logical request,
attempt, and continuation identities make retries idempotent. Startup draining
and the retry worker must be enabled. A host is qualified only after runtime
evidence shows:

1. application requests and provider invocations in the Handrail AI Runtime
   report;
2. correct organization, project, service-environment, user/session, provider,
   model, turn, attempt, and continuation attribution;
3. reported token totals where the provider supplies them and explicit
   unavailable quality otherwise;
4. successful, failed, and cancelled terminal receipts;
5. delivery after a simulated transient telemetry failure and process restart;
6. no prompt, transcript, attachment, tool arguments, credential, or token in
   a receipt.

The usage binding is observe-only unless the project explicitly adopts the
separate quota-lease enforcement contract. Telemetry failure must not make the
product unavailable, but it must remain durable and observable until delivered.

## Security, persistence, and migration

Authorization runs for every gateway action and tool execution. Client values
never select authoritative tenant, user, role, provider credential, or policy.
Tools that mutate state are either handled by the SDK approval coordinator or
return a proposal into the host's existing confirmation authority; never both.
All retries reuse the original idempotency identity.

Apply SDK Postgres migrations before enabling the new writable path. Releases
N and N-1 must tolerate the expanded schema. Rollback changes application
selection and package pin; it does not delete forward-compatible data. During
dual-write, compare canonical messages, citations, proposals, terminal state,
and usage receipts without repairing divergence by overwriting either source.

Migration order for an existing assistant:

1. inventory host-owned identity, tools, approvals, provider behavior, data,
   attachments, and UI requirements;
2. mechanically rename the package and prove a clean lockfile install;
3. construct and test the high-level server boundary behind the existing auth;
4. qualify the standard UI, or document and test the headless exception;
5. shadow and reconcile representative roles and failure paths;
6. select the new client for a bounded cohort while retaining one-step fallback;
7. prove telemetry, multi-instance recovery, and rollback;
8. retire duplicate generic code only after the observation gate passes.

## Required conformance gate

Run `handrail-ai-assistant check <host-directory>` before host tests. The source
gate checks the package pin, old-name removal, high-level server constructor,
automatic telemetry constructor, recovery lifecycle, and explicit UI path. It
does not replace behavioral tests.

A production adoption must additionally prove:

- clean install, SDK typecheck/build/package contract, and host compile;
- auth isolation across users and tenants;
- tool discovery/denial and proposal-only mutation safety;
- replay, conflicting idempotency, reconnect, cancellation races, and restart
  recovery across application instances;
- authorized image/PDF intake and cross-owner denial;
- approvals exactly once, including stale and repeated decisions;
- safe citations, Markdown, diagnostics, and renderer fallback;
- standard UI at narrow and wide viewports with keyboard/focus checks;
- usage invocation/receipt parity and durable retry;
- no secrets or private payloads in browser assets, logs, diagnostics, events,
  telemetry, or captured evidence.

Record the approved SDK SHA, host commit, migration state, environment, test
commands, runtime receipt evidence, rollback result, and unresolved exceptions.
A failed or missing invariant blocks rollout.

## Thirty-project rollout

Roll out only the already-qualified standard:

1. Mills is the migration and removal pilot.
2. Spartan validates the same boundary with a larger domain-tool catalog and
   preserves Aegis only as product naming and a domain adapter.
3. Two additional low-risk projects validate that no Mills/Spartan assumptions
   entered the template.
4. Adopt in batches of five, stopping a batch on any conformance, telemetry,
   security, recovery, or rollback failure.
5. Start the next batch only after every project in the prior batch has complete
   evidence and no unexplained usage discrepancy.

The rollout inventory tracks each project as `not_started`, `integrating`,
`shadowing`, `qualified`, `rolled_back`, or `blocked`, with its explicit UI mode
and any approved domain exception. Installation count alone is never success.

## Troubleshooting

- Package check fails: remove mixed imports, restore the approved full-SHA Git
  source, regenerate the lockfile, and reinstall cleanly.
- Capabilities are missing: inspect the protected `/capabilities` response and
  server construction; never enable a client feature speculatively.
- History diverges: stop cohort expansion, retain both authorities, and compare
  idempotency, attribution, and event revisions.
- A turn disappears when the UI closes: the host tied runtime lifetime to
  presentation visibility; use the standard workspace lifecycle.
- Usage is absent: verify runtime receipt counts and Handrail AI Runtime report
  attribution. Do not infer binding state from ordinary env configuration.
- Receipts remain pending: inspect the durable outbox and retry diagnostics;
  do not drop or recreate receipt identities.
- A mutation runs before review: disable the tool immediately and restore one
  authoritative proposal/confirmation boundary.
