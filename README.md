# @handrail/ai-assistant

`@handrail/ai-assistant` is the canonical package name beginning with `0.2.0`.
See the [package rename guide](./docs/package-rename.md) when migrating an
immutable `@handrail/ai` pin. New and migrated hosts must follow the
[adoption standard](./docs/adoption-standard.md), which is also the source for
Handrail's implementation Knowledge Base entry.

For styled React chat or Markdown components, install the optional UI peers
`react-markdown@^10.1.0` and `remark-gfm@^4.0.1` alongside React.
Core, client, server, and headless entry points do not load these peers. See
[shared Markdown rendering](./docs/markdown-rendering.md).

Chat can optionally expose a **Bad response** action through the Bug Reporter
SDK. It is disabled by default and requires platform support for manual review
before enablement. See [bad-response reporting](./docs/bad-response-reporting.md).

## Production assistant in one boundary

```ts
import { createHandrailAssistant, openaiResponses } from "@handrail/ai-assistant/server/assistant";
import { postgres } from "@handrail/ai-assistant/persistence/postgres";
import { usageFromEnvironment } from "@handrail/ai-assistant/server/usage-control";

const assistant = await createHandrailAssistant({
  id: "aegis",
  instructions,
  authorize: resolveAuthenticatedUser,
  provider: openaiResponses({ model }),
  persistence: postgres(pool),
  tools: [erpTools],
  usage: usageFromEnvironment(),
  // Use only when the host can enumerate server-trusted contexts at boot.
  recoveryContexts: listAuthorizedWorkerContexts,
});

app.use("/api/assistant/aegis", assistant.express({ origin: applicationOrigin }));
```

```tsx
import { HandrailAssistantLauncher } from "@handrail/ai-assistant/react/styled";

<HandrailAssistantLauncher endpoint="/api/assistant/aegis" />
```

The constructor owns the authenticated gateway, normalized streaming, bounded
provider/tool continuation, durable replay and cancellation, approvals,
attachments, conversation synchronization, activity/presence, automatic saved titles,
usage admission and receipts, authenticated-scope recovery, diagnostics, and capability negotiation. The
application continues to own authentication, domain tools/policy, provider
credentials, and its Postgres pool. See the
[Aegis qualification fixture](./examples/spartan-aegis-high-level.ts) for an
under-100-line migration target; legacy dual-write is deliberately outside the
reusable template.

`openaiResponses` includes a separate text-only Responses API title generator.
The server starts it after a saved turn completes, even when the client has
disconnected. It owns bounded user-message context, usage capture, duplicate
dispatch protection, and catalog persistence. Custom providers can supply
`generateTitle`; custom React surfaces use the shared `useConversationTitles`
hook rather than adding title logic to Send or Enter handlers. See
[conversation titles](./docs/conversation-titles.md) for migration and retry behavior.

Hosts retaining authorized application history or file storage can supply
`openaiResponses.prepareRequest` and `attachmentResolver`. Both receive the
server-owned conversation and authorization context; request preparation also
receives the saved turn and mutation identity. The SDK still owns provider
continuation, tool execution and usage capture. See
[trusted history and attachments](./docs/trusted-history-and-attachments.md).

`@handrail/ai-assistant` is a headless-first TypeScript SDK for provider-neutral chat
state, durable event replay, streaming transports, bounded application tools,
provider-neutral image and document attachment references, structured citations,
optional provider-context compaction, conversation lifecycle contracts, speech,
retries and cancellation, and normalized usage output. UI is optional: the core
runtime has no React or styling dependency.

Node.js 20 or newer is required for package tooling and trusted-server use.

## Supported entry points

| Import | Purpose | Runtime boundary |
| --- | --- | --- |
| `@handrail/ai-assistant` | Protocol, conversation runtime/store/catalog, citations, provider-context, approval, transcription, realtime voice, web-search, event-store and sync contracts, tools, presence, retry, and usage APIs | Runtime-neutral core; direct-provider construction and side effects are trusted-server only |
| `@handrail/ai-assistant/browser` | IndexedDB stores plus generalized image/document attachment intake, audio capture, and WebRTC voice helpers | Browser only; no provider credentials or server-side tool execution |
| `@handrail/ai-assistant/client` | Application-gateway transport and language-neutral wire types | Browser, React Native, and other Fetch/stream clients |
| `@handrail/ai-assistant/conformance` | Deterministic protocol and adapter qualification helpers | Tests and CI; no production side effects |
| `@handrail/ai-assistant/react/headless` | Runtime provider, selectors, and actions with no DOM elements or `react-dom` import | React Native and fully custom React renderers |
| `@handrail/ai-assistant/react` | Optional unstyled React bindings and accessible composition seams for chat, citations, conversation picking, approvals, transcription, and realtime voice | Browser/React; React is an optional peer |
| `@handrail/ai-assistant/react/markdown` | Shared CommonMark/GFM message renderer with scrollable tables | Browser/React; optional Markdown UI peers |
| `@handrail/ai-assistant/react/styled` | Optional responsive styled launcher/dialog/drawer/page preset | Browser/React; theme variables and renderers are application-owned |
| `@handrail/ai-assistant/server/application-gateway` | Express-compatible adapter for the web-standard streaming gateway | Trusted application server only |
| `@handrail/ai-assistant/server/application` | One-call trusted assembly for plugins, MCP connectors, policy, approvals, bounded tools, runtime, and gateway routing | Trusted application server only |
| `@handrail/ai-assistant/server/assistant` | High-level authenticated assistant, provider, durable persistence, usage worker, and HTTP assembly | Trusted application server only |
| `@handrail/ai-assistant/server/assistant-context` | Server-owned principal, attribution, model-profile, tool-context, presence, and untrusted-correlation separation | Trusted application server only |
| `@handrail/ai-assistant/server/managed` | Optional Handrail AI Runtime v1 streaming transport | Trusted server only |
| `@handrail/ai-assistant/server/usage-control` | Server-only AI Runtime admission, hard-denial, and idempotent receipt-settlement client | Trusted server only |
| `@handrail/ai-assistant/server/trusted-server` | Framework-neutral request protection contracts | Trusted server only |
| `@handrail/ai-assistant/connectors/mcp` | Injected-client MCP tool-plugin/discovery adapter | Optional connector boundary |
| `@handrail/ai-assistant/adapters/spartan-aegis` | Supported proposal-only adapter for Spartan's existing Aegis definitions and action registry | Trusted Spartan application server only |
| `@handrail/ai-assistant/adapters/mills-family` | Supported proposal-only adapter for Mills' existing tool runtime, citations, and proposal boundary | Trusted Mills application server only |
| `@handrail/ai-assistant/persistence/postgres` | Injected-client reference Postgres persistence | Optional database boundary |
| `@handrail/ai-assistant/providers/openai` | OpenAI Chat Completions and Responses adapters, including hosted/deferred tool projection | Trusted server only |
| `@handrail/ai-assistant/providers/openai/transcription` | OpenAI transcription capability | Trusted server only |
| `@handrail/ai-assistant/providers/openai/realtime` | OpenAI realtime bootstrap, event normalization, and session authority | Trusted server only |
| `@handrail/ai-assistant/providers/anthropic` | Anthropic provider adapter | Trusted server only |
| `@handrail/ai-assistant/providers/gemini` | Gemini provider adapter | Trusted server only |
| `@handrail/ai-assistant/providers/xai` | xAI provider adapter | Trusted server only |

