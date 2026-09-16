import { PostgresAiPersistence, PostgresConversationEventStore,
  type PostgresDocumentKind, type PostgresSqlClient } from "./index.js";
import { replayConversation } from "../conversation/replay.js";
import { ConversationEventStoreUnavailableError } from "../conversation/event-store.js";
import type { ConversationId } from "../conversation/events.js";
import { postgresRealtimeToolActivityScope } from "./realtime-tool-activity.js";
import { PostgresRealtimeCallStore } from "./realtime-calls.js";

export class PostgresConversationDeletionBlockedError extends Error {
  readonly code = "conversation_deletion_blocked" as const;
  constructor() {
    super("The conversation still has unresolved work or unreadable history.");
    this.name = "PostgresConversationDeletionBlockedError";
  }
}

/** A permanent identity fence, containing no transcript or authentication data. */
export class PostgresConversationDeletedError extends Error {
  readonly code = "conversation_deleted" as const;
  constructor() {
    super("The conversation has been permanently deleted.");
    this.name = "PostgresConversationDeletedError";
  }
}

export function postgresConversationLockKey(tenantId: string, conversationId: string): string {
  return [tenantId, conversationId].map(part => `${new TextEncoder().encode(part).byteLength}:${part}`).join("|");
}

/** Caller must hold a transaction. Uses the same lock as canonical event append. */
export async function lockPostgresConversation(
  client: PostgresSqlClient, tenantId: string, conversationId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [postgresConversationLockKey(tenantId, conversationId)]);
}

/** Serialize admission with deletion, and reject stale writers after the seal commits. */
export async function assertPostgresConversationWritable(
  client: PostgresSqlClient, tenantId: string, conversationId: string,
): Promise<void> {
  await lockPostgresConversation(client, tenantId, conversationId);
  const deleted = await client.query(
    "SELECT record_id FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted'",
    [tenantId, conversationId]);
  if (deleted.rows.length) throw new PostgresConversationDeletedError();
}

/** Resolve only the SDK's documented conversation bindings; never guess receipt ownership. */
export function postgresDocumentConversation(
  kind: PostgresDocumentKind, scopeId: string, recordId: string, value: unknown,
): string | null {
  if (["catalog_identity", "checkpoint", "approval", "turn_state", "durable_turn", "sync_state"].includes(kind)) return scopeId;
  if (kind === "catalog" || kind === "activity") return recordId;
  if (kind === "attachment" && value && typeof value === "object" && "retainedConversationId" in value &&
    typeof value.retainedConversationId === "string" && value.retainedConversationId.length > 0) return value.retainedConversationId;
  if (["attachment", "realtime_call", "openai_continuation", "provider_operation"].includes(kind) &&
    value && typeof value === "object" && "conversationId" in value &&
    typeof value.conversationId === "string" && value.conversationId.length > 0) return value.conversationId;
  return null;
}

/** Serialize reference creation/removal with deletion of a shared blob. */
export async function lockPostgresAttachmentBlob(client: PostgresSqlClient, tenantId: string, blobKey: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [JSON.stringify(["handrail-attachment-blob", tenantId, blobKey])]);
}

/** Read-only readiness check shared by deletion and managed upload expiry.
 * The caller must hold the transaction's conversation lock. Returns validated
 * voice activity partitions without deleting their read state or any receipts. */
