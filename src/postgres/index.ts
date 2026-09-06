import { createHash } from "node:crypto";
import { parseConversationEvent, type ConversationEvent, type ConversationId, type ConversationRevision } from "../conversation/events.js";
import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  type AppendConversationEventsInput, type AppendConversationEventsResult,
  type ConversationEventCheckpoint, type ConversationEventCursor, type ConversationEventStore,
  type ReadConversationEventsInput, type ReadConversationEventsResult,
  type StoredConversationEvent, type WriteConversationEventCheckpointResult,
} from "../conversation/event-store.js";
import {
  ManagedRuntimeTurnStateStoreConflictError,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
} from "../transports/managed-runtime-state.js";
import {
  durableApplicationTurnStartMatches,
  type DurableApplicationTurnDocument,
  type DurableApplicationTurnRecord,
  type DurableApplicationTurnStore,
} from "../transports/durable.js";
import {
  CONVERSATION_SYNC_STATE_SCHEMA_VERSION,
  ConversationSyncStateStoreConflictError,
  type ConversationSyncStateRecord,
  type ConversationSyncStateStore,
  type SaveConversationSyncStateInput,
} from "../sync/persistence.js";
import type { ApplicationToolResult } from "../protocol.js";
import { ToolExecutionIdentityConflictError, type ToolExecutionLedger } from "../tools/executor.js";
import {
  ConversationCatalogError, createConversationCatalogCursor,
  parseArchiveConversationInput, parseClearConversationInput, parseCreateConversationInput,
  parseGetConversationInput, parseListConversationsInput, parsePermanentlyDeleteConversationInput,
  parseRenameConversationInput, parseRestoreConversationInput, parseConversationCatalogDescriptor,
  type ActiveConversationCatalogDescriptor, type ArchiveConversationResult,
  type ClearConversationResult,
  type ConversationCatalog, type ConversationCatalogAuthorizer, type ConversationCatalogDescriptor,
  type ConversationCatalogVersion, type CreateConversationResult, type GetConversationResult,
  type ListConversationsResult, type PermanentlyDeleteConversationResult,
  type RenameConversationResult, type RestoreConversationResult,
} from "../conversation/catalog.js";
import type { ConversationTimestamp } from "../conversation/events.js";
import {
  ApprovalProposalStoreError,
  type ApprovalProposalPermissionCheck, type ApprovalProposalStore,
  type CreateApprovalProposalInput, type GetApprovalProposalInput,
  type ListApprovalProposalGroupInput, type TransitionApprovalProposalInput,
} from "../conversation/approval-proposal-store.js";
import { isConversationApprovalReason, isConversationApprovalReviewedArguments,
  isLegalConversationApprovalProposalTransition } from "../conversation/events.js";
import type { ConversationApprovalProposalRecord, ConversationEventAttribution } from "../conversation/state.js";
import { isConversationApprovalProposalRecord } from "../conversation/state-validation.js";
import type {
  OpenAIResponsesContinuationRecord,
  OpenAIResponsesContinuationStore,
} from "../providers/openai-responses.js";
import { jsonValuesEqual } from "../json-equality.js";
import {
  parseConversationActivityRecord,
  type ConversationActivityRecord,
  type DurableConversationActivityStore,
  retainConversationActivity,
  matchesConversationActivityRead,
} from "../conversation/activity.js";
import { createAttachmentStagingService, type AttachmentBlobStore, type AttachmentStagingMetadataStore,
  type AttachmentStagingLimits, type StagedAttachmentRecord } from "../attachments/staging.js";
import { diagnoseAiOperation, type AiDiagnosticSink } from "../diagnostics.js";
import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from "../usage.js";
import { parseOpenAIReportedAudioUsage, type OpenAIReportedAudioUsage } from "../providers/openai-audio-usage.js";
import {
  createAIRuntimeUsageReceiptSink,
  type AIRuntimeAdmissionInput,
  type AIRuntimeAdmissionResult,
  type AIRuntimeUsageClient,
  type AIRuntimeUsageOutbox,
  type AIRuntimeUsageOutboxEntry,
} from "../server/usage-control.js";

export * from "./live-pubsub.js";

export const POSTGRES_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export interface PostgresQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount: number;
}

/** Compatible with pg and other drivers through a tiny application-owned wrapper. */
export interface PostgresSqlClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<TRow>>;
  transaction<T>(operation: (client: PostgresSqlClient) => Promise<T>): Promise<T>;
}

export interface PostgresPoolQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly TRow[];
  readonly rowCount: number | null;
}

export interface PostgresPoolClientLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresPoolQueryResult<TRow>>;
  release(): void;
}

/** Structural subset implemented by pg.Pool; pg remains an application dependency. */
export interface PostgresPoolLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresPoolQueryResult<TRow>>;
  connect(): Promise<PostgresPoolClientLike>;
}

function postgresTransactionClient(client: PostgresPoolClientLike): PostgresSqlClient {
  return Object.freeze({
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<TRow>> {
      const result = await client.query<TRow>(text, values);
      return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? 0 });
    },
    transaction: <T>(operation: (transaction: PostgresSqlClient) => Promise<T>) =>
      operation(postgresTransactionClient(client)),
  });
}

/**
 * Adapts an existing pg-compatible pool without taking ownership of it.
 * Transactions always release their checked-out client and roll back failures.
 */