The provider subpaths accept application-injected request functions rather than
installing provider SDKs. This keeps the application in control of provider SDK
versions, server configuration, and credential resolution.

## Recommended integration paths

Start with the focused [`docs/integration-guide.md`](./docs/integration-guide.md).
Its checked golden path connects an authenticated application gateway to a
headless browser client, the styled single-conversation surface, and the styled
multi-conversation workspace. Use
`createHandrailAiClient({ conversations: { mode: "single", ... } })` when an
application has one fixed chat, or `mode: "multiple"` for catalog lifecycle,
background turns, and unread/error state. The legacy low-level assembly remains
available for custom ownership.

On the trusted server, `createAssistantGatewayAuthorizer` produces one cohesive
context while keeping authentication identity, authoritative attribution,
explicitly model-visible profile data, tool policy context, presence, and
untrusted client correlation hints separate. See the checked
[`examples/golden-authenticated-app.ts`](./examples/golden-authenticated-app.ts),
[`examples/golden-headless-client.ts`](./examples/golden-headless-client.ts),
[`examples/golden-styled-single.tsx`](./examples/golden-styled-single.tsx), and
[`examples/golden-styled-multiple.tsx`](./examples/golden-styled-multiple.tsx).

## Headless quickstart

Supply a `ConversationTransport` and a `ConversationEventStore`, then create one
runtime per conversation. `createConversationRuntime` hydrates its store by
replaying durable history before it resolves; it does not start a network
observation. The process-local store below is suitable for examples and tests.
Use an application-owned durable adapter in production (or
`IndexedDBConversationEventStore` from `@handrail/ai-assistant/browser` for local browser
persistence).

```ts
import {
  InMemoryConversationEventStore,
  createConversationRuntime,
  type ConversationClientId,
  type ConversationId,
  type ConversationState,
  type ConversationTransport,
} from "@handrail/ai-assistant";

declare const transport: ConversationTransport<unknown, AppRequest>;
declare const request: AppRequest;
declare function render(state: ConversationState): void;
declare function showCount(count: number): void;
interface AppRequest { readonly prompt: string }

const runtime = await createConversationRuntime({
  conversationId: "conversation-42" as ConversationId,
  clientId: "web-7" as ConversationClientId,
  eventStore: new InMemoryConversationEventStore(),
  transport,
});

const unobserve = runtime.observe((state) => render(state));
const unselect = runtime.store.select(
  (state) => state.messages.length,
  (messageCount) => showCount(messageCount),
);

try {
  await runtime.restoreActiveTurn();
  await runtime.sendMessage({ content: "Hello", request });
} finally {
  unselect();
  unobserve();
  runtime.destroy();
}
```

The complete credential-free example at
[`examples/headless-runtime.ts`](./examples/headless-runtime.ts) is checked
against the built package declarations. It also demonstrates:

- an injected fake streaming transport and event store;
- automatic hydration, `restoreActiveTurn`, and explicit `resumeTurn`;
- `observe`, `getSnapshot`, and selector subscriptions;
- text plus an opaque image attachment reference;
- `ToolRegistry`, `BoundedToolExecutor`, and `runToolLoop` with explicit limits,
  application policy, and an idempotent execution ledger;
- `stopObserving` versus authoritative `cancelTurn`;
- cleanup and deduplicated `NormalizedUsageReceipt` consumption.

`sendMessage` durably records the local message and attachment facts, while its
`request` is the provider-neutral transport input. The checked example keeps
the protocol image's `content_ref` opaque and records only attachment metadata
in conversation history.

## Unstyled React presentation recipes

The checked [`examples/react-presentations.tsx`](./examples/react-presentations.tsx)
uses the public `@handrail/ai-assistant` and `@handrail/ai-assistant/react` declarations to compose
one credential-free headless runtime as six presentations:

- `ChatDialogRecipe` for a modal;
- `ChatTabsRecipe` for a tab panel;
- `ChatDrawerRecipe` for a side drawer;
- `ChatLauncherRecipe` for a floating disclosure;
- `FullPageChatRecipe` from semantic chat primitives; and
- `CustomHooksChatRecipe` from native application markup plus hooks/selectors.

The recipes include named transcripts, live status, presence and typing,
image/PDF intake and removal, and send, Stop, and Retry controls. Presentation close or
tab-hide handlers only change local visibility; authoritative cancellation is
reserved for the explicit Stop action. The fake transport and uploader are
deterministic and perform no network, provider, or Handrail control-plane call.

The unstyled entry injects no CSS, fonts, branding, layout, or theme. Applications
that want a ready surface can import the one-component `HandrailChat` (runtime,
uploader, and request builder in; complete chat surface out) or `StyledChatPreset` and
`StyledChatPresetStyles` from `@handrail/ai-assistant/react/styled`; every visual can still
be replaced through the unstyled entry, CSS custom properties, slots, and tool
result renderer keys.

For concurrent conversations, use `HandrailChatWorkspace` or
`HandrailChatWorkspaceLauncher`. Their built-in thread picker can create and
switch chats while another turn continues in its independently owned runtime;
the launcher exposes Running, Done/unread, and Error state. Pass
`catalogOptions={{ catalog: client.catalog, authorizationContext }}` to hydrate
every authorized catalog page and expose capability-gated Archive/Restore
controls. The styled transcript follows new and streamed content only while the
reader remains near its bottom; scrolling up preserves position and reveals an
accessible Jump to latest control. Assistant thinking/responding/tool activity
and remote typing are presented with generic labels, and the local participant
is never shown as typing to itself. These conveniences do not alter the
independent headless primitives or custom renderer seams. Pass an optional
server-backed `ConversationActivityReadable` when unopened or remote turns must
also affect the badge. A client renderer plugin only needs stable renderer
implementations plus the data-only `AiApplication.catalog()` result—the styled
surface automatically joins matching plugin identities and renderer keys.

## Application-owned gateway and mobile clients

`createApplicationGateway` exposes protected capability, start, resume, and
authoritative cancellation endpoints as web-standard `Request`/`Response`
handling. `createApplicationGatewayTransport` supplies the matching browser or
React Native transport, including protected-request hooks and negotiated Blob
uploads. The server does not depend on Express; the optional structural adapter
and [`examples/trusted-server-application-gateway-express.ts`](./examples/trusted-server-application-gateway-express.ts)
show an Express mount. `createApplicationGatewayResourceClient` adds typed
conversation lifecycle, approval, synchronization, and title APIs; attachment,
presence, and turn streaming remain negotiated transport capabilities.
`createHandrailAiClient` is the high-level headless bootstrap: it negotiates
capabilities and composes the transport, resource client, catalog, optional
standard runtime registry/workspace, event-store factory, request builder,
attachment upload, presence, and conversation activity. Activity uses protected
SSE updates when available and keeps polling as its convergence fallback. The
styled React preset remains a separate optional entry point so custom web,
React Native, and Flutter UI do not inherit DOM dependencies.

See [`docs/wire-protocol.md`](./docs/wire-protocol.md) for the language-neutral
contract and `flutter/handrail_ai_client` for the tested Dart implementation.
See [`docs/platform-contracts.md`](./docs/platform-contracts.md) for security,
compatibility, package boundaries, and production persistence guidance. The
writable server-authoritative Spartan Aegis qualification mapping is in
[`docs/spartan-aegis-migration.md`](./docs/spartan-aegis-migration.md).
The Mills tool-runtime and rollback-safe adoption path is in
[`docs/mills-family-migration.md`](./docs/mills-family-migration.md).

React Native applications should import the transport, typed runtime/state, and
resource APIs from `@handrail/ai-assistant/client`, and provider/selectors/actions from
`@handrail/ai-assistant/react/headless`. That entry imports neither DOM components nor
`react-dom`; render ordinary native `View`, `Text`, and `TextInput` components.
Inject the platform's protected `fetch`, Blob upload support, and a durable
`ConversationEventStore` backed by application-owned storage. The browser
styled preset is intentionally not presented as native UI: a native drop-in
would impose navigation and design-system dependencies, so native UI stays
host-owned while the complete typed headless path remains shared.

The Dart client includes the same typed gateway lifecycle operations,
`HandrailConversationState`, and `HandrailConversationWorkspace` for keeping
background streams alive across native navigation. It intentionally supplies
state rather than imposing Flutter widgets.

## Direct/BYOK and managed operation

Both credential modes belong on an application-owned trusted server. Browser
and mobile code must call that application server. Never put provider
credentials, managed tokens, or authorization headers in client code, public
configuration, logs, telemetry, source control, or client-visible responses.

### Direct/BYOK on a trusted server

Create one of the four provider adapters on the trusted server, then inject it
into `createDirectProviderTransport`. The host supplies authoritative request,
trace, tenant attribution, and usage-attempt identities. It also resolves
opaque attachment references before provider-native input is constructed.

Pass one `diagnostics` sink to `createAiApplication`, the gateway/client, or a
direct-provider transport to receive correlated provider, gateway, retry, and
tool lifecycle events without prompts or payloads. `createAiDiagnosticLoggerSink`
adapts Pino-compatible structured loggers and removes the host-only error cause;
`createBrowserAiDiagnosticSink` provides the equivalent safe handoff to a
browser telemetry/error reporter with normalized severity. Retain a separate
access-controlled sink only when raw failures are required.

The checked
[`examples/trusted-server-transports.ts`](./examples/trusted-server-transports.ts)
accepts a `ProviderAdapter` from the host and builds the direct transport
without a live provider call or credential literal. Provider-specific adapter
factories are available from the four `@handrail/ai-assistant/providers/*` entry points
listed above.

