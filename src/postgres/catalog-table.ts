import type { PostgresSqlClient } from "./index.js";
import { createHash } from "node:crypto";

const defaultColumns = Object.freeze({ tenantId: "tenant_id", scopeId: "scope_id", conversationId: "conversation_id",
  lifecycle: "lifecycle", title: "title", createdAt: "created_at", updatedAt: "updated_at", archivedAt: "archived_at",
  version: "version", metadata: "metadata" });

/** Trusted server configuration for retaining an application's ownership table.
 * Every mapped column must preserve the SDK's catalog value/constraint contract.
 * No SQL expressions, request-derived identifiers or transcript import are supported. */
export interface PostgresConversationCatalogTableOptions {
  readonly name: string;
  readonly schema?: string;
  readonly columns?: Partial<Record<keyof typeof defaultColumns, string>>;
  /** Existing soft-deleted ownership rows remain unavailable and cannot be reused. */
  readonly deletedAtColumn?: string;
  /** UUID-backed ownership columns require canonical lower-case UUID identities.
   * This prevents SQL aliases from splitting the SDK's case-sensitive history keys. */
  readonly identityFormat?: "opaque" | "uuid";
  /** Include the latest tenant/conversation SDK event's database write time in
   * updatedAt and ordering. Client-supplied event timestamps are never trusted. */
  readonly includeEventActivity?: boolean;
}

export interface PostgresCatalogRow extends Record<string, unknown> {
  readonly conversation_id: string;
  readonly lifecycle: "active" | "archived";
  readonly title: string | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
  readonly archived_at: string | Date | null;
  readonly version: string;
  readonly metadata: Record<string, unknown>;
}

function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError("A catalog table or column identifier is invalid.");
  }
  return `"${value}"`;
}

/** SQL layout only. Authorization, lifecycle, idempotency and deletion stay in the catalog. */
export class PostgresConversationCatalogTable {
  readonly name: string;
  readonly columns: Readonly<Record<keyof typeof defaultColumns, string>>;
  readonly visible: string;
  readonly projection: string;
  readonly identity: string;
  readonly custom: boolean;
  readonly identityFormat: "opaque" | "uuid";
  readonly includeEventActivity: boolean;
  readonly updatedAtExpression: string;
  constructor(options?: PostgresConversationCatalogTableOptions) {
    const names = { ...defaultColumns, ...options?.columns };
    if (new Set(Object.values(names)).size !== Object.keys(defaultColumns).length ||
      (options?.deletedAtColumn && Object.values(names).includes(options.deletedAtColumn))) {
      throw new TypeError("Catalog storage columns must be distinct.");
    }
    this.name = options ? (options.schema ? identifier(options.schema) + "." : "") + identifier(options.name) : "handrail_ai_conversations";
    this.custom = options !== undefined;
    this.identityFormat = options?.identityFormat ?? "opaque";
    this.includeEventActivity = options?.includeEventActivity ?? false;
    if (typeof this.includeEventActivity !== "boolean") throw new TypeError("The catalog event activity option is invalid.");
    if (this.identityFormat !== "opaque" && this.identityFormat !== "uuid") throw new TypeError("The catalog identity format is invalid.");
    this.identity = createHash("sha256").update(JSON.stringify({ name: options?.name ?? "handrail_ai_conversations",
      schema: options?.schema ?? null, columns: names, deletedAtColumn: options?.deletedAtColumn ?? null,
      identityFormat: this.identityFormat })).digest("hex");
    this.columns = Object.freeze(Object.fromEntries(Object.entries(names).map(([key, name]) =>
      [key, options ? identifier(name) : name])) as Record<keyof typeof defaultColumns, string>);
    this.visible = options?.deletedAtColumn ? ` AND ${identifier(options.deletedAtColumn)} IS NULL` : "";
    const c = this.columns;
    this.updatedAtExpression = this.includeEventActivity
      ? `GREATEST(catalog_row.${c.updatedAt},(SELECT max(event.created_at) FROM handrail_ai_events event WHERE event.tenant_id=catalog_row.${c.tenantId}::text AND event.conversation_id=catalog_row.${c.conversationId}::text))`
      : c.updatedAt;
    this.projection = options
      ? `${c.conversationId} AS conversation_id,${c.lifecycle} AS lifecycle,${c.title} AS title,${c.createdAt} AS created_at,${this.updatedAtExpression} AS updated_at,${c.archivedAt} AS archived_at,${c.version}::text AS version,${c.metadata} AS metadata`
      : "conversation_id,lifecycle,title,created_at,updated_at,archived_at,version::text AS version,metadata";
  }

