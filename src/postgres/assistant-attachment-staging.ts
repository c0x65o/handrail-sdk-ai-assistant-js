import type { StagedAttachmentRecord } from "../attachments/staging.js";
import type { ConversationId } from "../conversation/events.js";
import { assertPostgresConversationIdle, lockPostgresAttachmentBlob, lockPostgresConversation,
  PostgresConversationDeletionBlockedError } from "./conversation-deletion.js";
import type { PostgresAiPersistence } from "./index.js";
import { recordPostgresAttachmentUploadExpiry } from "./attachment-expiry-receipts.js";

/** Distinct from retained-file uploads: these bytes belong to a real conversation. */
export interface ManagedAssistantStagingRecord extends StagedAttachmentRecord {
  readonly retention: { readonly version: 2; readonly scopeId: string };
}
export interface PostgresAssistantStagingCursor {
  readonly tenantId: string; readonly scopeId: string; readonly recordId: string;
}
export interface PostgresAssistantStagingCleanupOptions {
  readonly persistence: PostgresAiPersistence;
  /** Trusted service partition, also supplied when creating new managed uploads. */
  readonly maintenanceScopeId: string;
  /** Omit only for a service authorized for all tenants in this partition. */
  readonly tenantId?: string;
  /** A principal-bound invocation must also supply its trusted storage scope. */
  readonly scopeId?: string;
  readonly now?: () => number;
}
export interface PostgresAssistantStagingCleanupResult {
  readonly removed: number; readonly blocked: number;
  readonly nextCursor: PostgresAssistantStagingCursor | null;
}
interface Candidate extends Record<string, unknown> {
  tenant_id: string; scope_id: string; record_id: string; version: string; payload: ManagedAssistantStagingRecord;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
// Scan positions are SQL text keys, never authority to delete a row. They must
// round-trip even malformed persisted identities so blocked rows cannot strand
// the scan. Destructive targets still pass the stricter validation below.
const cursorKey = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
const validCursor = (cursor: PostgresAssistantStagingCursor) =>
  cursorKey(cursor.tenantId) && cursorKey(cursor.scopeId) && cursorKey(cursor.recordId);
function validateOptions(options: PostgresAssistantStagingCleanupOptions, limit: number) {
  if (!identity(options.maintenanceScopeId) || options.tenantId !== undefined && !identity(options.tenantId) ||
    options.scopeId !== undefined && (!identity(options.scopeId) || options.tenantId === undefined) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Invalid assistant staging cleanup scope or bounds.");
}
function valid(row: Candidate, maintenanceScopeId: string, before: string): boolean {
  const value = row.payload;
  return identity(row.tenant_id) && identity(row.scope_id) && identity(row.record_id) &&
    /^[1-9][0-9]*$/u.test(row.version) && Number.isSafeInteger(Number(row.version)) && !!value && typeof value === "object" &&
    value.retention?.version === 2 && value.retention.scopeId === maintenanceScopeId &&
    value.ownerScopeId === row.scope_id && identity(value.conversationId) && !("retainedConversationId" in value) &&
    value.contentRef === row.record_id && /^ref_[A-Za-z0-9._-]+$/u.test(value.contentRef) &&
    value.blobKey === `attachments/${value.contentRef}` && identity(value.attachmentId) &&
    identity(value.idempotencyKey) && identity(value.fingerprint) && identity(value.mediaType) &&
    Number.isSafeInteger(value.byteSize) && value.byteSize > 0 &&
    (value.filename === undefined || typeof value.filename === "string") &&
    timestamp(value.createdAt) && timestamp(value.expiresAt) && value.createdAt < value.expiresAt && value.expiresAt <= before &&
    (value.consumedAt === null || timestamp(value.consumedAt) && value.consumedAt >= value.createdAt && value.consumedAt <= before);
}

/** Bounded physical expiry of newly managed ordinary uploads. Old/unmarked,
 * retained-file and malformed records are never adopted. This removes neither
 * history nor audit/usage/effect receipts and never dispatches business work. */
export async function cleanupPostgresAssistantAttachmentStaging(
  options: PostgresAssistantStagingCleanupOptions, limit = 100, after?: PostgresAssistantStagingCursor,
): Promise<PostgresAssistantStagingCleanupResult> {
  validateOptions(options, limit);
  if (after !== undefined && !validCursor(after)) throw new TypeError("Invalid assistant staging cleanup cursor.");
  const before = new Date((options.now ?? Date.now)()).toISOString();
  const candidates = await options.persistence.client.query<Candidate>(`SELECT tenant_id,scope_id,record_id,version::text,payload
    FROM handrail_ai_documents WHERE kind='attachment' AND payload->'retention'->>'version'='2'
      AND payload->'retention'->>'scopeId'=$1 AND ($2::text IS NULL OR tenant_id=$2)
      AND ($3::text IS NULL OR scope_id=$3) AND payload->>'expiresAt'<=$4
      AND ($5::text IS NULL OR (tenant_id,scope_id,record_id)>($5,$6,$7))
    ORDER BY tenant_id,scope_id,record_id LIMIT $8`,
  [options.maintenanceScopeId, options.tenantId ?? null, options.scopeId ?? null, before,
    after?.tenantId ?? null, after?.scopeId ?? null, after?.recordId ?? null, limit]);
  let removed = 0, blocked = 0;
  for (const candidate of candidates.rows) {
    if (!valid(candidate, options.maintenanceScopeId, before)) { blocked++; continue; }
    try {
      const outcome = await options.persistence.client.transaction(async client => {
        const value = candidate.payload;
        await lockPostgresConversation(client, candidate.tenant_id, value.conversationId);
        await assertPostgresConversationIdle(client, candidate.tenant_id, value.conversationId as ConversationId);
        await lockPostgresAttachmentBlob(client, candidate.tenant_id, value.blobKey);
        const current = await client.query<Candidate>(`SELECT tenant_id,scope_id,record_id,version::text,payload
          FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2 AND record_id=$3
          FOR UPDATE SKIP LOCKED`, [candidate.tenant_id, candidate.scope_id, candidate.record_id]);
        const row = current.rows[0];
        if (!row || row.version !== candidate.version) return "changed";
        if (!valid(row, options.maintenanceScopeId, before) || JSON.stringify(row.payload) !== JSON.stringify(value)) return "blocked";
        // A mismatched or renewed blob lease is not authority to collect it.
        // Keep its metadata link for review instead of leaving an orphan behind.
        const blob = await client.query<{ matches: boolean }>(`SELECT
          (expires_at=$3::text::timestamptz AND media_type=$4 AND octet_length(payload)=$5) AS matches
          FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2 FOR UPDATE`,
        [row.tenant_id, value.blobKey, value.expiresAt, value.mediaType, value.byteSize]);
        if (blob.rows[0] && blob.rows[0].matches !== true) return "blocked";
        if (!await recordPostgresAttachmentUploadExpiry(client, row.tenant_id, row.scope_id, value)) return "blocked";
        const deleted = await client.query(`DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'
          AND scope_id=$2 AND record_id=$3 AND version=$4 RETURNING record_id`,
        [row.tenant_id, row.scope_id, row.record_id, Number(row.version)]);
        if (!deleted.rows.length) return "changed";
        await client.query(`DELETE FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2
          AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND payload->>'blobKey'=$2)`,
        [row.tenant_id, value.blobKey]);
        return "removed";
      });
      if (outcome === "removed") removed++;
      else if (outcome === "blocked") blocked++;
    } catch (error) {
      if (error instanceof PostgresConversationDeletionBlockedError) blocked++;
      else throw error;
    }
  }
  const last = candidates.rows.at(-1);
  // Advance past blocked rows as well; restart the scan after its end. A live
  // or malformed conversation must not starve other expired uploads forever.
  const nextCursor = candidates.rows.length === limit && last
    ? { tenantId: last.tenant_id, scopeId: last.scope_id, recordId: last.record_id } : null;
  return Object.freeze({ removed, blocked, nextCursor });
}

/** One explicitly owned lifecycle per service. No startup sweep; stopping joins
 * an in-flight batch, and restarting discovers only previously managed records. */
export function startPostgresAssistantAttachmentStagingCleanupWorker(options: PostgresAssistantStagingCleanupOptions & {
  readonly intervalMs?: number; readonly batchSize?: number;
  readonly onResult: (result: PostgresAssistantStagingCleanupResult) => void;
  readonly onError: () => void;
}) {
  const intervalMs = options.intervalMs ?? 60_000, batchSize = options.batchSize ?? 100;
  validateOptions(options, batchSize);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new TypeError("Invalid assistant staging cleanup interval.");
  let running: Promise<void> | undefined, stopped = false, cursor: PostgresAssistantStagingCursor | undefined;
  const flush = () => {
    if (stopped) return Promise.resolve();
    running ??= cleanupPostgresAssistantAttachmentStaging(options, batchSize, cursor).then(result => {
      cursor = result.nextCursor ?? undefined;
      try { options.onResult(result); } catch { /* Diagnostics cannot fail cleanup. */ }
    }, () => { try { options.onError(); } catch { /* Diagnostics cannot fail cleanup. */ } })
      .finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref?.();
  return { flush, async stop() { stopped = true; clearInterval(timer); await running; } };
}
