import type { StagedAttachmentRecord } from "../attachments/staging.js";
import { lockPostgresAttachmentBlob, lockPostgresConversation } from "./conversation-deletion.js";
import type { PostgresAiPersistence } from "./index.js";

interface ManagedStaging extends StagedAttachmentRecord {
  readonly retention: { readonly version: 1; readonly scopeId: string };
  readonly retainedConversationId?: string;
}
interface Candidate extends Record<string, unknown> {
  tenant_id: string; scope_id: string; record_id: string; version: string; payload: ManagedStaging;
}
export interface PostgresConversationFileStagingCleanupOptions {
  readonly persistence: PostgresAiPersistence;
  /** Trusted service partition. Only newly managed uploads in this partition
   * are eligible; no marker is inferred or added to older staging records. */
  readonly maintenanceScopeId: string;
  /** Omit only in a trusted service worker authorized for every tenant in the
   * named partition. Per-request maintenance must supply its trusted tenant. */
  readonly tenantId?: string;
  readonly now?: () => number;
}
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const timestamp = (value: unknown): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function valid(row: Candidate, scope: string, before: string): boolean {
  const value = row.payload;
  return identity(row.tenant_id) && identity(row.scope_id) && identity(row.record_id) &&
    /^[1-9][0-9]*$/u.test(row.version) && Number.isSafeInteger(Number(row.version)) && !!value && typeof value === "object" &&
    value.retention?.version === 1 && value.retention.scopeId === scope &&
    value.ownerScopeId === row.scope_id && value.conversationId === row.scope_id &&
    value.contentRef === row.record_id && /^ref_[A-Za-z0-9._-]+$/u.test(value.contentRef) &&
    value.blobKey === `attachments/${value.contentRef}` && identity(value.attachmentId) &&
    identity(value.idempotencyKey) && identity(value.mediaType) && Number.isSafeInteger(value.byteSize) && value.byteSize > 0 &&
    (value.filename === undefined || typeof value.filename === "string" && value.filename.length > 0 && value.filename.length <= 180) && /^[a-f0-9]{64}$/u.test(value.fingerprint) &&
    timestamp(value.createdAt) && timestamp(value.expiresAt) && value.createdAt < value.expiresAt && value.expiresAt <= before &&
    (value.consumedAt === null ? value.retainedConversationId === undefined
      : timestamp(value.consumedAt) && identity(value.retainedConversationId));
}

/** Atomic, bounded expiry of SDK-owned temporary uploads. Saved conversation
 * copies and shared references survive. No provider/business work is dispatched.
 * Unmarked historical uploads and malformed marked rows require explicit review. */
export async function cleanupPostgresConversationFileStaging(
  options: PostgresConversationFileStagingCleanupOptions, limit = 100,
): Promise<{ removed: number; blocked: number }> {
  if (!identity(options.maintenanceScopeId) || options.tenantId !== undefined && !identity(options.tenantId) ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("Invalid staging cleanup scope or bounds.");
  const before = new Date((options.now ?? Date.now)()).toISOString();
  const candidates = await options.persistence.client.query<Candidate>(`SELECT tenant_id,scope_id,record_id,version::text,payload
    FROM handrail_ai_documents WHERE kind='attachment' AND payload->'retention'->>'version'='1'
      AND payload->'retention'->>'scopeId'=$1 AND ($2::text IS NULL OR tenant_id=$2)
      AND payload->>'expiresAt'<=$3 ORDER BY payload->>'expiresAt',tenant_id,scope_id,record_id LIMIT $4`,
  [options.maintenanceScopeId, options.tenantId ?? null, before, limit]);
  const counts = { removed: 0, blocked: 0 };
  for (const candidate of candidates.rows) {
    if (!valid(candidate, options.maintenanceScopeId, before)) { counts.blocked++; continue; }
    const removed = await options.persistence.client.transaction(async client => {
      const value = candidate.payload;
      // Match retained-file materialization and conversation deletion lock order.
      await lockPostgresConversation(client, candidate.tenant_id, value.retainedConversationId ?? value.conversationId);
      await lockPostgresAttachmentBlob(client, candidate.tenant_id, value.blobKey);
      const current = await client.query<Candidate>(`SELECT tenant_id,scope_id,record_id,version::text,payload
        FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND scope_id=$2 AND record_id=$3
        FOR UPDATE SKIP LOCKED`, [candidate.tenant_id, candidate.scope_id, candidate.record_id]);
      const row = current.rows[0];
      // Consumption may have committed between discovery and locking. Retry a
      // later sweep with its current conversation lock, never guess a binding.
      if (!row || row.version !== candidate.version) return false;
      if (!valid(row, options.maintenanceScopeId, before) || JSON.stringify(row.payload) !== JSON.stringify(value)) return false;
      const deleted = await client.query(`DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment'
        AND scope_id=$2 AND record_id=$3 AND version=$4 RETURNING record_id`,
      [row.tenant_id, row.scope_id, row.record_id, Number(row.version)]);
      if (!deleted.rows.length) return false;
      await client.query(`DELETE FROM handrail_ai_attachment_blobs WHERE tenant_id=$1 AND blob_key=$2
        AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='attachment' AND payload->>'blobKey'=$2)`,
      [row.tenant_id, value.blobKey]);
      return true;
    });
    if (removed) counts.removed++;
  }
  return counts;
}

/** Explicit lifecycle hook: expiry continues while an app is idle, and can be
 * resumed after restart. No startup sweep; old unmarked records are untouched. */
export function startPostgresConversationFileStagingCleanupWorker(options: PostgresConversationFileStagingCleanupOptions & {
  readonly intervalMs?: number; readonly batchSize?: number;
  readonly onResult: (result: { removed: number; blocked: number }) => void;
  readonly onError: () => void;
}) {
  const intervalMs = options.intervalMs ?? 60_000, batchSize = options.batchSize ?? 100;
  if (!identity(options.maintenanceScopeId) || options.tenantId !== undefined && !identity(options.tenantId) ||
    !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new TypeError("Invalid staging cleanup worker settings.");
  }
  let running: Promise<void> | undefined, stopped = false;
  const flush = () => {
    if (stopped) return Promise.resolve();
    running ??= cleanupPostgresConversationFileStaging(options, batchSize).then(result => {
      try { options.onResult(result); } catch { /* Diagnostics cannot fail cleanup. */ }
    }, () => { try { options.onError(); } catch { /* Diagnostics cannot fail cleanup. */ } })
      .finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref?.();
  return { flush, async stop() { stopped = true; clearInterval(timer); await running; } };
}
