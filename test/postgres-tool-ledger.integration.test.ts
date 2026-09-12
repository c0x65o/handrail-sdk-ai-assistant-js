import { PGlite } from "@electric-sql/pglite";
import { ToolExecutionIdentityConflictError } from "../src/tools/executor.js";
import { expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresToolExecutionLedger, PostgresToolExecutionUncertainError, type PostgresSqlClient } from "../src/postgres/index.js";

it("retains dispatch claims across real SQL rollback while keeping external writes and legacy results", async () => {
  const database = new PGlite();
  let failResultInsert = false;
  const adapt = (queryable: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      query: async <T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (failResultInsert && sql.startsWith("INSERT INTO handrail_ai_tool_ledger")) {
          throw new Error("simulated completion write failure");
        }
        const result = await queryable.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      transaction: (operation) => operation(client),
    };
    return client;
  };
  const client: PostgresSqlClient = { query: adapt(database).query,
    transaction: (operation) => database.transaction((transaction) =>
      operation(adapt(transaction as unknown as Pick<PGlite, "query">))) };
  try {
    const persistence = new PostgresAiPersistence(client);
    await persistence.migrate();
    await persistence.migrate();
    await database.exec("CREATE TABLE external_changes (name text PRIMARY KEY)");
    const mutate = vi.fn(async (name: string) => {
      // A separate commit, outside the SDK ledger's admission transaction.
      await database.query("INSERT INTO external_changes (name) VALUES ($1)", [name]);
      return { applied: name };
    });
    await expect(persistence.getOrExecuteTool("tenant", "successful", () => mutate("successful"), "private original request"))
      .resolves.toEqual({ applied: "successful" });
    await expect(new PostgresAiPersistence(client).getOrExecuteTool("tenant", "successful", () => mutate("successful"), "private original request"))
      .resolves.toEqual({ applied: "successful" });
    expect(mutate).toHaveBeenCalledTimes(1);
    await expect(new PostgresAiPersistence(client).getOrExecuteTool("tenant", "successful", () => mutate("different"), "changed request"))
      .rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    await expect(persistence.getOrExecuteTool("tenant", "successful", () => mutate("unbound")))
      .rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    const bindings = await database.query("SELECT payload FROM handrail_ai_documents WHERE kind='tool_execution'");
    expect(JSON.stringify(bindings.rows)).not.toContain("private original request");
    expect(bindings.rows[0]).toMatchObject({ payload: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });

    failResultInsert = true;
    await expect(persistence.getOrExecuteTool("tenant", "uncertain", () => mutate("uncertain")))
      .rejects.toThrow("completion write failure");
    failResultInsert = false;
    await expect(new PostgresAiPersistence(client).getOrExecuteTool("tenant", "uncertain", () => mutate("uncertain")))
      .rejects.toBeInstanceOf(PostgresToolExecutionUncertainError);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect((await database.query("SELECT name FROM external_changes ORDER BY name")).rows)
      .toEqual([{ name: "successful" }, { name: "uncertain" }]);
    expect((await database.query("SELECT record_id FROM handrail_ai_documents WHERE kind='tool_execution' ORDER BY record_id")).rows)
      .toEqual([{ record_id: "successful" }, { record_id: "uncertain" }]);
    expect((await database.query("SELECT tool_call_id FROM handrail_ai_tool_ledger")).rows)
      .toEqual([{ tool_call_id: "successful" }]);

    await database.query("INSERT INTO handrail_ai_tool_ledger (tenant_id,tool_call_id,status,result) VALUES ($1,$2,'completed',$3::jsonb)",
      ["tenant", "legacy", JSON.stringify({ old: true })]);
    await expect(persistence.getOrExecuteTool("tenant", "legacy", () => mutate("legacy")))
      .resolves.toEqual({ old: true });
    expect(mutate).toHaveBeenCalledTimes(2);
    await expect(persistence.getOrExecuteTool("tenant", "legacy", () => mutate("legacy"), "new bound request"))
      .rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    const scopedExecute = vi.fn(async () => ({ tool_call_id: "local", name: "read", content: [{ type: "text" as const, text: "result" }], is_error: false }));
    await new PostgresToolExecutionLedger(persistence, "tenant", "scope-a").getOrCreate("local", scopedExecute, "bound");
    await new PostgresToolExecutionLedger(persistence, "tenant", "scope-b").getOrCreate("local", scopedExecute, "bound");
    await new PostgresToolExecutionLedger(persistence, "tenant", "scope-a").getOrCreate("local", scopedExecute, "bound");
    expect(scopedExecute).toHaveBeenCalledTimes(2);
    const recovered = new PostgresToolExecutionLedger(new PostgresAiPersistence(client), "tenant", "scope-a");
    expect(await recovered.lookup("local", "bound")).toEqual(await scopedExecute.mock.results[0]!.value);
    await expect(recovered.lookup("local", "changed")).rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    await expect(recovered.lookup("local")).rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    expect(await recovered.lookup("missing", "bound")).toBeUndefined();
    expect(await new PostgresToolExecutionLedger(persistence, "other-tenant", "scope-a").lookup("local", "bound")).toBeUndefined();
    expect(await new PostgresToolExecutionLedger(persistence, "tenant", "scope-c").lookup("local", "bound")).toBeUndefined();
    const unscoped = new PostgresToolExecutionLedger(persistence, "tenant");
    await expect(unscoped.lookup("uncertain")).rejects.toBeInstanceOf(PostgresToolExecutionUncertainError);
    expect(await unscoped.lookup("legacy")).toEqual({ old: true });
    await expect(unscoped.lookup("legacy", "new bound request")).rejects.toBeInstanceOf(ToolExecutionIdentityConflictError);
    expect((await database.query("SELECT record_id FROM handrail_ai_documents WHERE kind='tool_execution' AND record_id='missing'")).rows).toEqual([]);
    await database.query("INSERT INTO handrail_ai_tool_ledger (tenant_id,tool_call_id,status,result) VALUES ($1,$2,'completed',$3::jsonb)",
      ["other-tenant", "successful", JSON.stringify({ private: true })]);
    expect(await persistence.getToolResults("tenant", ["successful", "uncertain", "missing", "legacy", "successful"]))
      .toEqual([{ toolCallId: "legacy", result: { old: true } }, { toolCallId: "successful", result: { applied: "successful" } }]);
    expect(await persistence.getToolResults("tenant", [])).toEqual([]);
    await expect(persistence.getToolResults("tenant", Array.from({ length: 101 }, (_, index) => `tool-${index}`))).rejects.toBeInstanceOf(TypeError);
    expect(mutate).toHaveBeenCalledTimes(2);
  } finally { await database.close(); }
}, 30_000);
