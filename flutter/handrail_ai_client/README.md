# handrail_ai_client

Flutter/Dart headless client for the application-hosted Handrail AI wire protocol. It negotiates PDF/document, attachment, cancellation, presence, activity, synchronization, and resource capabilities; creates/lists/loads/renames/archives/restores threads; starts, resumes, and cancels SSE turns; uploads attachments; reviews approvals; generates titles; reads/marks and live-streams typed cross-device launcher activity; and publishes/subscribes to typing presence. `HandrailConversationState.apply` provides immutable typed state for text, tools, approvals, citations, attachments, and turn status.

The package deliberately has no Flutter widget dependency. Build fully custom Material/Cupertino UI from the state model, or wrap it in an application-owned widget kit. Authentication remains application-owned through `protectedHeaders`; provider credentials, server executors, actor/company context, and attachment bytes never enter durable client state.

Intentional native difference: the TypeScript package includes optional React styled primitives and renderer plugins; Dart stays headless and exposes typed state/streams for application-owned Material or Cupertino widgets. Browser `Blob` upload becomes `List<int>` multipart upload. Gateway protocol, resume checkpoints, terminal outcomes, approvals, activity, presence, and concurrent-workspace semantics remain aligned.

Version 0.1.1 separates `observationConnected` from server turn status. A
`disconnected` terminal or an SSE response ending without a terminal frame does
not mean the run failed; truncated streams retain the last checkpoint for resume.
Network exceptions still propagate to the host, which should reconnect and query
server activity before deciding that work stopped. Identified/numbered replay
frames are deduplicated, and frames from superseded turns cannot revive old work.

Workspace snapshots merge authoritative activity for open conversations as well
as unopened ones. Activity `turnId`/`turnRevision` prevent earlier turns from
replacing newer work, and known canonical completion cannot be revived by stale
same-turn running activity. Entries expose the shared activity summary/progress.
After a successful server `markActivityRead`, call `markRemoteRead`; merely
selecting an open chat is not a substitute for persisting the read acknowledgement.
A stale same-version unread response cannot undo that acknowledgement.

This package is still headless. Applications must connect protected HTTP and presentation.
`HandrailConversationSession` supplies canonical loading, synchronization, and
observation recovery for an existing conversation. Mills and Spartan mobile now vendor the 0.1.1 source candidate and provide
protected client factories. Mills now composes SDK sessions and pending storage behind an accessible
legacy/SDK selector. Spartan still needs its SDK repository/screen composition;
full native host/provider qualification remains open in both projects.


`HandrailConversationSession.initialize()` negotiates capabilities, loads a
canonical snapshot, and resumes an active turn. Periodic refreshes are serialized;
`read_since` checks avoid rebuilding an unchanged snapshot, while changed or
compacted history is reloaded through the server reducer. Transient initial
failures keep polling. Reconnection never calls `startTurn` or appends a new user
message. Render `document.messages` and the projected workspace state; replayed
SSE text is used for observation/checkpoints and is not appended a second time.

The session retains the last known run when synchronization fails. Its `error`
is distinct from server run status. `requestCancellation` sends server cancellation
with the host's stable mutation/idempotency IDs and waits for subsequent canonical
state before displaying completion. `dispose` cancels this observation and timer,
not the server run or the shared HTTP client. Stream cancellation also aborts
pending HTTP headers. Standard HTTP abortion support requires http >=1.6.0 and
Dart >=3.4; custom HTTP clients should honor `AbortableRequest.abortTrigger`.

For a new turn, call `session.prepareTurn(operationId: uniqueId, clientId: clientId,
request: chatWireRequest)` once. It refreshes the conversation and refuses another
message while a turn is active. `chatWireRequest` follows `handrail.ai-runtime.v1`:
the final message is the new user input; staged image/document references belong
in that message. The application gateway still validates the request and domain
authorization. `prepareTurn` does not write to the server.

Persist the returned `HandrailTurnSubmission.toJson()` in account-scoped storage
before calling `session.submitTurn(submission)`. On an uncertain send response or
app restart, restore it with `HandrailTurnSubmission.fromJson` and submit that same
value. Do not generate a new operation ID for a retry. The SDK atomically appends
the user message, attachment references, and turn admission, then starts execution
with stable IDs. `submitTurn` completes when the server acknowledges the start;
it does not wait for the run to finish. Render canonical run state while work
continues. A completed/cancelled/failed canonical turn is never restarted by this
retry path. Clear a saved submission after successful acknowledgement; subsequent
recovery uses the server-owned turn without a pending start request. Preserve it
after a lost response. On `admission_conflict`, show the refreshed conversation
for review before preparing another submission.

Native host authentication adapters are integrated in both mobile projects.
Mills now wires pending storage and the mode/composer path; Spartan still needs
that composition. Full native host qualification remains open. Gateway qualification uses an
actual Node HTTP server running the TypeScript SDK with in-memory persistence and
a deterministic provider, not a live mobile application or billable provider.
From the SDK root run `npm run build`, then from this directory run
`dart test test/submission_gateway_test.dart --concurrency=1` (Node must be on PATH).
Tests cover lost admission/start replies, session recreation, duplicate sends,
terminal retries, attachment admission, two concurrent threads, unread/read
persistence, and rejection of changed content under a reused mutation identity.


`HandrailProtectedHttpClient` wraps a host-authorized HTTP connection. Pass the
fixed gateway `baseUri`, an `authorize(uri)` callback for host-owned cookies/tokens,
and optionally `receive(uri, statusCode, headers)` to capture session rotation or
handle authentication failure. It rejects requests outside that gateway before
asking for credentials, disables redirects, and preserves abortable streaming
requests. Its default browser client enables browser-managed cookies. The host
must reject old sessions and ignore late responses after logout/account changes;
Mills and Spartan client factories bind a session generation for this purpose.
No cookies or CSRF values enter conversation documents, pending submissions,
activity records or diagnostic events.