export async function assertPostgresConversationIdle(
  client: PostgresSqlClient, tenantId: string, conversationId: ConversationId,
): Promise<readonly string[]> {
  const persistence = new PostgresAiPersistence(client);
  const voiceScopes: string[] = [];
  // An expired lease or failed local wait does not establish remote termination.
  const active = await client.query(`SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND (
    (kind='durable_turn' AND scope_id=$2 AND COALESCE(payload->>'status','') NOT IN ('completed','cancelled','failed')) OR
    (kind='realtime_call' AND payload->>'conversationId'=$2 AND COALESCE(payload->>'status','') <> 'ended')) LIMIT 1`,
  [tenantId, conversationId]);
  const approvals = await client.query(`SELECT 1 FROM handrail_ai_approvals WHERE tenant_id=$1
    AND group_id=$2 AND payload->>'status'='pending' LIMIT 1`, [tenantId, conversationId]);
  // A provider operation may outlive the text turn (dictation/title work in
  // particular). Only verified completion permits response-content removal.
  const providers = await client.query(`SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1
    AND kind='provider_operation' AND payload->>'conversationId'=$2 AND (
      ((version=2 AND payload->>'status'='completed') OR (version=3 AND payload->>'status'='purged'))
      AND payload->>'version'='1' AND payload->>'fingerprint' ~ '^[a-f0-9]{64}$'
    ) IS NOT TRUE LIMIT 1`, [tenantId, conversationId]);
  if (active.rows.length || approvals.rows.length || providers.rows.length) throw new PostgresConversationDeletionBlockedError();
  // Hangup does not undo a tool already dispatched by the voice connection.
  // Old activity rows have only a call-derived partition, not a conversation
  // field. Resolve that documented binding from the retained call identities.
  let after: { scope_id: string; record_id: string } | undefined;
  for (;;) {
    const calls = await client.query<{ scope_id: string; record_id: string }>(`SELECT scope_id,record_id
      FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='realtime_call' AND payload->>'conversationId'=$2
        AND ($3::text IS NULL OR (scope_id,record_id)>($3,$4)) ORDER BY scope_id,record_id LIMIT 100`,
    [tenantId, conversationId, after?.scope_id ?? null, after?.record_id ?? null]);
    if (!calls.rows.length) break;
    for (const row of calls.rows) {
      try {
        const call = await new PostgresRealtimeCallStore(persistence, tenantId, row.scope_id).get(row.record_id);
        if (!call || call.conversationId !== conversationId || call.status !== 'ended') throw new PostgresConversationDeletionBlockedError();
      } catch { throw new PostgresConversationDeletionBlockedError(); }
    }
    const scopes = calls.rows.map(call => postgresRealtimeToolActivityScope(call.scope_id, call.record_id));
    const unfinished = await client.query(`SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1
      AND kind='realtime_tool_activity' AND scope_id=ANY($2::text[])
      AND COALESCE(payload->>'status','') NOT IN ('completed','failed') LIMIT 1`, [tenantId, scopes]);
    if (unfinished.rows.length) throw new PostgresConversationDeletionBlockedError();
    voiceScopes.push(...scopes);
    if (calls.rows.length < 100) break;
    after = calls.rows.at(-1);
  }
  const history = await replayConversation({
    eventStore: new PostgresConversationEventStore(persistence, tenantId),
    conversationId: conversationId, checkpointPolicy: false,
  }).catch((error: unknown) => {
    // A malformed persisted event blocks this conversation only. A database
    // outage must remain an availability failure, rather than a successful scan.
    if (error instanceof ConversationEventStoreUnavailableError && !error.retryable) {
      throw new PostgresConversationDeletionBlockedError();
    }
    throw error;
  });
  try {
    if (history.state.replay_error || history.state.active_turn_id ||
      history.state.turns.some(turn => turn.remote_may_still_be_running) ||
      history.state.tool_calls.some(call => call.started_at && !call.result) ||
      history.state.approval_proposals.some(proposal => proposal.status === "pending")) {
      throw new PostgresConversationDeletionBlockedError();
    }
    return Object.freeze(voiceScopes);
  } finally { history.store.destroy(); }
}

export interface DeletePostgresConversationHistoryInput {
  /** A transactional client; nested transactions must use the existing transaction. */
  readonly client: PostgresSqlClient;
  readonly tenantId: string;
  readonly conversationId: ConversationId;
  /** Must verify current ownership/permission, including when replaying deletion. */
  readonly authorize: () => Promise<void>;
}

/**
 * Seal an authorized conversation identity and remove its canonical transcript,
 * checkpoints and text runtime state atomically. This is the history portion of
 * deletion, not a catalog/file deletion API. Hosts compose it with catalog and
 * attachment removal in the same transaction. Business/usage/effect evidence is
 * deliberately retained. Old workers that do not honor the fence must be drained
 * before using this operation.
 */