export function createPostgresSqlClientFromPool(pool: PostgresPoolLike): PostgresSqlClient {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("A Postgres-compatible pool is required");
  }
  return Object.freeze({
    async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PostgresQueryResult<TRow>> {
      const result = await pool.query<TRow>(text, values);
      return Object.freeze({ rows: result.rows, rowCount: result.rowCount ?? 0 });
    },
    async transaction<T>(operation: (transaction: PostgresSqlClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await operation(postgresTransactionClient(client));
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the operation failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

/**
 * Payload-blind diagnostics wrapper. It intentionally records neither SQL nor
 * parameter values, because both can contain prompts, tool data, and secrets.
 */
export function createDiagnosedPostgresSqlClient(
  client: PostgresSqlClient,
  diagnostics?: AiDiagnosticSink,
): PostgresSqlClient {
  const wrap = (current: PostgresSqlClient): PostgresSqlClient => Object.freeze({
    query: <TRow extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => diagnoseAiOperation(diagnostics, {
      domain: "persistence",
      operation: "postgres_query",
    }, () => current.query<TRow>(text, values)),
    transaction: <T>(operation: (transaction: PostgresSqlClient) => Promise<T>) =>
      diagnoseAiOperation(diagnostics, {
        domain: "persistence",
        operation: "postgres_transaction",
      }, () => current.transaction((transaction) => operation(wrap(transaction)))),
  });
  return wrap(client);
}

export const handrailPostgresSchemaV1 = Object.freeze([
  `CREATE TABLE IF NOT EXISTS handrail_ai_events (tenant_id text NOT NULL, conversation_id text NOT NULL, revision bigint NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, conversation_id, revision), UNIQUE (tenant_id, event_id))`,
  `ALTER TABLE handrail_ai_events ADD COLUMN IF NOT EXISTS mutation_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS handrail_ai_events_mutation ON handrail_ai_events (tenant_id, mutation_id) WHERE mutation_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_documents (tenant_id text NOT NULL, kind text NOT NULL, scope_id text NOT NULL, record_id text NOT NULL, version bigint NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind, scope_id, record_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_documents_scope ON handrail_ai_documents (tenant_id, kind, scope_id, updated_at DESC, record_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_tool_ledger (tenant_id text NOT NULL, tool_call_id text NOT NULL, status text NOT NULL CHECK (status IN ('completed')), result jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, tool_call_id))`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_idempotency (tenant_id text NOT NULL, domain text NOT NULL, scope_id text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, domain, scope_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_conversations (tenant_id text NOT NULL, scope_id text NOT NULL, conversation_id text NOT NULL, lifecycle text NOT NULL CHECK (lifecycle IN ('active','archived')), title text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, archived_at timestamptz, version bigint NOT NULL, metadata jsonb NOT NULL, PRIMARY KEY (tenant_id, scope_id, conversation_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_conversations_updated ON handrail_ai_conversations (tenant_id, scope_id, lifecycle, updated_at DESC, conversation_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_approvals (tenant_id text NOT NULL, scope_id text NOT NULL, proposal_id text NOT NULL, group_id text, version bigint NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, scope_id, proposal_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_approvals_group ON handrail_ai_approvals (tenant_id, scope_id, group_id, updated_at, proposal_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_attachment_blobs (tenant_id text NOT NULL, blob_key text NOT NULL, payload bytea NOT NULL, media_type text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, blob_key))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_attachment_blobs_expiry ON handrail_ai_attachment_blobs (tenant_id, expires_at)`,
] as const);

export type PostgresDocumentKind = "checkpoint" | "catalog" | "approval" | "turn_state" | "durable_turn" | "activity" | "sync_state" | "openai_continuation" | "attachment" | "usage_outbox" | "audio_usage_evidence" | "tool_execution" | "provider_operation" | "realtime_call" | "realtime_tool_activity" | "realtime_activity_read";
export * from "./realtime-calls.js";
export * from "./realtime-tool-activity.js";

export interface PostgresVersionedDocument<T = unknown> {
  readonly tenantId: string;
  readonly kind: PostgresDocumentKind;
  readonly scopeId: string;
  readonly recordId: string;
  readonly version: number;
  readonly value: T;
}

export class PostgresPersistenceConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor() { super("The durable record version conflicts with current state."); this.name = "PostgresPersistenceConflictError"; }
}

/** A dispatch was admitted but its outcome is not durably known. Never retry its side effect automatically. */
export class PostgresToolExecutionUncertainError extends Error {
  readonly code = "tool_execution_uncertain" as const;
  constructor() {
    super("Tool execution is in progress or its outcome requires reconciliation before retrying.");
    this.name = "PostgresToolExecutionUncertainError";
  }
}

export interface AppendPostgresEventsInput<TEvent extends { readonly event_id: string; readonly revision: number }> {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly expectedRevision: number | null;
  readonly events: readonly TEvent[];
}

function id(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new TypeError(`${field} is invalid`);
  return value;
}

function version(value: number | null, field: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${field} is invalid`);
  return value;
}

function jsonClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function advisoryLockKey(...parts: readonly string[]): string {
  return parts.map((part) => `${new TextEncoder().encode(part).byteLength}:${part}`).join("|");
}

/**
 * Reference Postgres persistence used to build existing high-level store
 * contracts. Tenant scope is mandatory in every key and query. Atomic CAS,
 * append, and tool-ledger methods preserve authorization/idempotency seams.
 */
export class PostgresAiPersistence {
  constructor(readonly client: PostgresSqlClient) {}

  async migrate(): Promise<void> { for (const statement of handrailPostgresSchemaV1) await this.client.query(statement); }

  async appendEvents<TEvent extends { readonly event_id: string; readonly revision: number }>(input: AppendPostgresEventsInput<TEvent>): Promise<readonly TEvent[]> {
    if (input.events.length === 0) throw new TypeError("events must not be empty");
    const tenant = id(input.tenantId, "tenantId"), conversation = id(input.conversationId, "conversationId");
    const expected = version(input.expectedRevision, "expectedRevision");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockKey(tenant, conversation)]);
      const latest = await tx.query<{ revision: string }>("SELECT revision::text AS revision FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY handrail_ai_events.revision DESC LIMIT 1", [tenant, conversation]);
      const actual = latest.rows[0] ? Number(latest.rows[0].revision) : null;
      if (actual !== expected) throw new PostgresPersistenceConflictError();
      let next = (expected ?? 0) + 1;
      for (const event of input.events) {
        if (event.revision !== next++) throw new TypeError("event revisions must be contiguous");
        await tx.query("INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [tenant, conversation, event.revision, id(event.event_id, "event_id"), JSON.stringify(event)]);
      }
      return Object.freeze(input.events.map(jsonClone));
    });
  }

  async readEvents<TEvent>(tenantId: string, conversationId: string, afterRevision = 0, limit = 100): Promise<readonly TEvent[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("event read bounds are invalid");
    const result = await this.client.query<{ payload: TEvent }>("SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 AND revision>$3 ORDER BY revision LIMIT $4", [id(tenantId, "tenantId"), id(conversationId, "conversationId"), afterRevision, limit]);
    return Object.freeze(result.rows.map((row) => jsonClone(row.payload)));
  }

  async getDocument<T>(tenantId: string, kind: PostgresDocumentKind, scopeId: string, recordId: string): Promise<PostgresVersionedDocument<T> | null> {
    const result = await this.client.query<{ version: string; payload: T }>("SELECT version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4", [id(tenantId, "tenantId"), kind, id(scopeId, "scopeId"), id(recordId, "recordId")]);
    const row = result.rows[0];
    return row ? Object.freeze({ tenantId, kind, scopeId, recordId, version: Number(row.version), value: jsonClone(row.payload) }) : null;
  }

  readCheckpoint<T>(tenantId: string, conversationId: string) {
    return this.getDocument<T>(tenantId, "checkpoint", conversationId, "latest");
  }

  writeCheckpoint<T>(tenantId: string, conversationId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "checkpoint", scopeId: conversationId, recordId: "latest", expectedVersion, value });
  }

  readCatalogDescriptor<T>(tenantId: string, ownerScopeId: string, conversationId: string) {
    return this.getDocument<T>(tenantId, "catalog", ownerScopeId, conversationId);
  }

  writeCatalogDescriptor<T>(tenantId: string, ownerScopeId: string, conversationId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "catalog", scopeId: ownerScopeId, recordId: conversationId, expectedVersion, value });
  }

  readApprovalProposal<T>(tenantId: string, conversationId: string, proposalId: string) {
    return this.getDocument<T>(tenantId, "approval", conversationId, proposalId);
  }

  writeApprovalProposal<T>(tenantId: string, conversationId: string, proposalId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "approval", scopeId: conversationId, recordId: proposalId, expectedVersion, value });
  }

  readTurnState<T>(tenantId: string, conversationId: string, turnId: string) {
    return this.getDocument<T>(tenantId, "turn_state", conversationId, turnId);
  }

  writeTurnState<T>(tenantId: string, conversationId: string, turnId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "turn_state", scopeId: conversationId, recordId: turnId, expectedVersion, value });
  }

  readSyncState<T>(tenantId: string, conversationId: string, deviceId: string) {
    return this.getDocument<T>(tenantId, "sync_state", conversationId, deviceId);
  }

  writeSyncState<T>(tenantId: string, conversationId: string, deviceId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "sync_state", scopeId: conversationId, recordId: deviceId, expectedVersion, value });
  }

  async compareAndSetDocument<T>(input: Omit<PostgresVersionedDocument<T>, "version"> & { readonly expectedVersion: number | null }): Promise<PostgresVersionedDocument<T>> {
    const tenant = id(input.tenantId, "tenantId"), scope = id(input.scopeId, "scopeId"), record = id(input.recordId, "recordId");
    const expected = version(input.expectedVersion, "expectedVersion");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockKey(tenant, input.kind, scope, record)]);
      const current = await tx.query<{ version: string }>("SELECT version::text AS version FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4", [tenant, input.kind, scope, record]);
      const actual = current.rows[0] ? Number(current.rows[0].version) : null;
      if (actual !== expected) throw new PostgresPersistenceConflictError();
      const next = (actual ?? 0) + 1;
      await tx.query("INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (tenant_id,kind,scope_id,record_id) DO UPDATE SET version=EXCLUDED.version,payload=EXCLUDED.payload,updated_at=now()", [tenant, input.kind, scope, record, next, JSON.stringify(input.value)]);
      return Object.freeze({ tenantId: tenant, kind: input.kind, scopeId: scope, recordId: record, version: next, value: jsonClone(input.value) });
    });
  }

  async listDocuments<T>(tenantId: string, kind: PostgresDocumentKind, scopeId: string, limit = 100): Promise<readonly PostgresVersionedDocument<T>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit is invalid");
    const tenant = id(tenantId, "tenantId"), scope = id(scopeId, "scopeId");
    const result = await this.client.query<{ record_id: string; version: string; payload: T }>("SELECT record_id,version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 ORDER BY updated_at DESC,record_id LIMIT $4", [tenant, kind, scope, limit]);
    return Object.freeze(result.rows.map((row) => Object.freeze({ tenantId: tenant, kind, scopeId: scope, recordId: row.record_id, version: Number(row.version), value: jsonClone(row.payload) })));
  }

  /**
   * Commits admission before dispatch. A lost process/connection leaves the claim
   * intact, so an uncertain external side effect cannot be dispatched twice.
   * Completed V1 results remain readable. All workers must honor these claims.
   */
  async getOrExecuteTool<T>(tenantId: string, toolCallId: string, execute: () => Promise<T>, requestFingerprint?: string): Promise<T> {
    const tenant = id(tenantId, "tenantId"), call = id(toolCallId, "toolCallId");
    const fingerprint = requestFingerprint === undefined ? null : createHash("sha256").update(requestFingerprint).digest("hex");
    const admission = await this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockKey(tenant, "tool", call)]);
      const existing = await tx.query<{ result: T }>("SELECT result FROM handrail_ai_tool_ledger WHERE tenant_id=$1 AND tool_call_id=$2", [tenant, call]);
      const claim = await tx.query<{ version: string; payload: { fingerprint?: string | null } }>(
        "SELECT version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='tool_execution' AND scope_id='tool' AND record_id=$2",
        [tenant, call],
      );
      // Missing bindings on old completed records are not proof that a new
      // bound request matches. Return legacy results only to unbound callers.
      if ((existing.rows[0] || claim.rows[0]) && (claim.rows[0]?.payload.fingerprint ?? null) !== fingerprint) {
        throw new ToolExecutionIdentityConflictError();
      }
      if (existing.rows[0]) return { completed: true as const, result: jsonClone(existing.rows[0].result) };
      if (claim.rows.length > 0) throw new PostgresToolExecutionUncertainError();
      await tx.query(
        "INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,'tool_execution','tool',$2,1,$3::jsonb)",
        [tenant, call, JSON.stringify({ version: 1, status: "admitted", fingerprint })],
      );
      return { completed: false as const };
    });
    if (admission.completed) return admission.result;
    // Deliberately outside the admission transaction. A rollback after an external
    // side effect must never erase the only durable evidence that it was started.
    const result = await execute();
    await this.client.transaction(async (tx) => {
      await tx.query("INSERT INTO handrail_ai_tool_ledger (tenant_id,tool_call_id,status,result) VALUES ($1,$2,'completed',$3::jsonb)",
        [tenant, call, JSON.stringify(result)]);
    });
    return jsonClone(result);
  }

  async getToolResult<T>(tenantId: string, toolCallId: string): Promise<T | null> {
    const result = await this.client.query<{ result: T }>(
      "SELECT result FROM handrail_ai_tool_ledger WHERE tenant_id=$1 AND tool_call_id=$2",
      [id(tenantId, "tenantId"), id(toolCallId, "toolCallId")],
    );
    return result.rows[0] ? jsonClone(result.rows[0].result) : null;
  }

  /** Bounded, read-only recovery. Missing entries are not failed executions and
   * never authorize redispatch. Tenant ownership is supplied by the host. */
  async getToolResults<T>(tenantId: string, toolCallIds: readonly string[]): Promise<readonly { readonly toolCallId: string; readonly result: T }[]> {
    const tenant = id(tenantId, "tenantId");
    if (!Array.isArray(toolCallIds) || toolCallIds.length > 100) throw new TypeError("A tool result batch must contain at most 100 identities.");
    const calls = [...new Set(toolCallIds.map((call) => id(call, "toolCallId")))];
    if (calls.length === 0) return Object.freeze([]);
    const rows = await this.client.query<{ tool_call_id: string; result: T }>(
      "SELECT tool_call_id,result FROM handrail_ai_tool_ledger WHERE tenant_id=$1 AND tool_call_id IN (SELECT jsonb_array_elements_text($2::jsonb)) ORDER BY tool_call_id",
      [tenant, JSON.stringify(calls)]);
    return Object.freeze(rows.rows.map((row) => Object.freeze({ toolCallId: row.tool_call_id, result: jsonClone(row.result) })));
  }

  async getOrCreateIdempotent<T>(input: { readonly tenantId: string; readonly domain: string; readonly scopeId: string;
    readonly idempotencyKey: string; readonly fingerprint: string; readonly execute: (client: PostgresSqlClient) => Promise<T> }): Promise<{ readonly status: "created" | "idempotent"; readonly value: T }> {
    const tenant = id(input.tenantId, "tenantId"), domain = id(input.domain, "domain"), scope = id(input.scopeId, "scopeId");
    const key = id(input.idempotencyKey, "idempotencyKey"), fingerprint = id(input.fingerprint, "fingerprint");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockKey(tenant, "idempotency", domain, scope, key)]);
      const existing = await tx.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain=$2 AND scope_id=$3 AND idempotency_key=$4",
        [tenant, domain, scope, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) throw new PostgresPersistenceConflictError();
        return { status: "idempotent" as const, value: jsonClone(existing.rows[0].result) };
      }
      const value = await input.execute(tx);
      await tx.query("INSERT INTO handrail_ai_idempotency (tenant_id,domain,scope_id,idempotency_key,fingerprint,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
        [tenant, domain, scope, key, fingerprint, JSON.stringify(value)]);
      return { status: "created" as const, value: jsonClone(value) };
    });
  }

  async deleteDocument(input: { readonly tenantId: string; readonly kind: PostgresDocumentKind; readonly scopeId: string;
    readonly recordId: string; readonly expectedVersion: number }): Promise<boolean> {
    const result = await this.client.query(
      "DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4 AND version=$5",
      [id(input.tenantId, "tenantId"), input.kind, id(input.scopeId, "scopeId"), id(input.recordId, "recordId"), input.expectedVersion],
    );
    return result.rowCount === 1;
  }
}

export interface PostgresOpenAIResponsesContinuationStoreOptions {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  /** Separates provider/model/application continuation domains for one tenant. */
  readonly scopeId: string;
}

function openAIContinuationRecord(value: OpenAIResponsesContinuationRecord): OpenAIResponsesContinuationRecord {
  const record = jsonClone(value);
  if (typeof record.requestId !== "string" || record.requestId.length === 0 || record.requestId.length > 256 ||
    !Array.isArray(record.inputItems) || record.inputItems.length > 256 ||
    new TextEncoder().encode(JSON.stringify(record.inputItems)).byteLength > 2 * 1024 * 1024) {
    throw new TypeError("OpenAI Responses continuation record is invalid");
  }
  return Object.freeze({ requestId: record.requestId, inputItems: Object.freeze(record.inputItems) });
}

/** Durable tenant-scoped retention for OpenAI Responses store:false continuations. */
export class PostgresOpenAIResponsesContinuationStore implements OpenAIResponsesContinuationStore {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  readonly scopeId: string;

  constructor(options: PostgresOpenAIResponsesContinuationStoreOptions) {
    this.persistence = options.persistence;
    this.tenantId = id(options.tenantId, "tenantId");
    this.scopeId = id(options.scopeId, "scopeId");
  }

  async load(requestId: string): Promise<OpenAIResponsesContinuationRecord | null> {
    const document = await this.persistence.getDocument<OpenAIResponsesContinuationRecord>(
      this.tenantId, "openai_continuation", this.scopeId, id(requestId, "requestId"),
    );
    return document ? openAIContinuationRecord(document.value) : null;
  }

