import { expect, it, vi } from "vitest";
import { createApplicationGateway, createApplicationGatewayDisplayHistory, ConversationDisplayHistoryError,
  type ConversationDisplayHistory, type ConversationTransport } from "../src/index.js";

const transport: ConversationTransport<never, never> = {
  capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
    attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
  startTurn: async () => { throw new Error("Display requests must not create turns"); },
  resumeTurn: async () => { throw new Error("Display requests must not resume turns"); },
};
const point = () => ({ lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null });

it("negotiates bounded controls without creating a provider transport and rejects mismatched turn identities", async () => {
  const turn = { turnId: "turn", revision: 12, status: "running" as const, remoteMayStillBeRunning: true, error: null };
  const value = { schemaVersion: 1 as const, status: "ready" as const, conversationId: "conversation", generation: 0,
    revision: 12, canonicalRevision: 12, activeTurnId: "turn", activeTurn: turn, latestTurn: turn, requestedTurn: null };
  const history: ConversationDisplayHistory = { page: vi.fn(), changes: vi.fn(), content: vi.fn(), control: vi.fn(async () => value) };
  const resolve = vi.fn(() => transport);
  const gateway = createApplicationGateway({ transportFor: resolve, authorize: async () => ({ principalId: "user" }),
    checkpointForEvent: point, displayHistoryFor: () => history, displayControl: true });
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    fetch: (async (url, init) => gateway.handle(new Request(url, init))) as typeof fetch });
  expect(await client.control({ conversationId: "conversation" })).toEqual(value);
  expect(resolve).not.toHaveBeenCalled();
  expect(await (await gateway.handle(new Request("https://app.test/capabilities"))).json())
    .toMatchObject({ value: { displayHistory: { control: true } } });
  const forged = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    fetch: (async () => Response.json({ ok: true, value: { ...value, requestedTurn: { ...turn, turnId: "different" } } })) as typeof fetch });
  await expect(forged.control({ conversationId: "conversation", turnId: "turn" })).rejects.toThrow("Invalid display control");
  await expect(client.control({ conversationId: "other" })).rejects.toThrow("Invalid display history");
});

it("rejects cross-conversation and malformed pages before caching and bounds streamed response bytes", async () => {
  const valid = { schemaVersion: 1, status: "ready", conversationId: "conversation", generation: 0,
    revision: 12, canonicalRevision: 12, activeTurnId: null, records: [], nextCursor: null };
  let value: unknown = valid;
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    fetch: (async () => Response.json({ ok: true, value })) as typeof fetch });
  for (const invalid of [{ ...valid, conversationId: "other-account" }, { ...valid, revision: -1 },
    { ...valid, records: [{ kind: "message", id: "a", revision: 13, turnId: null, bytes: 2, value: {}, deferred: false }] },
    { ...valid, records: [{ kind: "message", id: "a", revision: 2, turnId: null, bytes: 2, value: null, deferred: false, deleted: true }] }]) {
    value = invalid;
    await expect(client.page({ conversationId: "conversation" })).rejects.toThrow("Invalid display history response");
  }
  const cancelled = vi.fn();
  const oversized = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    fetch: (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(4096)); }, cancel: cancelled,
    }))) as typeof fetch });
  await expect(oversized.page({ conversationId: "conversation", maximumBytes: 8192 })).rejects.toThrow("byte budget");
  expect(cancelled).toHaveBeenCalledOnce();
});

it("cancels while waiting for credentials or a stalled response body", async () => {
  let resolveCredentials!: (value: RequestInit) => void;
  const fetcher = vi.fn();
  const credentials = new Promise<RequestInit>(resolve => { resolveCredentials = resolve; });
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test", fetch: fetcher,
    protectedRequest: () => credentials });
  const controller = new AbortController();
  const pending = client.page({ conversationId: "conversation" }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  resolveCredentials({}); await Promise.resolve(); expect(fetcher).not.toHaveBeenCalled();
  const cancelled = vi.fn();
  const body = new ReadableStream({ cancel: cancelled });
  const responseClient = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    fetch: (async () => new Response(body)) as typeof fetch });
  const second = new AbortController();
  const reading = responseClient.page({ conversationId: "conversation" }, second.signal);
  await vi.waitFor(() => expect(body.locked).toBe(true));
  second.abort(); await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toHaveBeenCalledOnce();
});

