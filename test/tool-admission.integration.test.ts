import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { createAiApplication } from "../src/server/application.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import type { ApplicationToolExecutor, ApplicationToolPolicyInput } from "../src/tools/executor.js";
import { PostgresAiPersistence, PostgresToolExecutionLedger, type PostgresSqlClient } from "../src/postgres/index.js";

type Principal = { id: string; permissions: string[]; namespace: boolean };
type Context = { principalId: string; principal: Principal; resolvePrincipal: () => Promise<Principal | null> };
const name = "finance__accounting_periods__request_reopen";
const permissions = ["finance.period-close.prepare", "finance.manage"];
const allowed = (): Principal => ({ id: "user", permissions: [...permissions], namespace: true });
const authorize = async ({ applicationContext, arguments: args }: ApplicationToolPolicyInput<Context>) => {
  const principal = await applicationContext.resolvePrincipal();
  return { outcome: principal?.id === applicationContext.principalId && principal.namespace &&
    principal.permissions.includes(String(args.permission)) ? "allow" as const : "deny" as const };
};

it.each(permissions)("rechecks %s exact durable receipts with stale/refreshed discovery and current principals after recreation", async permission => {
  const database = new PGlite();
  let failCompletion = false;
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (failCompletion && sql.startsWith("INSERT INTO handrail_ai_tool_ledger")) throw new Error("completion unavailable");
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: operation => operation(client) }; return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
  let current: Principal | null = allowed();
  const context: Context = { principalId: "user", principal: allowed(), resolvePrincipal: async () => current };
  const effect = vi.fn<ApplicationToolExecutor<Context>>(async (args, input) => {
    if ((await authorize({ ...input, arguments: args })).outcome !== "allow") throw new Error("denied in domain executor");
    await database.query("INSERT INTO domain_changes (permission) VALUES ($1)", [args.permission]);
    return { protectedReceipt: "reopened", permission: args.permission! };
  });
  const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context>({
    pluginId: "finance", version: "1.0.0", displayName: "Finance",
    registrations: [{ definition: { name, description: "Request reopen", input_schema: { type: "object",
      properties: { permission: { type: "string" } }, required: ["permission"], additionalProperties: false } },
      discover: ctx => ctx.principal.namespace, executor: effect }],
  });
  const admission = vi.fn(authorize);
  const create = (tenant = "tenant", scope = "user") => createAiApplication({ plugins: [plugin], installContext: context,
    policy: () => ({ outcome: "allow" }), toolAdmission: admission,
    toolExecutionLedger: new PostgresToolExecutionLedger(new PostgresAiPersistence(sql), tenant, scope) });
  const receipts = async () => (await database.query("SELECT * FROM handrail_ai_tool_ledger ORDER BY tenant_id, tool_call_id")).rows;
  try {
    await new PostgresAiPersistence(sql).migrate();
    await database.exec("CREATE TABLE domain_changes (permission text)");
    {
      current = allowed();
      const call = { tool_call_id: `first-reopen-${permission}`, name, arguments: { permission } };
      const input = { call, executionKey: call.tool_call_id, applicationContext: context, discovery: { context } };
      const original = await (await create()).executeTool(input);
      expect(original).toMatchObject({ status: "completed", result: { is_error: false } });
      const before = await receipts();
      const dispatches = effect.mock.calls.length;
      const app = await create();
      for (const principal of [ { ...allowed(), permissions: [] }, null, { ...allowed(), id: "other-user" },
        { ...allowed(), namespace: false } ]) {
        current = principal;
        for (const refreshed of [false, true]) {
          const result = await app.executeTool({ ...input, discovery: { context: refreshed
            ? { ...context, principal: principal ?? { ...allowed(), namespace: false } } : context } });
          expect(result, `${permission}: ${JSON.stringify(principal)}, refreshed=${refreshed}`)
            .toMatchObject({ status: "completed", result: { is_error: true } });
          expect(JSON.stringify(result)).not.toContain("protectedReceipt");
          expect(await receipts()).toEqual(before);
          expect(effect).toHaveBeenCalledTimes(dispatches);
        }
      }
      current = allowed();
      expect(await app.executeTool(input)).toEqual(original);
      expect(effect).toHaveBeenCalledTimes(dispatches);
      expect(await receipts()).toEqual(before);
      expect(await app.executeTool({ ...input, call: { ...call, arguments: { permission: "different" } } }))
        .toMatchObject({ result: { is_error: true } });
      // An authorized conflicting fingerprint still cannot reuse the identity.
      expect(await app.executeTool({ ...input, call: { ...call, arguments: { permission: permissions.find(p => p !== permission)! } } }))
        .toMatchObject({ result: { is_error: true, content: [{ text: "Tool call identity conflicts with its original request." }] } });
      expect(await receipts()).toEqual(before);
      for (const [tenant, scope] of [["other-tenant", "user"], ["tenant", "other-scope"]]) {
        expect(await (await create(tenant, scope)).executeTool(input)).toMatchObject({ result: { is_error: false } });
      }
      expect(effect).toHaveBeenCalledTimes(dispatches + 2);
    }
    expect((await database.query("SELECT * FROM domain_changes")).rows).toHaveLength(3);
    expect(await receipts()).toHaveLength(3);
    const uncertainCall = { tool_call_id: "uncertain", name, arguments: { permission } };
    const uncertainInput = { call: uncertainCall, executionKey: "uncertain", applicationContext: context, discovery: { context } };
    failCompletion = true;
    expect(await (await create()).executeTool(uncertainInput)).toMatchObject({ result: { is_error: true } });
    failCompletion = false;
    const claims = async () => (await database.query("SELECT * FROM handrail_ai_documents WHERE kind='tool_execution' ORDER BY record_id")).rows;
    const claimsBefore = await claims();
    const receiptsBefore = await receipts();
    current = null;
    const app = await create();
    expect(await app.executeTool(uncertainInput)).toMatchObject({ result: { is_error: true } });
    // A new denied request also cannot claim a ledger identity.
    expect(await app.executeTool({ ...uncertainInput, executionKey: "new-denied", call: { ...uncertainCall, tool_call_id: "new-denied" } }))
      .toMatchObject({ result: { is_error: true } });
    current = allowed();
    expect(await app.executeTool(uncertainInput)).toMatchObject({ result: { is_error: true } });
    expect(await claims()).toEqual(claimsBefore);
    expect(await receipts()).toEqual(receiptsBefore);
    expect(effect).toHaveBeenCalledTimes(4);
    expect((await database.query("SELECT * FROM domain_changes")).rows).toHaveLength(4);
    expect(admission).toHaveBeenCalled();
  } finally { await database.close(); }
}, 30_000);
