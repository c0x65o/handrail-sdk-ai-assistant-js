import { randomUUID } from "node:crypto";
import type { PostgresSqlClient } from "./index.js";
import type { DurableApplicationRecoveryCursor } from "../transports/durable.js";
import type { ConversationEventAttribution } from "../conversation/state.js";

/** Wake-ups carry identities only. Both writers run in the deciding transaction,
 * including older SDK instances during a rolling upgrade. */
export const postgresApprovalRecoverySchema = Object.freeze([
  `CREATE TABLE IF NOT EXISTS handrail_ai_approval_recovery (
    tenant_id text NOT NULL, conversation_id text NOT NULL, wake_id uuid NOT NULL DEFAULT gen_random_uuid(),
    lease_owner uuid, lease_until timestamptz, available_at timestamptz NOT NULL DEFAULT now(), after_proposal text NOT NULL DEFAULT '',
    PRIMARY KEY (tenant_id,conversation_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_approval_recovery_ready
    ON handrail_ai_approval_recovery (tenant_id,available_at,conversation_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_approval_recovery_backfill (
    tenant_id text PRIMARY KEY, after_scope text NOT NULL DEFAULT '', after_proposal text NOT NULL DEFAULT '',
    complete boolean NOT NULL DEFAULT false)`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_approval_decision_receipts ON handrail_ai_idempotency
    (tenant_id,(result->>'group_id'),(result->>'proposal_id'),scope_id,idempotency_key)
    WHERE domain='approval.transition' AND result->>'status' IN ('confirmed','rejected')`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_approvals_recovery_identity ON handrail_ai_approvals
    (tenant_id,group_id,proposal_id) WHERE payload->>'status'<>'pending'`,
  `CREATE OR REPLACE FUNCTION handrail_ai_wake_approval_recovery(t text,c text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF c IS NOT NULL AND NOT EXISTS(SELECT 1 FROM handrail_ai_documents
        WHERE tenant_id=t AND kind='conversation_deleted' AND scope_id=c AND record_id='deleted') THEN
        INSERT INTO handrail_ai_approval_recovery(tenant_id,conversation_id) VALUES(t,c)
          ON CONFLICT (tenant_id,conversation_id) DO UPDATE SET wake_id=gen_random_uuid(),available_at=now(),after_proposal='';
      END IF;
    END; $$`,
  `CREATE OR REPLACE FUNCTION handrail_ai_approval_recovery_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM handrail_ai_wake_approval_recovery(NEW.tenant_id,NEW.group_id);
      RETURN NEW;
    END; $$`,
  `CREATE OR REPLACE FUNCTION handrail_ai_approval_recovery_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.payload->'payload'->>'type'='conversation.cleared' THEN
        DELETE FROM handrail_ai_approval_recovery WHERE tenant_id=NEW.tenant_id AND conversation_id=NEW.conversation_id;
      ELSIF NOT EXISTS(SELECT 1 FROM handrail_ai_approvals WHERE tenant_id=NEW.tenant_id AND group_id=NEW.conversation_id
        AND proposal_id=NEW.payload->'payload'->>'proposal_id' AND payload->>'status'<>'pending') THEN
        PERFORM handrail_ai_wake_approval_recovery(NEW.tenant_id,NEW.conversation_id);
      END IF;
      RETURN NEW;
    END; $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='handrail_ai_approval_recovery_proposal_trigger'
      AND tgrelid='handrail_ai_approvals'::regclass) THEN
      CREATE TRIGGER handrail_ai_approval_recovery_proposal_trigger AFTER INSERT OR UPDATE OF payload ON handrail_ai_approvals
        FOR EACH ROW WHEN (NEW.group_id IS NOT NULL AND NEW.payload->>'status' IN ('confirmed','rejected','executing','executed','failed'))
        EXECUTE FUNCTION handrail_ai_approval_recovery_proposal();
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END; $$`,
  `DO $$ BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='handrail_ai_approval_recovery_event_trigger'
      AND tgrelid='handrail_ai_events'::regclass) THEN
      CREATE TRIGGER handrail_ai_approval_recovery_event_trigger AFTER INSERT ON handrail_ai_events
        FOR EACH ROW WHEN (NEW.payload->'payload'->>'type'='conversation.cleared' OR
          (NEW.payload->'payload'->>'type'='approval.proposal_status_changed' AND NEW.payload->'payload'->>'status' IN ('confirmed','rejected')))
        EXECUTE FUNCTION handrail_ai_approval_recovery_event();
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END; $$`,
] as const);

