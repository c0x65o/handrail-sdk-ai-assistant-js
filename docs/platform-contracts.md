# Platform contracts and package boundaries

The stable contract versions introduced by this platform layer are `handrail.tool-plugin.v1`, `handrail.ai-application.v1`, `handrail.deferred-tools.v1`, `handrail.mcp-connector.v1`, `handrail.application-gateway.v1`, `handrail.live-presence.v1`, `handrail.live-conversation-activity.v1`, and Postgres schema version 1. Patch releases may add optional fields and event kinds. Breaking field meaning, removal, or wire changes require a new version string/export and a migration window.

## Boundaries

- `@handrail/ai-assistant` is provider/framework neutral: canonical events, runtime, transport/store contracts, tool plugins, deferred plans, and presence semantics.
- `@handrail/ai-assistant/client` is React-free and usable by browser/React Native environments.
- `@handrail/ai-assistant/react` remains unstyled; `@handrail/ai-assistant/react/styled` is optional and fully themeable.
- `@handrail/ai-assistant/server/application-gateway` adapts web-standard handlers to Express-like servers without depending on Express.
- `@handrail/ai-assistant/server/application` is the trusted assembly closure for plugins, connectors, host/plugin policy, approvals, bounded execution, runtime, and gateway creation. Its client catalog is data-only.
- `@handrail/ai-assistant/connectors/mcp` depends only on an injected MCP client subset.
- Tool argument validation preserves explicitly declared draft-07 schemas from MCP discovery. Schemas without a dialect retain the existing draft 2020-12 behavior; unsupported dialects fail closed.
- `@handrail/ai-assistant/persistence/postgres` depends only on an injected SQL client subset.
- Provider-specific payloads stay in provider entry points. Database, UI, provider, MCP, and application framework packages must never be imported by the runtime-neutral core.

## Capability negotiation

Clients call `/capabilities` before enabling cancellation, PDF/document input, attachments, presence, activity, synchronization, conversation resources, approvals, or title generation. Unsupported capabilities must not expose callable adapters. Attachment media types and byte/file limits are server authority; client checks are only UX. A protocol version mismatch fails closed.

## Security and privacy

Applications own authentication, conversation/tenant authorization, CSRF/origin checks, rate/concurrency limits, and idempotency fingerprints. Authorize discovery before revealing tool names and authorize execution immediately before the side effect. Treat schemas, tool output, web content, attachments, and persisted JSON as untrusted data. Provider keys and MCP credentials remain server-only.

Application-hosted provider turns should wrap their low-level transport with `createDurableApplicationTransport`. Store `DurableApplicationTurnStore` records in `PostgresDurableApplicationTurnStore`, use an opaque request codec when prompts must not be retained, schedule bounded `recoverPendingPage` tasks from one or more workers (the compatibility `recoverPending` method can scan the complete pending backlog), and expose the result through the ordinary application gateway. Lease ownership, CAS writes, event checkpoints, replay, and cancellation are authoritative across processes; SSE connections are only observers.

Binary attachments belong in application-owned object/blob storage through `createAttachmentStagingService`. Durable records contain authorization scope, expiry, byte/media metadata, and opaque references—not base64 payloads. Resolve immediately before provider use, consume/delete after use when the workflow permits it, and schedule bounded expiry cleanup.

For principal- or session-dependent MCP connections, use `createRequestScopedMcpSession` per message. It authorizes before connecting or listing, authorizes again before every call, forwards the tool-call identity as the idempotency key, bounds the connection lifetime, and provides idempotent cleanup.

The host must close that session in `finally`. Deadlines and cancellation depend
on cooperation from the injected client and its underlying transport. Do not
cache an identity-bearing connection in a long-lived assistant plugin. See
[feedback integration qualification](./feedback-integration.md) for the pinned
canonical connector evidence and the unresolved enhancement readback contract.

Disconnecting a stream is not cancellation. Cancellation uses its own authorized, idempotent mutation. Resume only from a checkpoint durably applied on that device. Presence/typing is expiring and non-authoritative and must not enter transcripts, checkpoints, retention exports, or audit claims. Durable events, proposals, and execution results require tenant-scoped keys, atomic optimistic concurrency, defensive parsing, bounded reads, and encrypted transport/storage supplied by the host.

Conversation activity records may carry an optional bounded `summary` and
`progress` object (`completed`, `total`, and optional `unit`). These fields are
shared launcher/conversation-list status only. They do not grant authority,
replace durable tool lifecycle events, or prove that a mutation completed.

Tool authorization and human confirmation policy are independent. The host
authorization policy can deny execution regardless of approval settings. For
authorized plugin tools, `never` adds no plugin confirmation requirement,
`always` adds one, and `policy` delegates the confirmation choice to the
authenticated project-aware host callback. The host execution policy may
still require confirmation independently.

Postgres migrations run under an application-controlled role. Production deployments should add retention/partition policies, backups/PITR, monitoring, connection deadlines, row-level security where appropriate, and a transaction wrapper that guarantees rollback. The reference adapter never interpolates identifiers or values into data queries.

The high-level Postgres adapters bind one authenticated tenant/scope, validate canonical records, use optimistic versions and durable idempotency identities, and normalize domain conflicts. The host still owns pool sizing, statement/transaction deadlines, migrations, encryption, RLS, retention, backups, observability, and mapping authenticated actors to tenant/scope IDs.