The direct transport supports authoritative cancellation for active turns in
the current server process. It deliberately has no provider replay store, so a
host requiring reconnect or cross-process resume must supply that durable
server boundary rather than treating local disconnection as provider
cancellation.

### Optional managed runtime on a trusted server

`createManagedRuntimeTransport` from `@handrail/ai-assistant/server/managed` calls the
public Handrail AI Runtime v1 endpoint. Its `fetch` and per-request `getHeaders`
dependencies must be injected by trusted-server infrastructure so rotation and
authorization policy stay outside browser/mobile bundles. The checked trusted
server example accepts both dependencies instead of embedding either.

The managed transport keeps resume snapshots in a process-local map as its fast
path and backward-compatible fallback. Cross-instance restoration after a
refresh or process restart requires an optional trusted-server
`turnStateStore`, which durably retains only the validated replay identity and
canonical request body. The transport negotiates authoritative cancellation,
attachment upload, presence, and synchronization as unsupported. Applications
must inspect `transport.capabilities` and provide host adapters where required;
unsupported capabilities must not be inferred from method names or UI state.

## Lifecycle and consistency contracts

### Durable history and multi-device synchronization

Conversation events are durable, ordered facts. A `ConversationEventStore`
must atomically append contiguous revisions, reject conflicting writes, and
return the original fact for an identical retry. Checkpoints compact replay;
they do not replace the canonical event log. The reference in-memory adapter is
not durable.

Imported `message.created` events place historical messages by their original
`occurred_at`, with stable ordering for equal timestamps. Live events retain
arrival order. Importing an existing message identity does not overwrite its
content or create a turn; hosts must reconcile identities before importing.

Multi-device persistence and delivery remain host responsibilities. Implement
`ConversationEventStore` against application storage and, when devices need to
converge, provide a `ConversationSyncAdapter` to exchange canonical event
envelopes. Retry with stable event IDs, client mutation IDs, idempotency keys,
and logical request/attempt identities. Replayed or redelivered facts must be
idempotent; never retry a side effect under a fresh identity merely because a
connection ended.

`createEventStoreConversationSyncAdapter` is the checked trusted-server
implementation over any conforming event store. It requires application-owned
conversation authorization and a deterministic `canonicalizeMutation`
callback; the server assigns event identity, actor, source, timestamp, and
revision and atomically rejects stale competing batches. Lost-response retries
return the original durable event, while reuse of a mutation identity with
different canonical content fails closed. `createConversationSynchronizationHttpHandler`
mounts its bounded JSON operations behind the application gateway.

On browser, React Native, or other Fetch clients,
`createApplicationGatewaySyncAdapter` supplies pull/read/append and protected
polling subscriptions; the high-level `createHandrailAiClient` exposes it as
`client.synchronization` only when the server negotiates synchronization. In
the standard runtime configuration, omit `runtime.eventStoreFor` to use
`createSynchronizedConversationEventStore` automatically; the runtime then
projects the server's acknowledged canonical envelopes instead of keeping a
second device-local identity. Supply `eventStoreFor` when an application owns
an offline/local-first store and connect it with `createConversationSyncCoordinator`.

The trusted-server adapter accepts client-source proposals by default. Runtime
and usage-receipt proposals remain denied unless the host explicitly enables
them and its `canonicalizeMutation` callback proves each fact against a durable
server turn/provider record. Enabling those switches without that proof lets a
client forge assistant output or metering. Do not advertise synchronization
until provider/runtime-authored facts and client-authored facts share one
canonical server event identity; a read-only migration shadow is parity
evidence, not a completed history cutover.

Presence and typing are ephemeral signals. They are intentionally outside the
durable log and may expire, coalesce, or disappear across disconnects. Do not
reconstruct authoritative messages or turn state from presence records.

For multi-instance Node deployments that already use PostgreSQL,
`createPostgresLivePubSubFromPool` from `@handrail/ai-assistant/persistence/postgres`
adapts an injected `pg`-compatible pool to both live activity and presence
delivery. Pass the returned bridge as `pubSub` to
`createInMemoryLiveConversationActivityDelivery` and
`createInMemoryLivePresenceDelivery`, then call `close()` during server
shutdown. It uses one fixed LISTEN channel with validated logical channels,
bounded payloads, duplicate suppression in the delivery layer, and safe
diagnostics for malformed notifications. LISTEN/NOTIFY remains a latency path:
durable activity, snapshots, and client polling are still the convergence
authority after dropped notifications or reconnects.

### Disconnect, resume, retry, and cancellation

- `stopObserving(turnId)` interrupts only this runtime's local stream
  observation. Durable history is unchanged and the remote turn may continue.
- `resumeTurn(turnId)` reconnects from the latest durable checkpoint when the
  transport can replay that turn. `restoreActiveTurn()` finds the durable
  nonterminal turn after hydration and attempts the same recovery.
- Runtime retries are bounded and reuse the original idempotency identity.
  Transports and servers must make duplicate start/resume operations safe.
- `cancelTurn(turnId, reason)` requests authoritative cancellation only when
  the negotiated capability supports it. Check its structured result:
  `unsupported` and `failed` both mean the remote operation may still run.
- `destroy()` disconnects observations, releases subscriptions, and makes the
  runtime unusable. It is cleanup, not an authoritative remote cancellation.

### Attachments

`AttachmentReference` and conversation content represent images and documents
with provider-neutral metadata. Protocol document types include PDF, XLS/XLSX,
CSV, and TSV; a provider and host advertise the exact supported subset. Every
`content_ref` is an opaque identifier matching
`AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR`; it is neither a URL nor binary content.
Durable conversation events retain only bounded metadata such as kind, media
type, byte size, dimensions/page count, and the opaque reference. Binary image
or document contents, browser `File` objects, signed URLs, and provider-native
blocks never belong in SDK durable metadata.

