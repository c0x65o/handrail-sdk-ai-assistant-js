import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { AI_RUNTIME_PROTOCOL_VERSION, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { openaiResponses } from "../src/server/openai-responses.js";
import { retainProviderInvocation, type ProviderInvocationOperationStore } from "../src/server/provider-invocations.js";
import type { ProviderAdapterInvocation, ProviderAdapterResult, ProviderAdapterStream } from "../src/providers/index.js";
import type { NormalizedUsageReceipt } from "../src/usage.js";
import type { HandrailAssistantProvider, HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";

const fact = <T extends string | null>(id: T) => ({ id, source: "server_derived" as const, trust: "authoritative" as const });
const attribution: AuthoritativeAttribution = { organization: fact("org"), project: fact("project"), service_environment: fact("test"),
  known_user: fact("user"), session: fact("session"), automation: fact(null) };
const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "turn", trace_id: "mutation" };
const started: StreamEvent = { ...envelope, type: "response.started", sequence: 0, attribution };
const completed: StreamEvent = { ...envelope, type: "response.completed", sequence: 1, outcome: "stop" };
const result: ProviderAdapterResult = { status: "completed", outcome: "stop", usage: { input_tokens: 2, cached_input_tokens: 0,
  output_tokens: 1, total_tokens: 3, reasoning_tokens: 0, provider_cost: { known: false } } };
const invocation: ProviderAdapterInvocation = { messages: [], tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 },
  context: { request_id: "turn", trace_id: "mutation", attribution, correlation_hints: {} }, signal: new AbortController().signal };
async function collect(stream: ProviderAdapterStream) {
  const events: StreamEvent[] = []; let step = await stream.next();
  while (!step.done) { events.push(step.value); step = await stream.next(); }
  return { events, result: step.value };
}

