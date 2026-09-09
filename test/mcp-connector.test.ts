import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpConnectorAdapter, createRequestScopedMcpSession } from "../src/mcp/index.js";
afterEach(() => vi.useRealTimers());

describe("MCP connector adapter", () => {
  it("authorizes discovery and execution and forwards tool-call idempotency", async () => {
    const authorize = vi.fn(async () => "allow" as const);
    const callTool = vi.fn(async () => ({ ok: true } as const));
    const adapter = createMcpConnectorAdapter({
      connectorId: "erp", namespace: "aegis", authorize,
      discover: ({ context }) => context.actor === "owner",
      executionContext: (context: { applicationContext: { actor: string } }) => context.applicationContext,
      client: {
        async listTools() { return { tools: [{ name: "get_asset", description: "Get an asset", inputSchema: { type: "object", additionalProperties: false } }] }; },
        callTool,
      },
    });
    const registrations = await adapter.registrations({ actor: "owner" });
    const values = [];
    for await (const registration of registrations) values.push(registration);
    expect(values[0]?.definition.name).toBe("aegis.get_asset");
    expect(values[0]?.discover?.({ actor: "owner" })).toBe(true);
    expect(values[0]?.discover?.({ actor: "viewer" })).toBe(false);
    const result = await values[0]!.executor({}, {
      applicationContext: { actor: "owner" }, definition: values[0]!.definition,
      signal: new AbortController().signal, toolCallId: "call-123",
    });
    expect(result).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "get_asset", idempotencyKey: "call-123" }));
    expect(authorize).toHaveBeenCalledTimes(2);
    await values[0]!.executor({}, { applicationContext: { actor: "owner" }, definition: values[0]!.definition,
      signal: new AbortController().signal, toolCallId: "another-call", executionKey: "original-intent" });
    expect(callTool).toHaveBeenLastCalledWith(expect.objectContaining({ idempotencyKey: "original-intent" }));
  });

  it("does not disclose a catalog when discovery is denied", async () => {
    const listTools = vi.fn();
    const adapter = createMcpConnectorAdapter({
      connectorId: "private", authorize: async () => "deny" as const,
      discover: () => false, executionContext: (context) => context.applicationContext,
      client: { listTools, async callTool() { return null; } },
    });
    expect(await adapter.registrations({})).toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
  });

  it("filters every installed MCP tool for each discovery actor", async () => {
    const adapter = createMcpConnectorAdapter({
      connectorId: "tenant-tools",
      authorize: async () => "allow" as const,
      discover: ({ context }) => context.companyId === "company-a",
      executionContext: (context: { applicationContext: { companyId: string } }) => context.applicationContext,
      client: {
        async listTools() { return { tools: [{ name: "private_ledger", inputSchema: { type: "object" } }] }; },
        async callTool() { return null; },
      },
    });
    const registrations = await adapter.registrations({ companyId: "install" });
    const values = [];
    for await (const registration of registrations) values.push(registration);
    expect(values[0]?.discover?.({ companyId: "company-a" })).toBe(true);
    expect(values[0]?.discover?.({ companyId: "company-b" })).toBe(false);
  });

  it("creates an authorized per-request connection and closes it idempotently", async () => {
    const close = vi.fn(), callTool = vi.fn(async () => ({ accepted: true }));
    const connect = vi.fn(async () => ({ close, callTool,
      async listTools() { return { tools: [{ name: "create_invoice", inputSchema: { type: "object" as const } }] }; } }));
    const authorize = vi.fn(async () => "allow" as const);
    const session = await createRequestScopedMcpSession({ connectorId: "spartan", namespace: "erp", connect, authorize },
      { actorId: "actor-1", companyId: "company-1" });
    expect(session.tools.map((tool) => tool.name)).toEqual(["erp.create_invoice"]);
    await session.callTool({ name: "erp.create_invoice", arguments: {}, toolCallId: "call-1" });
    expect(callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "create_invoice", idempotencyKey: "call-1" }));
    await session.close(); await session.close();
    expect(close).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("does not connect when scoped discovery is denied", async () => {
    const connect = vi.fn();
    await expect(createRequestScopedMcpSession({ connectorId: "private", connect,
      authorize: async () => "deny" as const }, {})).rejects.toThrow("not authorized");
    expect(connect).not.toHaveBeenCalled();
  });

  it("keeps the session usable after discovery's deadline and bounds each subsequent call", async () => {
    vi.useFakeTimers();
    const callTool = vi.fn((_input: { readonly signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        _input.signal.addEventListener("abort", () => reject(_input.signal.reason), { once: true });
      }));
    const session = await createRequestScopedMcpSession({
      connectorId: "bounded",
      timeoutMilliseconds: 100,
      authorize: async () => "allow" as const,
      connect: async () => ({
        async listTools() { return { tools: [{ name: "slow", inputSchema: { type: "object" as const } }] }; },
        callTool,
      }),
    }, {});

    await vi.advanceTimersByTimeAsync(1_000);
    const result = expect(session.callTool({ name: "slow", arguments: {}, toolCallId: "call-timeout",
      signal: new AbortController().signal })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(callTool.mock.calls[0]?.[0].signal.aborted).toBe(true);
    await session.close();
  });
});
