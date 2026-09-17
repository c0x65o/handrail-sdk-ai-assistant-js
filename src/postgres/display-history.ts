import { createHash } from "node:crypto";
import { assistantToolArgumentReference } from "../conversation/approval-arguments.js";
import { approvalDisplayProposalBinding, parseConversationApprovalDisplayReview, type ConversationApprovalDisplayReviewInput,
  type ConversationApprovalDisplayReview } from "../conversation/approval-display-review.js";
import type { JsonObject } from "../protocol.js";
import type { PostgresSqlClient } from "./index.js";
import { parseConversationEvent, type ConversationEvent, type ConversationRevision, type ConversationTurnId } from "../conversation/events.js";
import { createInitialConversationState, type ConversationState } from "../conversation/state.js";
import { displayTurnControl, parseConversationDisplayControl, CONVERSATION_DISPLAY_CONTROL_MAXIMUM_BYTES,
  type ConversationDisplayControl, type ConversationDisplayControlInput } from "../conversation/display-control.js";
import { reduceConversationEvent } from "../conversation/reducer.js";
import { CONVERSATION_DISPLAY_LIMITS as limits, ConversationDisplayHistoryError,
  type ConversationDisplayContentInput, type ConversationDisplayHistory, type ConversationDisplayPage,
  type ConversationDisplayPageInput, type ConversationDisplayRecord, type ConversationDisplayRecordKind,
  type ConversationDisplayRecordTypes, type ConversationDisplayView, type ConversationDisplayChanges,
  type ConversationDisplayChangesInput } from "../conversation/display-history.js";