  async save(value: OpenAIResponsesContinuationRecord): Promise<void> {
    const record = openAIContinuationRecord(value);
    const existing = await this.persistence.getDocument<OpenAIResponsesContinuationRecord>(
      this.tenantId, "openai_continuation", this.scopeId, record.requestId,
    );
    if (existing) {
      if (jsonValuesEqual(openAIContinuationRecord(existing.value), record)) return;
      throw new PostgresPersistenceConflictError();
    }
    try {
      await this.persistence.compareAndSetDocument({ tenantId: this.tenantId,
        kind: "openai_continuation", scopeId: this.scopeId, recordId: record.requestId,
        expectedVersion: null, value: record });
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const winner = await this.load(record.requestId);
      if (winner && jsonValuesEqual(winner, record)) return;
      throw error;
    }
  }
}

/** Durable high-level replay store scoped to one already-authorized tenant. */
export class PostgresManagedRuntimeTurnStateStore implements ManagedRuntimeTurnStateStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) {
    id(tenantId, "tenantId");
  }

  async load(conversationId: string, turnId: string): Promise<ManagedRuntimeTurnStateRecord | null> {
    const document = await this.persistence.readTurnState<ManagedRuntimeTurnStateRecord>(this.tenantId, conversationId, turnId);
    return document ? parseManagedRuntimeTurnStateRecord(document.value) : null;
  }

  async save(value: ManagedRuntimeTurnStateRecord): Promise<ManagedRuntimeTurnStateRecord> {
    const record = parseManagedRuntimeTurnStateRecord(value);
    const existing = await this.persistence.readTurnState<ManagedRuntimeTurnStateRecord>(this.tenantId, record.conversationId, record.turnId);
    if (existing) {
      const stored = parseManagedRuntimeTurnStateRecord(existing.value);
      if (jsonValuesEqual(stored, record)) return stored;
      throw new ManagedRuntimeTurnStateStoreConflictError("The replay identity conflicts with durable state.", {
        code: "replay_identity_conflict", conversationId: record.conversationId, turnId: record.turnId,
      });
    }
    try {
      const saved = await this.persistence.writeTurnState(this.tenantId, record.conversationId, record.turnId, null, record);
      return parseManagedRuntimeTurnStateRecord(saved.value);
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const winner = await this.load(record.conversationId, record.turnId);
      if (winner && jsonValuesEqual(winner, record)) return winner;
      throw new ManagedRuntimeTurnStateStoreConflictError("The replay identity conflicts with durable state.", {
        code: "replay_identity_conflict", conversationId: record.conversationId, turnId: record.turnId,
      });
    }
  }
}

/** Tenant-scoped CAS store for application-hosted durable turn coordination. */
export class PostgresDurableApplicationTurnStore<TStoredRequest = unknown, TEvent = unknown>
implements DurableApplicationTurnStore<TStoredRequest, TEvent> {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) { id(tenantId, "tenantId"); }

  async load(conversationId: string, turnId: string): Promise<DurableApplicationTurnDocument<TStoredRequest, TEvent> | null> {
    const document = await this.persistence.getDocument<DurableApplicationTurnRecord<TStoredRequest, TEvent>>(
      this.tenantId, "durable_turn", conversationId, turnId,
    );
    return document ? { version: document.version, record: jsonClone(document.value) } : null;
  }

  async create(record: DurableApplicationTurnRecord<TStoredRequest, TEvent>) {
    try {
      const saved = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "durable_turn",
        scopeId: record.conversationId, recordId: record.turnId, expectedVersion: null, value: record });
      return { status: "created" as const, document: { version: saved.version, record: jsonClone(saved.value) } };
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const current = await this.load(record.conversationId, record.turnId);
      return current && durableApplicationTurnStartMatches(current.record, record)
        ? { status: "idempotent" as const, document: current }
        : { status: "conflict" as const, document: current };
    }
  }

  async compareAndSet(input: { readonly conversationId: string; readonly turnId: string; readonly expectedVersion: number;
    readonly record: DurableApplicationTurnRecord<TStoredRequest, TEvent> }) {
    try {
      const saved = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "durable_turn",
        scopeId: input.conversationId, recordId: input.turnId, expectedVersion: input.expectedVersion, value: input.record });
      return { status: "updated" as const, document: { version: saved.version, record: jsonClone(saved.value) } };
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      return { status: "conflict" as const, document: await this.load(input.conversationId, input.turnId) };
    }
  }

  async listRecoverable(limit: number): Promise<readonly DurableApplicationTurnDocument<TStoredRequest, TEvent>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("limit is invalid");
    const result = await this.persistence.client.query<{ version: string; payload: DurableApplicationTurnRecord<TStoredRequest, TEvent> }>(
      "SELECT version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='durable_turn' AND payload->>'status' IN ('pending','running') ORDER BY updated_at,record_id LIMIT $2",
      [this.tenantId, limit],
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({ version: Number(row.version), record: jsonClone(row.payload) })));
  }
}

/** Durable cross-device activity index scoped to one authorized workspace/principal. */
export class PostgresConversationActivityStore implements DurableConversationActivityStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string, readonly scopeId: string) {
    id(tenantId, "tenantId"); id(scopeId, "scopeId");
  }
  async list(): Promise<readonly ConversationActivityRecord[]> {
    const documents = await this.persistence.listDocuments<ConversationActivityRecord>(this.tenantId, "activity", this.scopeId, 1_000);
    return Object.freeze(documents.map((document) => parseConversationActivityRecord(document.value)));
  }
  async upsert(input: ConversationActivityRecord): Promise<ConversationActivityRecord> {
    const record = parseConversationActivityRecord(input);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.persistence.getDocument<ConversationActivityRecord>(this.tenantId, "activity", this.scopeId,
        String(record.conversationId));
      if (current) {
        const retained = parseConversationActivityRecord(current.value);
        if (retainConversationActivity(retained, record) === retained) return retained;
      }
      try {
        const saved = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "activity",
          scopeId: this.scopeId, recordId: String(record.conversationId), expectedVersion: current?.version ?? null, value: record });
        return parseConversationActivityRecord(saved.value);
      } catch (error) { if (!(error instanceof PostgresPersistenceConflictError)) throw error; }
    }
    throw new PostgresPersistenceConflictError();
  }
  async markRead(conversationId: string, observed?: ConversationActivityRecord): Promise<ConversationActivityRecord | null> {
    id(conversationId, "conversationId");
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.persistence.getDocument<ConversationActivityRecord>(this.tenantId, "activity", this.scopeId, conversationId);
      if (!current) return null;
      const record = parseConversationActivityRecord(current.value);
      if (!record.unread || (observed && !matchesConversationActivityRead(record, observed))) return record;
      try {
        const saved = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "activity",
          scopeId: this.scopeId, recordId: conversationId, expectedVersion: current.version, value: { ...record, unread: false } });
        return parseConversationActivityRecord(saved.value);
      } catch (error) { if (!(error instanceof PostgresPersistenceConflictError)) throw error; }
    }
    throw new PostgresPersistenceConflictError();
  }
}

/** Numerical provider evidence awaiting a supported billing contract, never an outbound receipt. */
export interface OpenAIAudioUsageEvidence {
  readonly version: 1;
  /** Stable provider-operation identity and server-derived attribution. */
  readonly context: Omit<NormalizedUsageReceipt, "version" | "tokens" | "provider_cost">;
  readonly usage: OpenAIReportedAudioUsage;
}

function audioUsageEvidence(value: OpenAIAudioUsageEvidence): OpenAIAudioUsageEvidence {
  if (value?.version !== 1 || value.context?.provider_id !== "openai" || value.context.source !== "provider" || value.usage === undefined || value.usage === null) {
    throw new TypeError("Invalid OpenAI audio usage evidence");
  }
  // Reuse the existing strict identity/attribution validation, without estimating
  // tokens or creating a billable receipt. Only the validated context is retained.
  const normalized = parseNormalizedUsageReceipt({ ...value.context, version: 1,
    tokens: { input_tokens: { status: "unavailable" }, cached_input_tokens: { status: "unavailable" },
      output_tokens: { status: "unavailable" }, reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "unavailable" } }, provider_cost: { status: "unavailable" } });
  const context: OpenAIAudioUsageEvidence["context"] = Object.freeze({
    ...(normalized.occurred_at === undefined ? {} : { occurred_at: normalized.occurred_at }),
    usage_receipt_id: normalized.usage_receipt_id, conversation_id: normalized.conversation_id,
    turn_id: normalized.turn_id, logical_request_id: normalized.logical_request_id, trace_id: normalized.trace_id,
    attempt: normalized.attempt, continuation: normalized.continuation, provider_id: normalized.provider_id,
    model_id: normalized.model_id, attribution: normalized.attribution, source: normalized.source,
    terminal_status: normalized.terminal_status,
  });
  const usage = value.usage?.type === "unavailable" ? Object.freeze({ type: "unavailable" as const })
    : parseOpenAIReportedAudioUsage(value.usage);
  return Object.freeze({ version: 1, context, usage });
}

/**
 * Immutable, tenant/environment-scoped provider evidence in the SDK document
 * schema. This store never submits to telemetry or deletes evidence on delivery.
 * Hosts must derive the stable receipt identity from the provider operation and
 * keep the same context on retry. The SDK receipt outbox remains separate.
 */
export class PostgresOpenAIAudioUsageEvidenceStore {
  constructor(
    readonly persistence: PostgresAiPersistence,
    readonly tenantId: string,
    readonly serviceEnvironmentId: string,
  ) {
    id(tenantId, "tenantId");
    id(serviceEnvironmentId, "serviceEnvironmentId");
  }

  async capture(value: OpenAIAudioUsageEvidence): Promise<void> {
    const evidence = audioUsageEvidence(value);
    if (evidence.context.attribution.service_environment.id !== this.serviceEnvironmentId) {
      throw new TypeError("Audio usage environment does not match storage scope");
    }
    const recordId = evidence.context.usage_receipt_id;
    const existing = await this.get(recordId);
    if (existing !== null) {
      if (!jsonValuesEqual(existing, evidence)) throw new PostgresPersistenceConflictError();
      return;
    }
    try {
      await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "audio_usage_evidence",
        scopeId: this.serviceEnvironmentId, recordId, expectedVersion: null, value: evidence });
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const winner = await this.get(recordId);
      if (winner === null || !jsonValuesEqual(winner, evidence)) throw error;
    }
  }

  async get(receiptId: string): Promise<OpenAIAudioUsageEvidence | null> {
    const document = await this.persistence.getDocument<OpenAIAudioUsageEvidence>(
      this.tenantId, "audio_usage_evidence", this.serviceEnvironmentId, id(receiptId, "receiptId"));
    if (document === null) return null;
    return this.#validateStored(receiptId, document.value);
  }

  /** Bounded keyset scan for reconciliation; rescan to discover later inserts. */
  async list(options: { readonly afterId?: string; readonly limit?: number } = {}): Promise<readonly OpenAIAudioUsageEvidence[]> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Audio evidence limit must be between 1 and 100");
    const afterId = options.afterId === undefined ? null : id(options.afterId, "afterId");
    const result = await this.persistence.client.query<{ record_id: string; payload: OpenAIAudioUsageEvidence }>(
      "SELECT record_id,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='audio_usage_evidence' AND scope_id=$2 AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4",
      [this.tenantId, this.serviceEnvironmentId, afterId, limit]);
    return Object.freeze(result.rows.map((row) => this.#validateStored(row.record_id, row.payload)));
  }

  #validateStored(receiptId: string, value: OpenAIAudioUsageEvidence): OpenAIAudioUsageEvidence {
    const evidence = audioUsageEvidence(value);
    if (evidence.context.usage_receipt_id !== receiptId ||
      evidence.context.attribution.service_environment.id !== this.serviceEnvironmentId) {
      throw new TypeError("Audio usage evidence identity does not match storage scope");
    }
    return evidence;
  }
}

const POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION = 1 as const;

