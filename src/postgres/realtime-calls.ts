import { createHash } from "node:crypto";
import { PostgresPersistenceConflictError, PostgresAiPersistence } from "./index.js";
import { assertPostgresConversationWritable } from "./conversation-deletion.js";

export type DurableRealtimeCallStatus = "admitted" | "starting" | "active" | "ending" | "ended" | "uncertain";
export interface DurableRealtimeCallRecord {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly conversationId: string;
  readonly fingerprint: string;
  readonly workerId: string;
  readonly status: DurableRealtimeCallStatus;
  readonly creationStarted: boolean;
  /** Private server reference, never a client-authorized provider call ID. */
  readonly providerCallRef: string | null;
  readonly leaseExpiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface DurableRealtimeCallSnapshot extends DurableRealtimeCallRecord {
  readonly recordVersion: number;
}

export class DurableRealtimeCallConflictError extends Error {
  constructor() { super("The realtime call identity or lifecycle conflicts with its retained state."); this.name = "DurableRealtimeCallConflictError"; }
}

function identity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError("Realtime call identity is invalid.");
  }
  return value;
}
function validRecord(value: DurableRealtimeCallRecord, callId: string): DurableRealtimeCallRecord {
  if (!value || value.schemaVersion !== 1 || value.callId !== callId ||
    !["admitted", "starting", "active", "ending", "ended", "uncertain"].includes(value.status) ||
    typeof value.creationStarted !== "boolean" || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    ![value.createdAt, value.updatedAt, value.leaseExpiresAt].every((time) => Number.isSafeInteger(time) && time >= 0) ||
    (value.providerCallRef !== null && typeof value.providerCallRef !== "string") ||
    (value.status === "active" && value.providerCallRef === null) ||
    (["starting", "active", "ending"].includes(value.status) && !value.creationStarted) ||
    (value.status === "admitted" && value.creationStarted) ||
    (value.status === "ended" && value.creationStarted && value.providerCallRef === null) ||
    value.updatedAt < value.createdAt || value.leaseExpiresAt < value.createdAt ||
    (!value.creationStarted && value.providerCallRef !== null)) throw new TypeError("Stored realtime call is invalid.");
  identity(value.conversationId); identity(value.workerId);
  if (value.providerCallRef !== null) identity(value.providerCallRef);
  return value;
}

/**
 * Server-owned call admission, remote identity and termination evidence. Scope
 * by environment/authenticated owner and authorize every use in the host.
 * Lease expiry means uncertain, never ended or permission to recreate a call.
 * No SDP, audio, transcript or provider credential belongs in these records.
 */