The host owns binary resolution, file/object storage, authorization, access
revocation, and retention. It must apply the exported MIME, byte, and per-request
count limits before upload and again at trusted resolution. `AttachmentUploader`
adds bounded concurrency, progress reporting, retry of explicitly retryable
failures, and cancellation. Browser helpers include `intakeFileInputImages`,
`intakeDroppedImages`, `intakeClipboardImages`, `intakeFileInputDocuments`, and
`intakeDroppedDocuments`; the earlier PDF-specific `intakeFileInputPdfs` and
`intakeDroppedPdfs` names remain compatibility
aliases. These helpers validate and fingerprint selections without turning
local files into durable conversation data.

Later reuse is a host-domain operation, not permission carried by an attachment
reference. A durable host may retain the authorized binary behind the opaque
attachment ID and expose tools such as “attach this upload to that record.” The
tool must reauthorize the source conversation and destination record, require
the product's normal confirmation policy, and copy through host storage. SDK
staging is intentionally temporary and must not be treated as durable record
storage or as authority to reuse a file.

Document behavior is negotiated, never inferred from an adapter class, method,
or UI control. Inspect `ProviderModelCapabilities` and its `document_input`
field, the matching transport capability, MIME list, count/byte bounds, and
`requires_host_resolution` before enabling document submission.

| Adapter | Current file-input behavior | Provider-context compaction |
| --- | --- | --- |
| OpenAI | Supports the explicitly configured protocol document MIME subset when a trusted host supplies `resolve_document_reference`; otherwise unsupported | Supported only when both injected measurement and compaction operations are configured |
| Anthropic | Explicitly unsupported by the built-in adapter | Explicitly unsupported |
| Gemini | Explicitly unsupported by the built-in adapter | Explicitly unsupported |
| xAI | Explicitly unsupported by the built-in adapter | Explicitly unsupported |

These declarations describe the built-in adapters, not every upstream model or
future host adapter. A host may supply another adapter, but callers must still
negotiate its declared capability rather than assuming support from API
presence.

#### `imageIntake` to `attachmentIntake` migration

The React composer migration is source-compatible. Use `attachmentIntake` for
generalized image/document selection. When both options are supplied,
`attachmentIntake` takes precedence. When `attachmentIntake` is omitted, the
existing image-only `imageIntake` behavior remains available; no immediate
versioned migration is required. The checked
[`examples/react-presentations.tsx`](./examples/react-presentations.tsx) uses
the generalized option.

### Structured citations and provenance

`CitationSource`, `Citation`, and `CitationRecordSet` are bounded,
provider-neutral records. Sources have a stable ID, `web`, `document`, or
`tool` type, a label, and an optional safe public URL or opaque locator.
Citations provide stable identity and deterministic order while linking a
source to an assistant message or tool result. Normalization validates public
URLs, rejects credential-bearing locators, and deduplicates deterministically.

Provider adapters and application tools project only normalized records; raw
annotations and provider-native payloads are not durable provenance. Runtime
turns persist normalized citation/source events alongside their target facts.
Optional `CitationList` and `CitationItem` React seams are accessible,
unstyled, and accept host render/activation policy; the React-free citation
model remains in `@handrail/ai-assistant`.

### Provider-context measurement and compaction

`ProviderContextCapability` and `ProviderContextCheckpointStore` are optional
provider-input acceleration boundaries. They are distinct from event-log
checkpoints: provider-context checkpoints never replace, truncate, summarize,
or otherwise mutate canonical conversation history. The canonical event log
remains the source of truth and is always sufficient to rebuild a turn after a
checkpoint is invalidated or discarded.

`ConversationRuntime` uses provider context only when a host supplies
`ConversationRuntimeProviderContextOptions` through `providerContext` and the
negotiated capability reports
`supported: true`. The fingerprint covers provider/model identity,
instructions, tools, generation settings, and relevant provider settings. It
binds a bounded opaque checkpoint to an exact canonical history position;
fingerprint or history drift, rewind, expiry, corruption, provider rejection,
or version mismatch invalidates the checkpoint. Checkpoints must not contain
prompts, instructions, tool definitions/results, credentials, or native
requests/responses.

Measurement, compaction, checkpoint save/invalidation, and runtime retries are
bounded. Stable idempotency keys and optimistic store versions make retries
safe, and the same abort signal defines cancellation across measurement,
compaction, persistence, and the subsequent turn start.
`InMemoryProviderContextCheckpointStore` is a bounded, non-durable reference
adapter. The OpenAI adapter's `createOpenAIProviderContextCapability` supports
this contract only when both host-injected measurement and compaction request
functions are configured. The built-in Anthropic, Gemini, and xAI adapters
explicitly report unsupported; use a host-supplied adapter to add support
elsewhere.

### Conversation catalog and runtime ownership

`ConversationCatalog` is a storage-neutral lifecycle contract. Its `list`,
`create`, `get`, `rename`, `clear`, `archive`, `restore`, and
`permanentlyDelete` operations specify pagination/ordering, bounded metadata,
capability checks, optimistic versions, idempotency, and
authorization-before-disclosure hooks without requiring a database.
`InMemoryConversationCatalog` is a bounded, process-local reference for tests
and development; it is non-durable. Persistence, authorization, and the
separate content-clearing operation are host-supplied.

