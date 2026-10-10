import { expect, it, vi } from "vitest";
import { createHandrailAssistant } from "../src/server/assistant.js";
import { createApplicationTurnTransport, type ApplicationTurnExecutionContext } from "../src/transports/application-turn.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type AuthoritativeAttribution, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import { postgresFromClient, type PostgresSqlClient } from "../src/postgres/index.js";
import { PGlite } from "@electric-sql/pglite";
import { createHandrailAiClient } from "../src/client/bootstrap.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

import { createServer } from "node:http";
import { once } from "node:events";
import { writeFileSync, mkdirSync } from "node:fs";

it.each([
  { label: "default cadence", interval: undefined, minimumPartialUpdates: 2 },
  { label: "configured five-second cadence", interval: 5000, minimumPartialUpdates: 1 },
])("qualifies 70 streamed deltas at $label through real HTTP with the unchanged 120/60 budget", async ({ interval, minimumPartialUpdates }) => {
  const db = new PGlite();
  const adapt = (connection: Pick<PGlite, "query">): PostgresSqlClient => {
    const sql: PostgresSqlClient = { query: async <T extends Record<string, unknown>>(statement: string, values: readonly unknown[] = []) => {
      const result = await connection.query<T>(statement, [...values]); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: work => work(sql) }; return sql;
  };
  const persistence = postgresFromClient({ query: adapt(db).query,
    transaction: work => db.transaction(tx => work(adapt(tx as unknown as Pick<PGlite, "query">))) });
  await persistence.persistence.migrate();
  const context = { principalId: "alice", tenantId: "tenant", scopeId: "alice", attribution };
  const stores = persistence.forScope<typeof context>(context, { createConversationId: () => "volume-chat" as never });
  await stores.catalog.create({ authorizationContext: context, idempotencyKey: "create" as never });
  const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
  let providerFinished = false;
  const execute = vi.fn(async (_request: ChatRequest, turn: ApplicationTurnExecutionContext<StreamEvent>) => {
    const envelope = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: "provider", trace_id: "trace" };
    await turn.emit({ ...envelope, type: "response.started", sequence: 0, attribution });
    for (let i = 0; i < 70; i++) {
      await turn.emit({ ...envelope, type: "response.text.delta", sequence: i + 1, delta: `delta${i} ` });
      await new Promise(resolve => setTimeout(resolve, 100)); // deterministic provider cadence
    }
    providerFinished = true;
    await turn.emit({ ...envelope, type: "response.completed", sequence: 71, outcome: "stop" });
    return { status: "completed" as const, checkpoint };
  });
  const assistant = await createHandrailAssistant({ id: "volume", authorize: () => context, persistence,
    recoverPendingOnContext: false, automaticTitles: false, attachmentUpload: false, attachmentDownloads: false,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: false, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: () => createApplicationTurnTransport({ execute }) },
  });
  const started = Date.now(), shared: number[] = [];
  const dispatches: { ms: number; path: string; operation?: string; turnId?: string; rolling60s: number; status?: number }[] = [];
  let concurrency = 0, maximumConcurrency = 0;
  const server = createServer(async (request, response) => {
    let isHistory = false;
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString(), input = body ? JSON.parse(body) : {};
      const now = Date.now(); while (shared.length && shared[0]! <= now - 60000) shared.shift(); shared.push(now);
      const row = { ms: now - started, path: request.url!, operation: input.operation, turnId: input.input?.turnId,
        rolling60s: shared.length, status: 0 }; dispatches.push(row);
      if (shared.length > 120) { row.status = 429; response.writeHead(429, { "retry-after": "60" }); response.end(); return; }
      isHistory = request.url!.endsWith("/conversations/history");
      if (isHistory) maximumConcurrency = Math.max(maximumConcurrency, ++concurrency);
      const result = await assistant.handle(new Request(`http://127.0.0.1${request.url}`, {
        method: request.method ?? "GET", headers: request.headers as HeadersInit, ...(body ? { body } : {}),
      }));
      row.status = result.status;
      const headers: Record<string, string> = {};
      result.headers.forEach((value, key) => { headers[key] = value; });
      response.writeHead(result.status, headers);
      const reader = result.body?.getReader();
      response.on("close", () => { void reader?.cancel().catch(() => undefined); });
      if (reader) { for (;;) { const next = await reader.read(); if (next.done) break; response.write(next.value); } reader.releaseLock(); }
      response.end();
    } catch (cause) { response.destroy(cause as Error); }
    finally { if (isHistory) concurrency--; }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const client = await createHandrailAiClient<StreamEvent, ChatRequest>({ baseUrl: `http://127.0.0.1:${address.port}/api/ai`,
    startActivityPolling: false,
    ...(interval === undefined ? {} : { synchronizationPollingMilliseconds: interval }),
    conversations: { mode: "single", conversationId: "volume-chat" as never, clientId: "web" as never } });
  const partialLengths = new Set<number>();
  const unobserve = client.conversation!.observe(snapshot => {
    if (providerFinished) return;
    const message = snapshot.messages.filter(candidate => candidate.role === "assistant").at(-1);
    const text = message?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
    if (text) partialLengths.add(text.length);
  });
  try {
    await client.conversation!.synchronize!();
    const result = await client.conversation!.sendMessage({ content: "Question", request: {
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION, messages: [{ role: "user", content: [{ type: "text", text: "Question" }] }],
      continuation_of: null, tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {},
    } });
    expect(result.status).toBe("completed");
    await client.conversation!.synchronize!();
    expect(client.conversation!.getSnapshot().messages.at(-1)?.content).toEqual([{ type: "text", text: Array.from({length: 70}, (_, i) => `delta${i} `).join("") }]);
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatches.some(row => row.status === 429)).toBe(false);
    // Qualify the real gateway limit together with visible progressive output;
    // an incidental lower count must not reward delaying the default display.
    expect(Math.max(...dispatches.map(row => row.rolling60s))).toBeLessThanOrEqual(120);
    expect(partialLengths.size).toBeGreaterThanOrEqual(minimumPartialUpdates);
    expect(maximumConcurrency).toBeLessThanOrEqual(2); // exact-turn observation can overlap presentation
  } finally {
    unobserve();
    await client.dispose(); await assistant.stopBackgroundWorkers(); await db.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const evidence = { dispatches, maximumConcurrency, maximumRolling60s: Math.max(...dispatches.map(row => row.rolling60s)), partialLengths: [...partialLengths] };
    if (process.env.HANDRAIL_READ_VOLUME_EVIDENCE) {
      mkdirSync(process.env.HANDRAIL_READ_VOLUME_EVIDENCE, { recursive: true });
      writeFileSync(`${process.env.HANDRAIL_READ_VOLUME_EVIDENCE}/${interval === undefined ? "js-http-default" : "js-http"}.json`, JSON.stringify(evidence, null, 2));
    }
  }
}, 30000);
