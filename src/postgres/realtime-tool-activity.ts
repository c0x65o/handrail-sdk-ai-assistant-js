import { createHash } from "node:crypto";
import { PostgresPersistenceConflictError } from "./index.js";
import { DurableRealtimeCallConflictError, type PostgresRealtimeCallStore } from "./realtime-calls.js";

export type RealtimeToolActivityStatus = "running" | "completed" | "failed";
export interface RealtimeToolActivityRecord {
  readonly schemaVersion: 1;
  readonly toolCallId: string;
  readonly name: string;
  readonly status: RealtimeToolActivityStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
}
export interface RealtimeToolActivitySummary {
  readonly total: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
}
/** Acknowledges only the lifecycle and monotonic outcomes actually displayed. */
export interface RealtimeActivityReadToken {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly callVersion: number;
  readonly scopeBinding: string;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
}
function readToken(value: RealtimeActivityReadToken, callId: string, scopeBinding: string): RealtimeActivityReadToken {
  if (!value || value.schemaVersion !== 1 || value.callId !== callId || value.scopeBinding !== scopeBinding ||
      !Number.isSafeInteger(value.callVersion) || value.callVersion < 1 ||
      ![value.total, value.completed, value.failed].every((count) => Number.isSafeInteger(count) && count >= 0) ||
      value.completed + value.failed > value.total) throw new TypeError("Voice activity read token is invalid.");
  return { schemaVersion: 1, callId, scopeBinding, callVersion: value.callVersion, total: value.total,
    completed: value.completed, failed: value.failed };
}
function identity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError("Realtime tool activity identity is invalid.");
  }
  return value;
}
/** The existing call-owned activity partition, shared with retention checks. */
export function postgresRealtimeToolActivityScope(callScopeId: string, callId: string): string {
  return createHash("sha256").update(JSON.stringify([identity(callScopeId), identity(callId)])).digest("hex");
}
function validate(value: RealtimeToolActivityRecord, toolCallId: string): RealtimeToolActivityRecord {
  if (!value || value.schemaVersion !== 1 || value.toolCallId !== toolCallId ||
      !["running", "completed", "failed"].includes(value.status) ||
      ![value.startedAt, value.updatedAt].every((time) => Number.isSafeInteger(time) && time >= 0) ||
      value.updatedAt < value.startedAt) throw new TypeError("Stored realtime tool activity is invalid.");
  identity(value.toolCallId); identity(value.name);
  return { schemaVersion: 1, toolCallId: value.toolCallId, name: value.name, status: value.status,
    startedAt: value.startedAt, updatedAt: value.updatedAt };
}

/** Durable, owner-scoped display evidence, never execution authorization or a result ledger.
 * Only names/status/timestamps are stored; arguments and business results stay in host-owned records.
 * Finishing a previously started tool is allowed after call termination, since termination cannot
 * undo an already dispatched action. Missing outcomes remain running and require review.
 */
