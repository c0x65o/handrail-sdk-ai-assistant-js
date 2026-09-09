import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { PostgresAiPersistence, PostgresToolIncidentStore, type PostgresSqlClient } from "../src/postgres/index.js";
import type { ToolIncidentOccurrence } from "../src/server/tool-incidents.js";

it("durably deduplicates occurrences and reports within the exact tenant and project scope", async () => {
  const database = new PGlite();
  const adapt = (queryable: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      query: async <T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        const result = await queryable.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }, transaction: (operation) => operation(client),
    };
    return client;
  };
  const client: PostgresSqlClient = { query: adapt(database).query,
    transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
  const makeStore = (tenantId = "tenant-a", scopeId = "project-a") => new PostgresToolIncidentStore({ client, tenantId, scopeId });
  const event: ToolIncidentOccurrence = { occurrenceId: "call-1", toolName: "lookup", sdkVersion: "0.2.22", appVersion: "1.0",
    environment: "production", recovery: { type: "handrail.tool_recovery.v1", status: "recovered", attempts: 2,
      failedAttempts: 1, category: "not_found", code: "invoice_not_found", reason: "completed" } };
  try {
    await new PostgresAiPersistence(client).migrate();
    const first = await makeStore().record(event);
    expect(await makeStore().record(event)).toEqual(first);
    await Promise.all([makeStore().record({ ...event, occurrenceId: "call-2" }), makeStore().record({ ...event, occurrenceId: "call-3" })]);
    const [pending] = await makeStore().pending(10, new Date().toISOString());
    expect(pending).toMatchObject({ occurrences: 3, recoveredOccurrences: 3, report: { kind: "bug" } });
    await makeStore().update(first.incidentId, (row) => ({ ...row, deliveryAttempts: 1 }));
    const next = await makeStore().record({ ...event, occurrenceId: "call-4" });
    expect(next).toMatchObject({ occurrences: 4, deliveryAttempts: 1 });
    expect(next.report).toEqual(pending!.report);
    expect(await makeStore("tenant-b").pending(10, new Date().toISOString())).toEqual([]);
    expect(await makeStore("tenant-a", "project-b").pending(10, new Date().toISOString())).toEqual([]);
    const other = await makeStore("tenant-b").record(event);
    expect(other.incidentId).not.toBe(first.incidentId);
    expect(other.occurrences).toBe(1);
    await expect(makeStore().record({ ...event, toolName: "other" })).rejects.toThrow("identity conflict");
    expect((await makeStore().record(event)).occurrences).toBe(4);
    expect((await database.query("SELECT count(*)::int AS count FROM handrail_ai_documents WHERE kind='tool_incident_event'")).rows[0])
      .toEqual({ count: 5 });
  } finally { await database.close(); }
}, 30_000);