interface PostgresUsageOutboxRecord {
  readonly schemaVersion: typeof POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION;
  readonly status: "pending" | "failed" | "delivered";
  readonly entry: AIRuntimeUsageOutboxEntry;
  readonly lastError?: { readonly code: string; readonly retryable: boolean };
}

function usageOutboxEntry(value: AIRuntimeUsageOutboxEntry): AIRuntimeUsageOutboxEntry {
  const receipt = parseNormalizedUsageReceipt(value.receipt);
  const enqueuedAt = new Date(value.enqueuedAt);
  if (!Number.isFinite(enqueuedAt.getTime()) || enqueuedAt.toISOString() !== value.enqueuedAt) {
    throw new TypeError("Usage outbox enqueuedAt must be an RFC 3339 UTC timestamp");
  }
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0) {
    throw new TypeError("Usage outbox attempts must be a non-negative safe integer");
  }
  return Object.freeze({ receipt, enqueuedAt: value.enqueuedAt, attempts: value.attempts });
}

function usageOutboxRecord(value: PostgresUsageOutboxRecord): PostgresUsageOutboxRecord {
  if (value?.schemaVersion !== POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION ||
    (value.status !== "pending" && value.status !== "failed" && value.status !== "delivered")) {
    throw new TypeError("Postgres usage outbox record is invalid");
  }
  const entry = usageOutboxEntry(value.entry);
  const lastError = value.lastError;
  if (lastError !== undefined && (typeof lastError.code !== "string" || !lastError.code ||
    lastError.code.length > 256 || typeof lastError.retryable !== "boolean")) {
    throw new TypeError("Postgres usage outbox failure is invalid");
  }
  return Object.freeze({
    schemaVersion: POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION,
    status: value.status,
    entry,
    ...(lastError === undefined ? {} : { lastError: Object.freeze({ ...lastError }) }),
  });
}

/** Durable, tenant-scoped receipt delivery queue for createAIRuntimeUsageReceiptSink. */
export class PostgresAIRuntimeUsageOutbox implements AIRuntimeUsageOutbox {
  constructor(
    readonly persistence: PostgresAiPersistence,
    readonly tenantId: string,
    readonly scopeId: string,
  ) {
    id(tenantId, "tenantId");
    id(scopeId, "scopeId");
  }

  async enqueue(value: AIRuntimeUsageOutboxEntry): Promise<void> {
    const entry = usageOutboxEntry(value);
    const recordId = entry.receipt.usage_receipt_id;
    const record = usageOutboxRecord({
      schemaVersion: POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION,
      status: "pending",
      entry,
    });
    const current = await this.persistence.getDocument<PostgresUsageOutboxRecord>(
      this.tenantId, "usage_outbox", this.scopeId, recordId,
    );
    if (current) {
      if (!jsonValuesEqual(usageOutboxRecord(current.value).entry.receipt, entry.receipt)) {
        throw new PostgresPersistenceConflictError();
      }
      return;
    }
    try {
      await this.persistence.compareAndSetDocument({
        tenantId: this.tenantId,
        kind: "usage_outbox",
        scopeId: this.scopeId,
        recordId,
        expectedVersion: null,
        value: record,
      });
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const winner = await this.persistence.getDocument<PostgresUsageOutboxRecord>(
        this.tenantId, "usage_outbox", this.scopeId, recordId,
      );
      if (!winner || !jsonValuesEqual(usageOutboxRecord(winner.value).entry.receipt, entry.receipt)) {
        throw error;
      }
    }
  }

  async pending(limit: number): Promise<readonly AIRuntimeUsageOutboxEntry[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Usage outbox limit must be an integer between 1 and 100");
    }
    const result = await this.persistence.client.query<{ payload: PostgresUsageOutboxRecord }>(
      "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='usage_outbox' AND scope_id=$2 AND payload->>'status'='pending' ORDER BY payload->'entry'->>'enqueuedAt',record_id LIMIT $3",
      [this.tenantId, this.scopeId, limit],
    );
    return Object.freeze(result.rows
      .map((row) => usageOutboxRecord(row.payload))
      .map((candidate) => candidate.entry));
  }

  async acknowledge(usageReceiptId: string): Promise<void> {
    const recordId = id(usageReceiptId, "usageReceiptId");
    // Keep the receipt identity after delivery: terminal-turn reconciliation may
    // capture it again long after its original settlement was acknowledged.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.persistence.getDocument<PostgresUsageOutboxRecord>(
        this.tenantId, "usage_outbox", this.scopeId, recordId,
      );
      if (!current) return;
      const retained = usageOutboxRecord(current.value);
      if (retained.status === "delivered") return;
      try {
        await this.persistence.compareAndSetDocument({
          tenantId: this.tenantId, kind: "usage_outbox", scopeId: this.scopeId,
          recordId, expectedVersion: current.version,
          value: usageOutboxRecord({ schemaVersion: POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION,
            status: "delivered", entry: retained.entry }),
        });
        return;
      } catch (cause) {
        if (!(cause instanceof PostgresPersistenceConflictError) || attempt === 3) throw cause;
      }
    }
  }

  async failed(
    usageReceiptId: string,
    error: { readonly code: string; readonly retryable: boolean },
  ): Promise<void> {
    const recordId = id(usageReceiptId, "usageReceiptId");
    if (typeof error.code !== "string" || !error.code || error.code.length > 256 ||
      typeof error.retryable !== "boolean") {
      throw new TypeError("Usage outbox failure is invalid");
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.persistence.getDocument<PostgresUsageOutboxRecord>(
        this.tenantId, "usage_outbox", this.scopeId, recordId,
      );
      if (!current) return;
      const retained = usageOutboxRecord(current.value);
      if (retained.status === "delivered") return;
      const next = usageOutboxRecord({
        schemaVersion: POSTGRES_USAGE_OUTBOX_SCHEMA_VERSION,
        status: error.retryable ? "pending" : "failed",
        entry: { ...retained.entry, attempts: retained.entry.attempts + 1 },
        lastError: error,
      });
      try {
        await this.persistence.compareAndSetDocument({
          tenantId: this.tenantId,
          kind: "usage_outbox",
          scopeId: this.scopeId,
          recordId,
          expectedVersion: current.version,
          value: next,
        });
        return;
      } catch (cause) {
        if (!(cause instanceof PostgresPersistenceConflictError) || attempt === 3) throw cause;
      }
    }
  }
}

/** Durable idempotent usage admission paired with the scoped receipt outbox. */
export class PostgresAIRuntimeUsageAdmissionStore {
  constructor(
    readonly persistence: PostgresAiPersistence,
    readonly tenantId: string,
    readonly scopeId: string,
    readonly client: AIRuntimeUsageClient,
  ) {
    id(tenantId, "tenantId"); id(scopeId, "scopeId");
  }

  async admit(input: AIRuntimeAdmissionInput): Promise<AIRuntimeAdmissionResult> {
    const key = id(input.idempotency_key, "idempotencyKey");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const retained = await this.persistence.getOrCreateIdempotent({
      tenantId: this.tenantId,
      domain: "usage.admission",
      scopeId: this.scopeId,
      idempotencyKey: key,
      fingerprint,
      execute: () => this.client.admit(input),
    });
    return Object.freeze({ ...retained.value, replayed: retained.status === "idempotent" || retained.value.replayed });
  }
}

/** Application-owned Postgres bytea staging. Binary payloads never enter JSON documents. */
export class PostgresAttachmentBlobStore implements AttachmentBlobStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) { id(tenantId, "tenantId"); }
  async put(input: { readonly key: string; readonly bytes: Uint8Array; readonly mediaType: string; readonly expiresAt: string }) {
    await this.persistence.client.query(
      "INSERT INTO handrail_ai_attachment_blobs (tenant_id,blob_key,payload,media_type,expires_at) VALUES ($1,$2,$3,$4,$5)",
      [this.tenantId, id(input.key, "blobKey"), input.bytes, id(input.mediaType, "mediaType"), input.expiresAt],
    );
  }
  async get(key: string): Promise<Uint8Array | null> {
    const result = await this.persistence.client.query<{ payload: Uint8Array }>(
      "SELECT payload FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2 AND expires_at>now()",
      [this.tenantId, id(key, "blobKey")],
    );
    return result.rows[0] ? new Uint8Array(result.rows[0].payload) : null;
  }
  async delete(key: string): Promise<void> {
    await this.persistence.client.query("DELETE FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2",
      [this.tenantId, id(key, "blobKey")]);
  }
}

/** Principal/workspace-scoped metadata index paired with PostgresAttachmentBlobStore. */
export class PostgresAttachmentStagingMetadataStore implements AttachmentStagingMetadataStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string, readonly scopeId: string) {
    id(tenantId, "tenantId"); id(scopeId, "scopeId");
  }
  async getByIdempotency(ownerScopeId: string, conversationId: string, idempotencyKey: string) {
    if (ownerScopeId !== this.scopeId) return null;
    const result = await this.persistence.client.query<{ payload: StagedAttachmentRecord }>(
      "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2 AND payload->>'conversationId'=$3 AND payload->>'idempotencyKey'=$4 LIMIT 1",
      [this.tenantId, this.scopeId, id(conversationId, "conversationId"), id(idempotencyKey, "idempotencyKey")],
    );
    return result.rows[0] ? jsonClone(result.rows[0].payload) : null;
  }
  async getByContentRef(contentRef: string) {
    const value = await this.persistence.getDocument<StagedAttachmentRecord>(this.tenantId, "attachment", this.scopeId,
      id(contentRef, "contentRef"));
    return value ? jsonClone(value.value) : null;
  }
  async create(record: StagedAttachmentRecord): Promise<"created" | "conflict"> {
    return this.persistence.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [advisoryLockKey(this.tenantId, "attachment", this.scopeId, record.conversationId, record.idempotencyKey)]);
      const existing = await tx.query(
        "SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2 AND (record_id=$3 OR (payload->>'conversationId'=$4 AND payload->>'idempotencyKey'=$5)) LIMIT 1",
        [this.tenantId, this.scopeId, record.contentRef, record.conversationId, record.idempotencyKey],
      );
      if (existing.rowCount > 0) return "conflict";
      await tx.query("INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,'attachment',$2,$3,1,$4::jsonb)",
        [this.tenantId, this.scopeId, record.contentRef, JSON.stringify(record)]);
      return "created";
    });
  }
  async markConsumed(contentRef: string, consumedAt: string): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const current = await this.persistence.getDocument<StagedAttachmentRecord>(this.tenantId, "attachment", this.scopeId, contentRef);
      if (!current || current.value.consumedAt) return;
      try { await this.persistence.compareAndSetDocument({ ...current, expectedVersion: current.version,
        value: { ...current.value, consumedAt } }); return;
      } catch (error) { if (!(error instanceof PostgresPersistenceConflictError)) throw error; }
    }
    throw new PostgresPersistenceConflictError();
  }
  async listExpired(before: string, limit: number) {
    const result = await this.persistence.client.query<{ payload: StagedAttachmentRecord }>(
      "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2 AND payload->>'expiresAt'<=$3 ORDER BY payload->>'expiresAt' LIMIT $4",
      [this.tenantId, this.scopeId, before, limit],
    );
    return Object.freeze(result.rows.map((row) => jsonClone(row.payload)));
  }
  async delete(contentRef: string): Promise<void> {
    const recordId = id(contentRef, "contentRef");
    const current = await this.persistence.getDocument<StagedAttachmentRecord>(this.tenantId, "attachment", this.scopeId, recordId);
    if (current) await this.persistence.deleteDocument({ tenantId: this.tenantId, kind: "attachment", scopeId: this.scopeId,
      recordId, expectedVersion: current.version });
  }
}