export async function deletePostgresConversationHistory(input: DeletePostgresConversationHistoryInput) {
  for (const value of [input.tenantId, input.conversationId]) {
    if (typeof value !== "string" || !value.length || value.length > 512 ||
      [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new TypeError("Conversation deletion identity is invalid.");
    }
  }
  await input.authorize();
  return input.client.transaction(async client => {
    await lockPostgresConversation(client, input.tenantId, input.conversationId);
    await input.authorize();
    const persistence = new PostgresAiPersistence(client);
    const deleted = await persistence.getDocument(input.tenantId, "conversation_deleted", input.conversationId, "deleted");
    if (deleted) return Object.freeze({ status: "idempotent" as const });
    const voiceScopes = await assertPostgresConversationIdle(client, input.tenantId, input.conversationId);
    // Only deletion removes presentation acknowledgements. Expiry uses the same
    // readiness check without changing voice history or outcome receipts.
    for (let offset = 0; offset < voiceScopes.length; offset += 100) {
      await client.query(`DELETE FROM handrail_ai_documents WHERE tenant_id=$1
        AND kind='realtime_activity_read' AND scope_id=ANY($2::text[])`,
      [input.tenantId, voiceScopes.slice(offset, offset + 100)]);
    }
    // The marker and removed transcript commit together. The same conversation
    // identity may never be reused, even through a stale client or catalog create.
    await client.query(`INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload)
      VALUES ($1,'conversation_deleted',$2,'deleted',1,'{"schemaVersion":1}'::jsonb)`,
    [input.tenantId, input.conversationId]);
    await client.query("DELETE FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2",
      [input.tenantId, input.conversationId]);
    await client.query("DELETE FROM handrail_ai_display_records WHERE tenant_id=$1 AND conversation_id=$2",
      [input.tenantId, input.conversationId]);
    await client.query("DELETE FROM handrail_ai_display_heads WHERE tenant_id=$1 AND conversation_id=$2",
      [input.tenantId, input.conversationId]);
    await client.query(`DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND
      ((kind IN ('checkpoint','turn_state','durable_turn','sync_state') AND scope_id=$2)
        OR (kind IN ('catalog','activity') AND record_id=$2)
        OR (kind='openai_continuation' AND payload->>'conversationId'=$2))`, [input.tenantId, input.conversationId]);
    // Preserve admission identity and completion evidence, but no response,
    // prompt, tools or attachment content. A replay must refuse to redispatch.
    await client.query(`UPDATE handrail_ai_documents SET version=3,
      payload=jsonb_build_object('version',1,'fingerprint',payload->>'fingerprint',
        'status','purged','conversationId',$2::text,'completedAt',updated_at), updated_at=now()
      WHERE tenant_id=$1 AND kind='provider_operation' AND payload->>'conversationId'=$2
        AND version=2 AND payload->>'status'='completed'`, [input.tenantId, input.conversationId]);
    // Catalog responses duplicate titles/metadata. Keep their claimed keys and
    // fingerprints, but replay must report deletion instead of an old descriptor.
    await client.query(`UPDATE handrail_ai_idempotency
      SET result=jsonb_build_object('schemaVersion',1,'status','conversation_deleted','conversationId',$2::text)
      WHERE tenant_id=$1 AND result->>'conversationId'=$2
        AND domain IN ('catalog.create','catalog.rename','catalog.clear','catalog.archive','catalog.restore')`,
    [input.tenantId, input.conversationId]);
    await input.authorize();
    return Object.freeze({ status: "deleted" as const });
  });
}

/** Removes SDK-owned attachment references and bytes; external storage stays host-owned. */
export async function deletePostgresConversationAttachments(
  client: PostgresSqlClient, tenantId: string, conversationId: string,
): Promise<void> {
  // Called under the conversation fence, so no new reference to this conversation
  // can appear. Lock each blob before deleting references or collecting bytes.
  const attachments = await client.query<{ blob_key: string }>(`SELECT DISTINCT payload->>'blobKey' AS blob_key
    FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND (payload->>'conversationId'=$2 OR payload->>'retainedConversationId'=$2
      OR (payload->'retention'->>'version'='1' AND payload->>'draftConversationId'=$2))
    AND payload->>'blobKey' IS NOT NULL ORDER BY blob_key`, [tenantId, conversationId]);
  for (const attachment of attachments.rows) await lockPostgresAttachmentBlob(client, tenantId, attachment.blob_key);
  await client.query(`DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'
    AND (payload->>'conversationId'=$2 OR payload->>'retainedConversationId'=$2
      OR (payload->'retention'->>'version'='1' AND payload->>'draftConversationId'=$2))`, [tenantId, conversationId]);
  for (const attachment of attachments.rows) {
    await client.query(`DELETE FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2
      AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'
        AND payload->>'blobKey'=$2)`, [tenantId, attachment.blob_key]);
  }
}