export class PostgresRealtimeToolActivityStore {
  readonly #scope: string;
  readonly #readBinding: string;
  constructor(readonly calls: PostgresRealtimeCallStore, readonly callId: string,
    readonly clock: () => number = Date.now) {
    identity(callId);
    this.#scope = postgresRealtimeToolActivityScope(calls.scopeId, callId);
    this.#readBinding = createHash("sha256").update(JSON.stringify([calls.tenantId, calls.scopeId, callId])).digest("hex");
  }
  async record(input: { readonly workerId: string; readonly toolCallId: string; readonly name: string;
    readonly status: RealtimeToolActivityStatus }): Promise<RealtimeToolActivityRecord> {
    return this.calls.withConversationLock(this.callId, calls =>
      new PostgresRealtimeToolActivityStore(calls, this.callId, this.clock).#record(input));
  }
  async #record(input: { readonly workerId: string; readonly toolCallId: string; readonly name: string;
    readonly status: RealtimeToolActivityStatus }): Promise<RealtimeToolActivityRecord> {
    identity(input.workerId); identity(input.toolCallId); identity(input.name);
    if (!["running", "completed", "failed"].includes(input.status)) throw new TypeError("Realtime tool activity status is invalid.");
    for (let attempt = 0; attempt < 4; attempt++) {
      const call = await this.calls.get(this.callId);
      if (!call || call.workerId !== input.workerId) throw new DurableRealtimeCallConflictError();
      const saved = await this.calls.persistence.getDocument<RealtimeToolActivityRecord>(this.calls.tenantId,
        "realtime_tool_activity", this.#scope, input.toolCallId);
      const previous = saved ? validate(saved.value, input.toolCallId) : undefined;
      if (previous && previous.name !== input.name) throw new DurableRealtimeCallConflictError();
      if (previous?.status === input.status || previous && input.status === "running") return Object.freeze({ ...previous });
      if (previous && previous.status !== "running" || !previous && (input.status !== "running" || call.status !== "active")) {
        throw new DurableRealtimeCallConflictError();
      }
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Realtime tool activity clock is invalid.");
      const record = validate({ schemaVersion: 1, toolCallId: input.toolCallId, name: input.name, status: input.status,
        startedAt: previous?.startedAt ?? now, updatedAt: Math.max(now, previous?.updatedAt ?? 0) }, input.toolCallId);
      try {
        await this.calls.persistence.compareAndSetDocument({ tenantId: this.calls.tenantId, kind: "realtime_tool_activity",
          scopeId: this.#scope, recordId: input.toolCallId, expectedVersion: saved?.version ?? null, value: record });
        return Object.freeze(record);
      } catch (error) { if (!(error instanceof PostgresPersistenceConflictError)) throw error; }
    }
    throw new PostgresPersistenceConflictError();
  }
  async summary(): Promise<RealtimeToolActivitySummary> {
    if (!await this.calls.get(this.callId)) throw new DurableRealtimeCallConflictError();
    const result = await this.calls.persistence.client.query<{ total: string; running: string; completed: string; failed: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE payload->>'status'='running')::text AS running,
       count(*) FILTER (WHERE payload->>'status'='completed')::text AS completed,
       count(*) FILTER (WHERE payload->>'status'='failed')::text AS failed FROM handrail_ai_documents
       WHERE tenant_id=$1 AND kind='realtime_tool_activity' AND scope_id=$2`, [this.calls.tenantId, this.#scope]);
    const row = result.rows[0];
    const value = { total: Number(row?.total), running: Number(row?.running), completed: Number(row?.completed), failed: Number(row?.failed) };
    if (!Object.values(value).every((count) => Number.isSafeInteger(count) && count >= 0) ||
      value.total !== value.running + value.completed + value.failed) throw new TypeError("Stored realtime tool counts are invalid.");
    return Object.freeze(value);
  }
  async readState() {
    const call = await this.calls.get(this.callId);
    if (!call) throw new DurableRealtimeCallConflictError();
    const counts = await this.summary();
    const retained = await this.calls.persistence.getDocument<RealtimeActivityReadToken>(this.calls.tenantId,
      "realtime_activity_read", this.#scope, this.callId);
    const seen = retained ? readToken(retained.value, this.callId, this.#readBinding) : undefined;
    const completed = call.status === "ended" && call.creationStarted;
    const token: RealtimeActivityReadToken | null = completed ? Object.freeze({ schemaVersion: 1, callId: this.callId,
      scopeBinding: this.#readBinding, callVersion: call.recordVersion, total: counts.total, completed: counts.completed, failed: counts.failed }) : null;
    const unread = completed && (!seen || seen.callVersion < call.recordVersion || seen.total < counts.total ||
      seen.completed < counts.completed || seen.failed < counts.failed);
    return Object.freeze({ call, counts, unread, readToken: token });
  }
  /** Call only after host authorization. Replaying an older view cannot read newer outcomes. */
  async markRead(input: RealtimeActivityReadToken) {
    return this.calls.withConversationLock(this.callId, calls =>
      new PostgresRealtimeToolActivityStore(calls, this.callId, this.clock).#markRead(input));
  }
  async #markRead(input: RealtimeActivityReadToken) {
    const token = readToken(input, this.callId, this.#readBinding);
    for (let attempt = 0; attempt < 4; attempt++) {
      const state = await this.readState();
      if (!state.readToken || token.callVersion !== state.call.recordVersion || token.total > state.counts.total ||
          token.completed > state.counts.completed || token.failed > state.counts.failed) throw new DurableRealtimeCallConflictError();
      const saved = await this.calls.persistence.getDocument<RealtimeActivityReadToken>(this.calls.tenantId,
        "realtime_activity_read", this.#scope, this.callId);
      const previous = saved ? readToken(saved.value, this.callId, this.#readBinding) : undefined;
      const next = previous && previous.callVersion === token.callVersion ? { ...token,
        total: Math.max(previous.total, token.total), completed: Math.max(previous.completed, token.completed),
        failed: Math.max(previous.failed, token.failed) } : token;
      if (previous && previous.callVersion > token.callVersion || previous && JSON.stringify(previous) === JSON.stringify(next)) {
        return this.readState();
      }
      try {
        await this.calls.persistence.compareAndSetDocument({ tenantId: this.calls.tenantId, kind: "realtime_activity_read",
          scopeId: this.#scope, recordId: this.callId, expectedVersion: saved?.version ?? null, value: next });
        return this.readState();
      } catch (error) { if (!(error instanceof PostgresPersistenceConflictError)) throw error; }
    }
    throw new PostgresPersistenceConflictError();
  }
  async list(input: { readonly afterToolCallId?: string; readonly limit?: number } = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Realtime tool activity page size is invalid.");
    const after = input.afterToolCallId === undefined ? null : identity(input.afterToolCallId);
    if (!await this.calls.get(this.callId)) throw new DurableRealtimeCallConflictError();
    const result = await this.calls.persistence.client.query<{ record_id: string; payload: RealtimeToolActivityRecord }>(
      `SELECT record_id,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='realtime_tool_activity'
       AND scope_id=$2 AND ($3::text IS NULL OR record_id>$3) ORDER BY record_id LIMIT $4`,
      [this.calls.tenantId, this.#scope, after, limit + 1]);
    const tools = result.rows.slice(0, limit).map((row) => Object.freeze({ ...validate(row.payload, row.record_id) }));
    return Object.freeze({ tools: Object.freeze(tools), nextToolCallId: result.rows.length > limit ? tools.at(-1)!.toolCallId : null });
  }
}
