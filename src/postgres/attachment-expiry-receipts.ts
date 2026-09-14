import { createHash } from "node:crypto";
import { AttachmentStagingError, type StagedAttachmentRecord } from "../attachments/staging.js";
import type { PostgresSqlClient } from "./index.js";

const expiryKey = (conversationId: string, idempotencyKey: string) =>
  createHash("sha256").update(JSON.stringify([conversationId, idempotencyKey])).digest("hex");
const fingerprintFor = (fingerprint: string) => createHash("sha256").update(fingerprint).digest("hex");
interface ExpiryReceipt extends Record<string, unknown> { fingerprint: string; result: { version?: unknown; status?: unknown } }
const validReceipt = (row: ExpiryReceipt) => typeof row.fingerprint === "string" && /^[a-f0-9]{64}$/u.test(row.fingerprint) &&
  row.result?.version === 1 && row.result.status === "expired";

/** Caller holds the upload conversation lock. Only hashed retry identity and
 * status survive physical expiry; a stale retry cannot create a second upload. */
export async function assertPostgresAttachmentUploadNotExpired(client: PostgresSqlClient, tenantId: string,
  scopeId: string, conversationId: string, idempotencyKey: string, fingerprint: string): Promise<void> {
  const result = await client.query<ExpiryReceipt>(`SELECT fingerprint,result FROM handrail_ai_idempotency
    WHERE tenant_id=$1 AND domain='attachment.expired' AND scope_id=$2 AND idempotency_key=$3`,
  [tenantId, scopeId, expiryKey(conversationId, idempotencyKey)]);
  const receipt = result.rows[0];
  if (!receipt) return;
  if (!validReceipt(receipt)) throw new AttachmentStagingError("unavailable");
  throw new AttachmentStagingError(receipt.fingerprint === fingerprintFor(fingerprint) ? "expired" : "conflict");
}

/** Same transaction and upload lock as validated metadata removal. Conflicting
 * evidence blocks deletion; no transcript, content reference or filename is kept. */
export async function recordPostgresAttachmentUploadExpiry(client: PostgresSqlClient, tenantId: string, scopeId: string,
  record: Pick<StagedAttachmentRecord, "conversationId" | "idempotencyKey" | "fingerprint">): Promise<boolean> {
  const key = expiryKey(record.conversationId, record.idempotencyKey), fingerprint = fingerprintFor(record.fingerprint);
  await client.query(`INSERT INTO handrail_ai_idempotency (tenant_id,domain,scope_id,idempotency_key,fingerprint,result)
    VALUES ($1,'attachment.expired',$2,$3,$4,'{"version":1,"status":"expired"}'::jsonb)
    ON CONFLICT (tenant_id,domain,scope_id,idempotency_key) DO NOTHING`, [tenantId, scopeId, key, fingerprint]);
  const receipts = await client.query<ExpiryReceipt>(`SELECT fingerprint,result FROM handrail_ai_idempotency
    WHERE tenant_id=$1 AND domain='attachment.expired' AND scope_id=$2 AND idempotency_key=$3 FOR UPDATE`,
  [tenantId, scopeId, key]);
  return !!receipts.rows[0] && validReceipt(receipts.rows[0]) && receipts.rows[0].fingerprint === fingerprint;
}