it("withholds the terminal outcome until the store commits and replays without another invocation", async () => {
  let saved: unknown;
  let release!: () => void;
  const committed = new Promise<void>(resolve => { release = resolve; });
  const store: ProviderInvocationOperationStore = { async run(input) {
    if (saved) return input.parseResult(saved);
    const result = input.parseResult(await input.execute());
    await committed; saved = JSON.parse(JSON.stringify(result)); return result;
  } };
  const invoke = vi.fn(async function* (): ProviderAdapterStream { yield started; yield completed; return result; });
  const run = () => retainProviderInvocation({ store, operationId: "op", requestFingerprint: "fp", invocation, invoke });
  const stream = run();
  expect(await stream.next()).toEqual({ done: false, value: started });
  let terminalReturned = false;
  const terminal = stream.next().then(value => { terminalReturned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(terminalReturned).toBe(false);
  release(); expect(await terminal).toEqual({ done: false, value: completed });
  expect(await stream.next()).toEqual({ done: true, value: result });
  expect(await collect(run())).toEqual({ events: [started, completed], result });
  expect(invoke).toHaveBeenCalledOnce();
});

it("emits only a safe failure when completion cannot be saved", async () => {
  const store: ProviderInvocationOperationStore = { async run(input) {
    await input.execute(); throw new Error("private database detail");
  } };
  const value = await collect(retainProviderInvocation({ store, operationId: "op", requestFingerprint: "fp", invocation,
    invoke: async function* () { yield started; yield completed; return result; } }));
  expect(value.events.map(event => event.type)).toEqual(["response.started", "response.error"]);
  expect(value.result).toMatchObject({ status: "failed", error: { code: "policy_denied", retryable: false } });
  expect(JSON.stringify(value)).not.toContain("private database");
});

it.each(["request", "sequence", "terminal", "error_union", "tokens"])("rejects corrupt saved %s evidence before replay", async kind => {
  const saved = structuredClone({ version: 1, events: [started, completed], result }) as unknown as { version: number; events: Record<string, unknown>[]; result: Record<string, unknown> };
  if (kind === "request") saved.events[0]!.request_id = "foreign";
  if (kind === "sequence") saved.events[1]!.sequence = 9;
  if (kind === "terminal") saved.events.push({ ...completed });
  if (kind === "tokens") saved.result.usage = { ...result.usage, total_tokens: -1 };
  if (kind === "error_union") {
    saved.events[1] = { ...envelope, type: "response.error", sequence: 1,
      error: { category: "internal", code: "internal_error", retryable: false, message: "bad" } };
    saved.result = { status: "failed", usage: null, error: { kind: "client", code: "internal_error", retryable: false, message: "bad" } };
  }
  const invoke = vi.fn(async function* (): ProviderAdapterStream { yield started; throw new Error("must not dispatch"); });
  const store: ProviderInvocationOperationStore = { run: async input => input.parseResult(saved) };
  const value = await collect(retainProviderInvocation({ store, operationId: "op", requestFingerprint: "fp", invocation, invoke }));
  expect(value.events.map(event => event.type)).toEqual(["response.started", "response.error"]);
  expect(value.result.status).toBe("failed"); expect(invoke).not.toHaveBeenCalled();
});

it("provides physical retries, durable tool identities and replay in the default server provider", async () => {
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
  try {
    await persistence.persistence.migrate();
    const context: HandrailAssistantAuthorizationContext = { principalId: "user", tenantId: "tenant", scopeId: "owner", attribution };
    const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>(context, { createConversationId: () => "conversation" as never,
      authorizeConversation: () => "allow", authorizeApproval: () => "allow" });
    const receipts: NormalizedUsageReceipt[] = [];
    let physical = 0;
    const request = vi.fn(async () => {
      if (++physical === 1) throw Object.assign(new Error("private retry"), { status: 503 });
      return (async function* () {
        if (physical === 2) {
          yield { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc", call_id: "call", name: "lookup", arguments: "" } };
          yield { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc", arguments: "{}" };
        }
        yield { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      })();
    });
    const tools = { definitions: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" as const, properties: {} } }],
      execute: vi.fn(async (call: { tool_call_id: string; name: string }) => ({ status: "completed" as const, result: {
        tool_call_id: call.tool_call_id, name: call.name, content: [{ type: "text" as const, text: "saved" }], is_error: false,
      } })), awaitApproval: vi.fn() };
    const provider = openaiResponses({ model: "fixture", request, supportsToolSearch: false, retry: { initialDelayMs: 1 } });
    const input = { context, persistence: { ...bundle, usageReceiptSink: {
      capture: async (receipt: NormalizedUsageReceipt) => { receipts.push(receipt); }, flush: vi.fn(),
    } }, instructions: [], tools, limits: { maxIterations: 3, maxTotalToolCalls: 3, maxElapsedMs: 10_000, parallelism: 1 },
      toolActivity: { waitForApproval: vi.fn(), observe: vi.fn() },
    } as unknown as Parameters<HandrailAssistantProvider<HandrailAssistantAuthorizationContext>["createTransport"]>[0];
    const chat: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Read" }] }], tools: [], tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
    const run = async (attempt: number, changed = chat, turnId = "turn") => {
      const transport = await provider.createTransport(input);
      const start = await transport.startTurn({ conversationId: "conversation", conversationTurnId: turnId as never,
        mutationId: "mutation" as never, idempotencyKey: "request", request: changed },
      { durableExecution: { conversationId: "conversation", turnId, attempt } });
      if (!start.ok) throw new Error(start.error.message);
      const events = []; for await (const event of start.value.observation.events) events.push(event);
      return { events, result: await start.value.observation.result };
    };
    expect((await run(2, chat, "legacy-without-receipt")).result.status).toBe("failed");
    expect(request).not.toHaveBeenCalled(); expect(tools.execute).not.toHaveBeenCalled();
    expect((await run(1)).result.status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(3);
    expect(receipts.map(receipt => receipt.terminal_status)).toEqual(["failed", "completed", "completed"]);
    expect(new Set(receipts.map(receipt => receipt.usage_receipt_id)).size).toBe(3);
    expect(tools.execute.mock.calls[0]?.[0]).toMatchObject({ tool_call_id: "call", name: "lookup" });
    expect((await run(2)).result.status).toBe("completed");
    expect(request).toHaveBeenCalledTimes(3); expect(receipts).toHaveLength(3);
    // The domain executor remains responsible for its durable action ledger on replay.
    expect(tools.execute).toHaveBeenCalledTimes(2);
    expect((await run(3, { ...chat, generation: { ...chat.generation, max_output_tokens: 99 } })).result.status).toBe("failed");
    expect(request).toHaveBeenCalledTimes(3); expect(tools.execute).toHaveBeenCalledTimes(2);
  } finally { await database.close(); }
}, 30_000);
