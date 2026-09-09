import { createHash } from "node:crypto";
import type { PostgresSqlClient } from "./index.js";
import { accumulateToolIncident, normalizeToolIncidentOccurrence, toolIncidentId,
  type ToolIncidentOccurrence, type ToolIncidentRecord, type ToolIncidentStore } from "../server/tool-incidents.js";

/** Uses the SDK's existing documents table. Tenant and project scope are constructor-owned. */
export class PostgresToolIncidentStore implements ToolIncidentStore {
  constructor(private readonly options: { client: PostgresSqlClient; tenantId: string; scopeId: string }) {
    for (const key of [options.tenantId, options.scopeId]) {
      if (typeof key !== "string" || key.length < 1 || key.length > 255) throw new TypeError("Invalid incident storage scope");
    }
  }
  private async lock(client: PostgresSqlClient, key: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(["ai-tool-incidents", this.options.tenantId, this.options.scopeId, key]),
    ]);
  }
  private async read(client: PostgresSqlClient, incidentId: string): Promise<ToolIncidentRecord | null> {
    const result = await client.query<{ payload: ToolIncidentRecord }>(
      "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id=$2 AND kind='tool_incident' AND record_id=$3",
      [this.options.tenantId, this.options.scopeId, incidentId]);
    return result.rows[0]?.payload ?? null;
  }
  private async write(client: PostgresSqlClient, value: ToolIncidentRecord) {
    await client.query("INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,'tool_incident',$2,$3,1,$4::jsonb) ON CONFLICT (tenant_id,kind,scope_id,record_id) DO UPDATE SET version=handrail_ai_documents.version+1,payload=EXCLUDED.payload,updated_at=now()",
      [this.options.tenantId, this.options.scopeId, value.incidentId, JSON.stringify(value)]);
  }
  async record(input: ToolIncidentOccurrence): Promise<ToolIncidentRecord> {
    const occurrence = normalizeToolIncidentOccurrence(input);
    const scope = JSON.stringify([this.options.tenantId, this.options.scopeId]);
    const incidentId = toolIncidentId(occurrence, scope);
    const eventId = createHash("sha256").update(occurrence.occurrenceId).digest("hex");
    return this.options.client.transaction(async (client) => {
      await this.lock(client, `event:${eventId}`);
      await this.lock(client, incidentId);
      const seen = await client.query<{ payload: { incidentId: string } }>(
        "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id=$2 AND kind='tool_incident_event' AND record_id=$3",
        [this.options.tenantId, this.options.scopeId, eventId]);
      const current = await this.read(client, incidentId);
      if (seen.rows[0]) {
        if (seen.rows[0].payload.incidentId !== incidentId || !current) throw new Error("Incident occurrence identity conflict");
        return current;
      }
      const next = accumulateToolIncident(current, occurrence, scope);
      await this.write(client, next);
      await client.query("INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,'tool_incident_event',$2,$3,1,$4::jsonb)",
        [this.options.tenantId, this.options.scopeId, eventId, JSON.stringify({ incidentId })]);
      return next;
    });
  }
  async pending(limit: number, now: string): Promise<readonly ToolIncidentRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isFinite(Date.parse(now))) throw new TypeError("Invalid incident page");
    const result = await this.options.client.query<{ payload: ToolIncidentRecord }>(
      "SELECT payload FROM handrail_ai_documents WHERE tenant_id=$1 AND scope_id=$2 AND kind='tool_incident' AND payload->'report'<>'null'::jsonb AND (payload->>'nextAttemptAt')::timestamptz<=$3::timestamptz ORDER BY updated_at,record_id LIMIT $4",
      [this.options.tenantId, this.options.scopeId, now, limit]);
    return result.rows.map((row) => row.payload);
  }
  async update(incidentId: string, update: (current: ToolIncidentRecord) => ToolIncidentRecord): Promise<void> {
    await this.options.client.transaction(async (client) => {
      await this.lock(client, incidentId);
      const current = await this.read(client, incidentId);
      if (!current) return;
      const next = update(current);
      if (next.incidentId !== incidentId) throw new Error("Incident identity changed");
      await this.write(client, next);
    });
  }
}
