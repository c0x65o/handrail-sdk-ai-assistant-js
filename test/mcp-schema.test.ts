import { expect, it, vi } from "vitest";
import { createMcpConnectorAdapter } from "../src/mcp/index.js";
import { createAiApplication } from "../src/server/application.js";
import { parseToolDefinition } from "../src/protocol.js";

it("retains the default dialect's rejection of legacy tuple items", () => {
  const input_schema = { type: "object", properties: { values: { type: "array", items: [{ type: "string" }] } } };
  expect(() => parseToolDefinition({ name: "legacy", description: "Legacy tuple", input_schema })).toThrow();
});

it.each([
  { dialect: "http://json-schema.org/draft-07/schema#", tuple: { items: [{ type: "string" }], additionalItems: false } },
  { dialect: "https://json-schema.org/draft/2020-12/schema", tuple: { prefixItems: [{ type: "string" }], items: false } },
])("preserves $dialect tuple validation through MCP discovery and admission", async ({ dialect, tuple }) => {
  const callTool = vi.fn(async () => ({ accepted: true }));
  const adapter = createMcpConnectorAdapter({ connectorId: "schema-proof", authorize: () => "allow",
    discover: () => true, executionContext: context => context.applicationContext,
    client: { callTool, listTools: async () => ({ tools: [{ name: "bounded_tuple",
      inputSchema: { $schema: dialect, type: "object", properties: { values: { type: "array", ...tuple } },
        required: ["values"], additionalProperties: false } }] }) },
  });
  const app = await createAiApplication({ connectors: [adapter], installContext: {},
    policy: () => ({ outcome: "allow" }), toolAdmission: () => ({ outcome: "allow" }) });
  for (const [i, values] of [["valid"], [123], ["valid", "extra"]].entries()) {
    const outcome = await app.executeTool({ discovery: { context: {} }, applicationContext: {},
      call: { name: "bounded_tuple", tool_call_id: `tuple-${i}`, arguments: { values } } });
    expect(outcome).toMatchObject({ status: "completed", result: { is_error: i !== 0 } });
  }
  expect(callTool).toHaveBeenCalledTimes(1);
});

it("rejects an unsupported schema dialect without dispatch", async () => {
  const callTool = vi.fn(async () => null);
  const app = await createAiApplication({ installContext: {}, policy: () => ({ outcome: "allow" }),
    connectors: [createMcpConnectorAdapter({ connectorId: "unknown-schema", authorize: () => "allow",
      discover: () => true, executionContext: context => context.applicationContext,
      client: { callTool, listTools: async () => ({ tools: [{ name: "unknown", inputSchema: {
        $schema: "https://example.invalid/unsupported", type: "object",
      } }] }) } })] });
  expect(await app.executeTool({ discovery: { context: {} }, applicationContext: {},
    call: { name: "unknown", tool_call_id: "unknown", arguments: {} } }))
    .toMatchObject({ result: { is_error: true } });
  expect(callTool).not.toHaveBeenCalled();
});