/** Additive schema; installing it does not replay any existing transcript. */
export const postgresDisplayHistorySchema = Object.freeze([
  `CREATE TABLE IF NOT EXISTS handrail_ai_display_heads (
    tenant_id text NOT NULL, conversation_id text NOT NULL, revision bigint NOT NULL DEFAULT 0,
    generation bigint NOT NULL DEFAULT 0, active_turn_id text,
    PRIMARY KEY (tenant_id,conversation_id))`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_display_records (
    tenant_id text NOT NULL, conversation_id text NOT NULL, kind text NOT NULL, record_id text NOT NULL,
    first_revision bigint NOT NULL, revision bigint NOT NULL, sort_at text NOT NULL,
    turn_id text, message_id text, source_id text, visible boolean NOT NULL,
    payload text NOT NULL, payload_bytes integer NOT NULL,
    PRIMARY KEY (tenant_id,conversation_id,kind,record_id))`,
  `ALTER TABLE handrail_ai_display_records ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`,
  `ALTER TABLE handrail_ai_display_records ADD COLUMN IF NOT EXISTS control_payload text`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_pending_approvals ON handrail_ai_display_records
    (tenant_id,conversation_id,sort_at DESC,first_revision DESC,record_id DESC)
    WHERE kind='approval' AND NOT deleted AND (payload::jsonb->>'status')='pending'`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_latest_turn ON handrail_ai_display_records
    (tenant_id,conversation_id,first_revision DESC,record_id DESC) WHERE kind='turn' AND NOT deleted`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_missing_control ON handrail_ai_display_records
    (tenant_id,conversation_id,first_revision,record_id) WHERE kind='turn' AND NOT deleted AND control_payload IS NULL`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_missing_review_control ON handrail_ai_display_records
    (tenant_id,conversation_id,first_revision,kind,record_id) WHERE kind IN ('tool','approval') AND NOT deleted AND control_payload IS NULL`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_messages ON handrail_ai_display_records
    (tenant_id,conversation_id,sort_at DESC,first_revision DESC,record_id DESC) WHERE kind='message' AND visible`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_turn ON handrail_ai_display_records
    (tenant_id,conversation_id,turn_id,sort_at DESC,first_revision DESC,record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_message ON handrail_ai_display_records
    (tenant_id,conversation_id,message_id,sort_at DESC,first_revision DESC,record_id DESC)`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_display_changes ON handrail_ai_display_records
    (tenant_id,conversation_id,revision,kind,record_id)`,
] as const);

const fields = { message: "messages", turn: "turns", tool: "tool_calls", approval: "approval_proposals",
  citation: "citations", source: "citation_sources", budget: "tool_loop_budget_exhaustions" } as const;
const kinds = Object.keys(fields) as ConversationDisplayRecordKind[];
const encoder = new TextEncoder();
type Head = { revision: number; generation: number; active_turn_id: string | null };
type Entity = ConversationDisplayRecordTypes[ConversationDisplayRecordKind];
type Row = Record<string, unknown> & {
  kind: ConversationDisplayRecordKind; record_id: string; first_revision: string; revision: string;
  sort_at: string; payload: string | null; payload_bytes: number; turn_id: string | null; sentinel?: boolean; record_deleted?: boolean;
};

/** Computed at canonical projection/backfill time, never by a display read. */
function reviewControl(conversationId: string, kind: ConversationDisplayRecordKind, value: Entity): string | null {
  if (kind === "tool") {
    const call = value as ConversationDisplayRecordTypes["tool"];
    return JSON.stringify({ version: 1, toolCallId: call.tool_call_id, turnId: call.turn_id, toolName: call.name,
      argumentReference: call.arguments ? assistantToolArgumentReference(call.arguments as JsonObject) : null });
  }
  if (kind !== "approval") return null;
  const p = value as ConversationDisplayRecordTypes["approval"];
  return JSON.stringify({ version: 1, proposalBinding: approvalDisplayProposalBinding(conversationId, p), proposalId: p.proposal_id, proposalVersion: p.proposal_version,
    groupId: p.group_id, turnId: p.turn_id, toolCallId: p.tool_call_id, toolName: p.tool_name, status: p.status,
    reviewType: p.reviewed_arguments.type, argumentReference: p.reviewed_arguments.type === "opaque_reference"
      ? p.reviewed_arguments.argument_ref : assistantToolArgumentReference(p.reviewed_arguments.value as JsonObject) });
}

function packPage<T extends ConversationDisplayPage>(page: T, allRows: readonly Row[], limit: number,
  maximumBytes: number, cursorFor: (row: Row) => string, reverse: boolean): T {
  const rows = allRows.filter(row => row.record_id != null), records: ConversationDisplayRecord[] = [];
  let bytes = encoder.encode(JSON.stringify(page)).byteLength + 3072;
  for (const row of rows.slice(0, limit)) {
    if (row.sentinel) break;
    let record = { kind: row.kind, id: row.record_id, revision: Number(row.revision), turnId: row.turn_id,
      bytes: row.payload_bytes, value: row.record_deleted || row.payload === null ? null : JSON.parse(row.payload),
      deferred: !row.record_deleted && row.payload === null,
      ...(row.record_deleted ? { deleted: true as const } : {}) } as ConversationDisplayRecord;
    const size = encoder.encode(JSON.stringify(record)).byteLength + 1;
    if (bytes + size > maximumBytes && records.length) break;
    if (bytes + size > maximumBytes && !record.deleted) record = { ...record, value: null, deferred: true };
    bytes += encoder.encode(JSON.stringify(record)).byteLength + 1;
    records.push(record);
  }
  for (;;) {
    const last = rows[records.length - 1];
    const nextCursor = last && rows.length > records.length ? cursorFor(last) : null;
    const result = { ...page, records: reverse ? [...records].reverse() : [...records], nextCursor };
    if (encoder.encode(JSON.stringify(result)).byteLength <= maximumBytes) return result;
    if (records.length > 1) records.pop();
    else if (records[0]?.value !== null) records[0] = { ...records[0]!, value: null, deferred: true };
    else throw new ConversationDisplayHistoryError("invalid_input", "The page byte budget is too small for its identifiers");
  }
}

/** Exactly the canonical append lock; projection backfill and append cannot race. */
function lockKey(tenant: string, conversation: string) {
  return [tenant, conversation].map(part => `${encoder.encode(part).byteLength}:${part}`).join("|");
}
function recordId(kind: ConversationDisplayRecordKind, entity: Entity): string {
  const value = entity as unknown as Record<string, unknown>;
  return kind === "budget" ? JSON.stringify([value.turn_id, value.budget])
    : String(value[({ message: "message_id", turn: "turn_id", tool: "tool_call_id", approval: "proposal_id",
      citation: "citation_id", source: "source_id" } as const)[kind]]);
}

async function ensureHead(client: PostgresSqlClient, tenant: string, conversation: string): Promise<Head> {
  await client.query(`INSERT INTO handrail_ai_display_heads (tenant_id,conversation_id) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [tenant, conversation]);
  const result = await client.query<{ revision: string; generation: string; active_turn_id: string | null }>(
    `SELECT revision::text,generation::text,active_turn_id FROM handrail_ai_display_heads
      WHERE tenant_id=$1 AND conversation_id=$2 FOR UPDATE`, [tenant, conversation]);
  const row = result.rows[0]!;
  return { revision: Number(row.revision), generation: Number(row.generation), active_turn_id: row.active_turn_id };
}

/** Find only reducer dependencies for this event, never the conversation checkpoint. */
async function dependencies(client: PostgresSqlClient, tenant: string, event: ConversationEvent,
  cache: Map<string, Entity | null>): Promise<ConversationState> {
  const p = event.payload;
  const keys: { kind: ConversationDisplayRecordKind; id: string }[] = [];
  const add = (kind: ConversationDisplayRecordKind, id: string) => keys.push({ kind, id });
  if ("message_id" in p) add("message", p.message_id);
  if ("turn_id" in p) add("turn", p.turn_id);
  if ("tool_call_id" in p) add("tool", p.tool_call_id);
  if ("proposal_id" in p) add("approval", p.proposal_id);
  if (p.type === "tool_loop.budget_exhausted") add("budget", JSON.stringify([p.turn_id, p.budget]));
  if (p.type === "citation.records_linked") {
    if (p.target.type === "assistant_message") add("message", p.target.message_id);
    else { add("turn", p.target.turn_id); add("tool", p.target.tool_call_id); }
    for (const source of p.sources) add("source", source.source_id);
    for (const citation of p.citations) {
      add("citation", citation.citation_id); add("source", citation.source_id);
    }
  }
  const state = { ...createInitialConversationState(event.conversation_id),
    revision: (event.revision - 1 || null) as ConversationRevision | null };
  if (keys.length) {
    const unique = [...new Map(keys.map(key => [JSON.stringify([key.kind, key.id]), key])).values()];
    const missing = unique.filter(key => !cache.has(JSON.stringify([key.kind, key.id])));
    if (missing.length) {
      const rows = await client.query<Row>(`SELECT r.kind,r.record_id,r.payload FROM handrail_ai_display_records r
      JOIN jsonb_to_recordset($3::text::jsonb) AS wanted(kind text,id text)
        ON r.kind=wanted.kind AND r.record_id=wanted.id
      WHERE r.tenant_id=$1 AND r.conversation_id=$2 AND NOT r.deleted`,
      [tenant, event.conversation_id, JSON.stringify(missing)]);
      for (const key of missing) cache.set(JSON.stringify([key.kind, key.id]), null);
      for (const row of rows.rows) cache.set(JSON.stringify([row.kind, row.record_id]), JSON.parse(row.payload!));
    }
    for (const kind of kinds) {
      // The subset goes only to the internal entity reducer, never replay/model context.
      Object.assign(state, { [fields[kind]]: unique.filter(key => key.kind === kind)
        .map(key => cache.get(JSON.stringify([key.kind, key.id]))).filter(value => value != null) });
    }
  }
  return state;
}

async function writeEntity(client: PostgresSqlClient, tenant: string, event: ConversationEvent,
  kind: ConversationDisplayRecordKind, value: Entity, firstRevision: number, firstOccurredAt: string) {
  const data = value as unknown as Record<string, unknown>;
  const target = data.target as { type: string; message_id?: string; tool_call_id?: string } | undefined;
  const payload = JSON.stringify(value);
  const time = typeof data.created_at === "string" ? data.created_at : firstOccurredAt;
  // ISO normalization gives lexical ordering even when imported offsets differ.
  const sortAt = new Date(time).toISOString();
  let turnId = typeof data.turn_id === "string" ? data.turn_id : null;
  if (kind === "citation" && target?.tool_call_id) {
    const p = event.payload;
    if (p.type === "citation.records_linked" && p.target.type === "tool_result") turnId = p.target.turn_id;
  }
  await client.query(`INSERT INTO handrail_ai_display_records
    (tenant_id,conversation_id,kind,record_id,first_revision,revision,sort_at,turn_id,message_id,source_id,visible,payload,payload_bytes,control_payload)
    VALUES ($1,$2,$3,$4,$13,$5,$6,$7,$8,$9,$10,$11,$12,$14)
    ON CONFLICT (tenant_id,conversation_id,kind,record_id) DO UPDATE SET revision=EXCLUDED.revision,
      first_revision=CASE WHEN handrail_ai_display_records.deleted OR NOT handrail_ai_display_records.visible AND EXCLUDED.visible THEN EXCLUDED.first_revision
        ELSE handrail_ai_display_records.first_revision END,
      sort_at=CASE WHEN handrail_ai_display_records.deleted OR NOT handrail_ai_display_records.visible AND EXCLUDED.visible THEN EXCLUDED.sort_at
        ELSE handrail_ai_display_records.sort_at END,
      turn_id=COALESCE(EXCLUDED.turn_id,handrail_ai_display_records.turn_id),message_id=EXCLUDED.message_id,source_id=EXCLUDED.source_id,
      visible=EXCLUDED.visible,payload=EXCLUDED.payload,payload_bytes=EXCLUDED.payload_bytes,deleted=false,control_payload=EXCLUDED.control_payload`,
  [tenant, event.conversation_id, kind, recordId(kind, value), event.revision, sortAt, turnId,
    kind === "message" ? data.message_id : target?.message_id ?? null,
    kind === "citation" ? data.source_id : null, kind !== "message" || data.role !== null,
    payload, encoder.encode(payload).byteLength, firstRevision,
    kind === "turn" ? JSON.stringify(displayTurnControl(value as ConversationDisplayRecordTypes["turn"], event.revision)) : reviewControl(event.conversation_id, kind, value)]);
}

/** Called in the append transaction after the canonical lock has been acquired.
 * A legacy/gapped projection stays unready until bounded backfill catches up. */
export async function projectPostgresDisplayEvents(client: PostgresSqlClient, tenant: string,
  conversation: string, events: readonly ConversationEvent[]): Promise<void> {
  if (!events.length) return;
  let head = await ensureHead(client, tenant, conversation);
  if (head.revision !== events[0]!.revision - 1) return;
  // Token batches touch the same message repeatedly. Read and persist each
  // affected entity once per batch, rather than rewriting it per token.
  const cache = new Map<string, Entity | null>();
  const pending = new Map<string, { kind: ConversationDisplayRecordKind; value: Entity; event: ConversationEvent;
    firstRevision: number; firstOccurredAt: string }>();
  const links: { turnId: string; messageIds: readonly string[]; revision: number }[] = [];
  for (const event of events) {
    if (event.conversation_id !== conversation || event.revision !== head.revision + 1) {
      throw new TypeError("Display projection requires contiguous canonical events");
    }
    if (event.payload.type === "conversation.cleared") {
      await client.query(`DELETE FROM handrail_ai_display_records WHERE tenant_id=$1 AND conversation_id=$2`, [tenant, conversation]);
      cache.clear(); pending.clear(); links.length = 0;
      head = { revision: event.revision, generation: event.revision, active_turn_id: null };
      continue;
    }
    const before = { ...await dependencies(client, tenant, event, cache),
      active_turn_id: head.active_turn_id as ConversationTurnId | null };
    const after = reduceConversationEvent(before, event);
    if (after.replay_error) throw new TypeError("Invalid canonical display event sequence");
    for (const kind of kinds) {
      const previous = new Map((before[fields[kind]] as readonly Entity[]).map(value => [recordId(kind, value), value]));
      for (const value of after[fields[kind]] as readonly Entity[]) {
        const id = recordId(kind, value), old = previous.get(id), key = JSON.stringify([kind, id]);
        if (old !== value) {
          const becameVisible = kind === "message" && (old as ConversationDisplayRecordTypes["message"] | undefined)?.role == null
            && (value as ConversationDisplayRecordTypes["message"]).role !== null;
          const firstRevision = becameVisible ? event.revision : pending.get(key)?.firstRevision ?? event.revision;
          const firstOccurredAt = becameVisible ? event.occurred_at : pending.get(key)?.firstOccurredAt ?? event.occurred_at;
          cache.set(key, value); pending.set(key, { kind, value, event, firstRevision, firstOccurredAt });
        }
      }
    }
    // Message attachments live in the message record; audit linkage lives in the log.
    // A placeholder later resolved as non-assistant cannot retain assistant citations.
    if (event.payload.type === "message.created" && event.payload.role !== "assistant") {
      const messageId = event.payload.message_id;
      if (after.messages.some(message => message.message_id === messageId && message.role !== "assistant")) {
        for (const [key, value] of cache) {
          if (key.startsWith('["citation",') && value) {
            const citation = value as ConversationDisplayRecordTypes["citation"];
            if (citation.target.type === "assistant_message" && String(citation.target.message_id) === messageId) {
              cache.set(key, null); pending.delete(key);
            }
          }
        }
        await client.query(`UPDATE handrail_ai_display_records SET deleted=true,payload='{}',payload_bytes=2,revision=$4
          WHERE tenant_id=$1 AND conversation_id=$2 AND kind='citation' AND NOT deleted AND message_id=$3`,
        [tenant, conversation, messageId, event.revision]);
      }
    }
    // Turns also identify user input / nonstreamed output messages. Store an indexed
    // relation even if no text_appended event supplied a message.turn_id.
    if (event.payload.type === "turn.started" || event.payload.type === "turn.completed") {
      const ids = event.payload.type === "turn.started" ? event.payload.input_message_ids : event.payload.output_message_ids;
      links.push({ turnId: event.payload.turn_id, messageIds: ids, revision: event.revision });
    }
    head = { ...head, revision: event.revision, active_turn_id: after.active_turn_id };
  }
  for (const record of pending.values()) await writeEntity(client, tenant, record.event, record.kind, record.value, record.firstRevision, record.firstOccurredAt);
  for (const link of links) await client.query(`UPDATE handrail_ai_display_records SET turn_id=COALESCE(turn_id,$3),revision=GREATEST(revision,$5)
    WHERE tenant_id=$1 AND conversation_id=$2 AND kind='message' AND record_id=ANY($4::text[])`,
  [tenant, conversation, link.turnId, link.messageIds, link.revision]);
  await client.query(`UPDATE handrail_ai_display_heads SET revision=$3,generation=$4,active_turn_id=$5
    WHERE tenant_id=$1 AND conversation_id=$2`, [tenant, conversation, head.revision, head.generation, head.active_turn_id]);
}

function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) invalid();
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
}
function invalid(): never { throw new ConversationDisplayHistoryError("invalid_input", "Invalid history request"); }
type Cursor = { v: 1; scope: string; generation: number; ceiling: number; view: string;
  at: string; sequence: number; id: string; kind: string; direction?: "older" | "newer" };
function viewOf(view: ConversationDisplayView | undefined): ConversationDisplayView {
  if (!view || view.type === "messages") return { type: "messages" };
  if (view.type === "pending_approvals") return { type: "pending_approvals" };
  if (view.type === "approval") { identity(view.proposalId); return { type: "approval", proposalId: view.proposalId }; }
  if (view.type === "turn") { identity(view.turnId); return { type: "turn", turnId: view.turnId }; }
  if (view.type === "context") {
    // A display window can retain adjacent pages. The request envelope and
    // response page budgets still apply independently of this reference bound.
    if (!Array.isArray(view.messageIds) || view.messageIds.length > 100) invalid();
    view.messageIds.forEach(identity);
    if (view.turnId !== undefined) identity(view.turnId);
    return { type: "context", messageIds: [...new Set(view.messageIds)].sort(),
      ...(view.turnId === undefined ? {} : { turnId: view.turnId }) };
  }
  if (view.type === "citations") { identity(view.messageId); return { type: "citations", messageId: view.messageId }; }
  return invalid();
}

/** Authorized read model. No read method initiates recovery, replay or backfill. */
export class PostgresConversationDisplayHistory implements ConversationDisplayHistory {
  constructor(readonly client: PostgresSqlClient, readonly tenantId: string, readonly ownerScopeId: string,
    readonly authorize: (conversationId: string) => Promise<void>) {
    identity(tenantId); identity(ownerScopeId);
  }

  private scope(conversation: string) {
    return createHash("sha256").update(JSON.stringify([this.tenantId, this.ownerScopeId, conversation])).digest("hex");
  }

  /** One bounded, resumable migration step. Caller owns scheduling and cancellation.
   * Permission is checked before and inside the transaction, including after work. */
  async backfill(conversationId: string, maximumEvents: number = limits.backfillEvents) {
    identity(conversationId); integer(maximumEvents, 1, 1000);
    await this.authorize(conversationId);
    return this.client.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(this.tenantId, conversationId)]);
      await this.authorize(conversationId);
      const deleted = await client.query(`SELECT 1 FROM handrail_ai_documents
        WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted'`, [this.tenantId, conversationId]);
      if (deleted.rows.length) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
      const head = await ensureHead(client, this.tenantId, conversationId);
      const events = await client.query<{ payload: unknown }>(`SELECT payload FROM handrail_ai_events
        WHERE tenant_id=$1 AND conversation_id=$2 AND revision>$3 ORDER BY revision LIMIT $4`,
      [this.tenantId, conversationId, head.revision, maximumEvents + 1]);
      const batch = events.rows.slice(0, maximumEvents).map(row => parseConversationEvent(row.payload));
      await projectPostgresDisplayEvents(client, this.tenantId, conversationId, batch);
      await this.authorize(conversationId);
      return { revision: batch.at(-1)?.revision ?? head.revision, processed: batch.length, hasMore: events.rows.length > maximumEvents };
    });
  }

  /** Scalar controls read only indexed metadata and precomputed small summaries.
   * A legacy summary is prepared separately, never by parsing history here. */
  async control(input: ConversationDisplayControlInput): Promise<ConversationDisplayControl> {
    identity(input.conversationId);
    if (input.turnId !== undefined) identity(input.turnId);
    await this.authorize(input.conversationId);
    const result = await this.client.query<{ revision: string; generation: string; canonical_revision: string;
      active_turn_id: string | null; latest_turn_id: string | null; deleted: boolean;
      record_id: string | null; control_payload: string | null; has_pending_approvals: boolean }>(`
      WITH head AS (
        SELECT COALESCE(h.revision,0) AS revision,COALESCE(h.generation,0) AS generation,h.active_turn_id,
          COALESCE((SELECT e.revision FROM handrail_ai_events e WHERE e.tenant_id=$1 AND e.conversation_id=$2
            ORDER BY e.revision DESC LIMIT 1),0) AS canonical_revision,
          EXISTS(SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted'
            AND scope_id=$2 AND record_id='deleted') AS deleted
        FROM (SELECT 1) seed LEFT JOIN handrail_ai_display_heads h ON h.tenant_id=$1 AND h.conversation_id=$2
      ), latest AS (
        SELECT record_id FROM handrail_ai_display_records WHERE tenant_id=$1 AND conversation_id=$2
          AND kind='turn' AND NOT deleted ORDER BY first_revision DESC,record_id DESC LIMIT 1
      ) SELECT h.revision::text,h.generation::text,h.canonical_revision::text,h.active_turn_id,h.deleted,
        (SELECT record_id FROM latest) AS latest_turn_id,r.record_id,
        EXISTS(SELECT 1 FROM handrail_ai_display_records p WHERE p.tenant_id=$1 AND p.conversation_id=$2
          AND p.kind='approval' AND NOT p.deleted AND (p.payload::jsonb->>'status')='pending') AS has_pending_approvals,
        CASE WHEN octet_length(r.control_payload)<=8192 THEN r.control_payload ELSE NULL END AS control_payload
      FROM head h LEFT JOIN handrail_ai_display_records r ON r.tenant_id=$1 AND r.conversation_id=$2
        AND r.kind='turn' AND NOT r.deleted AND h.revision=h.canonical_revision AND NOT h.deleted
        AND r.record_id=ANY(ARRAY[h.active_turn_id,(SELECT record_id FROM latest),$3::text])`,
    [this.tenantId, input.conversationId, input.turnId ?? null]);
    await this.authorize(input.conversationId);
    const head = result.rows[0]!;
    if (head.deleted) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
    const turns = new Map(result.rows.filter(row => row.record_id !== null)
      .map(row => [row.record_id, row.control_payload ? JSON.parse(row.control_payload) as unknown : null]));
    const ready = head.revision === head.canonical_revision && ![...turns.values()].includes(null) &&
      (!head.active_turn_id || turns.has(head.active_turn_id)) && (!head.latest_turn_id || turns.has(head.latest_turn_id));
    const response = parseConversationDisplayControl({ schemaVersion: 1, conversationId: input.conversationId,
      status: ready ? "ready" : "preparing", generation: Number(head.generation), revision: Number(head.revision),
      canonicalRevision: Number(head.canonical_revision), activeTurnId: head.active_turn_id,
      hasPendingApprovals: ready && head.has_pending_approvals,
      activeTurn: ready && head.active_turn_id ? turns.get(head.active_turn_id) : null,
      latestTurn: ready && head.latest_turn_id ? turns.get(head.latest_turn_id) : null,
      requestedTurn: ready && input.turnId ? turns.get(input.turnId) ?? null : null }, input);
    if (encoder.encode(JSON.stringify(response)).byteLength > CONVERSATION_DISPLAY_CONTROL_MAXIMUM_BYTES) {
      throw new TypeError("Display control exceeded its byte budget");
    }
    return response;
  }

  /** One-time preparation for display indexes written by an older SDK. Null
   * summaries are the durable watermark. The append lock excludes clear/delete
   * and concurrent projection; no canonical data is rewritten. */
  async backfillControls(conversationId: string, maximumTurns = 10) {
    identity(conversationId); integer(maximumTurns, 1, 50);
    await this.authorize(conversationId);
    return this.client.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(this.tenantId, conversationId)]);
      await this.authorize(conversationId);
      const deleted = await client.query(`SELECT 1 FROM handrail_ai_documents
        WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted'`, [this.tenantId, conversationId]);
      if (deleted.rows.length) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
      const repaired = await client.query(`WITH batch AS (
        SELECT record_id,revision,payload::jsonb AS p FROM handrail_ai_display_records
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind='turn' AND NOT deleted AND control_payload IS NULL
        ORDER BY first_revision DESC,record_id DESC LIMIT $3 FOR UPDATE
      ) UPDATE handrail_ai_display_records r SET control_payload=jsonb_build_object(
        'turnId',b.record_id,'revision',b.revision,'status',b.p->>'status',
        'remoteMayStillBeRunning',b.p->'remote_may_still_be_running',
        'error',CASE WHEN b.p->'error' IS NULL OR b.p->'error'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object(
          'code',left(b.p#>>'{error,code}',64),'message',left(b.p#>>'{error,message}',256),
          'retryable',b.p#>'{error,retryable}','messageTruncated',length(b.p#>>'{error,message}')>256) END)::text
        FROM batch b WHERE r.tenant_id=$1 AND r.conversation_id=$2 AND r.kind='turn' AND r.record_id=b.record_id
        RETURNING r.record_id`, [this.tenantId, conversationId, maximumTurns]);
      const remaining = await client.query(`SELECT 1 FROM handrail_ai_display_records
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind='turn' AND NOT deleted AND control_payload IS NULL LIMIT 1`,
      [this.tenantId, conversationId]);
      await this.authorize(conversationId);
      return { processed: repaired.rows.length, hasMore: remaining.rows.length > 0 };
    });
  }

  /** Durable, separately scheduled upgrade of existing review summaries. One
   * entity by default: large arguments never hydrate on a user display read. */
  async backfillReviewControls(conversationId: string, maximumRecords = 1) {
    identity(conversationId); integer(maximumRecords, 1, 10);
    await this.authorize(conversationId);
    return this.client.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey(this.tenantId, conversationId)]);
      await this.authorize(conversationId);
      const deleted = await client.query(`SELECT 1 FROM handrail_ai_documents
        WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted'`, [this.tenantId, conversationId]);
      if (deleted.rows.length) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
      const batch = await client.query<Row>(`SELECT kind,record_id,payload FROM handrail_ai_display_records
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind IN ('tool','approval') AND NOT deleted AND control_payload IS NULL
        ORDER BY first_revision,kind,record_id LIMIT $3 FOR UPDATE`, [this.tenantId, conversationId, maximumRecords]);
      for (const row of batch.rows) await client.query(`UPDATE handrail_ai_display_records SET control_payload=$5
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind=$3 AND record_id=$4`,
      [this.tenantId, conversationId, row.kind, row.record_id, reviewControl(conversationId, row.kind, JSON.parse(row.payload!))]);
      const remaining = await client.query(`SELECT 1 FROM handrail_ai_display_records
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind IN ('tool','approval') AND NOT deleted AND control_payload IS NULL LIMIT 1`,
      [this.tenantId, conversationId]);
      await this.authorize(conversationId);
      return { processed: batch.rows.length, hasMore: remaining.rows.length > 0 };
    });
  }

  async approvalReview(input: ConversationApprovalDisplayReviewInput): Promise<ConversationApprovalDisplayReview> {
    identity(input.conversationId); identity(input.proposalId); integer(input.generation, 0);
    const offset = input.offset ?? 0; integer(offset, 0, 2_147_483_646);
    if (input.binding !== undefined && !/^[a-f0-9]{64}$/u.test(input.binding) || offset > 0 && input.binding === undefined) invalid();
    await this.authorize(input.conversationId);
    const result = await this.client.query<{ generation: string; revision: string; canonical_revision: string;
      proposal_revision: string | null; proposal_control: string | null; tool_revision: string | null;
      tool_control: string | null; proposal_control_missing: boolean; tool_control_missing: boolean; content: string | null }>(`
      WITH head AS (
        SELECT h.*,COALESCE((SELECT e.revision FROM handrail_ai_events e WHERE e.tenant_id=$1 AND e.conversation_id=$2
          ORDER BY e.revision DESC LIMIT 1),0) AS canonical_revision FROM handrail_ai_display_heads h
        WHERE h.tenant_id=$1 AND h.conversation_id=$2 AND NOT EXISTS(SELECT 1 FROM handrail_ai_documents
          WHERE tenant_id=$1 AND kind='conversation_deleted' AND scope_id=$2 AND record_id='deleted')
      ), selected AS (
        SELECT h.generation,h.revision,h.canonical_revision,p.revision AS proposal_revision,p.payload AS proposal_payload,
          p.control_payload IS NULL AS proposal_control_missing,t.control_payload IS NULL AS tool_control_missing,
          CASE WHEN octet_length(p.control_payload)<=8192 THEN p.control_payload::jsonb END AS pc,
          t.revision AS tool_revision,t.payload AS tool_payload,
          CASE WHEN octet_length(t.control_payload)<=8192 THEN t.control_payload::jsonb END AS tc
        FROM head h LEFT JOIN handrail_ai_display_records p ON p.tenant_id=h.tenant_id AND p.conversation_id=h.conversation_id
          AND p.kind='approval' AND p.record_id=$3 AND NOT p.deleted
        LEFT JOIN handrail_ai_display_records t ON t.tenant_id=h.tenant_id AND t.conversation_id=h.conversation_id
          AND t.kind='tool' AND t.record_id=p.control_payload::jsonb->>'toolCallId' AND NOT t.deleted
      ) SELECT generation::text,revision::text,canonical_revision::text,proposal_revision::text,pc::text AS proposal_control,
        tool_revision::text,tc::text AS tool_control,proposal_control_missing,tool_control_missing,
        CASE WHEN generation=$4 AND revision=canonical_revision AND pc->>'version'='1' AND pc->>'status'='pending' AND
          (pc->>'reviewType'='redacted_json' OR pc->>'reviewType'='opaque_reference' AND tc->>'version'='1' AND
            pc->>'argumentReference'=tc->>'argumentReference' AND pc->>'turnId'=tc->>'turnId' AND
            pc->>'toolName'=tc->>'toolName' AND pc->>'toolCallId'=tc->>'toolCallId')
        THEN substring(jsonb_pretty(CASE WHEN pc->>'reviewType'='redacted_json'
          THEN proposal_payload::jsonb#>'{reviewed_arguments,value}' ELSE tool_payload::jsonb->'arguments' END)
          FROM $5::integer FOR $6::integer) END AS content FROM selected`,
    [this.tenantId, input.conversationId, input.proposalId, input.generation, offset + 1, limits.contentChunkCharacters + 1]);
    await this.authorize(input.conversationId);
    const row = result.rows[0];
    if (!row) throw new ConversationDisplayHistoryError("not_found", "Approval review not found");
    if (Number(row.generation) !== input.generation) throw new ConversationDisplayHistoryError("stale_cursor", "History was cleared");
    const header = { schemaVersion: 1 as const, conversationId: input.conversationId, generation: input.generation, proposalId: input.proposalId };
    if (row.revision !== row.canonical_revision) return { ...header, status: "preparing", review: null };
    if (row.proposal_revision === null) throw new ConversationDisplayHistoryError("not_found", "Approval review not found");
    const proposal = row.proposal_control ? JSON.parse(row.proposal_control) as Record<string, unknown> : null;
    if (row.proposal_control_missing || proposal?.reviewType === "opaque_reference" && row.tool_control_missing && row.tool_revision !== null) {
      return { ...header, status: "preparing", review: null };
    }
    if (!proposal || proposal.version !== 1 || proposal.proposalId !== input.proposalId || proposal.status !== "pending" || row.content === null) {
      throw new ConversationDisplayHistoryError("content_changed", "Verified approval details are unavailable. Reload the review.");
    }
    const binding = createHash("sha256").update(JSON.stringify([this.scope(input.conversationId), input.generation,
      input.proposalId, row.proposal_revision, proposal, proposal.reviewType === "opaque_reference" ? row.tool_revision : null])).digest("hex");
    if (input.binding !== undefined && input.binding !== binding) throw new ConversationDisplayHistoryError("content_changed", "Approval changed. Reload before deciding.");
    const characters = Array.from(row.content);
    return parseConversationApprovalDisplayReview({ ...header, status: "ready", review: {
      binding, proposalBinding: proposal.proposalBinding, proposalVersion: proposal.proposalVersion, groupId: proposal.groupId, turnId: proposal.turnId,
      toolCallId: proposal.toolCallId, toolName: proposal.toolName, argumentReference: proposal.argumentReference,
      text: characters.slice(0, limits.contentChunkCharacters).join(""), offset,
      nextOffset: characters.length > limits.contentChunkCharacters ? offset + limits.contentChunkCharacters : null,
    } }, input);
  }

  async page(input: ConversationDisplayPageInput): Promise<ConversationDisplayPage> {
    identity(input.conversationId);
    const view = viewOf(input.view), limit = input.limit ?? limits.defaultPageSize;
    const viewKey = createHash("sha256").update(JSON.stringify(view)).digest("hex");
    const maximumBytes = input.maximumBytes ?? limits.defaultPageBytes;
    integer(limit, 1, limits.maximumPageSize); integer(maximumBytes, limits.minimumPageBytes, limits.maximumPageBytes);
    if (input.anchor !== undefined) {
      if (!input.anchor || input.cursor !== undefined || view.type !== "messages" ||
        !["older", "newer"].includes(input.anchor.direction) ||
        input.anchor.inclusive !== undefined && typeof input.anchor.inclusive !== "boolean") invalid();
      identity(input.anchor.messageId); integer(input.anchor.generation, 0);
    }
    let cursor: Cursor | null = null;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== "string" || input.cursor.length > 4096) invalid();
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as Cursor; } catch { invalid(); }
      if (!cursor || cursor.v !== 1 || cursor.scope !== this.scope(input.conversationId)
        || cursor.view !== viewKey || typeof cursor.at !== "string" || cursor.at.length > 32) invalid();
      integer(cursor.generation, 0); integer(cursor.ceiling, 0); integer(cursor.sequence, 1);
      identity(cursor.id); identity(cursor.kind);
      if (cursor.direction !== undefined && !["older", "newer"].includes(cursor.direction)) invalid();
    }
    const direction = cursor?.direction ?? input.anchor?.direction ?? "older";
    const order = direction === "older" ? "DESC" : "ASC";
    const comparison = (direction === "older" ? "<" : ">") + (input.anchor?.inclusive ? "=" : "");
    await this.authorize(input.conversationId);
    const contextMatch = `(c.kind='citation' AND c.message_id=ANY(ARRAY(SELECT jsonb_array_elements_text($9::jsonb->'messageIds')))
      OR c.turn_id=ANY(ARRAY(SELECT turn_id FROM handrail_ai_display_records
          WHERE tenant_id=$1 AND conversation_id=$2 AND kind='message' AND NOT deleted
          AND record_id=ANY(ARRAY(SELECT jsonb_array_elements_text($9::jsonb->'messageIds')))
        UNION SELECT $9::jsonb->>'turnId'))) AND c.kind IN ('turn','tool','approval','budget','citation')`;
    const filter = view.type === "messages" ? "r.kind='message' AND r.visible AND $9::text IS NULL"
      : view.type === "pending_approvals" ? "r.kind='approval' AND (r.payload::jsonb->>'status')='pending' AND $9::text IS NULL"
      : view.type === "approval" ? `(r.kind,r.record_id) IN (
          SELECT 'approval',$9::text UNION ALL
          SELECT 'tool',p.payload::jsonb->>'tool_call_id' FROM handrail_ai_display_records p
            WHERE p.tenant_id=$1 AND p.conversation_id=$2 AND p.kind='approval' AND p.record_id=$9 AND NOT p.deleted)`
      : view.type === "turn" ? "r.turn_id=$9 AND r.kind IN ('turn','tool','approval','budget','citation')"
        : view.type === "context" ? `(r.kind,r.record_id) IN (
          SELECT c.kind,c.record_id FROM handrail_ai_display_records c
            WHERE c.tenant_id=$1 AND c.conversation_id=$2 AND NOT c.deleted AND ${contextMatch}
          UNION SELECT 'source',c.source_id FROM handrail_ai_display_records c
            WHERE c.tenant_id=$1 AND c.conversation_id=$2 AND NOT c.deleted AND c.kind='citation' AND ${contextMatch})`
        : "r.message_id=$9 AND r.kind='citation'";
    // One statement owns both the projection watermark and records, so a concurrent
    // clear/append cannot combine an old generation with new page contents.
    const result = await this.client.query<Row & { head_revision: string; canonical_revision: string;
      generation: string; active_turn_id: string | null; deleted: boolean; anchor_found: boolean }>(`
      WITH head AS (
        SELECT COALESCE(h.revision,0) AS revision,COALESCE(h.generation,0) AS generation,h.active_turn_id,
          COALESCE((SELECT e.revision FROM handrail_ai_events e WHERE e.tenant_id=$1 AND e.conversation_id=$2
            ORDER BY e.revision DESC LIMIT 1),0) AS canonical_revision,
          EXISTS(SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted'
            AND scope_id=$2 AND record_id='deleted') AS deleted
        FROM (SELECT 1) seed LEFT JOIN handrail_ai_display_heads h ON h.tenant_id=$1 AND h.conversation_id=$2
      ), anchor AS (
        SELECT sort_at,first_revision,record_id,kind FROM handrail_ai_display_records
        WHERE tenant_id=$1 AND conversation_id=$2 AND kind='message' AND record_id=$12 AND visible AND NOT deleted
      ), candidates AS (
        SELECT r.kind,r.record_id,r.first_revision,r.revision,r.sort_at,r.payload_bytes,r.turn_id,
          (CASE WHEN r.payload_bytes<=$4 THEN r.payload_bytes ELSE 0 END) + 256 + octet_length(r.record_id)
            + COALESCE(octet_length(r.turn_id),0) AS cost
        FROM handrail_ai_display_records r,head h WHERE r.tenant_id=$1 AND r.conversation_id=$2
          AND h.revision=h.canonical_revision AND NOT h.deleted AND NOT r.deleted AND ${filter}
          AND r.first_revision<=COALESCE($3::bigint,h.revision)
          AND (($5::text IS NULL AND $12::text IS NULL) OR (r.sort_at,r.first_revision,r.record_id,r.kind) ${comparison}
            (COALESCE($5,(SELECT sort_at FROM anchor)),COALESCE($6::bigint,(SELECT first_revision FROM anchor)),
             COALESCE($7,(SELECT record_id FROM anchor)),COALESCE($8,(SELECT kind FROM anchor))))
        ORDER BY r.sort_at ${order},r.first_revision ${order},r.record_id ${order},r.kind ${order} LIMIT $10
      ), budget AS (
        SELECT *,sum(cost) OVER (ORDER BY sort_at ${order},first_revision ${order},record_id ${order},kind ${order}) AS needed,
          row_number() OVER (ORDER BY sort_at ${order},first_revision ${order},record_id ${order},kind ${order}) AS ordinal
        FROM candidates
      ), page AS (
        SELECT b.*,b.needed>$11 AND b.ordinal>1 AS sentinel,
          CASE WHEN (b.needed<=$11 OR b.ordinal=1) AND b.payload_bytes<=$4 THEN r.payload ELSE NULL END AS payload
        FROM budget b JOIN handrail_ai_display_records r ON r.tenant_id=$1 AND r.conversation_id=$2
          AND r.kind=b.kind AND r.record_id=b.record_id
        WHERE b.needed-b.cost<=$11 OR b.ordinal=1
      ) SELECT h.revision::text AS head_revision,h.generation::text,h.canonical_revision::text,h.active_turn_id,h.deleted,
        EXISTS(SELECT 1 FROM anchor) AS anchor_found,
        p.kind,p.record_id,p.first_revision::text,p.revision::text,p.sort_at,p.payload_bytes,p.payload,p.turn_id,p.sentinel
      FROM head h LEFT JOIN page p ON true
      ORDER BY p.sort_at ${order},p.first_revision ${order},p.record_id ${order},p.kind ${order}`,
    [this.tenantId, input.conversationId, cursor?.ceiling ?? null, Math.min(limits.maximumInlineRecordBytes, maximumBytes - 4096),
      cursor?.at ?? null, cursor?.sequence ?? null, cursor?.id ?? null, cursor?.kind ?? null,
      view.type === "messages" || view.type === "pending_approvals" ? null : view.type === "approval" ? view.proposalId : view.type === "turn" ? view.turnId : view.type === "context" ? JSON.stringify(view) : view.messageId, limit + 1, maximumBytes - 1024,
      input.anchor?.messageId ?? null]);
    await this.authorize(input.conversationId);
    const head = result.rows[0]!;
    if (head.deleted) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
    const generation = Number(head.generation), revision = Number(head.head_revision), canonicalRevision = Number(head.canonical_revision);
    if (cursor && (cursor.generation !== generation || cursor.ceiling > revision) ||
      input.anchor && input.anchor.generation !== generation) {
      throw new ConversationDisplayHistoryError("stale_cursor", "History changed. Reload the newest page.");
    }
    if (input.anchor && !head.anchor_found && revision === canonicalRevision) {
      throw new ConversationDisplayHistoryError("not_found", "The saved message is no longer available");
    }
    const page: ConversationDisplayPage = { schemaVersion: 1, status: revision === canonicalRevision ? "ready" : "preparing",
      conversationId: input.conversationId, generation, revision, canonicalRevision,
      activeTurnId: head.active_turn_id, records: [], nextCursor: null };
    return packPage(page, result.rows, limit, maximumBytes, last => Buffer.from(JSON.stringify({ v: 1,
        scope: this.scope(input.conversationId), generation, ceiling: cursor?.ceiling ?? revision, view: viewKey,
        at: last.sort_at, sequence: Number(last.first_revision), id: last.record_id, kind: last.kind, direction } satisfies Cursor)).toString("base64url"), direction === "older");
  }

  async changes(input: ConversationDisplayChangesInput): Promise<ConversationDisplayChanges> {
    identity(input.conversationId); integer(input.generation, 0); integer(input.afterRevision, 0);
    const limit = input.limit ?? limits.defaultPageSize, maximumBytes = input.maximumBytes ?? limits.defaultPageBytes;
    integer(limit, 1, limits.maximumPageSize); integer(maximumBytes, limits.minimumPageBytes, limits.maximumPageBytes);
    type ChangeCursor = { v: 1; operation: "changes"; scope: string; generation: number; after: number;
      ceiling: number; revision: number; kind: string; id: string };
    let cursor: ChangeCursor | null = null;
    if (input.cursor !== undefined) {
      if (typeof input.cursor !== "string" || input.cursor.length > 4096) invalid();
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as ChangeCursor; } catch { invalid(); }
      if (!cursor || cursor.v !== 1 || cursor.operation !== "changes" || cursor.scope !== this.scope(input.conversationId)
        || cursor.generation !== input.generation || cursor.after !== input.afterRevision) invalid();
      integer(cursor.ceiling, input.afterRevision); integer(cursor.revision, input.afterRevision + 1, cursor.ceiling);
      identity(cursor.kind); identity(cursor.id);
    }
    await this.authorize(input.conversationId);
    const result = await this.client.query<Row & { head_revision: string; canonical_revision: string;
      generation: string; active_turn_id: string | null; deleted: boolean }>(`
      WITH head AS (
        SELECT COALESCE(h.revision,0) AS revision,COALESCE(h.generation,0) AS generation,h.active_turn_id,
          COALESCE((SELECT e.revision FROM handrail_ai_events e WHERE e.tenant_id=$1 AND e.conversation_id=$2
            ORDER BY e.revision DESC LIMIT 1),0) AS canonical_revision,
          EXISTS(SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted'
            AND scope_id=$2 AND record_id='deleted') AS deleted
        FROM (SELECT 1) seed LEFT JOIN handrail_ai_display_heads h ON h.tenant_id=$1 AND h.conversation_id=$2
      ), candidates AS (
        SELECT r.kind,r.record_id,r.first_revision,r.revision,r.sort_at,r.payload_bytes,r.turn_id,r.deleted AS record_deleted,
          (CASE WHEN r.payload_bytes<=$5 THEN r.payload_bytes ELSE 0 END) + 256 + octet_length(r.record_id)
            + COALESCE(octet_length(r.turn_id),0) AS cost
        FROM handrail_ai_display_records r,head h WHERE r.tenant_id=$1 AND r.conversation_id=$2
          AND h.revision=h.canonical_revision AND NOT h.deleted AND (r.kind<>'message' OR r.visible)
          AND r.revision>$3 AND r.revision<=COALESCE($4::bigint,h.revision)
          AND ($6::bigint IS NULL OR (r.revision,r.kind,r.record_id)>($6,$7,$8))
        ORDER BY r.revision,r.kind,r.record_id LIMIT $9
      ), budget AS (
        SELECT *,sum(cost) OVER (ORDER BY revision,kind,record_id) AS needed,
          row_number() OVER (ORDER BY revision,kind,record_id) AS ordinal FROM candidates
      ), page AS (
        SELECT b.*,b.needed>$10 AND b.ordinal>1 AS sentinel,
          CASE WHEN (b.needed<=$10 OR b.ordinal=1) AND b.payload_bytes<=$5 AND NOT b.record_deleted THEN r.payload ELSE NULL END AS payload
        FROM budget b JOIN handrail_ai_display_records r ON r.tenant_id=$1 AND r.conversation_id=$2
          AND r.kind=b.kind AND r.record_id=b.record_id WHERE b.needed-b.cost<=$10 OR b.ordinal=1
      ) SELECT h.revision::text AS head_revision,h.generation::text,h.canonical_revision::text,h.active_turn_id,h.deleted,
        p.kind,p.record_id,p.first_revision::text,p.revision::text,p.sort_at,p.payload_bytes,p.payload,p.turn_id,p.sentinel,p.record_deleted
      FROM head h LEFT JOIN page p ON true ORDER BY p.revision,p.kind,p.record_id`,
    [this.tenantId, input.conversationId, input.afterRevision, cursor?.ceiling ?? null,
      Math.min(limits.maximumInlineRecordBytes, maximumBytes - 4096), cursor?.revision ?? null, cursor?.kind ?? null,
      cursor?.id ?? null, limit + 1, maximumBytes - 1024]);
    await this.authorize(input.conversationId);
    const head = result.rows[0]!;
    if (head.deleted) throw new ConversationDisplayHistoryError("not_found", "Conversation not found");
    const revision = Number(head.head_revision), generation = Number(head.generation), canonicalRevision = Number(head.canonical_revision);
    if (input.generation !== generation || input.afterRevision > revision || cursor && cursor.ceiling > revision) {
      throw new ConversationDisplayHistoryError("stale_cursor", "History changed. Reload the newest page.");
    }
    const throughRevision = cursor?.ceiling ?? revision;
    const page: ConversationDisplayChanges = { schemaVersion: 1, conversationId: input.conversationId,
      status: revision === canonicalRevision ? "ready" : "preparing", generation, revision, canonicalRevision,
      throughRevision, activeTurnId: head.active_turn_id, records: [], nextCursor: null };
    return packPage(page, result.rows, limit, maximumBytes, last => Buffer.from(JSON.stringify({ v: 1,
      operation: "changes", scope: this.scope(input.conversationId), generation, after: input.afterRevision,
      ceiling: throughRevision, revision: Number(last.revision), kind: last.kind, id: last.record_id } satisfies ChangeCursor)).toString("base64url"), false);
  }

  async content(input: ConversationDisplayContentInput) {
    identity(input.conversationId); identity(input.id); integer(input.generation, 0);
    if (input.revision !== undefined) integer(input.revision, 1);
    const offset = input.offset ?? 0; integer(offset, 0, 2_147_483_646);
    if (offset > 0 && input.revision === undefined) invalid();
    if (!kinds.includes(input.kind)) invalid();
    if (input.format !== undefined && !["json-text", "message-text", "record-text"].includes(input.format) ||
        input.format === "message-text" && input.kind !== "message") invalid();
    await this.authorize(input.conversationId);
    const result = await this.client.query<{ generation: string; revision: string | null; content: string | null }>(`
      SELECT h.generation::text,r.revision::text,
        CASE WHEN h.generation=$5 AND ($6::bigint IS NULL OR r.revision=$6) THEN substring(
          CASE WHEN $9='message-text' THEN COALESCE((SELECT string_agg(part->>'text',chr(10)||chr(10) ORDER BY ordinal)
            FROM jsonb_array_elements(r.payload::jsonb->'content') WITH ORDINALITY AS parts(part,ordinal)), '')
            WHEN $9='record-text' THEN jsonb_pretty(r.payload::jsonb)
            ELSE r.payload END FROM $7::integer FOR $8::integer) ELSE NULL END AS content
      FROM handrail_ai_display_heads h LEFT JOIN handrail_ai_display_records r
        ON r.tenant_id=h.tenant_id AND r.conversation_id=h.conversation_id AND r.kind=$3 AND r.record_id=$4 AND NOT r.deleted
      WHERE h.tenant_id=$1 AND h.conversation_id=$2
        AND NOT EXISTS(SELECT 1 FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='conversation_deleted'
          AND scope_id=$2 AND record_id='deleted')
        AND h.revision=COALESCE((SELECT e.revision FROM handrail_ai_events e
          WHERE e.tenant_id=$1 AND e.conversation_id=$2 ORDER BY e.revision DESC LIMIT 1),0)`,
    [this.tenantId, input.conversationId, input.kind, input.id, input.generation, input.revision ?? null,
      offset + 1, limits.contentChunkCharacters + 1, input.format ?? "json-text"]);
    await this.authorize(input.conversationId);
    const row = result.rows[0];
    if (!row || row.revision === null) throw new ConversationDisplayHistoryError("not_found", "History record not found");
    if (Number(row.generation) !== input.generation) throw new ConversationDisplayHistoryError("stale_cursor", "History was cleared");
    if (input.revision !== undefined && Number(row.revision) !== input.revision) throw new ConversationDisplayHistoryError("content_changed", "Record changed. Reload before reading more content.");
    const characters = Array.from(row.content ?? "");
    return { encoding: input.format === "message-text" || input.format === "record-text" ? "plain-text" as const : "json-text" as const, text: characters.slice(0, limits.contentChunkCharacters).join(""),
      nextOffset: characters.length > limits.contentChunkCharacters ? offset + limits.contentChunkCharacters : null, revision: Number(row.revision) };
  }
}
