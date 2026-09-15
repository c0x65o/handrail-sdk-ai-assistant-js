import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { createHandrailAssistant, openaiResponses, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { createAiApplication, type ApplicationToolAdmission } from "../src/server/application.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import { parseConversationEvent } from "../src/conversation/events.js";
import type { ApplicationToolExecutor } from "../src/tools/executor.js";
import type { ChatRequest } from "../src/protocol.js";

const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
type Context = HandrailAssistantAuthorizationContext & { resolvePrincipal: () => Promise<{ id: string; allowed: boolean } | null> };
const name = "finance__accounting_periods__request_reopen";
const call = { tool_call_id: "first-reopen", name, arguments: { period: "2026-09" } };
const location = { conversationId: "conversation", turnId: "original-turn" };
const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Reopen September" }] }], tools: [], tool_results: [],
  generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };

it.each([false, true])("HTTP authenticated recovery admits exact execution replay (allowed=%s), while history retains separate authorization", async permitted => {
  const database = new PGlite();
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: operation => operation(client) }; return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query,
    transaction: operation => database.transaction(tx => operation(adapt(tx as unknown as Pick<PGlite, "query">))) };
  const persistence = postgresFromClient(sql);
  let current = { id: "user", allowed: true };
  const context: Context = { principalId: "user", tenantId: "tenant", scopeId: "user", resolvePrincipal: async () => current,
    attribution: { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
      known_user: fact("user"), session: fact("session"), automation: fact(null) } };
  const admission = vi.fn<ApplicationToolAdmission<Context>>(async ({ applicationContext }) => {
    const principal = await applicationContext.resolvePrincipal();
    return { outcome: principal?.id === applicationContext.principalId && principal.allowed ? "allow" : "deny" };
  });
  const effect = vi.fn<ApplicationToolExecutor<Context>>(async () => {
    await database.query("INSERT INTO domain_changes (period) VALUES ('2026-09')");
    return { protectedReceipt: "September reopened" };
  });
  const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context>({ pluginId: "finance",
    version: "1.0.0", displayName: "Finance", registrations: [{ definition: { name, description: "Reopen period",
      input_schema: { type: "object", properties: { period: { type: "string" } }, required: ["period"] } },
      discover: () => true, executor: effect }] });
  const providerRequest = vi.fn(async function* () {
    if (providerRequest.mock.calls.length === 1) {
      yield { type: "response.output_item.added", output_index: 0,
        item: { type: "function_call", id: "fc", call_id: call.tool_call_id, name, arguments: "" } };
      yield { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc", arguments: JSON.stringify(call.arguments) };
    } else yield { type: "response.output_text.delta", delta: "Request handled." };
    yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
  });
  let authenticated = true;
  let historyAllowed = true;
  const diagnostics = vi.fn();
  const assistant = await createHandrailAssistant<Context>({ id: "admission", persistence, tools: [plugin],
    automaticTitles: false, toolAdmission: admission, diagnostics,
    authorize: () => { if (!authenticated) throw new Error("unauthenticated"); return context; },
    authorizeConversation: () => historyAllowed ? "allow" : "deny",
    provider: openaiResponses({ model: "fixture", request: providerRequest, supportsToolSearch: false }) });
  const post = (path: string, value: unknown) => assistant.handle(new Request(`https://local.test/api/cents/sdk/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) }));
  try {
    await persistence.persistence.migrate();
    await database.exec("CREATE TABLE domain_changes (period text)");
    const bundle = persistence.forScope<Context>(context, { createConversationId: () => "conversation" as never,
      authorizeConversation: () => "allow", authorizeApproval: () => "allow" });
    await bundle.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
    // Real receipt plus pending durable turn models the crash window after ledger commit
    // and before canonical tool-result/turn completion. Use the native runtime's exact identity.
    const executionKey = `tool-${createHash("sha256").update(JSON.stringify([
      context.scopeId, location.conversationId, location.turnId, call.tool_call_id])).digest("hex")}`;
    const app = await createAiApplication({ plugins: [plugin], installContext: context, policy: () => ({ outcome: "allow" }),
      toolAdmission: admission, toolExecutionLedger: bundle.toolLedger });
    expect(await app.executeTool({ call, executionKey, location, applicationContext: context, discovery: { context } }))
      .toMatchObject({ result: { is_error: false } });
    const before = (await database.query("SELECT * FROM handrail_ai_tool_ledger")).rows;
    const now = new Date().toISOString();
    await bundle.events.append({ conversationId: "conversation" as never, expectedRevision: null, events: [
      { type: "message.created", message_id: "message", role: "user", content: request.messages[0]!.content },
      { type: "turn.started", turn_id: location.turnId, input_message_ids: ["message"] },
    ].map((payload, index) => parseConversationEvent({ version: 1, event_id: `event-${index}`, conversation_id: "conversation",
      revision: index + 1, occurred_at: now, actor: { type: "user", id: "user" }, source: { type: "sync" },
      ...(index === 0 ? { mutation_id: "admission" } : {}), payload })) });
    await bundle.durableTurns.create({ schemaVersion: 1, ...location, mutationId: "admission", idempotencyKey: "start",
      requestFingerprint: createHash("sha256").update(JSON.stringify(request)).digest("hex"), request,
      delegateTurnId: null, status: "pending", attempt: 0, events: [], terminal: null, cancellation: null, lease: null,
      createdAt: now, updatedAt: now });
    current = { id: "user", allowed: permitted };
    admission.mockClear();
    authenticated = false;
    expect((await assistant.handle(new Request("https://local.test/api/cents/sdk/capabilities"))).status).toBe(403);
    expect(providerRequest).not.toHaveBeenCalled();
    authenticated = true;
    expect((await assistant.handle(new Request("https://local.test/api/cents/sdk/capabilities"))).status).toBe(200);
    await vi.waitFor(async () => expect((await bundle.durableTurns.load("conversation", location.turnId))?.record.status).toBe("completed"), { timeout: 10_000 });
    const recorded = (await bundle.events.read({ conversationId: "conversation" as never })).entries
      .map(entry => entry.event.payload).filter(payload => payload.type === "tool_call.result_recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ is_error: !permitted });
    expect(JSON.stringify(recorded).includes("protectedReceipt")).toBe(permitted);
    expect(admission).toHaveBeenCalledOnce();
    expect(admission.mock.calls[0]![0]).toMatchObject({ executionKey, location, toolCallId: "first-reopen" });
    expect(JSON.stringify(providerRequest.mock.calls).includes("protectedReceipt")).toBe(permitted);
    expect(effect).toHaveBeenCalledOnce();
    expect((await database.query("SELECT * FROM handrail_ai_tool_ledger")).rows).toEqual(before);
    expect((await database.query("SELECT * FROM domain_changes")).rows).toHaveLength(1);
    expect(providerRequest).toHaveBeenCalledTimes(2);
    // Same completed durable start is observation/history replay, not another execution.
    const started = await post("turns/start", { ...location, conversationTurnId: location.turnId,
      mutationId: "admission", idempotencyKey: "start", request });
    expect(started.status).toBe(200);
    await started.text();
    expect(admission).toHaveBeenCalledOnce();
    expect(providerRequest).toHaveBeenCalledTimes(2);
    current = { id: "user", allowed: false };
    const snapshot = await post("synchronization", { operation: "pull_snapshot", input: { conversationId: "conversation" } });
    expect(snapshot.status).toBe(200);
    expect((await snapshot.text()).includes("protectedReceipt")).toBe(permitted);
    expect(admission).toHaveBeenCalledOnce();
    historyAllowed = false;
    const deniedHistory = await post("synchronization", { operation: "pull_snapshot", input: { conversationId: "conversation" } });
    // Existing sync error mapping reports thrown catalog denials as unavailable.
    // Inspect the host diagnostic so this cannot pass because of an unrelated failure.
    expect(deniedHistory.status).toBe(503);
    expect(await deniedHistory.text()).not.toContain("protectedReceipt");
    expect(diagnostics.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
      domain: "gateway", operation: "synchronization.pull_snapshot", phase: "failed",
      cause: expect.objectContaining({ code: "forbidden" }),
    }));
    expect(admission).toHaveBeenCalledOnce();
  } finally { await assistant.stopBackgroundWorkers(); await database.close(); }
}, 30_000);
