# OpenAI audio usage capture

The trusted-server OpenAI transcription and realtime adapters accept an optional
`capture_usage` callback. It must resolve after a durable write. These hooks expose
provider evidence; they do not define Handrail pricing or extend the normalized
v1 billing receipt. Existing callers that omit the callback retain their prior
behavior.

## Recorded-audio transcription

Pass `capture_usage` to `createOpenAITranscriptionCapability` from
`@handrail/ai-assistant/providers/openai/transcription`. Each observation contains:

- The parsed `request_id` and `audio_id`.
- The bounded `provider_idempotency_key` passed to the provider.
- The server-configured `model_id`.
- `usage`, parsed from the provider's JSON `usage` field.

The adapter awaits capture before validating or returning transcript text. If the
caller cancels while the provider is working, the caller stops waiting immediately.
A provider response that arrives later still runs capture. A capture failure does
not issue another provider request. Cancellation is deliberately not passed to the
storage callback. Storage implementations should provide their own bounded write
and shutdown/drain behavior.

## Realtime voice

Pass `capture_usage` to `createOpenAIRealtimeServer` from
`@handrail/ai-assistant/providers/openai/realtime`. Feed it trusted provider-side
events through `handleProviderEvent`; browser-submitted usage is not authoritative.

Two event types yield observations:

| Provider event | Observation operation | Durable identity fields |
| --- | --- | --- |
| `response.done` | `response` | Session ID, operation, provider response ID |
| `conversation.item.input_audio_transcription.completed` | `input_transcription` | Session ID, operation, input item ID, content index |

Observations include `session_id`, `operation`, `operation_id`, `content_index`,
`terminal_status`, and `usage`. Hosts derive authorization, model and billing
attribution from the server-owned session. Input transcription can use a different
model than voice responses; do not assign both operations the same model by default.

The adapter awaits capture before projecting that final event. It coalesces
concurrent duplicate observations by the operation identity above. Changed usage
for a retained identity raises `idempotency_conflict`. A storage rejection raises
`temporarily_unavailable` and permits retrying the same event. Retrying capture does
not create another provider response or execute a tool.

Final usage can be captured after hangup while the session remains tracked, without
reopening the session. An aborted event caller stops waiting while the write
continues. Unknown/untracked sessions cannot capture usage through this server.
The in-process observation cache is bounded to 256 entries per tracked session and
may evict settled entries. It is not a durable deduplication ledger. The host must
retain the identity and immutable evidence in storage across cache eviction,
process restarts, and delivery retries. Applications needing recovery after SDK
session eviction can use exported `parseOpenAIRealtimeUsageObservation` at their
authorized provider ingestion boundary and persist against their durable session.
The parser itself does not authorize a session.

## SDK PostgreSQL evidence storage

`PostgresOpenAIAudioUsageEvidenceStore` is exported from
`@handrail/ai-assistant/persistence/postgres`. Construct it with the existing
`PostgresAiPersistence`, an authoritative tenant ID, and the Handrail service
environment ID. The existing SDK migration must already have created
`handrail_ai_documents`; this addition uses document kind `audio_usage_evidence`
and requires no extra application table or DDL.

`capture({ version: 1, context, usage })` resolves after an atomic durable write.
`context` contains the existing normalized receipt identity/attribution fields,
excluding `version`, `tokens`, and `provider_cost`. It must use provider `openai`,
source `provider`, the actual server-selected model and environment, and a stable
`usage_receipt_id` derived from the operation identities described above. Preserve
that context (including the original occurrence time when supplied) on retries.
Map an incomplete provider response to the existing receipt terminal status
`failed`; retain its reported quantities. The store cannot establish authorization
from caller-supplied context; compose it behind your authenticated server boundary.

The store validates and retains only the context and numerical usage snapshot.
Concurrent identical captures and retries after a lost write acknowledgement
converge to the same immutable record. A different model, attribution or usage for
the same identity raises `PostgresPersistenceConflictError`. An environment mismatch
is rejected before writing. `get(receiptId)` and `list({ afterId?, limit? })` read
only the configured tenant/environment; list returns at most 100 records in receipt
ID order. Rescan from the beginning to discover later inserts before an old cursor.

This is evidence retention for reconciliation. Capturing does not enqueue a
normalized billing receipt, submit telemetry, calculate a price or delete the
source evidence. Once Handrail's audio contract is established, an explicit
reconciliation step can map retained evidence to supported receipts and use the
existing durable receipt outbox with stable identities.

## Quantities and billing boundary

`parseOpenAIReportedAudioUsage` is exported from both adapter entry points and
`@handrail/ai-assistant/providers/openai`. It accepts only the provider `usage`
object and returns one of:

- `type: "tokens"`: input, output and total counts, audio/text/image details,
  cached input totals, and cached modality details. Missing counts are `null`;
  reported zero remains zero. Cache counts are subsets, not additional tokens.
- `type: "duration"`: provider-reported `seconds`, including fractional seconds.
- `type: "unavailable"`: the provider did not include a usage object.

Invalid numeric values or unsupported usage types are rejected. The parser does
not derive totals, durations, costs, or missing modality counts. It drops extra
provider fields and never includes transcript text, audio bytes, credentials,
provider error text, or full response objects.

