# Application gateway wire protocol v1

`handrail.application-gateway.v1` is JSON over HTTPS with SSE turn delivery. The TypeScript `@handrail/ai-assistant/client` entry works in browsers and React Native runtimes that provide Fetch, AbortController, ReadableStream, TextDecoder, and crypto-grade application IDs. The Dart reference client is in [`handrail_ai_client`](https://github.com/c0x65o/handrail-sdk-ai-assistant-flutter/tree/main/packages/handrail_ai_client).

All endpoints are relative to an application-owned mount path. Every request must pass the application's authentication, authorization, origin/CSRF, rate-limit, concurrency, body-size, and idempotency controls. Provider credentials never enter a client.

- `GET /capabilities` returns cancellation, attachment limits/media types/upload URL, presence, conversation activity, and sync support.
- `POST /activity` with `{operation:"list"}` returns the authorized launcher index; `{operation:"mark_read",conversationId}` clears unread state. The same protected request identity scopes both operations.
- `GET /activity` optionally streams the authorized activity index and updates as `activity` SSE frames. Clients retain `POST /activity` polling to converge after stream loss or a missed multi-instance publication.
- A running activity record may include a bounded `summary` and optional
  `progress:{completed,total,unit?}`. Clients should show the newest running
  summary in their shared launcher/work indicator. These fields are
  non-authoritative status and never substitute for tool or approval events.
- `POST /turns/start` accepts `StartTurnInput` and streams `started`, `event`, then exactly one `terminal` SSE frame.
- `POST /turns/resume` accepts the conversation/turn IDs and last event ID, opaque cursor, and revision. Replayed events must be idempotent.
- `POST /turns/cancel` requests authoritative cancellation using a distinct mutation and idempotency key. Closing an SSE connection only disconnects that device.
- `POST /synchronization` admits canonical message mutations before provider work.
  A successful HTTP envelope can contain a synchronization failure in `value`:
  `unauthorized` means access was denied; `temporarily_unavailable` permits a
  bounded retry; `rejected` means the batch was not admitted and must be corrected.
  A rejection includes a fixed safe `code` and `message`, such as
  `attachment_expired` with an instruction to select the file again. Do not start
  the turn, acknowledge the send, or automatically retry a rejected batch. Keep
  the user's composer draft available for correction. Rejection callbacks receive
  the original pending mutations before they are removed from the resend queue.
  Adopt a Flutter client revision that understands `rejected` before enabling
  retained-file admission; older Flutter clients label this unknown result retryable.

Each `event` frame contains `{type:"event", event, checkpoint}`. Canonical `StreamEvent` values represent text, citations, tool calls/results, approvals, attachments, errors, usage, cancellation, and completion. Presence uses separate `handrail.live-presence.v1` ephemeral frames and must never be appended to the conversation event log.

Clients must ignore unknown additive fields and event types they do not render, reject an incompatible major protocol string, preserve opaque IDs/cursors byte-for-byte, and resume only after durably applying the associated event. Servers must bound JSON/SSE sizes, redact public errors, authorize every conversation and attachment, and never trust client-supplied tenancy or actor identity.