  validateIdentity(...values: string[]) {
    if (this.identityFormat === "uuid" && values.some(value => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) {
      throw new PostgresCatalogIdentityError();
    }
  }

  list(client: PostgresSqlClient, input: { tenantId: string; scopeId: string; pageSize: number;
    lifecycle: "active" | "archived" | "all"; order: { field: "created_at" | "updated_at"; direction: "asc" | "desc" };
    cursor: { primary: string; conversationId: string } | null }) {
    const c = this.columns;
    this.validateIdentity(input.tenantId, input.scopeId, ...(input.cursor ? [input.cursor.conversationId] : []));
    // The wire cursor contains millisecond timestamps. Compare and sort at that
    // same precision so PostgreSQL microseconds cannot repeat or skip rows.
    const primary = `date_trunc('milliseconds',${input.order.field === "updated_at" ? this.updatedAtExpression : c.createdAt})`;
    const comparison = input.order.direction === "asc" ? ">" : "<";
    const order = input.order.direction === "asc" ? "ASC" : "DESC";
    const values: unknown[] = [input.tenantId, input.scopeId, input.pageSize + 1, this.identity];
    let predicate = this.visible + ` AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents AS claim
      WHERE claim.tenant_id=catalog_row.${c.tenantId}::text AND claim.kind='catalog_identity' AND claim.record_id='owner'
      AND claim.scope_id=catalog_row.${c.conversationId}::text AND
      (claim.payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR
       claim.payload->>'ownerScopeId' IS DISTINCT FROM catalog_row.${c.scopeId}::text OR
       claim.payload->>'storageIdentity' IS DISTINCT FROM $4::text))`;
    if (input.lifecycle !== "all") { values.push(input.lifecycle); predicate += ` AND ${c.lifecycle}=$${values.length}`; }
    if (input.cursor) {
      const primaryIndex = values.length + 1, idIndex = values.length + 2;
      values.push(input.cursor.primary, input.cursor.conversationId);
      predicate += ` AND (${primary}${comparison}$${primaryIndex} OR (${primary}=$${primaryIndex} AND ${c.conversationId}>$${idIndex}))`;
    }
    return client.query<PostgresCatalogRow>(`SELECT ${this.projection} FROM ${this.name} AS catalog_row WHERE ${c.tenantId}=$1 AND ${c.scopeId}=$2${predicate} ORDER BY ${primary} ${order},${c.conversationId} ASC LIMIT $3`, values);
  }

  lookup(client: PostgresSqlClient, tenantId: string, scopeId: string, conversationId: string, lock: boolean) {
    this.validateIdentity(tenantId, scopeId, conversationId);
    const c = this.columns;
    return client.query<PostgresCatalogRow>(`SELECT ${this.projection} FROM ${this.name}${this.includeEventActivity ? " AS catalog_row" : ""} WHERE ${c.tenantId}=$1 AND ${c.scopeId}=$2 AND ${c.conversationId}=$3${this.visible}${lock ? " FOR UPDATE" : ""}`,
      [tenantId, scopeId, conversationId]);
  }
  existingIdentity(client: PostgresSqlClient, tenantId: string, conversationId: string) {
    this.validateIdentity(tenantId, conversationId);
    const c = this.columns;
    return client.query(`SELECT ${c.conversationId} FROM ${this.name} WHERE ${c.tenantId}=$1 AND ${c.conversationId}=$2 LIMIT 1`, [tenantId, conversationId]);
  }
  ambiguousIdentity(client: PostgresSqlClient, tenantId: string, conversationId: string, scopeId: string) {
    const c = this.columns;
    return client.query(`SELECT ${c.scopeId} FROM ${this.name} WHERE ${c.tenantId}=$1 AND ${c.conversationId}=$2 AND ${c.scopeId}<>$3 LIMIT 1`, [tenantId, conversationId, scopeId]);
  }
  insert(client: PostgresSqlClient, input: { tenantId: string; scopeId: string; conversationId: string;
    title: string | null; now: string; metadata: unknown }) {
    const c = this.columns;
    return client.query(`INSERT INTO ${this.name} (${c.tenantId},${c.scopeId},${c.conversationId},${c.lifecycle},${c.title},${c.createdAt},${c.updatedAt},${c.archivedAt},${c.version},${c.metadata}) VALUES ($1,$2,$3,'active',$4,$5,$5,NULL,1,$6::text::jsonb)`,
      [input.tenantId, input.scopeId, input.conversationId, input.title, input.now, JSON.stringify(input.metadata)]);
  }
  update(client: PostgresSqlClient, input: { tenantId: string; scopeId: string; conversationId: string; expectedVersion: number;
    lifecycle: string; title: string | null; updatedAt: string; archivedAt: string | null; version: number; metadata: unknown }) {
    const c = this.columns;
    return client.query(`UPDATE ${this.name} SET ${c.lifecycle}=$5,${c.title}=$6,${c.updatedAt}=$7,${c.archivedAt}=$8,${c.version}=$9,${c.metadata}=$10::text::jsonb WHERE ${c.tenantId}=$1 AND ${c.scopeId}=$2 AND ${c.conversationId}=$3 AND ${c.version}=$4${this.visible}`,
      [input.tenantId, input.scopeId, input.conversationId, input.expectedVersion, input.lifecycle, input.title, input.updatedAt, input.archivedAt, input.version, JSON.stringify(input.metadata)]);
  }
  delete(client: PostgresSqlClient, tenantId: string, scopeId: string, conversationId: string, expectedVersion: number) {
    const c = this.columns;
    return client.query(`DELETE FROM ${this.name} WHERE ${c.tenantId}=$1 AND ${c.scopeId}=$2 AND ${c.conversationId}=$3 AND ${c.version}=$4${this.visible}`,
      [tenantId, scopeId, conversationId, expectedVersion]);
  }
}

export class PostgresCatalogIdentityError extends Error {
  constructor() { super("A catalog identity is not in its canonical storage format."); this.name = "PostgresCatalogIdentityError"; }
}