/** Atomic Postgres implementation of the cross-device sync baseline contract. */
export class PostgresConversationSyncStateStore implements ConversationSyncStateStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) {
    id(tenantId, "tenantId");
  }

  async load(conversationId: ConversationId): Promise<ConversationSyncStateRecord | null> {
    const document = await this.persistence.readSyncState<ConversationSyncStateRecord>(this.tenantId, conversationId, "latest");
    if (!document) return null;
    const record = jsonClone(document.value);
    if (record.schemaVersion !== CONVERSATION_SYNC_STATE_SCHEMA_VERSION || record.conversationId !== conversationId ||
      record.generation !== document.version) throw new TypeError("Postgres sync state is invalid");
    return record;
  }

  async save(input: SaveConversationSyncStateInput): Promise<ConversationSyncStateRecord> {
    const generation = (input.expectedGeneration ?? 0) + 1;
    const record: ConversationSyncStateRecord = jsonClone({ ...input.record, generation });
    try {
      const saved = await this.persistence.writeSyncState(
        this.tenantId, record.conversationId, "latest", input.expectedGeneration, record,
      );
      return jsonClone(saved.value);
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const actual = await this.persistence.readSyncState<ConversationSyncStateRecord>(this.tenantId, record.conversationId, "latest");
      throw new ConversationSyncStateStoreConflictError("The sync generation conflicts with durable state.", {
        code: "generation_conflict", conversationId: record.conversationId,
        expectedGeneration: input.expectedGeneration, actualGeneration: actual?.version ?? null,
      });
    }
  }
}

/** A provider request was admitted but no completed result is durably known. */
export class PostgresProviderOperationUncertainError extends Error {
  readonly code = "provider_operation_uncertain" as const;
  constructor() {
    super("The provider operation is running or its outcome requires reconciliation.");
    this.name = "PostgresProviderOperationUncertainError";
  }
}

export class PostgresProviderOperationConflictError extends Error {
  readonly code = "provider_operation_conflict" as const;
  constructor() {
    super("The provider operation identity is bound to different input.");
    this.name = "PostgresProviderOperationConflictError";
  }
}

interface ProviderOperationRecord {
  readonly version: 1;
  readonly fingerprint: string;
  readonly status: "started" | "completed";
  readonly result?: unknown;
}

/**
 * Claims one host-authorized provider operation before external dispatch. Keys
 * must include the authenticated owner/request scope; authorize before every run.
 * Completed JSON results are retained for replay. Failed/uncertain claims never
 * expire automatically: deleting one can duplicate provider work or charges.
 */
export class PostgresProviderOperationStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string, readonly scopeId: string) {
    id(tenantId, "tenantId"); id(scopeId, "scopeId");
  }

  async run<T>(input: {
    readonly operationId: string;
    readonly requestFingerprint: string;
    /** Runs only after the claim transaction commits. Rejections retain the claim. */
    readonly execute: () => Promise<T>;
    /** Validate both newly returned and stored JSON before exposing it to callers. */
    readonly parseResult: (value: unknown) => T;
  }): Promise<T> {
    const operationId = id(input.operationId, "operationId");
    const fingerprint = createHash("sha256").update(id(input.requestFingerprint, "requestFingerprint")).digest("hex");
    const readCompleted = async (): Promise<{ readonly found: boolean; readonly result?: T }> => {
      const record = await this.persistence.getDocument<ProviderOperationRecord>(
        this.tenantId, "provider_operation", this.scopeId, operationId);
      if (record === null) return { found: false };
      const value = record.value;
      if (!value || value.version !== 1 || typeof value.fingerprint !== "string" ||
        (value.status !== "started" && value.status !== "completed") ||
        record.version !== (value.status === "started" ? 1 : 2)) {
        throw new TypeError("The stored provider operation is invalid.");
      }
      if (value.fingerprint !== fingerprint) throw new PostgresProviderOperationConflictError();
      if (value.status !== "completed") throw new PostgresProviderOperationUncertainError();
      return { found: true, result: input.parseResult(jsonClone(value.result)) };
    };
    const existing = await readCompleted();
    if (existing.found) return existing.result!;
    try {
      await this.persistence.compareAndSetDocument<ProviderOperationRecord>({
        tenantId: this.tenantId, kind: "provider_operation", scopeId: this.scopeId,
        recordId: operationId, expectedVersion: null,
        value: { version: 1, fingerprint, status: "started" },
      });
    } catch (error) {
      // A known competing claim may already have completed. An ambiguous commit
      // failure never grants permission to dispatch based on absence alone.
      if (error instanceof PostgresPersistenceConflictError) {
        const winner = await readCompleted();
        if (winner.found) return winner.result!;
      }
      throw error;
    }
    const result = input.parseResult(jsonClone(await input.execute()));
    try {
      await this.persistence.compareAndSetDocument<ProviderOperationRecord>({
        tenantId: this.tenantId, kind: "provider_operation", scopeId: this.scopeId,
        recordId: operationId, expectedVersion: 1,
        value: { version: 1, fingerprint, status: "completed", result },
      });
    } catch (error) {
      // Repair a lost completion acknowledgement without another provider call.
      try {
        const saved = await readCompleted();
        if (saved.found) return saved.result!;
      } catch { /* The original write error remains the primary failure. */ }
      throw error;
    }
    return jsonClone(result);
  }
}

/** Durable dispatch claims and reusable completed results. Uncertain outcomes require host reconciliation. */
export class PostgresToolExecutionLedger implements ToolExecutionLedger {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string, readonly scopeId?: string) {
    id(tenantId, "tenantId");
    if (scopeId !== undefined) id(scopeId, "scopeId");
  }

  getOrCreate(toolCallId: string, execute: () => Promise<ApplicationToolResult>, requestFingerprint?: string): Promise<ApplicationToolResult> {
    const key = this.scopeId === undefined ? toolCallId
      : `tool-scope-${createHash("sha256").update(JSON.stringify([this.scopeId, toolCallId])).digest("hex")}`;
    return this.persistence.getOrExecuteTool(this.tenantId, key, execute, requestFingerprint);
  }
}

function eventCursor(conversationId: string, revision: number): ConversationEventCursor {
  return `handrail.pg-event.v1:${encodeURIComponent(conversationId)}:${revision}` as ConversationEventCursor;
}

function revisionFromCursor(cursor: ConversationEventCursor, conversationId: ConversationId): number {
  const match = /^handrail\.pg-event\.v1:([^:]+):(\d+)$/u.exec(cursor);
  if (!match || decodeURIComponent(match[1]!) !== conversationId) throw new ConversationEventStoreConflictError(
    "The event cursor does not belong to this conversation.", {
      code: "cursor_not_found", conversationId, expectedRevision: null,
      actualRevision: null, identifier: cursor,
    });
  return Number(match[2]);
}

function storedEvent(event: ConversationEvent): StoredConversationEvent {
  return Object.freeze({ cursor: eventCursor(event.conversation_id, event.revision), event: jsonClone(event) });
}

/** Tenant-scoped atomic event log and compact-checkpoint implementation. */
export class PostgresConversationEventStore implements ConversationEventStore {
  readonly checkpoints = {
    read: (conversationId: ConversationId) => this.readCheckpoint(conversationId),
    write: (checkpoint: ConversationEventCheckpoint) => this.writeCheckpoint(checkpoint),
  };

  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) { id(tenantId, "tenantId"); }

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (input.events.length === 0) return this.appendConflict("invalid_append", input, null, null);
    const events = input.events.map((event) => parseConversationEvent(event));
    let expected = (input.expectedRevision ?? 0) + 1;
    if (events.some((event) => event.conversation_id !== input.conversationId || event.revision !== expected++)) {
      return this.appendConflict("invalid_append", input, null, null);
    }
    try { return await this.persistence.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [advisoryLockKey(this.tenantId, input.conversationId)]);
      const identifiers = events.flatMap((event) => [event.event_id, ...(event.mutation_id ? [event.mutation_id] : [])]);
      const duplicates = await tx.query<{ payload: ConversationEvent }>(
        "SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND (event_id=ANY($2::text[]) OR mutation_id=ANY($2::text[]))",
        [this.tenantId, identifiers],
      );
      if (duplicates.rows.length > 0) {
        const durable = duplicates.rows.map((row) => parseConversationEvent(row.payload));
        const complete = events.every((event) => durable.some((candidate) => jsonValuesEqual(candidate, event)));
        if (complete && durable.length === events.length) {
          const latest = await this.latest(tx, input.conversationId);
          return Object.freeze({ status: "idempotent" as const, entries: Object.freeze(events.map(storedEvent)), latestRevision: latest! });
        }
        return this.appendConflict("idempotency_conflict", input,
          await this.latest(tx, input.conversationId), identifiers[0] ?? null);
      }
      let actual = await this.latest(tx, input.conversationId);
      if (input.expectedRevision !== null && (actual ?? 0) < input.expectedRevision) {
        const evidence = await tx.query<{ revision: string }>(
          "SELECT revision::text AS revision FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 AND revision >= $3 ORDER BY handrail_ai_events.revision DESC LIMIT 1",
          [this.tenantId, input.conversationId, input.expectedRevision],
        );
        const evidencedRevision = evidence.rows[0] ? Number(evidence.rows[0].revision) as ConversationRevision : null;
        if (evidencedRevision !== null && (actual === null || evidencedRevision > actual)) actual = evidencedRevision;
      }
      if (actual !== input.expectedRevision) return this.appendConflict("revision_conflict", input, actual, null);
      for (const event of events) await tx.query(
        "INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,mutation_id,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
        [this.tenantId, input.conversationId, event.revision, event.event_id, event.mutation_id ?? null, JSON.stringify(event)],
      );
      return Object.freeze({ status: "appended" as const, entries: Object.freeze(events.map(storedEvent)),
        latestRevision: events.at(-1)!.revision });
    }); } catch (error) { throw this.storeError(error, "append"); }
  }

  async read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    const after = input.after?.cursor ? revisionFromCursor(input.after.cursor, input.conversationId)
      : input.after?.revision ?? 0;
    const limit = input.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("Event read limit is invalid");
    try { return await this.persistence.client.transaction(async (tx) => {
      const result = await tx.query<{ payload: ConversationEvent }>(
        "SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 AND revision>$3 ORDER BY revision LIMIT $4",
        [this.tenantId, input.conversationId, after, limit + 1],
      );
      const entries = Object.freeze(result.rows.slice(0, limit).map((row) => storedEvent(parseConversationEvent(row.payload))));
      const queriedLatest = await this.latest(tx, input.conversationId);
      // A routed/read-replica client can transiently report an older aggregate
      // revision than the rows returned by the same logical read. Never publish
      // a latest revision behind evidence already included in this page.
      const pageLatest = entries.at(-1)?.event.revision ?? null;
      const latestRevision = queriedLatest === null || pageLatest !== null && queriedLatest < pageLatest
        ? pageLatest
        : queriedLatest;
      return Object.freeze({ entries, nextCursor: entries.at(-1)?.cursor ?? null,
        latestRevision, hasMore: result.rows.length > limit });
    }); } catch (error) { throw this.storeError(error, "read"); }
  }

  async getLatestRevision(conversationId: ConversationId): Promise<ConversationRevision | null> {
    try { return await this.latest(this.persistence.client, conversationId); }
    catch (error) { throw this.storeError(error, "latest_revision"); }
  }

  private async latest(client: PostgresSqlClient, conversationId: ConversationId): Promise<ConversationRevision | null> {
    const result = await client.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY handrail_ai_events.revision DESC LIMIT 1",
      [this.tenantId, conversationId],
    );
    return result.rows[0] ? Number(result.rows[0].revision) as ConversationRevision : null;
  }

  private appendConflict(code: "invalid_append" | "revision_conflict" | "idempotency_conflict",
    input: AppendConversationEventsInput, actualRevision: ConversationRevision | null, identifier: string | null): never {
    throw new ConversationEventStoreConflictError("The event append conflicts with durable state.", {
      code, conversationId: input.conversationId, expectedRevision: input.expectedRevision, actualRevision, identifier,
    });
  }

  private async readCheckpoint(conversationId: ConversationId): Promise<ConversationEventCheckpoint | null> {
    try { return (await this.persistence.readCheckpoint<ConversationEventCheckpoint>(this.tenantId, conversationId))?.value ?? null; }
    catch (error) { throw this.storeError(error, "checkpoint_read"); }
  }

  private async writeCheckpoint(checkpoint: ConversationEventCheckpoint): Promise<WriteConversationEventCheckpointResult> {
    const current = await this.persistence.readCheckpoint<ConversationEventCheckpoint>(this.tenantId, checkpoint.conversationId);
    if (current && jsonValuesEqual(current.value, checkpoint)) return { status: "idempotent", checkpoint: jsonClone(checkpoint) };
    if (current && current.value.revision >= checkpoint.revision) throw new ConversationEventStoreConflictError(
      "The checkpoint conflicts with durable state.", { code: "checkpoint_conflict", conversationId: checkpoint.conversationId,
        expectedRevision: checkpoint.revision, actualRevision: current.value.revision, identifier: null });
    try {
      const saved = await this.persistence.writeCheckpoint(this.tenantId, checkpoint.conversationId, current?.version ?? null, checkpoint);
      return { status: "written", checkpoint: jsonClone(saved.value) };
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw this.storeError(error, "checkpoint_write");
      throw new ConversationEventStoreConflictError("The checkpoint conflicts with durable state.", {
        code: "checkpoint_conflict", conversationId: checkpoint.conversationId,
        expectedRevision: checkpoint.revision, actualRevision: null, identifier: null,
      });
    }
  }

  private storeError(error: unknown, operation: ConstructorParameters<typeof ConversationEventStoreUnavailableError>[0]): Error {
    if (error instanceof ConversationEventStoreConflictError || error instanceof ConversationEventStoreUnavailableError) return error;
    return new ConversationEventStoreUnavailableError(operation, "The conversation event store is unavailable.");
  }
}