`session.sendMessage(..., pendingStore: store)` now performs prepare, durable
retain, submit and acknowledgement cleanup together. `retryPendingMessage(store)`
restores that exact submission. A storage failure stops admission before any
server write; an uncertain admission/start response retains the saved intent.

Use `HandrailPendingTurnStore` for a host's atomic encrypted database, or
`HandrailKeyValuePendingTurnStore` for native encrypted key-value callbacks. Its
namespace must include API realm and authenticated account (and household/company
when applicable). The key-value adapter serializes operations across adapter
instances in the same Dart isolate, refuses to overwrite a different pending
submission and compares the full submission before deleting it. Hosts sharing
storage across processes/isolates must supply database atomicity through the
interface instead. It is an adapter, not unencrypted filesystem persistence.

### Retained realtime voice calls

`HandrailRealtimeCallMonitor` is a headless, conversation-scoped observer for
server-owned voice call records. Supply authenticated `readPage(afterCallId)`
and `requestEnd(callId)` callbacks, subscribe to `changes`, then call
`startPolling()`. Dispose it when leaving that conversation/account. It never
contains provider credentials, SDP or a private provider call reference.

Use `state.unfinished` for recovery controls and `state.canStartCall` for the
presentation gate before starting a new voice session. A failed/incomplete read
retains prior evidence and cannot authorize a start. Ending/ended evidence wins
over older replies. A server acknowledgement of `ending` keeps recovery pending;
only `ended` confirms termination. The host must still authorize/admit starts on
the server; this UI gate is not an authorization boundary or a global mutex.

Polling joins in-flight reads; paging and retained records are bounded. Disposing
stops polling and discards late replies. Hosts should impose transport timeouts
and use account-scoped authenticated adapters. This observer does not re-create a
provider call, resume WebRTC, or infer termination from a missing record.


`HandrailRealtimeActivityMonitor` observes one protected voice call's saved tool
counts. Hosts supply `readPage(details, afterToolCallId)` and dispose the monitor
on account/call changes. Details are off by default; `setDetails(true)` enables
bounded pages and `loadMore()` expands the retained page window. Polling is
serialized. Failed, foreign and regressed reads preserve saved evidence and
surface a safe error. `hasUnresolvedTools` distinguishes missing outcomes from
work on a call still confirmed active. These display records do not authorize
execution and contain no tool arguments or business results.

For endpoints that support completion receipts, activity pages include `unread`
and a scope-bound `readToken`. Supply `acknowledgeRead(token)` and call
`monitor.markRead(displayedToken)` only after that snapshot is visibly rendered.
The monitor queues distinct acknowledgements, joins matching ones, and refreshes
server state after success; it never optimistically clears newer outcomes.
Failures retain unread state and expose `readError`. Hosts should retry on a later
visible refresh, not immediately in response to the error. Hidden/background
views must not acknowledge. Older endpoints without receipt fields still support
counts/details but cannot supply durable read acknowledgements.

`HandrailRealtimeWorkspaceMonitor` observes voice status/counts/unread across
independent conversations without changing text run or text read state. Supply
`readPage(conversationIds, after)`, call `setConversations()` with the current
authorized catalog, and start polling. It queries at most 100 conversation IDs
per request, joins refreshes, bounds total pages (100 by default), rejects foreign,
duplicate, missing or regressed saved records, and ignores late results after
scope changes/disposal. A failed or truncated refresh preserves the previous
whole snapshot and exposes a safe error. `state.forConversation(id)` separates
active calls, calls awaiting end confirmation, unread calls and unresolved tool
outcomes. Reading or selecting a conversation never acknowledges voice results.
Hosts should label cached active state as last reported when an error is present,
show the checking/error state before inferring absence, enforce authenticated
transport timeouts, and dispose/recreate the monitor on account changes.


### Submission admission notification

`sendMessage`, `retryPendingMessage` and `submitTurn` accept an optional
`onAccepted(HandrailTurnSubmission)` callback. It runs after all durable
admission acknowledgements and the canonical turn have been verified, before
starting/observing the provider response. Coalesced callers for the exact same
submission are notified too. A callback exception cannot strand admitted work.
Storage/admission failures do not clear an unsent draft, and a lost start reply
can occur after acceptance: recover the same pending submission instead of
constructing another message. Pair this notification with the Flutter widgets'
`HandrailDraftController` or `HandrailComposerDrafts`, never with a completion-time
text comparison. This additive API is part of the local consolidation candidate.


### Protected transcription

`HandrailGatewayCapabilities.transcription` describes available formats, bytes,
duration and an optional endpoint. `HandrailConversationSession.capabilities`
exposes the negotiated value after initialization. `transcribeAudio` validates
that contract, sends raw audio through the protected client, bounds the response,
and maps safe errors without provider text. The URI remains under the configured
gateway; authenticated redirects are disabled. Pass a cancellation future to stop
observation. A late response cannot be inserted after cancellation; cancellation
alone does not prove the provider never ran.

`transcribeAudioResult` returns a structural `(text, errorCode, retryable)` record.
`transcriptionForConversation(id, capability: capability)` supplies the function
expected by the optional Flutter composer. This keeps the two SDK packages
independent while removing per-host HTTP/error adapters. A retained retry must
reuse its exact recording and key; `outcome_unknown` is never retryable.