export class PostgresRealtimeCallStore {
  readonly #clock: () => number;
  readonly #leaseMs: number;
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string,
    readonly scopeId: string, options: { readonly clock?: () => number; readonly leaseMs?: number } = {}) {
    identity(tenantId); identity(scopeId);
    this.#clock = options.clock ?? Date.now; this.#leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 120_000) throw new TypeError("Realtime lease duration is invalid.");
  }
  #now(): number {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Realtime clock is invalid.");
    return now;
  }
  async get(callId: string): Promise<DurableRealtimeCallSnapshot | null> {
    const row = await this.persistence.getDocument<DurableRealtimeCallRecord>(this.tenantId, "realtime_call", this.scopeId, identity(callId));
    if (!row) return null;
    return this.#snapshot(row.value, row.version, callId);
  }
  /** Storage-only call mutation boundary. Host authorization remains required.
   * Re-read under the conversation fence; never dispatch external work here. */
  async withConversationLock<T>(callId: string, operation: (calls: PostgresRealtimeCallStore) => Promise<T>): Promise<T> {
    const initial = await this.get(callId);
    if (!initial) throw new DurableRealtimeCallConflictError();
    return this.persistence.client.transaction(async client => {
      await assertPostgresConversationWritable(client, this.tenantId, initial.conversationId);
      const calls = new PostgresRealtimeCallStore(new PostgresAiPersistence(client), this.tenantId, this.scopeId,
        { clock: this.#clock, leaseMs: this.#leaseMs });
      const current = await calls.get(callId);
      if (!current || current.conversationId !== initial.conversationId) throw new DurableRealtimeCallConflictError();
      return operation(calls);
    });
  }
  #snapshot(record: DurableRealtimeCallRecord, recordVersion: number, callId: string): DurableRealtimeCallSnapshot {
    if (!Number.isSafeInteger(recordVersion) || recordVersion < 1) throw new TypeError("Stored realtime call version is invalid.");
    const value = validRecord(record, callId);
    const expired = value.leaseExpiresAt <= this.#now() && ["admitted", "starting", "active"].includes(value.status);
    return Object.freeze({ ...value, status: expired ? "uncertain" : value.status, recordVersion });
  }
  /** Bounded server-side enumeration; apply the same owner authorization as get.
   * Cleared calls are retained for explicit audit reads, outside current context. */
  async list(input: { readonly afterCallId?: string; readonly limit?: number; readonly includeCleared?: boolean } = {}) {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Realtime call page size is invalid.");
    const after = input.afterCallId === undefined ? null : identity(input.afterCallId);
    const rows = await this.persistence.client.query<{ record_id: string; version: string; payload: DurableRealtimeCallRecord }>(
      `SELECT d.record_id,d.version::text AS version,d.payload FROM handrail_ai_documents d
       WHERE d.tenant_id=$1 AND d.kind='realtime_call' AND d.scope_id=$2 AND ($3::text IS NULL OR d.record_id>$3)
         AND ($5::boolean OR NOT EXISTS (SELECT 1 FROM handrail_ai_documents cleared WHERE cleared.tenant_id=d.tenant_id
           AND cleared.kind='checkpoint' AND cleared.scope_id=d.payload->>'conversationId'
           AND cleared.record_id='cleared-call:' || d.record_id)) ORDER BY d.record_id LIMIT $4`,
      [this.tenantId, this.scopeId, after, limit + 1, input.includeCleared === true]);
    const calls = rows.rows.slice(0, limit).map((row) => this.#snapshot(row.payload, Number(row.version), row.record_id));
    return Object.freeze({ calls: Object.freeze(calls), nextCallId: rows.rows.length > limit ? calls.at(-1)!.callId : null });
  }
  async admit(input: { readonly callId: string; readonly conversationId: string; readonly workerId: string; readonly fingerprint: string }) {
    const callId = identity(input.callId);
    const fingerprint = createHash("sha256").update(identity(input.fingerprint)).digest("hex");
    const conversationId = identity(input.conversationId), workerId = identity(input.workerId);
    const readExisting = async () => {
      const existing = await this.get(callId);
      if (existing && (existing.fingerprint !== fingerprint || existing.conversationId !== conversationId)) throw new DurableRealtimeCallConflictError();
      return existing;
    };
    const existing = await readExisting();
    if (existing) return { created: false, call: existing };
    const now = this.#now();
    const value: DurableRealtimeCallRecord = { schemaVersion: 1, callId, conversationId, workerId, fingerprint,
      status: "admitted", creationStarted: false, providerCallRef: null, createdAt: now, updatedAt: now, leaseExpiresAt: now + this.#leaseMs };
    try {
      const row = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "realtime_call", scopeId: this.scopeId,
        recordId: callId, expectedVersion: null, value });
      return { created: true, call: Object.freeze({ ...value, recordVersion: row.version }) };
    } catch (error) {
      // An unknown commit acknowledgement never authorizes provider creation.
      if (error instanceof PostgresPersistenceConflictError) {
        const winner = await readExisting();
        if (winner) return { created: false, call: winner };
      }
      throw error;
    }
  }
  /** Must commit before invoking the provider; cancellation may win this CAS. */
  beginCreation(callId: string, workerId: string) {
    return this.#update(callId, (call) => {
      if (call.workerId !== workerId || call.status !== "admitted") throw new DurableRealtimeCallConflictError();
      return { ...call, status: "starting", creationStarted: true };
    });
  }
  attachProviderCall(callId: string, workerId: string, providerCallRef: string) {
    identity(providerCallRef);
    return this.#update(callId, (call) => {
      if (call.workerId !== workerId || !call.creationStarted ||
        (call.providerCallRef !== null && call.providerCallRef !== providerCallRef)) throw new DurableRealtimeCallConflictError();
      return { ...call, providerCallRef, status: call.status === "starting" ? "active" : call.status };
    });
  }
  renewLease(callId: string, workerId: string) {
    return this.#update(callId, (call) => {
      if (call.workerId !== workerId || !["admitted", "starting", "active"].includes(call.status)) throw new DurableRealtimeCallConflictError();
      return { ...call, leaseExpiresAt: this.#now() + this.#leaseMs };
    });
  }
  requestEnd(callId: string) {
    return this.#update(callId, (call) => ({ ...call,
      status: call.status === "ended" || !call.creationStarted ? "ended" : "ending" }));
  }
  /** Invoke only after the authorized provider adapter confirms remote hangup. */
  confirmEnded(callId: string, providerCallRef: string) {
    return this.#update(callId, (call) => {
      if (!["ending", "ended"].includes(call.status) || call.providerCallRef !== providerCallRef) throw new DurableRealtimeCallConflictError();
      return { ...call, status: "ended" };
    });
  }
  async #update(callId: string, change: (call: DurableRealtimeCallRecord) => DurableRealtimeCallRecord): Promise<DurableRealtimeCallSnapshot> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.get(callId);
      if (!current) throw new DurableRealtimeCallConflictError();
      const { recordVersion, ...record } = current;
      const changed = change(record);
      if (JSON.stringify(record) === JSON.stringify(changed)) return current;
      const value = validRecord({ ...changed, updatedAt: this.#now() }, callId);
      try {
        const row = await this.persistence.compareAndSetDocument({ tenantId: this.tenantId, kind: "realtime_call", scopeId: this.scopeId,
          recordId: callId, expectedVersion: recordVersion, value });
        return Object.freeze({ ...value, recordVersion: row.version });
      } catch (error) {
        if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      }
    }
    throw new PostgresPersistenceConflictError();
  }
}