export interface PostgresConversationCatalogOptions<TAuthorizationContext> {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  /** Stable company/user ownership scope derived only after authentication. */
  readonly scopeId: (context: TAuthorizationContext) => string;
  readonly authorize: ConversationCatalogAuthorizer<TAuthorizationContext>;
  readonly createId: () => ConversationId;
  readonly now?: () => ConversationTimestamp;
  /** Runs in the same SQL transaction before the catalog clear is committed. */
  readonly clearContents?: (input: { readonly client: PostgresSqlClient; readonly tenantId: string;
    readonly scopeId: string; readonly conversationId: ConversationId }) => Promise<void>;
  /** Runs in the same SQL transaction before permanent catalog deletion. */
  readonly permanentlyDeleteContents?: (input: { readonly client: PostgresSqlClient; readonly tenantId: string;
    readonly scopeId: string; readonly conversationId: ConversationId }) => Promise<void>;
}

interface PostgresCatalogRow extends Record<string, unknown> {
  readonly conversation_id: string;
  readonly lifecycle: "active" | "archived";
  readonly title: string | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly archived_at: string | Date | null;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
}

function timestamp(value: string | Date): ConversationTimestamp {
  return (value instanceof Date ? value : new Date(value)).toISOString() as ConversationTimestamp;
}

function catalogDescriptor(row: PostgresCatalogRow): ConversationCatalogDescriptor {
  const common = { conversationId: row.conversation_id as ConversationId, title: row.title,
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at),
    version: Number(row.version) as ConversationCatalogVersion, metadata: jsonClone(row.metadata) };
  return parseConversationCatalogDescriptor(row.lifecycle === "active"
    ? { ...common, lifecycle: "active", archivedAt: null }
    : { ...common, lifecycle: "archived", archivedAt: timestamp(row.archived_at!) });
}

