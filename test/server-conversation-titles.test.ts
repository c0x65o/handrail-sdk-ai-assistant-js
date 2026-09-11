import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { postgresFromClient, type PostgresSqlClient, type PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { createAssistantConversationTitles } from "../src/server/conversation-titles.js";
import { createHandrailAssistant, openaiResponses, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import { parseConversationEvent, type ConversationEventPayload } from "../src/conversation/events.js";
import { createApplicationGatewayResourceClient, createApplicationGatewayTransport, negotiateApplicationGatewayCapabilities } from "../src/transports/application-gateway.js";
import { createConversationRuntime } from "../src/runtime.js";
import { createApplicationGatewaySyncAdapter } from "../src/client/synchronization.js";
import { createSynchronizedConversationEventStore } from "../src/sync/conversation-event-store.js";

const database = new PGlite();
function adapt(db: Pick<PGlite, "query">): PostgresSqlClient {
  const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
    const result = await db.query<T>(sql, values ? [...values] : []);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }, transaction: (operation) => operation(client) };
  return client;
}
const persistence = postgresFromClient({ query: adapt(database).query,
  transaction: (operation) => database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">))) });
beforeAll(async () => { await persistence.persistence.migrate(); });
afterAll(async () => { await database.close(); });

async function fixture(title?: string, deltas = false) {
  const scope = randomUUID();
  const context: HandrailAssistantAuthorizationContext = { tenantId: "titles", scopeId: scope, principalId: scope,
    attribution: { organization: { id: "org", source: "server_derived", trust: "authoritative" },
      project: { id: "project", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
      known_user: { id: scope, source: "server_derived", trust: "authoritative" },
      session: { id: "session", source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" } } };
  const bundle = persistence.forScope<HandrailAssistantAuthorizationContext>({ tenantId: context.tenantId, scopeId: scope }, {
    createConversationId: () => randomUUID() as never,
    authorizeConversation: ({ authorizationContext }) => authorizationContext.principalId === scope ? "allow" : "deny",
  });
  const conversationId = (await bundle.catalog.create({ authorizationContext: context,
    idempotencyKey: "create" as never, ...(title ? { title } : {}) })).descriptor.conversationId;
  const append = async (payload: ConversationEventPayload) => {
    const revision = await bundle.events.getLatestRevision(conversationId) ?? 0;
    await bundle.events.append({ conversationId, expectedRevision: revision || null, events: [parseConversationEvent({
      version: 1, event_id: `event-${conversationId}-${revision + 1}`, conversation_id: conversationId, revision: revision + 1,
      occurred_at: new Date().toISOString(), actor: { type: "user", id: scope }, source: { type: "runtime" }, payload,
    })] });
  };
  const complete = async () => {
    await append({ type: "message.created", message_id: "greeting" as never, role: "assistant", content: [{ type: "text", text: "Private system-derived welcome" }] });
    await append({ type: "message.created", message_id: "question" as never, role: "user", content: [{ type: "text", text: "  Plan   quarterly cash  " }] });
    await append({ type: "turn.started", turn_id: "first-turn" as never, input_message_ids: ["question" as never] });
    await append({ type: "turn.completed", turn_id: "first-turn" as never, outcome: "stop", output_message_ids: [] });
  };
  const currentTitle = async () => (await bundle.catalog.get({ authorizationContext: context, conversationId })).descriptor.title;
  const request = vi.fn(async function* () {
    if (deltas) yield { type: "response.output_text.delta", delta: "Quarterly Cash Planning" };
    yield { type: "response.completed", response: { status: "completed", output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: "Quarterly Cash Planning" }] },
    ], usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 } } };
  });
  const provider = openaiResponses({ model: "test-model", request, hosted: { webSearch: {} }, toolChoice: "required" });
  const options = { assistantId: "test-assistant", provider, catalogFor: () => bundle.catalog, bundleFor: () => bundle };
  return { context, bundle, conversationId, append, complete, currentTitle, request, provider, options };
}

describe("SDK-owned conversation titles", () => {
  it("does not replace reported usage after a failed durable capture or repeat the provider across restarts", async () => {
    const f = await fixture(); await f.complete();
    let rejectCapture!: (error: Error) => void;
    const capture = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectCapture = reject; }));
    const options = { ...f.options,
      bundleFor: () => ({ ...f.bundle, usageReceiptSink: { capture } } as unknown as typeof f.bundle) };
    let settled = false;
    const result = createAssistantConversationTitles(options).generate(f.conversationId, f.context)
      .then(() => { settled = true; return "completed"; }, () => { settled = true; return "failed"; });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(await f.currentTitle()).toBeNull();
    rejectCapture(new Error("Usage store unavailable"));
    expect(await result).toBe("failed");
    expect(capture).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ terminal_status: "completed",
      tokens: expect.objectContaining({ total_tokens: { status: "reported", value: 24 } }) }));
    await createAssistantConversationTitles(options).afterCompletion(f.conversationId, f.context);
    expect(f.request).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledOnce();
    expect(await f.currentTitle()).toBeNull();
  });

  it.each([false, true])("persists bounded titles without duplication across instances (deltas=%s)", async (deltas) => {
    const f = await fixture("New thread", deltas);
    await f.complete();
    const capture = vi.fn(async () => undefined);
    const admit = vi.fn(async () => undefined);
    const options = { ...f.options, automatic: { placeholderTitles: ["New thread"] },
      bundleFor: () => ({ ...f.bundle, usageReceiptSink: { capture }, usageAdmissions: { admit } } as unknown as typeof f.bundle) };
    const titles = createAssistantConversationTitles(options);
    await Promise.all([titles.afterCompletion(f.conversationId, f.context), titles.generate(f.conversationId, f.context)]);
    expect(await f.currentTitle()).toBe("Quarterly Cash Planning");
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model", stream: true, store: false,
      tools: [], input: [{ role: "user", content: [{ type: "input_text", text: "Plan quarterly cash" }] }],
      instructions: expect.stringMatching(/do not include secrets, account numbers, document numbers.*return only the title/i),
    }), expect.anything());
    expect(admit).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ provider_id: "openai", model_id: "test-model",
      logical_request_id: expect.stringMatching(/^title-/), terminal_status: "completed",
      attribution: f.context.attribution, tokens: expect.objectContaining({ total_tokens: { status: "reported", value: 24 } }) }));
    await createAssistantConversationTitles(options).afterCompletion(f.conversationId, f.context);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("names a running turn and reuses its durable result after completion", async () => {
    const f = await fixture();
    await f.append({ type: "message.created", message_id: "question" as never, role: "user",
      content: [{ type: "text", text: "Plan quarterly cash" }] });
    await f.append({ type: "turn.started", turn_id: "first-turn" as never, input_message_ids: ["question" as never] });
    const rename = vi.spyOn(f.bundle.catalog, "rename").mockRejectedValueOnce(new Error("Temporary catalog failure"));
    await createAssistantConversationTitles(f.options).afterActivity(f.conversationId, f.context);
    expect(f.request).toHaveBeenCalledOnce();
    expect(await f.currentTitle()).toBeNull();
    rename.mockRestore();
    await f.append({ type: "turn.completed", turn_id: "first-turn" as never, outcome: "stop", output_message_ids: [] });
    await createAssistantConversationTitles(f.options).afterCompletion(f.conversationId, f.context);
    expect(await f.currentTitle()).toBe("Quarterly Cash Planning");
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("preserves a concurrent manual rename", async () => {
    const f = await fixture(); await f.complete();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const generateTitle = vi.fn(async () => { await waiting; return "Generated title"; });
    const titles = createAssistantConversationTitles({ ...f.options, provider: { ...f.provider, generateTitle } });
    const work = titles.generate(f.conversationId, f.context);
    await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledOnce());
    const found = await f.bundle.catalog.get({ authorizationContext: f.context, conversationId: f.conversationId });
    await f.bundle.catalog.rename({ authorizationContext: f.context, conversationId: f.conversationId,
      expectedVersion: found.descriptor.version, title: "My chosen title", idempotencyKey: "manual" as never });
    finish();
    expect(await work).toBe("My chosen title");
    expect(await f.currentTitle()).toBe("My chosen title");
  });

  it("reuses a generated result after a catalog-write failure across instances", async () => {
    const f = await fixture(); await f.complete();
    const rename = vi.spyOn(f.bundle.catalog, "rename").mockRejectedValueOnce(new Error("write failed"));
    await expect(createAssistantConversationTitles(f.options).generate(f.conversationId, f.context)).rejects.toThrow("write failed");
    expect(await createAssistantConversationTitles(f.options).generate(f.conversationId, f.context)).toBe("Quarterly Cash Planning");
    expect(rename).toHaveBeenCalledTimes(2);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("protects tenant scope and skips named, archived, incomplete, and disabled conversations", async () => {
    const f = await fixture();
    const titles = createAssistantConversationTitles(f.options);
    await titles.afterCompletion(f.conversationId, f.context);
    expect(f.request).not.toHaveBeenCalled();
    await f.complete();
    await expect(titles.generate(f.conversationId, { ...f.context, principalId: "other-user" })).rejects.toMatchObject({ code: "forbidden" });
    await createAssistantConversationTitles({ ...f.options, automatic: false }).afterCompletion(f.conversationId, f.context);
    const found = await f.bundle.catalog.get({ authorizationContext: f.context, conversationId: f.conversationId });
    await f.bundle.catalog.archive({ authorizationContext: f.context, conversationId: f.conversationId,
      expectedVersion: found.descriptor.version, idempotencyKey: "archive" as never });
    await titles.afterCompletion(f.conversationId, f.context);
    const named = await fixture("Already named"); await named.complete();
    await createAssistantConversationTitles(named.options).afterCompletion(named.conversationId, named.context);
    expect(f.request).not.toHaveBeenCalled(); expect(named.request).not.toHaveBeenCalled();
  });

  it("does not dispatch the same provider operation from concurrent server instances", async () => {
    const f = await fixture(); await f.complete();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const generateTitle = vi.fn(async () => { await waiting; return "Shared title"; });
    const options = { ...f.options, provider: { ...f.provider, generateTitle } };
    const first = createAssistantConversationTitles(options).generate(f.conversationId, f.context);
    await vi.waitFor(() => expect(generateTitle).toHaveBeenCalledOnce());
    await expect(createAssistantConversationTitles(options).generate(f.conversationId, f.context))
      .rejects.toMatchObject({ code: "provider_operation_uncertain" });
    finish(); await first;
    expect(await createAssistantConversationTitles(options).generate(f.conversationId, f.context)).toBe("Shared title");
    expect(generateTitle).toHaveBeenCalledOnce();
  });

  it("keeps provider failures out of the conversation and records a safe diagnostic", async () => {
    const f = await fixture(); await f.complete();
    const diagnostics = vi.fn();
    const generateTitle = vi.fn(async () => { throw new Error("provider private diagnostic"); });
    const titles = createAssistantConversationTitles({ ...f.options, diagnostics, provider: { ...f.provider, generateTitle } });
    await titles.afterCompletion(f.conversationId, f.context);
    expect(await f.currentTitle()).toBeNull();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ operation: "automatic_title", phase: "failed" }));
    await titles.afterCompletion(f.conversationId, f.context);
    expect(generateTitle).toHaveBeenCalledOnce();
  });

  it("generates on durable completion without a browser title request", async () => {
    const f = await fixture();
    let finishTitle!: () => void;
    const titleGate = new Promise<void>((resolve) => { finishTitle = resolve; });
    const response = f.request.getMockImplementation()!;
    f.request.mockImplementation(async function* (...args: unknown[]) {
      if ((args[0] as { instructions?: string }).instructions?.includes("conversation title")) await titleGate;
      yield* response();
    });
    const paths: string[] = [];
    const assistant = await createHandrailAssistant({ id: "completion-title", authorize: () => f.context,
      persistence: { ...persistence, forScope: <T>() => f.bundle as unknown as PostgresAssistantPersistenceBundle<T> }, provider: f.provider });
    const baseUrl = "https://example.test/assistant";
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init); paths.push(new URL(request.url).pathname);
      return assistant.handle(request);
    };
    const resources = createApplicationGatewayResourceClient({ baseUrl, fetch: fetcher });
    const capabilities = await negotiateApplicationGatewayCapabilities({ baseUrl, fetch: fetcher });
    const transport = createApplicationGatewayTransport<StreamEvent, ChatRequest>({ baseUrl, fetch: fetcher, capabilities });
    const runtime = await createConversationRuntime({ conversationId: f.conversationId, clientId: "test-client" as never,
      transport, eventStore: createSynchronizedConversationEventStore({ adapter: createApplicationGatewaySyncAdapter({ resources }) }) });
    try {
      const result = await runtime.sendMessage({ content: "Plan quarterly cash", request: { protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
        continuation_of: null, messages: [{ role: "user", content: [{ type: "text", text: "Plan quarterly cash" }] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0.2 }, correlation_hints: {} } });
      expect(result.status).toBe("completed");
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
      expect(await f.currentTitle()).toBeNull(); // A slow title does not delay the answer.
      finishTitle();
      await vi.waitFor(async () => expect(await f.currentTitle()).toBe("Quarterly Cash Planning"));
      expect(f.request).toHaveBeenCalledTimes(2); // Answer plus the separate title Responses call.
      expect(paths.some((path) => path.endsWith("/titles/generate"))).toBe(false);
    } finally { finishTitle(); runtime.destroy(); assistant.stopUsageWorker(); }
  });
});