`ConversationTitleGenerationService` invokes an optional bounded host title
hook and falls back deterministically to sanitized first-user text or
`DEFAULT_CONVERSATION_TITLE`; catalog titles are labels, not transcript
storage. Hosts should use `ConversationRuntimeRegistry` (or an equivalent
host coordinator) to maintain one `ConversationRuntime` per open conversation,
share concurrent `open` calls, and clean up runtimes across `release`, archive,
clear, deletion, and `dispose`. `ConversationPickerRoot` and its companion
primitives plus `useConversationPicker` provide optional accessible, unstyled
composition; they do not add storage, authorization, or a database.

### Tools

Tool discovery does not authorize execution. `ToolRegistry` exposes only
definitions selected for the current context; `BoundedToolExecutor` separately
applies schema validation, application policy, time/concurrency/result limits,
and a `ToolExecutionLedger`. Production ledgers must make a repeated tool-call
ID return the first execution promise/result. `runToolLoop` adds bounded
continuations and records public lifecycle evidence, but the application still
owns tool side effects and approval policy. The Postgres ledger commits a claim
before dispatch and reuses completed results. A claim without a result stops
retries until the host can reconcile the domain outcome; see the
[crash-recovery and upgrade contract](docs/integration-migration.md#tool-execution-admission-and-crash-recovery).

### Durable human approval

Approval proposals move through `pending`, `confirmed`, `rejected`, `expired`,
`executing`, `executed`, and `failed` statuses. Proposals may carry a group ID,
an expiration, an optimistic version, and either bounded redacted reviewed
arguments or an opaque host reference/digest to sensitive arguments. Never put
sensitive tool inputs into proposal metadata or audit events.

`ApprovalProposalStore` is host-persistable;
`InMemoryApprovalProposalStore` is bounded and non-durable.
`createApprovalCoordinator` performs permission-checked, versioned,
idempotent confirm/reject/expire decisions for one proposal or a group.
`createApprovalExecutionCoordinator` lets `BoundedToolExecutor` resume only an
exact confirmed proposal, re-authorize it, verify its argument binding, claim
execution, and record a terminal result. Stable proposal, decision, and
execution identities make confirm, reject, claim, settlement, retries, and
restart/resume idempotent; a failed execution can be explicitly reclaimed
through a new version. Expired, mismatched, stale, rejected, or unauthorized
proposals cannot execute.

Approval and authorization are separate decisions. A plugin declares each
tool as `never`, `always`, or `policy`: `never` adds no plugin confirmation
requirement, `always` always adds one, and `policy` calls the trusted host's
`approvalPolicy`. The callback receives the authenticated application context,
so one project can require confirmation while another can allow the same
authorized bulk tool to run directly. The host execution policy can still deny
or require confirmation for any tool:

```ts
const assistant = await createHandrailAssistant({
  // Authentication and role/tenant authorization still belong here.
  toolPolicy: authorizeToolExecution,
  approvalPolicy: ({ applicationContext }) =>
    applicationContext.project.approvalsRequired
      ? "require_approval"
      : "allow_without_approval",
  // Example budgets for long bulk tools and the complete multi-step request.
  toolExecutorLimits: { timeoutMs: 5 * 60_000 },
  toolLoopLimits: { maxElapsedMs: 15 * 60_000, maxIterations: 16, maxTotalToolCalls: 64 },
  // ...provider, persistence, tools, and authorization...
});
```

Allowing execution without a confirmation pause does not bypass schema
validation, authorization, bounded execution, the durable tool execution ledger, or
durable tool lifecycle evidence. For a bulk mutation, prefer one domain-level
tool whose transaction and audit semantics cover the reviewed batch instead of
creating one approval proposal per row.

Long-running tools may publish one current summary through the executor
context. The SDK stores it in the same protected, cross-device activity index
used by the launcher and conversation workspace:

```ts
executor: async (input, context) => {
  await context.reportActivity?.({
    summary: "Tracing prior invoice revenue accounts",
    progress: { completed: 18, total: 43, unit: "products" },
  });
  return reconcileRevenue(input);
}
```

`activityForToolCall` on `createHandrailAssistant` can provide the initial safe
summary before a tool has measured its work. Summaries are trimmed and bounded
to 240 characters; progress is optional and bounded to non-negative completed
items not exceeding a positive total. The launcher binding exposes the newest
running `activitySummary` and `activityProgress`, and `ChatLauncherStatus`
renders them by default. Activity is status UI, not authorization or an audit
record; durable tool and approval events remain authoritative.

The standard chat also shows the selected conversation's summary and counts
in one status line while it runs, replacing that line as each step changes.
`HandrailAssistantLauncher` connects activity automatically for both page and
launcher presentations. Custom `StyledChatPreset` and `HandrailChatWorkspace`
hosts pass the client's `activity` store. Progress delivery failures are
diagnosed without failing a mutation, and reports made after tool completion,
cancellation, or timeout are ignored.

The high-level assistant publishes running and terminal activity from durable
server status changes, independently of browser stream consumption. Reloading
or replaying a finished turn does not publish another completion or reset its
read marker. Custom durable transports can observe the same lifecycle through
`onTurnStatusChanged`; callback failures emit diagnostics without changing the
persisted execution outcome.

The default styled chat groups persisted tool calls into one collapsed activity
panel with counts and statuses. Set `toolActivity` to `"expanded"` or `"hidden"`,
or supply `renderToolActivity` for custom presentation. The headless
`ToolActivity` component and `projectToolActivity` selector expose the same
counts without exposing tool arguments or results. Application result renderers
remain separate from activity details.

Built-in multiple-conversation clients using negotiated server synchronization
poll canonical events every second, including while tools run without provider
frames. `synchronizationPollingMilliseconds` controls this interval. Custom
runtimes and event stores retain their own synchronization policy; the runtime
also exposes `synchronize()` and an optional
`synchronizationIntervalMilliseconds`. Poll failures are diagnosed and retried;
destroying the runtime stops polling. Recovery of saved active turns runs in
the background so opening the chat does not wait for execution to finish.

Server activity includes the canonical `turnId` and, when admission history is
available, `turnRevision`. The Postgres activity store uses these fields to
reject delayed updates from older turns and to retain terminal/read state.
`projectConversationActivity` and React `useConversationActivitySnapshot` merge
server activity with open runtimes. The default launcher and thread pickers use
this shared rule: same-turn server completion replaces stale local running
state, while an older turn cannot hide a newer locally admitted request.
Custom thread lists should use the same projection. Older activity records
remain readable; the added fields use the existing JSON document schema.

The high-level server reconciles finished durable turns into canonical transcripts
when the writer finishes and when authorized conversation/synchronization reads
recover missed work. It reuses stored output and the shared runtime projector;
it does not start provider or domain-tool execution. Concurrent browser/server
projection deduplicates frames and retains the winning message identity. Worker
failure and cancellation can settle without a provider terminal frame; successful
completion still requires stored completion evidence. Read-time reconciliation
also retries activity writes that failed after execution finished, preserving
already-cleared read markers.

`toolExecutorLimits` sets each tool's timeout (30 seconds by default);
`toolLoopLimits` sets the overall continuation budget (two minutes by default).
Configure both for longer requests. Tools must honor their abort signal and
use application-owned transactions and idempotency for partial work.

For the invoice-revenue example, the application must supply tools that trace
invoice history, update product accounts, create corrective journal entries,
and compare the two months' P&L. Each step can replace the same activity summary.
The SDK supplies execution, optional confirmation, and presentation; it does
not supply those accounting rules or infer that a P&L comparison proves every
correction is right. Existing hosts that stage their own per-row proposals
must adopt policy-controlled batch executors to use this flow.

Model output and tool discovery never authorize side effects. The trusted host
must perform permission checks at proposal reads/decisions and again before
execution. `ApprovalReviewRoot` and its companion primitives plus
`useApprovalReview` expose accessible unstyled review/grouping seams; they do
not execute tools or decide permissions.

### Transcription

`TranscriptionCapability` accepts one bounded, validated opaque audio reference
with negotiated format/size/duration limits, an abort signal, and a stable
idempotency key. A trusted host resolves bytes only for the operation and maps
failures to safe errors. Retries must reuse the logical identity; cancellation
does not authorize a retry under a new identity. The OpenAI implementation is
available from `@handrail/ai-assistant/providers/openai/transcription` through
`createOpenAITranscriptionCapability` with injected resolution and request
functions. The adapter requests `json`, which supports text-only responses from
the transcription models. Project `speech_hints` supplies vocabulary, context,
and languages; see [project speech hints](docs/speech-hints.md) for the SDK option,
shared environment setting, and OpenAI bridge. Current models use plural
`languages`; legacy models retain their single-language hint behavior.
Detected language is nullable, including multilingual results. If the provider
omits duration, output metadata uses the trusted audio resolver's validated
duration. This display metadata is not a provider usage receipt. The host request
function must capture actual provider usage separately; the capability does not
currently provide durable voice telemetry automatically.

`createBrowserAudioCaptureController` and `intakeBrowserAudio` provide bounded
browser capture/intake without provider credentials. `TranscriptionControlsRoot`
and its optional unstyled companion primitives coordinate capture, host upload,
negotiated transcription, retry, cancellation, and host-owned transcript
application. The credential-free checked recipe is
[`examples/react-transcription.tsx`](./examples/react-transcription.tsx).

### Realtime voice

The provider-neutral realtime contract negotiates WebRTC audio, interruption,
and server-tool capabilities. The host owns an authenticated bootstrap endpoint
and returns only short-lived opaque browser authorization and connection data.
`createBrowserRealtimeVoiceController` manages client media/session state; it
does not receive provider credentials or server tool callbacks. Credentials
and realtime server-side tool execution must stay off clients.

The trusted-server OpenAI entry provides `createOpenAIRealtimeServer` for
authenticated bootstrap, normalized events, and authoritative hangup/cleanup.
`createIdempotentRealtimeVoiceSessionAuthority` makes hangup terminal and
idempotent. A host must invoke authoritative hangup even after local microphone
or peer-connection cleanup, and must bound duration/idle time, revoke provider
resources, stop local media, and make cleanup safe to repeat.
`createRealtimeVoiceServerToolBridge` keeps server tools behind registered
session capabilities, bounded parsing/execution, approval and permission hooks,
idempotent call bindings, cancellation, and safe results; client events are
untrusted requests, not authorization. `RealtimeVoiceControlsRoot` and its
optional unstyled companion controls are shown in
[`examples/react-realtime-voice.tsx`](./examples/react-realtime-voice.tsx).

### Bounded web search

`WebSearchService` orchestrates one injected trusted-server `WebSearchAdapter`.
The SDK does not operate, deploy, or credential an external search provider.
The host authorizes each query, owns HTTP/provider SDK behavior, validates every
result and redirect URL (including DNS/private-network policy), and applies its
result policy. The service enforces bounded query/result/payload sizes,
deadlines, timeouts, cancellation, and bounded idempotency retention; it
deterministically deduplicates accepted source IDs and effective URLs.

`createWebSearchToolRegistration` exposes the service as an optional bounded
tool, and `createWebSearchCitationRecords` projects accepted results into
normalized ordered citations. The credential-free
[`examples/protected-web-search.mjs`](./examples/protected-web-search.mjs)
uses a deterministic injected adapter and performs no external search or other
live network operation.

### Versioned trusted-server request protection

`TRUSTED_SERVER_REQUEST_PROTECTION_VERSION` and
`createTrustedServerRequestProtectorV1` define a framework-neutral protected
request pipeline. Hosts inject origin validation, authentication,
authorization, rate limiting, idempotency reservation/settlement, concurrency
leases, deadlines/cancellation, deterministic public errors, and a bounded
terminal-retention hook. The hook receives public identifiers and outcomes,
not request/result bodies, credentials, or sensitive inputs. These contracts do
not mandate a web framework, database, network topology, or deployment model.

### Normalized usage outputs

`NormalizedUsageReceipt` represents one provider invocation and preserves the
conversation, turn, logical request, retry attempt, and tool-continuation
identities needed for deduplication. Deduplicate by `usage_receipt_id`. Token
and exact base-10 cost fields distinguish `reported`, `estimated`, and
`unavailable`; a known zero is not unknown, and cost strings must not be
converted to floating point.

Receipts are telemetry and attribution outputs, not settlement. Pricing,
metering settlement, credits, billing, ledgers, databases, and authoritative
control-plane policy remain owned by Handrail and are not implemented in this
package.

`createAIRuntimeUsageClient` from `@handrail/ai-assistant/server/usage-control` submits
normalized receipt batches from a trusted application server. Pair it with
`createAIRuntimeUsageReceiptSink` and a host-implemented durable
`AIRuntimeUsageOutbox`, then pass that sink as `ConversationRuntime`'s
`usageReceiptSink`. The runtime durably enqueues each receipt before linking it;
transient delivery leaves the stable receipt identity queued for startup or
worker `flush()` retries. `createHandrailAssistant` wires that Postgres outbox
through its high-level persistence boundary, drains configured recovery scopes
at startup, recovers opaque user-bound scopes when they are next authenticated,
and runs a non-overlapping retry worker by default. Tune this with
`usageDelivery`, call `flushUsage()` for an explicit drain, and call
`stopUsageWorker()` during process shutdown. The token and exact service-environment binding remain
server-only. Empty receipt batches are accepted only when a request is finalized
before provider usage. The helper never accepts prompts, credentials, or raw
provider payloads and does not become settlement authority. Handrail-managed
streams identify Handrail as settlement owner, so their SDK projection cannot
double-submit usage already settled by the managed gateway.

## Host-supplied boundaries

Deployment, file/object storage, authentication implementation, provider
credentials, external-service operation, databases, application-specific
authorization/retention policy, cross-device delivery, and production side
effect ledgers remain host-owned and outside this package. The SDK does not
mandate a web framework or infrastructure. It also does not supply a managed
token issuer, pricing catalog, or billing system. Its narrow usage-control
client consumes those Handrail-owned services without owning them. MCP tools
may be adapted through a separately versioned connector; this
package does not absorb ownership of that connector.

Durable metadata, checkpoints, catalog rows, approval/audit records, usage
records, errors, logs, and telemetry must not retain binary image/document
contents, audio, transcripts, prompts, credentials, hidden instructions,
sensitive tool inputs/results, or provider-native internals. Canonical
conversation events may retain host-selected user-visible message content as
the conversation itself; that explicit product retention is separate from SDK
operational metadata and remains governed by host authorization and retention
policy. Opaque references are identifiers, not permission to copy referenced
content into metadata. Do not log any of the sensitive values listed above.

The React entry is optional and unstyled, while the core remains React-free.
All linked examples are deterministic, credential-free repository examples;
none deploys infrastructure, operates an external service, or performs a live
provider request.

## Development

```sh
npm install
npm run build
npm run check:examples
npm run check:package-contract
npm run check:vite-consumer
npm run typecheck
npm test
npm run lint
npm run pack:dry-run
```

## License

Copyright (c) Handrail. All rights reserved. See [LICENSE](./LICENSE).

### Observing a retained application tool loop

A migrating provider can use `createTransport({ toolActivity, ... })` to connect
its existing domain executor to the shared activity UI:

```ts
const value = await toolActivity.observe({
  conversationId, turnId, signal,
  call: { tool_call_id: providerCallId, name: toolName, arguments: args },
  activity: { summary: "Looking up previous invoice accounts" },
}, async (report) => {
  const value = await authorizedDomainExecutor();
  await report({ summary: "Checking the lookup result" });
  return { value, isError: false };
});
```

This records requested/started/completed or failed tool calls in the canonical
conversation log, publishes a current summary, and returns the original value.
The shared details component only exposes names, counts and statuses. The
observer stores a generic outcome instead of copying domain result data.
Cancellation is shown from the authoritative turn outcome.

The observer is a migration seam, not an execution ledger or approval decision.
The supplied executor must retain its existing authorization, validation,
approval and idempotency rules. Pass the stable provider tool-call identity
through to that executor. New applications should use SDK tool plugins and the
bounded SDK tool executor directly.

When an existing application owns confirmation and execution, publish its saved
proposal before waiting inside the observed tool. Call
`toolActivity.waitForApproval({ conversationId, turnId, signal, expiresAt, read })`
with an absolute persisted expiry in milliseconds. The `read(signal)` callback
returns `{ status: "pending" }` until the existing domain endpoint finishes, then
`{ status: "settled", value: savedResult }`; throw for rejection, missing state,
or failed execution. The SDK serializes reads, reports waiting/settlement, and
bounds slow reads and activity writes by cancellation and expiry (at most fifteen
minutes per observation). It does not execute the approved action again.

`waitForApplicationApproval` from `@handrail/ai-assistant/server/assistant` provides
the same observation without activity reporting. Hosts retain proposal identity,
expiry, authorization, execution evidence, and cancellation policy. Ending a wait
does not revoke an approval or undo an action already executing. Provider time
budgets must explicitly account for the separately bounded human wait.