function catalogFingerprint(operation: string, value: unknown): string {
  return `${operation}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function cursorValues(cursor: string): { readonly primary: string; readonly conversationId: string } {
  const parts = cursor.split("|");
  return { primary: decodeURIComponent(parts[3]!), conversationId: decodeURIComponent(parts[4]!) };
}

/** Production catalog with authorization-before-lookup, keyset pages, CAS, and durable idempotency. */
export class PostgresConversationCatalog<TAuthorizationContext> implements ConversationCatalog<TAuthorizationContext> {
  readonly capabilities = Object.freeze({ rename: { supported: true as const }, clear: { supported: true as const },
    archive: { supported: true as const }, restore: { supported: true as const }, permanentDelete: { supported: true as const } });
  readonly #now: () => ConversationTimestamp;
  constructor(readonly options: PostgresConversationCatalogOptions<TAuthorizationContext>) {
    id(options.tenantId, "tenantId"); this.#now = options.now ?? (() => new Date().toISOString() as ConversationTimestamp);
  }

  async list(value: Parameters<ConversationCatalog<TAuthorizationContext>["list"]>[0]): Promise<ListConversationsResult> {
    const input = parseListConversationsInput<TAuthorizationContext>(value); await this.allowed({ action: "list", authorizationContext: input.authorizationContext });
    const scope = id(this.options.scopeId(input.authorizationContext), "scopeId");
    const cursor = input.cursor ? cursorValues(input.cursor) : null;
    const primary = input.order.field === "updated_at" ? "updated_at" : "created_at";
    const comparison = input.order.direction === "asc" ? ">" : "<";
    const order = input.order.direction === "asc" ? "ASC" : "DESC";
    const values: unknown[] = [this.options.tenantId, scope, input.pageSize + 1];
    let lifecycleSql = "", cursorSql = "";
    if (input.lifecycle !== "all") { values.push(input.lifecycle); lifecycleSql = ` AND lifecycle=$${values.length}`; }
    if (cursor) {
      const primaryIndex = values.length + 1, idIndex = values.length + 2;
      values.push(cursor.primary, cursor.conversationId);
      cursorSql = ` AND (${primary}${comparison}$${primaryIndex} OR (${primary}=$${primaryIndex} AND conversation_id>$${idIndex}))`;
    }
    try {
      const rows = await this.options.persistence.client.query<PostgresCatalogRow>(
        `SELECT conversation_id,lifecycle,title,created_at,updated_at,archived_at,version::text AS version,metadata FROM handrail_ai_conversations WHERE tenant_id=$1 AND scope_id=$2${lifecycleSql}${cursorSql} ORDER BY ${primary} ${order},conversation_id ASC LIMIT $3`,
        values,
      );
      const items = Object.freeze(rows.rows.slice(0, input.pageSize).map(catalogDescriptor));
      const hasMore = rows.rows.length > input.pageSize, final = items.at(-1);
      return Object.freeze({ items, hasMore, nextCursor: hasMore && final ? createConversationCatalogCursor(final, input.order) : null,
        order: input.order });
    } catch (error) { throw this.storageError(error, "list"); }
  }

  async create(value: Parameters<ConversationCatalog<TAuthorizationContext>["create"]>[0]): Promise<CreateConversationResult> {
    const input = parseCreateConversationInput<TAuthorizationContext>(value); await this.allowed({ action: "create", authorizationContext: input.authorizationContext,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}) });
    const scope = id(this.options.scopeId(input.authorizationContext), "scopeId");
    const fingerprint = catalogFingerprint("create", { conversationId: input.conversationId ?? null, title: input.title ?? null, metadata: input.metadata ?? {} });
    try {
      const retained = await this.options.persistence.getOrCreateIdempotent({ tenantId: this.options.tenantId, domain: "catalog.create", scopeId: scope,
        idempotencyKey: input.idempotencyKey, fingerprint, execute: async (tx) => {
          const conversationId = input.conversationId ?? this.options.createId(); const now = this.#now();
          const descriptor: ActiveConversationCatalogDescriptor = Object.freeze({ conversationId, title: input.title ?? null,
            createdAt: now, updatedAt: now, version: 1 as ConversationCatalogVersion, metadata: input.metadata ?? {}, lifecycle: "active", archivedAt: null });
          await tx.query("INSERT INTO handrail_ai_conversations (tenant_id,scope_id,conversation_id,lifecycle,title,created_at,updated_at,archived_at,version,metadata) VALUES ($1,$2,$3,'active',$4,$5,$5,NULL,1,$6::jsonb)",
            [this.options.tenantId, scope, conversationId, descriptor.title, now, JSON.stringify(descriptor.metadata)]);
          return descriptor;
        } });
      return Object.freeze({ operation: "create", status: retained.status === "created" ? "created" : "idempotent", descriptor: retained.value });
    } catch (error) { throw this.idempotencyError(error, "create"); }
  }

  async get(value: Parameters<ConversationCatalog<TAuthorizationContext>["get"]>[0]): Promise<GetConversationResult> {
    const input = parseGetConversationInput<TAuthorizationContext>(value); await this.allowed({ action: "get", authorizationContext: input.authorizationContext,
      conversationId: input.conversationId });
    let descriptor: ConversationCatalogDescriptor | null;
    try { descriptor = await this.lookup(this.options.persistence.client, this.options.scopeId(input.authorizationContext), input.conversationId); }
    catch (error) { throw this.storageError(error, "get"); }
    if (!descriptor) throw new ConversationCatalogError("not_found", "get");
    return Object.freeze({ operation: "get", status: "found", descriptor });
  }

  rename(value: Parameters<ConversationCatalog<TAuthorizationContext>["rename"]>[0]): Promise<RenameConversationResult> {
    const input = parseRenameConversationInput<TAuthorizationContext>(value);
    return this.mutate("rename", input, (current, now) => ({ ...current, title: input.title, updatedAt: now }), "updated");
  }
  clear(value: Parameters<ConversationCatalog<TAuthorizationContext>["clear"]>[0]): Promise<ClearConversationResult> {
    const input = parseClearConversationInput<TAuthorizationContext>(value);
    return this.mutate("clear", input, (current, now) => ({ ...current, updatedAt: now }), "cleared", this.options.clearContents) as Promise<ClearConversationResult>;
  }
  archive(value: Parameters<ConversationCatalog<TAuthorizationContext>["archive"]>[0]): Promise<ArchiveConversationResult> {
    const input = parseArchiveConversationInput<TAuthorizationContext>(value);
    return this.mutate("archive", input, (current, now) => ({ ...current, lifecycle: "archived", archivedAt: now, updatedAt: now }), "archived") as Promise<ArchiveConversationResult>;
  }
  restore(value: Parameters<ConversationCatalog<TAuthorizationContext>["restore"]>[0]): Promise<RestoreConversationResult> {
    const input = parseRestoreConversationInput<TAuthorizationContext>(value);
    return this.mutate("restore", input, (current, now) => ({ ...current, lifecycle: "active", archivedAt: null, updatedAt: now }), "restored") as Promise<RestoreConversationResult>;
  }

  async permanentlyDelete(value: Parameters<ConversationCatalog<TAuthorizationContext>["permanentlyDelete"]>[0]): Promise<PermanentlyDeleteConversationResult> {
    const input = parsePermanentlyDeleteConversationInput<TAuthorizationContext>(value); await this.allowed({ action: "permanent_delete",
      authorizationContext: input.authorizationContext, conversationId: input.conversationId });
    const scope = id(this.options.scopeId(input.authorizationContext), "scopeId");
    const deleteFingerprint = catalogFingerprint("permanent_delete", {
      conversationId: input.conversationId, expectedVersion: input.expectedVersion,
    });
    try {
      const retained = await this.options.persistence.getOrCreateIdempotent({ tenantId: this.options.tenantId, domain: "catalog.permanent_delete",
        scopeId: scope, idempotencyKey: input.idempotencyKey, fingerprint: deleteFingerprint, execute: async (tx) => {
          const current = await this.lookup(tx, scope, input.conversationId, true);
          if (!current) throw new ConversationCatalogError("not_found", "permanent_delete");
          if (current.version !== input.expectedVersion) throw new ConversationCatalogError("version_conflict", "permanent_delete");
          await this.options.permanentlyDeleteContents?.({ client: tx, tenantId: this.options.tenantId, scopeId: scope, conversationId: input.conversationId });
          const deleted = await tx.query("DELETE FROM handrail_ai_conversations WHERE tenant_id=$1 AND scope_id=$2 AND conversation_id=$3 AND version=$4",
            [this.options.tenantId, scope, input.conversationId, input.expectedVersion]);
          if (deleted.rowCount !== 1) throw new ConversationCatalogError("version_conflict", "permanent_delete");
          return { conversationId: input.conversationId, deletedVersion: input.expectedVersion };
        } });
      return Object.freeze({ operation: "permanent_delete", status: retained.status === "created" ? "deleted" : "idempotent", ...retained.value });
    } catch (error) { throw this.idempotencyError(error, "permanent_delete"); }
  }

  private async mutate<TOperation extends "rename" | "clear" | "archive" | "restore", TSuccess extends "updated" | "cleared" | "archived" | "restored">(
    operation: TOperation, input: { authorizationContext: TAuthorizationContext;
    conversationId: ConversationId; expectedVersion: ConversationCatalogVersion; idempotencyKey: string },
    update: (current: ConversationCatalogDescriptor, now: ConversationTimestamp) => ConversationCatalogDescriptor,
    success: TSuccess,
    contents?: PostgresConversationCatalogOptions<TAuthorizationContext>["clearContents"],
  ): Promise<{ readonly operation: TOperation; readonly status: TSuccess | "idempotent"; readonly descriptor: ConversationCatalogDescriptor }> {
    await this.allowed({ action: operation, authorizationContext: input.authorizationContext, conversationId: input.conversationId });
    const scope = id(this.options.scopeId(input.authorizationContext), "scopeId");
    const logicalInput = { ...input } as Record<string, unknown>;
    delete logicalInput.authorizationContext;
    try {
      const retained = await this.options.persistence.getOrCreateIdempotent({ tenantId: this.options.tenantId, domain: `catalog.${operation}`,
        scopeId: scope, idempotencyKey: input.idempotencyKey, fingerprint: catalogFingerprint(operation, logicalInput), execute: async (tx) => {
          const current = await this.lookup(tx, scope, input.conversationId, true);
          if (!current) throw new ConversationCatalogError("not_found", operation);
          if (current.version !== input.expectedVersion) throw new ConversationCatalogError("version_conflict", operation);
          if (operation === "archive" && current.lifecycle !== "active" || operation === "restore" && current.lifecycle !== "archived" || operation === "clear" && current.lifecycle !== "active") {
            throw new ConversationCatalogError("invalid_input", operation);
          }
          await contents?.({ client: tx, tenantId: this.options.tenantId, scopeId: scope, conversationId: input.conversationId });
          const next = { ...update(current, this.#now()), version: (current.version + 1) as ConversationCatalogVersion } as ConversationCatalogDescriptor;
          const changed = await tx.query("UPDATE handrail_ai_conversations SET lifecycle=$5,title=$6,updated_at=$7,archived_at=$8,version=$9,metadata=$10::jsonb WHERE tenant_id=$1 AND scope_id=$2 AND conversation_id=$3 AND version=$4",
            [this.options.tenantId, scope, input.conversationId, input.expectedVersion, next.lifecycle, next.title, next.updatedAt, next.archivedAt, next.version, JSON.stringify(next.metadata)]);
          if (changed.rowCount !== 1) throw new ConversationCatalogError("version_conflict", operation);
          return next;
        } });
      return Object.freeze({ operation, status: retained.status === "created" ? success : "idempotent", descriptor: retained.value });
    } catch (error) { throw this.idempotencyError(error, operation); }
  }

  private async lookup(client: PostgresSqlClient, scope: string, conversationId: ConversationId, lock = false): Promise<ConversationCatalogDescriptor | null> {
    const result = await client.query<PostgresCatalogRow>(
      `SELECT conversation_id,lifecycle,title,created_at,updated_at,archived_at,version::text AS version,metadata FROM handrail_ai_conversations WHERE tenant_id=$1 AND scope_id=$2 AND conversation_id=$3${lock ? " FOR UPDATE" : ""}`,
      [this.options.tenantId, id(scope, "scopeId"), conversationId],
    );
    return result.rows[0] ? catalogDescriptor(result.rows[0]) : null;
  }
  private async allowed(request: Parameters<ConversationCatalogAuthorizer<TAuthorizationContext>>[0]): Promise<void> {
    if (await this.options.authorize(request) !== "allow") throw new ConversationCatalogError("forbidden", request.action);
  }
  private idempotencyError(error: unknown, operation: Parameters<ConversationCatalogAuthorizer<TAuthorizationContext>>[0]["action"]): unknown {
    if (error instanceof ConversationCatalogError) return error;
    if (error instanceof PostgresPersistenceConflictError) return new ConversationCatalogError("idempotency_conflict", operation);
    return new ConversationCatalogError("unavailable", operation);
  }
  private storageError(error: unknown, operation: Parameters<ConversationCatalogAuthorizer<TAuthorizationContext>>[0]["action"]): Error {
    return error instanceof ConversationCatalogError ? error : new ConversationCatalogError("unavailable", operation);
  }
}

export interface PostgresApprovalProposalStoreOptions<TPermissionContext> {
  readonly persistence: PostgresAiPersistence;
  readonly tenantId: string;
  readonly scopeId: (context: TPermissionContext) => string;
  readonly authorize: ApprovalProposalPermissionCheck<TPermissionContext>;
  readonly now?: () => ConversationTimestamp;
  readonly expiryAttribution?: ConversationEventAttribution;
}

const POSTGRES_EXPIRY_ATTRIBUTION = Object.freeze({ actor: { type: "system" as const }, source: { type: "runtime" as const } });

function approvalId(value: unknown, operation: "create" | "get" | "list_group" | "transition"): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new ApprovalProposalStoreError("invalid_input", operation);
  return value;
}

function approvalRecord(value: unknown, operation: "create" | "get" | "list_group" | "transition"): ConversationApprovalProposalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApprovalProposalStoreError("unavailable", operation);
  let candidate: unknown;
  try { candidate = jsonClone(value); } catch { throw new ApprovalProposalStoreError("unavailable", operation); }
  if (!isConversationApprovalProposalRecord(candidate)) throw new ApprovalProposalStoreError("unavailable", operation);
  return candidate;
}

function approvalTransition(current: ConversationApprovalProposalRecord, input: TransitionApprovalProposalInput<unknown>,
  now: ConversationTimestamp): ConversationApprovalProposalRecord {
  const decision = ["confirmed", "rejected", "expired"].includes(input.status);
  return jsonClone({ ...current, status: input.status, proposal_version: current.proposal_version + 1,
    updated_at: now, latest_attribution: input.attribution,
    decision_at: decision ? now : current.decision_at,
    decision_attribution: decision ? input.attribution : current.decision_attribution,
    decision_reason: decision ? input.decisionReason ?? null : current.decision_reason,
    failure_reason: input.status === "failed" ? input.failureReason! : input.status === "executing" ? null : current.failure_reason });
}

/** Durable approval proposals; authorization runs before every identifier lookup. */
export class PostgresApprovalProposalStore<TPermissionContext> implements ApprovalProposalStore<TPermissionContext> {
  readonly #now: () => ConversationTimestamp;
  readonly #expiryAttribution: ConversationEventAttribution;
  constructor(readonly options: PostgresApprovalProposalStoreOptions<TPermissionContext>) {
    id(options.tenantId, "tenantId"); this.#now = options.now ?? (() => new Date().toISOString() as ConversationTimestamp);
    this.#expiryAttribution = options.expiryAttribution ?? POSTGRES_EXPIRY_ATTRIBUTION;
  }

  async create(input: CreateApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord> {
    approvalId(input.proposalId, "create"); approvalId(input.turnId, "create"); approvalId(input.toolCallId, "create"); approvalId(input.toolName, "create");
    if (input.groupId !== undefined) approvalId(input.groupId, "create");
    if (!isConversationApprovalReviewedArguments(input.reviewedArguments) || input.attribution.actor.type !== "system" ||
      !Number.isFinite(Date.parse(input.expiresAt)) || !this.validIdempotency(input)) throw new ApprovalProposalStoreError("invalid_input", "create");
    await this.allowed({ operation: "create", permissionContext: input.permissionContext, proposalId: input.proposalId,
      ...(input.groupId ? { groupId: input.groupId } : {}) });
    const scope = id(this.options.scopeId(input.permissionContext), "scopeId"), now = this.#now();
    if (Date.parse(input.expiresAt) <= Date.parse(now)) throw new ApprovalProposalStoreError("invalid_input", "create");
    const logical = { proposalId: input.proposalId, groupId: input.groupId ?? null, turnId: input.turnId,
      toolCallId: input.toolCallId, toolName: input.toolName, reviewedArguments: input.reviewedArguments,
      expiresAt: input.expiresAt, attribution: input.attribution };
    try {
      const retained = await this.options.persistence.getOrCreateIdempotent({ tenantId: this.options.tenantId,
        domain: "approval.create", scopeId: scope, idempotencyKey: input.idempotencyKey,
        fingerprint: catalogFingerprint(input.idempotencyFingerprint, logical), execute: async (tx) => {
          const record = approvalRecord({ proposal_id: input.proposalId, group_id: input.groupId ?? null,
            turn_id: input.turnId, tool_call_id: input.toolCallId, tool_name: input.toolName,
            reviewed_arguments: input.reviewedArguments, status: "pending", proposal_version: 1,
            expires_at: input.expiresAt, created_at: now, updated_at: now,
            created_attribution: input.attribution, latest_attribution: input.attribution,
            decision_at: null, decision_attribution: null, decision_reason: null, failure_reason: null }, "create");
          await tx.query("INSERT INTO handrail_ai_approvals (tenant_id,scope_id,proposal_id,group_id,version,payload,updated_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6)",
            [this.options.tenantId, scope, input.proposalId, input.groupId ?? null, JSON.stringify(record), now]);
          return record;
        } });
      return approvalRecord(retained.value, "create");
    } catch (error) { throw this.conflict(error, "create"); }
  }

  async get(input: GetApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord | null> {
    approvalId(input.proposalId, "get"); await this.allowed({ operation: "get", permissionContext: input.permissionContext, proposalId: input.proposalId });
    const scope = id(this.options.scopeId(input.permissionContext), "scopeId");
    try { return await this.options.persistence.client.transaction(async (tx) => {
      const current = await this.lookup(tx, scope, input.proposalId, true);
      return current ? this.expireIfDue(tx, scope, current) : null;
    }); } catch (error) { throw this.unavailable(error, "get"); }
  }

  async listGroup(input: ListApprovalProposalGroupInput<TPermissionContext>): Promise<readonly ConversationApprovalProposalRecord[]> {
    approvalId(input.groupId, "list_group"); await this.allowed({ operation: "list_group", permissionContext: input.permissionContext, groupId: input.groupId });
    const scope = id(this.options.scopeId(input.permissionContext), "scopeId");
    try { return await this.options.persistence.client.transaction(async (tx) => {
      const result = await tx.query<{ payload: unknown }>("SELECT payload FROM handrail_ai_approvals WHERE tenant_id=$1 AND scope_id=$2 AND group_id=$3 ORDER BY updated_at,proposal_id FOR UPDATE",
        [this.options.tenantId, scope, input.groupId]);
      const records: ConversationApprovalProposalRecord[] = [];
      for (const row of result.rows) records.push(await this.expireIfDue(tx, scope, approvalRecord(row.payload, "list_group")));
      return Object.freeze(records);
    }); } catch (error) { throw this.unavailable(error, "list_group"); }
  }

  async transition(input: TransitionApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord> {
    approvalId(input.proposalId, "transition");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !this.validIdempotency(input) ||
      !["confirmed", "rejected", "expired", "executing", "executed", "failed"].includes(input.status) ||
      (input.decisionReason !== undefined && (!["confirmed", "rejected", "expired"].includes(input.status) ||
        !isConversationApprovalReason(input.decisionReason))) ||
      (input.status === "failed" ? !isConversationApprovalReason(input.failureReason) : input.failureReason !== undefined)) {
      throw new ApprovalProposalStoreError("invalid_input", "transition");
    }
    await this.allowed({ operation: "transition", permissionContext: input.permissionContext,
      proposalId: input.proposalId, targetStatus: input.status });
    const scope = id(this.options.scopeId(input.permissionContext), "scopeId");
    const logical = { proposalId: input.proposalId, expectedVersion: input.expectedVersion, status: input.status,
      attribution: input.attribution, decisionReason: input.decisionReason ?? null, failureReason: input.failureReason ?? null };
    try {
      const retained = await this.options.persistence.getOrCreateIdempotent({ tenantId: this.options.tenantId,
        domain: "approval.transition", scopeId: scope, idempotencyKey: input.idempotencyKey,
        fingerprint: catalogFingerprint(input.idempotencyFingerprint, logical), execute: async (tx) => {
          const current = await this.lookup(tx, scope, input.proposalId, true);
          if (!current) throw new ApprovalProposalStoreError("not_found", "transition");
          if (current.proposal_version !== input.expectedVersion) throw new ApprovalProposalStoreError("version_conflict", "transition");
          const now = this.#now(), expired = Date.parse(now) >= Date.parse(current.expires_at);
          if (input.status === "expired" && !expired) throw new ApprovalProposalStoreError("not_expired", "transition");
          if ((current.status === "pending" && expired && input.status !== "expired") ||
            (input.status === "executing" && expired) || !isLegalConversationApprovalProposalTransition(current.status, input.status)) {
            throw new ApprovalProposalStoreError("invalid_transition", "transition");
          }
          if (["expired", "executing", "executed", "failed"].includes(input.status) && input.attribution.actor.type !== "system" ||
            ["confirmed", "rejected"].includes(input.status) && !["user", "system"].includes(input.attribution.actor.type)) {
            throw new ApprovalProposalStoreError("invalid_input", "transition");
          }
          const next = approvalTransition(current, input as TransitionApprovalProposalInput<unknown>, now);
          const updated = await tx.query("UPDATE handrail_ai_approvals SET version=$4,payload=$5::jsonb,updated_at=$6 WHERE tenant_id=$1 AND scope_id=$2 AND proposal_id=$3 AND version=$7",
            [this.options.tenantId, scope, input.proposalId, next.proposal_version, JSON.stringify(next), now, input.expectedVersion]);
          if (updated.rowCount !== 1) throw new ApprovalProposalStoreError("version_conflict", "transition");
          return next;
        } });
      return approvalRecord(retained.value, "transition");
    } catch (error) { throw this.conflict(error, "transition"); }
  }

  private async lookup(client: PostgresSqlClient, scope: string, proposalId: string, lock: boolean): Promise<ConversationApprovalProposalRecord | null> {
    const result = await client.query<{ payload: unknown }>(`SELECT payload FROM handrail_ai_approvals WHERE tenant_id=$1 AND scope_id=$2 AND proposal_id=$3${lock ? " FOR UPDATE" : ""}`,
      [this.options.tenantId, scope, proposalId]);
    return result.rows[0] ? approvalRecord(result.rows[0].payload, "get") : null;
  }
  private async expireIfDue(tx: PostgresSqlClient, scope: string, current: ConversationApprovalProposalRecord): Promise<ConversationApprovalProposalRecord> {
    const now = this.#now();
    if (current.status !== "pending" || Date.parse(now) < Date.parse(current.expires_at)) return current;
    const next = approvalTransition(current, { status: "expired", attribution: this.#expiryAttribution } as TransitionApprovalProposalInput<unknown>, now);
    await tx.query("UPDATE handrail_ai_approvals SET version=$4,payload=$5::jsonb,updated_at=$6 WHERE tenant_id=$1 AND scope_id=$2 AND proposal_id=$3 AND version=$7",
      [this.options.tenantId, scope, current.proposal_id, next.proposal_version, JSON.stringify(next), now, current.proposal_version]);
    return next;
  }
  private validIdempotency(input: { idempotencyKey: string; idempotencyFingerprint: string }): boolean {
    return /^[a-z0-9][a-z0-9._:/-]*$/iu.test(input.idempotencyKey) && input.idempotencyKey.length <= 256 &&
      /^[a-z0-9][a-z0-9._:/-]*$/iu.test(input.idempotencyFingerprint) && input.idempotencyFingerprint.length <= 256;
  }
  private async allowed(request: Parameters<ApprovalProposalPermissionCheck<TPermissionContext>>[0]): Promise<void> {
    try { if (await this.options.authorize(request) === "allow") return; } catch { /* denial */ }
    throw new ApprovalProposalStoreError("permission_denied", request.operation);
  }
  private conflict(error: unknown, operation: "create" | "transition"): unknown {
    if (error instanceof ApprovalProposalStoreError) return error;
    if (error instanceof PostgresPersistenceConflictError) return new ApprovalProposalStoreError("idempotency_conflict", operation);
    return new ApprovalProposalStoreError("unavailable", operation);
  }
  private unavailable(error: unknown, operation: "get" | "list_group"): Error {
    return error instanceof ApprovalProposalStoreError ? error : new ApprovalProposalStoreError("unavailable", operation);
  }
}

/** Identity used to scope every store in one authenticated assistant request. */
export interface PostgresAssistantPersistenceScope {
  readonly tenantId: string;
  readonly scopeId: string;
}

export interface PostgresAssistantPersistenceOptions {
  readonly diagnostics?: AiDiagnosticSink;
  readonly attachmentLimits?: AttachmentStagingLimits;
  readonly usageClient?: AIRuntimeUsageClient;
}

export interface PostgresAssistantScopedOptions<TAuthorizationContext> {
  readonly createConversationId: () => ConversationId;
  readonly authorizeConversation?: ConversationCatalogAuthorizer<TAuthorizationContext>;
  readonly authorizeApproval?: ApprovalProposalPermissionCheck<TAuthorizationContext>;
  readonly usageClient?: AIRuntimeUsageClient;
}

/**
 * The complete durable store graph for one server-authenticated tenant/scope.
 * It is deliberately created after authorization so browser-controlled fields
 * can never select persistence partitions.
 */
export interface PostgresAssistantPersistenceBundle<TAuthorizationContext> {
  readonly persistence: PostgresAiPersistence;
  readonly continuation: PostgresOpenAIResponsesContinuationStore;
  readonly managedTurns: PostgresManagedRuntimeTurnStateStore;
  readonly durableTurns: PostgresDurableApplicationTurnStore;
  readonly activity: PostgresConversationActivityStore;
  readonly attachmentBlobs: PostgresAttachmentBlobStore;
  readonly attachmentMetadata: PostgresAttachmentStagingMetadataStore;
  readonly attachments: ReturnType<typeof createAttachmentStagingService>;
  readonly synchronization: PostgresConversationSyncStateStore;
  readonly events: PostgresConversationEventStore;
  readonly toolLedger: PostgresToolExecutionLedger;
  readonly catalog: PostgresConversationCatalog<TAuthorizationContext>;
  readonly approvals: PostgresApprovalProposalStore<TAuthorizationContext>;
  readonly usageOutbox: PostgresAIRuntimeUsageOutbox;
  readonly usageAdmissions: PostgresAIRuntimeUsageAdmissionStore | null;
  readonly usageReceiptSink: ReturnType<typeof createAIRuntimeUsageReceiptSink> | null;
}

export interface PostgresAssistantPersistence {
  readonly persistence: PostgresAiPersistence;
  readonly attachmentLimits: AttachmentStagingLimits;
  forScope<TAuthorizationContext>(
    scope: PostgresAssistantPersistenceScope,
    options: PostgresAssistantScopedOptions<TAuthorizationContext>,
  ): PostgresAssistantPersistenceBundle<TAuthorizationContext>;
}

const DEFAULT_ASSISTANT_ATTACHMENT_LIMITS: AttachmentStagingLimits = Object.freeze({
  maximumBytes: 20 * 1024 * 1024,
  acceptedMediaTypes: Object.freeze(["image/*", "application/pdf", "text/plain"]),
  ttlMilliseconds: 60 * 60 * 1_000,
  cleanupBatchSize: 100,
});

/** Adapt a pg Pool into the complete production persistence bundle. */
export function postgres(
  pool: PostgresPoolLike,
  options: PostgresAssistantPersistenceOptions = {},
): PostgresAssistantPersistence {
  return postgresFromClient(createPostgresSqlClientFromPool(pool), options);
}

/** Adapt an application's transactional SQL client without requiring `pg`. */
export function postgresFromClient(
  client: PostgresSqlClient,
  options: PostgresAssistantPersistenceOptions = {},
): PostgresAssistantPersistence {
  const persistence = new PostgresAiPersistence(createDiagnosedPostgresSqlClient(client, options.diagnostics));
  const attachmentLimits = Object.freeze(options.attachmentLimits ?? DEFAULT_ASSISTANT_ATTACHMENT_LIMITS);
  return Object.freeze({
    persistence,
    attachmentLimits,
    forScope<TAuthorizationContext>(
      scope: PostgresAssistantPersistenceScope,
      scoped: PostgresAssistantScopedOptions<TAuthorizationContext>,
    ): PostgresAssistantPersistenceBundle<TAuthorizationContext> {
      const tenantId = id(scope.tenantId, "tenantId");
      const scopeId = id(scope.scopeId, "scopeId");
      const attachmentBlobs = new PostgresAttachmentBlobStore(persistence, tenantId);
      const attachmentMetadata = new PostgresAttachmentStagingMetadataStore(persistence, tenantId, scopeId);
      const usageOutbox = new PostgresAIRuntimeUsageOutbox(persistence, tenantId, scopeId);
      const usageClient = scoped.usageClient ?? options.usageClient;
      return Object.freeze({
        persistence,
        continuation: new PostgresOpenAIResponsesContinuationStore({ persistence, tenantId, scopeId }),
        managedTurns: new PostgresManagedRuntimeTurnStateStore(persistence, tenantId),
        durableTurns: new PostgresDurableApplicationTurnStore(persistence, tenantId),
        activity: new PostgresConversationActivityStore(persistence, tenantId, scopeId),
        attachmentBlobs,
        attachmentMetadata,
        attachments: createAttachmentStagingService({
          blobs: attachmentBlobs,
          metadata: attachmentMetadata,
          limits: attachmentLimits,
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        }),
        synchronization: new PostgresConversationSyncStateStore(persistence, tenantId),
        events: new PostgresConversationEventStore(persistence, tenantId),
        toolLedger: new PostgresToolExecutionLedger(persistence, tenantId, scopeId),
        catalog: new PostgresConversationCatalog({
          persistence,
          tenantId,
          scopeId: () => scopeId,
          authorize: scoped.authorizeConversation ?? (() => "allow"),
          createId: scoped.createConversationId,
        }),
        approvals: new PostgresApprovalProposalStore({
          persistence,
          tenantId,
          scopeId: () => scopeId,
          authorize: scoped.authorizeApproval ?? (() => "allow"),
        }),
        usageOutbox,
        usageAdmissions: usageClient
          ? new PostgresAIRuntimeUsageAdmissionStore(persistence, tenantId, scopeId, usageClient) : null,
        usageReceiptSink: usageClient
          ? createAIRuntimeUsageReceiptSink(usageClient, usageOutbox)
          : null,
      });
    },
  });
}

export { PostgresRealtimeWorkspaceActivityStore, type AuthorizedRealtimeConversation, type RealtimeWorkspaceCursor } from "./realtime-workspace.js";