export interface ApprovalRecoveryCandidate { readonly conversationId: string; readonly wakeId: string }
export interface ApprovalRecoveryClaim extends ApprovalRecoveryCandidate { readonly owner: string; readonly afterProposal: string }
export interface ApprovalDecisionReceiptIdentity {
  readonly scopeId: string; readonly idempotencyKey: string; readonly proposalId: string;
  readonly turnId: string; readonly toolCallId: string; readonly status: "confirmed" | "rejected";
  readonly version: number;
  readonly decidedAt: string; readonly attribution: ConversationEventAttribution; readonly reason: string | null;
}

/** Trusted storage adapter. Authorize the conversation before claim/receipt
 * lookup; candidate enumeration intentionally exposes no decision bodies. */
export class PostgresApprovalRecoveryQueue {
  #legacyComplete = false;
  constructor(readonly client: PostgresSqlClient, readonly tenantId: string) {}

  /** One transactional legacy page; cursor survives restarts and does not rewrite
   * proposals, versions or canonical events. New writes are covered by triggers. */
  async prepare(limit = 10): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Recovery preparation limit is invalid");
    if (this.#legacyComplete) return;
    this.#legacyComplete = await this.client.transaction(async tx => {
      await tx.query(`INSERT INTO handrail_ai_approval_recovery_backfill(tenant_id) VALUES($1) ON CONFLICT DO NOTHING`, [this.tenantId]);
      const progress = await tx.query<{ after_scope: string; after_proposal: string; complete: boolean }>(
        `SELECT after_scope,after_proposal,complete FROM handrail_ai_approval_recovery_backfill
          WHERE tenant_id=$1 FOR UPDATE SKIP LOCKED`, [this.tenantId]);
      const head = progress.rows[0]; if (!head || head.complete) return head?.complete ?? false;
      const page = await tx.query<{ scope_id: string; proposal_id: string; group_id: string | null; status: string }>(
        `SELECT scope_id,proposal_id,group_id,payload->>'status' AS status FROM handrail_ai_approvals
          WHERE tenant_id=$1 AND (scope_id,proposal_id)>($2,$3) ORDER BY scope_id,proposal_id LIMIT $4`,
        [this.tenantId, head.after_scope, head.after_proposal, limit]);
      for (const conversation of new Set(page.rows.filter(row => row.group_id && row.status !== "pending").map(row => row.group_id!))) {
        // Recovery rechecks current canonical proposals, so an old receipt
        // cannot revive work removed by clear. The function excludes deletion.
        await tx.query(`SELECT handrail_ai_wake_approval_recovery($1,$2)`, [this.tenantId, conversation]);
      }
      const last = page.rows.at(-1);
      await tx.query(`UPDATE handrail_ai_approval_recovery_backfill SET after_scope=$2,after_proposal=$3,complete=$4 WHERE tenant_id=$1`,
        [this.tenantId, last?.scope_id ?? head.after_scope, last?.proposal_id ?? head.after_proposal, page.rows.length < limit]);
      return page.rows.length < limit;
    });
  }

  async scan(limit: number, cursor?: DurableApplicationRecoveryCursor) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Recovery page limit is invalid");
    await this.prepare();
    const page = await this.client.query<{ conversation_id: string; wake_id: string; through: string }>(
      `WITH fence AS (SELECT COALESCE($3::text,(SELECT conversation_id FROM handrail_ai_approval_recovery
        WHERE tenant_id=$1 ORDER BY conversation_id DESC LIMIT 1)) AS through)
       SELECT q.conversation_id,q.wake_id::text,fence.through FROM handrail_ai_approval_recovery q CROSS JOIN fence
       WHERE q.tenant_id=$1 AND q.conversation_id>COALESCE($2::text,'') AND q.conversation_id<=fence.through
         AND q.available_at<=now() AND (q.lease_until IS NULL OR q.lease_until<=now())
       ORDER BY q.conversation_id LIMIT $4`, [this.tenantId, cursor?.after.conversationId ?? null, cursor?.through.conversationId ?? null, limit + 1]);
    const rows = page.rows.slice(0, limit), last = rows.at(-1);
    return { candidates: rows.map(row => ({ conversationId: row.conversation_id, wakeId: row.wake_id })),
      cursor: page.rows.length > limit && last ? { after: { conversationId: last.conversation_id, turnId: "approval" },
        through: { conversationId: last.through, turnId: "approval" } } : null };
  }
  async claim(candidate: ApprovalRecoveryCandidate): Promise<ApprovalRecoveryClaim | null> {
    const owner = randomUUID();
    const result = await this.client.query<{ after_proposal: string }>(`UPDATE handrail_ai_approval_recovery SET lease_owner=$4::uuid,lease_until=now()+interval '30 seconds'
      WHERE tenant_id=$1 AND conversation_id=$2 AND wake_id=$3::uuid AND available_at<=now()
        AND (lease_until IS NULL OR lease_until<=now()) RETURNING after_proposal`, [this.tenantId, candidate.conversationId, candidate.wakeId, owner]);
    return result.rows[0] ? { ...candidate, owner, afterProposal: result.rows[0].after_proposal } : null;
  }
  async renew(claim: ApprovalRecoveryClaim): Promise<boolean> {
    const result = await this.client.query(`UPDATE handrail_ai_approval_recovery SET lease_until=now()+interval '30 seconds'
      WHERE tenant_id=$1 AND conversation_id=$2 AND lease_owner=$3::uuid AND lease_until>now()`,
      [this.tenantId, claim.conversationId, claim.owner]);
    return result.rowCount === 1;
  }
  async finish(claim: ApprovalRecoveryClaim, complete: boolean, afterProposal = ""): Promise<void> {
    if (complete) await this.client.query(`DELETE FROM handrail_ai_approval_recovery
      WHERE tenant_id=$1 AND conversation_id=$2 AND wake_id=$3::uuid AND lease_owner=$4::uuid`,
      [this.tenantId, claim.conversationId, claim.wakeId, claim.owner]);
    // A decision saved during processing gets a new wake id. An older worker
    // may release its own lease, but cannot acknowledge/delay that newer work.
    await this.client.query(`UPDATE handrail_ai_approval_recovery SET lease_owner=NULL,lease_until=NULL,
      available_at=CASE WHEN wake_id=$3::uuid THEN now()+interval '15 seconds' ELSE now() END,
      after_proposal=CASE WHEN wake_id=$3::uuid THEN $5 ELSE after_proposal END
      WHERE tenant_id=$1 AND conversation_id=$2 AND lease_owner=$4::uuid`,
      [this.tenantId, claim.conversationId, claim.wakeId, claim.owner, afterProposal]);
  }
  async decision(conversationId: string, proposalId: string): Promise<ApprovalDecisionReceiptIdentity | null> {
    const result = await this.client.query<{ scope_id: string; idempotency_key: string; proposal_id: string; turn_id: string;
      tool_call_id: string; status: "confirmed" | "rejected"; version: string; decided_at: string;
      attribution: ConversationEventAttribution; reason: string | null }>(
      `SELECT scope_id,idempotency_key,result->>'proposal_id' AS proposal_id,result->>'turn_id' AS turn_id,
        result->>'tool_call_id' AS tool_call_id,result->>'status' AS status,result->>'proposal_version' AS version,
        result->>'updated_at' AS decided_at,result->'latest_attribution' AS attribution,result->>'decision_reason' AS reason
        FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain='approval.transition' AND result->>'group_id'=$2
        AND result->>'status' IN ('confirmed','rejected') AND result->>'proposal_id'=$3
        ORDER BY scope_id,idempotency_key LIMIT 2`, [this.tenantId, conversationId, proposalId]);
    if (result.rows.length > 1) throw new Error("The approval decision receipt identity is ambiguous");
    const row = result.rows[0];
    return row ? {
      scopeId: row.scope_id, idempotencyKey: row.idempotency_key, proposalId: row.proposal_id, turnId: row.turn_id,
      toolCallId: row.tool_call_id, status: row.status, version: Number(row.version), decidedAt: row.decided_at,
      attribution: row.attribution, reason: row.reason } : null;
  }
}
