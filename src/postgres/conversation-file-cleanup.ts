import { createHash } from "node:crypto";
import type { PostgresSqlClient } from "./index.js";

type JsonObject = Readonly<Record<string, unknown>>;
interface PendingCleanup extends Record<string, unknown> {
  schemaVersion: 1; status: "pending"; fingerprint: string; conversationId: string;
  target: JsonObject; attempts: number; nextAttemptAt: string;
}
const identity = (value: string) => {
  if (typeof value !== "string" || !value || value.length > 256) throw new TypeError("Invalid file cleanup identity.");
  return value;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(conversationId: string, target: JsonObject): string {
  return createHash("sha256").update(canonical({ conversationId, target })).digest("hex");
}

/** Enqueue after sealing a conversation, inside its authorized deletion SQL
 * transaction. The host must first detach this immutable object identity from
 * all shared/business references and prevent new references/writes. No remote
 * effect happens here. The job is visible to workers only after SQL commit. */
export async function enqueuePostgresConversationFileCleanup(input: {
  readonly client: PostgresSqlClient; readonly tenantId: string; readonly scopeId: string;
  readonly conversationId: string; readonly jobId: string; readonly target: JsonObject; readonly now?: Date;
}): Promise<void> {
  const tenantId = identity(input.tenantId), scopeId = identity(input.scopeId);
  const conversationId = identity(input.conversationId), jobId = identity(input.jobId);
  const target = JSON.parse(JSON.stringify(input.target)) as JsonObject;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new TypeError("Invalid file cleanup target.");
  const now = (input.now ?? new Date()).toISOString();
  const fence = await input.client.query("SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted' AND payload->>'schemaVersion'='1'", [tenantId, conversationId]);
  if (!fence.rows.length) throw new Error("File cleanup requires an authorized, sealed conversation.");
  const hash = fingerprint(conversationId, target);
  const record: PendingCleanup = { schemaVersion: 1, status: "pending", fingerprint: hash, conversationId, target, attempts: 0, nextAttemptAt: now };
  await input.client.query(`INSERT INTO handrail_ai_documents(tenant_id,kind,scope_id,record_id,version,payload)
    VALUES ($1,'conversation_file_cleanup',$2,$3,1,$4::text::jsonb) ON CONFLICT DO NOTHING`,
  [tenantId, scopeId, jobId, JSON.stringify(record)]);
  const existing = await input.client.query<{ payload: Record<string, unknown> }>("SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_file_cleanup' AND scope_id=$2 AND record_id=$3", [tenantId, scopeId, jobId]);
  if (existing.rows[0]?.payload.schemaVersion !== 1 || existing.rows[0]?.payload.fingerprint !== hash) {
    throw new Error("File cleanup identity is bound to another object.");
  }
}

export interface PostgresConversationFileCleanupOptions<TTarget> {
  readonly client: PostgresSqlClient;
  /** Trusted service partition. Draining may process any tenant in this partition. */
  readonly scopeId: string;
  /** Validate canonical object identity and tenant/bucket policy before deletion. */
  readonly parseTarget: (value: unknown, tenantId: string) => TTarget;
  /** Must be idempotent for an immutable key: uncertain acknowledgements are
   * retried. Never use this queue for financial/business side effects. */
  readonly deleteFile: (target: TTarget, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

/** Bounded SQL queue for postcommit, idempotent deletion of external chat files.
 * Row locks serialize workers. SQL loss may repeat a remote deletion; callers
 * guarantee keys cannot be reused. Completed receipts contain no object target. */
export async function drainPostgresConversationFileCleanup<TTarget>(
  options: PostgresConversationFileCleanupOptions<TTarget>, limit = 20,
): Promise<{ completed: number; retrying: number; blocked: number }> {
  const scopeId = identity(options.scopeId), timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Invalid file cleanup bounds.");
  }
  const clock = options.now ?? (() => new Date());
  const candidates = await options.client.query<{ tenant_id: string; record_id: string }>(`SELECT tenant_id,record_id FROM handrail_ai_documents
    WHERE kind='conversation_file_cleanup' AND scope_id=$1 AND payload->>'status'='pending'
      AND payload->>'nextAttemptAt'<=$2 ORDER BY updated_at,tenant_id,record_id LIMIT $3`, [scopeId, clock().toISOString(), limit]);
  const counts = { completed: 0, retrying: 0, blocked: 0 };
  for (const candidate of candidates.rows) {
    const result = await options.client.transaction(async client => {
      const current = await client.query<{ payload: PendingCleanup }>(`SELECT payload FROM handrail_ai_documents
        WHERE tenant_id=$1 AND kind='conversation_file_cleanup' AND scope_id=$2 AND record_id=$3
          AND payload->>'status'='pending' AND payload->>'nextAttemptAt'<=$4 FOR UPDATE SKIP LOCKED`,
      [candidate.tenant_id, scopeId, candidate.record_id, clock().toISOString()]);
      if (!current.rows[0]) return null;
      const record = current.rows[0].payload;
      const save = (payload: unknown) => client.query(`UPDATE handrail_ai_documents SET payload=$4::text::jsonb,version=version+1,updated_at=now()
        WHERE tenant_id=$1 AND kind='conversation_file_cleanup' AND scope_id=$2 AND record_id=$3`,
      [candidate.tenant_id, scopeId, candidate.record_id, JSON.stringify(payload)]);
      let target: TTarget;
      try {
        if (record?.schemaVersion !== 1 || !Number.isSafeInteger(record.attempts) || record.attempts < 0 ||
          !Number.isFinite(Date.parse(record.nextAttemptAt)) || !record.target || typeof record.target !== "object" || Array.isArray(record.target) ||
          record.fingerprint !== fingerprint(identity(record.conversationId), record.target)) throw new TypeError("Invalid cleanup record.");
        target = options.parseTarget(record.target, candidate.tenant_id);
      } catch {
        await save({ ...record, status: "blocked", errorCode: "invalid_file_cleanup_target" });
        return "blocked" as const;
      }
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.resolve().then(() => options.deleteFile(target, controller.signal)), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("File cleanup timed out.")); }, timeoutMs);
        })]);
        await save({ schemaVersion: 1, status: "completed", fingerprint: record.fingerprint,
          attempts: record.attempts + 1, completedAt: clock().toISOString() });
        return "completed" as const;
      } catch {
        await save({ ...record, attempts: record.attempts + 1,
          nextAttemptAt: new Date(clock().getTime() + Math.min(300_000, 1_000 * 2 ** Math.min(record.attempts, 8))).toISOString(),
          errorCode: "external_file_delete_failed" });
        return "retrying" as const;
      } finally { if (timer !== undefined) clearTimeout(timer); }
    });
    if (result) counts[result] += 1;
  }
  return counts;
}

/** Hosts own worker startup/shutdown and provider configuration. This helper
 * only drains already authorized deletion jobs, never inventories/purges chats. */
export function startPostgresConversationFileCleanupWorker<TTarget>(options: PostgresConversationFileCleanupOptions<TTarget> & {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onResult: (result: { completed: number; retrying: number; blocked: number }) => void;
  readonly onError: () => void;
}) {
  const intervalMs = options.intervalMs ?? 30_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) throw new TypeError("Invalid file cleanup worker interval.");
  let running: Promise<void> | undefined, stopped = false;
  const flush = () => {
    if (stopped) return Promise.resolve();
    running ??= drainPostgresConversationFileCleanup(options, options.batchSize ?? 1).then(result => {
      try { options.onResult(result); } catch { /* Diagnostics cannot fail cleanup. */ }
    }, () => { try { options.onError(); } catch { /* Diagnostics cannot fail cleanup. */ } })
      .finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref?.();
  void flush();
  return { flush, async stop() { stopped = true; clearInterval(timer); await running; } };
}