it("negotiates paged display separately from synchronization and derives identity from the protected request", async () => {
  const history: ConversationDisplayHistory = { page: vi.fn(async input => ({ schemaVersion: 1 as const, status: "ready" as const,
    conversationId: input.conversationId, generation: 0, revision: 12345, canonicalRevision: 12345,
    activeTurnId: null, records: [], nextCursor: null })), content: vi.fn(), changes: vi.fn(async input => ({
      schemaVersion: 1 as const, status: "ready" as const, conversationId: input.conversationId,
      generation: input.generation, revision: 12346, canonicalRevision: 12346, throughRevision: 12346,
      activeTurnId: null, records: [], nextCursor: null })) };
  const historyFor = vi.fn(() => history);
  const resolveTransport = vi.fn(() => transport);
  const gateway = createApplicationGateway({ transportFor: resolveTransport,
    authorize: async request => {
      if (request.headers.get("authorization") !== "Bearer test-user") throw new Error("denied");
      return { principalId: "verified-user", scopeId: "verified-scope" };
    }, checkpointForEvent: point, displayHistoryFor: historyFor });
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test/assistant",
    protectedRequest: input => ({ ...input, headers: { ...input.headers, authorization: "Bearer test-user" } }),
    fetch: (async (url, init) => gateway.handle(new Request(url, init))) as typeof fetch });
  expect(await client.page({ conversationId: "conversation", limit: 12 })).toMatchObject({ revision: 12345, records: [] });
  expect(resolveTransport).not.toHaveBeenCalled();
  expect(historyFor).toHaveBeenCalledWith({ principalId: "verified-user", scopeId: "verified-scope" });
  expect(history.page).toHaveBeenCalledWith({ conversationId: "conversation", limit: 12 });
  expect(await client.changes({ conversationId: "conversation", generation: 0, afterRevision: 12345 })).toMatchObject({ throughRevision: 12346 });
  expect(history.changes).toHaveBeenCalledWith({ conversationId: "conversation", generation: 0, afterRevision: 12345 });
  const response = await gateway.handle(new Request("https://app.test/assistant/capabilities", { headers: { authorization: "Bearer test-user" } }));
  expect(await response.json()).toMatchObject({ ok: true, value: { synchronization: false,
    displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144 } } });
  const denied = await gateway.handle(new Request("https://app.test/assistant/conversations/history", {
    method: "POST", body: JSON.stringify({ operation: "page", input: { conversationId: "conversation" } }) }));
  expect(denied.status).toBe(403); expect(history.page).toHaveBeenCalledTimes(1);
});

it("reports cursor/content conflicts, rejects malformed or oversized requests and preserves old-server negotiation", async () => {
  const history: ConversationDisplayHistory = {
    page: vi.fn(async () => { throw new ConversationDisplayHistoryError("stale_cursor", "History was cleared"); }),
    content: vi.fn(async () => { throw new ConversationDisplayHistoryError("content_changed", "Content changed"); }),
    changes: vi.fn(),
  };
  const options = { transport, authorize: async () => ({ principalId: "user" }), checkpointForEvent: point };
  const gateway = createApplicationGateway({ ...options, displayHistoryFor: () => history });
  const fetcher = (async (url, init) => gateway.handle(new Request(url, init))) as typeof fetch;
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test", fetch: fetcher });
  await expect(client.page({ conversationId: "conversation", cursor: "old" })).rejects.toMatchObject({
    resourceDomain: "display_history", resourceCode: "stale_cursor", transportCode: "conflict" });
  await expect(client.content({ conversationId: "conversation", generation: 1, kind: "message", id: "message", revision: 4 }))
    .rejects.toMatchObject({ resourceCode: "content_changed" });
  for (const body of ["null", "[]", "{}", '{"operation":"page","input":null}', '{"operation":"unknown","input":{}}']) {
    const response = await fetcher("https://app.test/conversations/history", { method: "POST", body });
    expect(response.status).toBe(400);
  }
  const oversized = await fetcher("https://app.test/conversations/history", { method: "POST", body: "a".repeat(8193) });
  expect(oversized.status).toBe(413);
  expect(history.page).toHaveBeenCalledTimes(1);
  const legacy = createApplicationGateway(options);
  const capabilities = await legacy.handle(new Request("https://app.test/capabilities"));
  expect((await capabilities.json()).value).not.toHaveProperty("displayHistory");
  expect((await legacy.handle(new Request("https://app.test/conversations/history", { method: "POST", body: "{}" }))).status).toBe(501);
});

it("keeps cancellation attached even if an async credential decorator returns a fresh RequestInit", async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test",
    protectedRequest: async () => ({ method: "POST", headers: { authorization: "Bearer example" } }),
    fetch: (async (_url, init) => { received = init?.signal;
      return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }) as typeof fetch });
  const pending = client.page({ conversationId: "conversation" }, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(received).toBeInstanceOf(AbortSignal));
  controller.abort(); await rejected; expect(received!.aborted).toBe(true);
});

it("bounds stalled reads by a deadline and rejects unsupported client budgets before requesting", async () => {
  const client = createApplicationGatewayDisplayHistory({ baseUrl: "https://app.test", historyTimeoutMilliseconds: 20,
    protectedRequest: () => new Promise(() => {}), fetch: vi.fn() });
  await expect(client.page({ conversationId: "a" })).rejects.toMatchObject({ name: "TimeoutError" });
  await expect(client.page({ conversationId: "a", maximumBytes: 1_000_000_000 })).rejects.toThrow("page bounds");
  await expect(client.page({ conversationId: "a", limit: 51 })).rejects.toThrow("page bounds");
});
