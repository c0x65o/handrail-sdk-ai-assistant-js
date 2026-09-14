import { describe, expect, it, vi } from "vitest";
import {
  SPARTAN_AEGIS_ADAPTER_VERSION,
  SPARTAN_AEGIS_MAXIMUM_INPUT_MESSAGES,
  SPARTAN_AEGIS_TOOL_LOOP_LIMITS,
  createSpartanAegisPlugin,
} from "../src/adapters/spartan-aegis.js";

const schema = { type: "object" as const, properties: {}, additionalProperties: false };

describe("supported Spartan Aegis adapter", () => {
  it("keeps actions proposal-only and preserves Spartan validation and summaries", async () => {
    const actor = { companyId: "company-a" };
    const validate = vi.fn(() => ({ amount: 1200 }));
    const proposeAction = vi.fn(async () => ({ proposalId: "proposal-a" }));
    const plugin = createSpartanAegisPlugin({
      actor,
      readDefinitions: [{ name: "get_invoices", description: "Read invoices", parameters: schema }],
      runReadTool: async () => ({ invoices: [] }),
      actionRegistry: {
        catalogFunctions: () => [{ name: "create_invoice", description: "Propose invoice", parameters: schema }],
        validate,
        summarizeForActor: async () => "Create a $1,200 invoice",
      },
      proposeAction,
      presentationFor: (name) => ({ label: name, rendererKey: `spartan.${name}` }),
    });
    const registrations = [];
    for await (const registration of await plugin.registrations(undefined)) registrations.push(registration);
    const action = registrations.find((item) => item.definition.name === "create_invoice")!;
    await expect(action.executor({}, { applicationContext: actor, definition: action.definition,
      signal: new AbortController().signal, toolCallId: "call-a" })).resolves.toEqual({ proposalId: "proposal-a" });
    expect(validate).toHaveBeenCalledWith("create_invoice", {});
    expect(proposeAction).toHaveBeenCalledWith(expect.objectContaining({
      actor, name: "create_invoice", validatedArguments: { amount: 1200 },
      summary: "Create a $1,200 invoice", toolCallId: "call-a",
    }));
    expect(plugin.adapterVersion).toBe(SPARTAN_AEGIS_ADAPTER_VERSION);
    expect(plugin.presentations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "get_invoices", rendererKey: "spartan.get_invoices" }),
      expect.objectContaining({ toolName: "create_invoice", rendererKey: "spartan.create_invoice" }),
    ]));
    expect(SPARTAN_AEGIS_TOOL_LOOP_LIMITS.maxTotalToolCalls).toBe(150);
    expect(SPARTAN_AEGIS_MAXIMUM_INPUT_MESSAGES).toBe(30);
  });

  it("does not disclose actor-scoped registrations to another actor", async () => {
    const actor = { companyId: "company-a" };
    const plugin = createSpartanAegisPlugin({ actor,
      readDefinitions: [{ name: "get_invoices", description: "Read invoices", parameters: schema }],
      runReadTool: async () => null,
      actionRegistry: { catalogFunctions: () => [], validate: () => ({}), summarizeForActor: async () => "" },
      proposeAction: async () => null });
    const registrations = [];
    for await (const registration of await plugin.registrations(undefined)) registrations.push(registration);
    expect(registrations[0]?.discover?.(actor)).toBe(true);
    expect(registrations[0]?.discover?.({ companyId: "company-b" })).toBe(false);
  });
});