The current normalized Handrail receipt models token totals and cost but does not
have an established audio modality/duration wire contract in the available project
KB. Retain this evidence without inventing fields, prices, or billable conversions.
Do not report voice billing as qualified until the Handrail contract is wired and
real delivery, pricing and deduplication have been verified. The hooks and evidence store are now included in the two web hosts' vendored
candidate. Mills recorded-audio transcription now uses the shared parser and
evidence store through its existing provider callback. Mills realtime responses
now also retain evidence through the shared parser/store before dependent tools.
Its session does not enable input transcription. Live qualification, voice
approval-policy parity and verified Handrail audio billing remain goal work.

Provider schemas verified against OpenAI's [Realtime cost guide](https://developers.openai.com/api/docs/guides/realtime-costs)
and [transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
Local validation covers the shared parser, transcription cancellation/capture,
realtime lifecycle/capture, retry identity, and safe public failures. It does not
prove live provider or Handrail billing behavior.


## Durable provider operation replay

`PostgresProviderOperationStore` from the PostgreSQL entry point provides a shared
claim/result ledger for host-authorized provider operations. Construct it with the
host tenant and deployment scope, then call `run({ operationId,
requestFingerprint, execute, parseResult })` after authentication and validation.
The host must bind the operation ID to its authenticated owner and request key,
and bind the fingerprint to the immutable request content. Neither field should
contain credentials or raw audio. `parseResult` validates and minimizes JSON data
before storage and whenever a saved result is replayed; saved results can contain
sensitive application content, so the host owns access and retention policy.

The SDK commits a claim before invoking `execute`. A completed call stores its
validated result and replays it without invoking `execute` again. This includes
repairing a lost completion acknowledgement when the saved result can be read.
Concurrent or restarted callers cannot dispatch through an unresolved claim.
`PostgresProviderOperationUncertainError` means a call is still running or its
outcome is unknown; it does not assert that the provider is still active. A caller
may check again with the same key, but must not mint a replacement key and assume
that the old provider call did nothing. Automatic expiry and automatic redispatch
are deliberately absent. A request fingerprint mismatch raises
`PostgresProviderOperationConflictError`.

A failed callback, invalid result, ambiguous admission acknowledgement or failed
completion write can leave an unresolved claim. Hosts must reconcile such claims
with provider evidence before allowing any new dispatch. This store does not
provide a provider-specific reconciliation API or invent missing usage. Durable
usage capture should be part of `execute` so a replay does not submit it again.

The ledger uses the existing `handrail_ai_documents` table with kind
`provider_operation`; no extra DDL is required after the SDK V1 migration.
Every server worker handling the protected endpoint must honor this ledger before
claiming duplicate-request protection. An older endpoint implementation that never
consults the ledger can still dispatch again; mixed-version routing and rolling
rollback require a host deployment plan.

## Primary platform contract audit — 2026-09-05

The read-only Handrail source audit now establishes the v1 invocation receipt
contract and its limits, beyond the earlier KB search. See
[platform dependencies](parity-platform-dependencies.md). Recorded Mills
transcription already sends v1 receipts (known aggregate tokens or unavailable
quantities) and retains separate audio evidence. Mills realtime currently stores
only the evidence and does not enqueue a receipt. Neither path has verified
modality/duration pricing. Current platform validation rejects extra audio fields,
and its price calculator uses aggregate token dimensions. Completing this goal
requires the corresponding platform receipt/pricing decision and durable host/SDK
delivery work; the evidence store alone is not completion.

## Recorded voice host update — 2026-09-06

Spartan's web composer candidate replaces browser SpeechRecognition with an
authenticated host transcription endpoint, defaulting to `gpt-transcribe` and
reusing the provisioned server OpenAI key. It uses the provider-operation ledger,
SQL receipt outbox, and audio evidence store described above. Mills already uses
that model and server credential path.

Browser capture now compares the MIME container independently of native codec
parameters: `audio/webm;codecs=opus` matches a declared `audio/webm`. Different
containers still fail. Both hosts include metadata-only compatibility adapters
for the reviewed SDK pin; bytes are not transcoded. This fixes the false
unsupported-format failure after native recording.

Handrail read-only source revision `2b74faa6bcd6c26d96f62321ecb48745674939fd`
still limits receipts/pricing to aggregate token dimensions in
`src/server/services/ai-runtime-usage.js`. Platform completion requires:

1. A versioned receipt extension for provider-reported audio/text/cache token
   dimensions and duration, preserving unknown quantities.
2. Matching Telemetry ingestion, durable deduplication and forwarding of those
   fields with server-derived project/service-environment attribution.
3. Effective-dated audio model pricing and reconciliation of the retained
   evidence using the original receipt identity, without duplicate charges.
4. Service-scoped AI Runtime credentials delivered alongside the shared OpenAI
   capability and a deployed end-to-end charging check.

These platform changes are outside the current AI Chatbot group's repository
scope (Mills Family Office, Spartan Cyber ERP, Handrail AI Assistant SDK).
No platform configuration or billing schema was changed by this candidate.

Validation: 19 SDK recorder tests, 39 Mills voice/provider/durable-usage tests,
and 9 Spartan recorder/transcription/HTTP-route tests passed. SDK typecheck,
Spartan qualification typecheck, Mills scoped voice typecheck, and scoped lint
passed. A broader Spartan legacy launcher check still expects "Done" where the
unchanged launcher renders "Unread"; Mills' broader qualification includes a
separately edited attachment test assigning to a readonly property. Those checks
are not a passing full-suite result. Provider and Telemetry responses were test
fixtures; no deployed microphone session or live charge was verified.
