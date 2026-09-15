import { describe, expect, it, vi } from "vitest";
import { createSpartanAegisPlugin, createSpartanAegisRegistrations, SPARTAN_AEGIS_TOOL_LOOP_LIMITS } from "../examples/spartan-aegis-adapter.js";

const schema = { type: "object" as const, properties: {}, additionalProperties: false };

describe("Spartan Aegis checked adapter", () => {
  it("keeps reads executable and actions behind Spartan validation plus confirmation", async () => {
    const validate = vi.fn(() => ({}));
    const execute = vi.fn(async () => ({ posted: true }));
    const actor = { companyId: "company-1" };
    const bridge = createSpartanAegisRegistrations({
      actor,
      readDefinitions: [{ name: "get_invoices", description: "Read invoices", parameters: schema }],
      runReadTool: async () => ({ invoices: [] }),
      actionRegistry: {
        catalogFunctions: () => [{ name: "propose_invoice", description: "Propose invoice", parameters: schema }],
        validate,
        summarizeForActor: async () => "Create invoice",
        execute,
      },
      actionExecutionContext: { requestId: "request-1" },
    });
    expect(bridge.registrations.map((item) => item.definition.name)).toEqual([
      "get_invoices", "propose_invoice",
    ]);
    expect(await bridge.policy({ applicationContext: actor, arguments: {},
      definition: bridge.registrations[0]!.definition, signal: new AbortController().signal,
      toolCallId: "read-1" })).toEqual({ outcome: "allow" });
    expect(await bridge.policy({ applicationContext: actor, arguments: {},
      definition: bridge.registrations[1]!.definition, signal: new AbortController().signal,
      toolCallId: "action-1" })).toEqual({ outcome: "external_approval_required" });
    expect(validate).toHaveBeenCalledWith("propose_invoice", {});
    expect(execute).not.toHaveBeenCalled();
    expect(SPARTAN_AEGIS_TOOL_LOOP_LIMITS.maxTotalToolCalls).toBe(150);
  });

  it("turns action calls into proposals without exposing the business executor", async () => {
    const validate = vi.fn(() => ({ amount: 1200 }));
    const proposeAction = vi.fn(async () => ({ proposalId: "proposal-1" }));
    const plugin = createSpartanAegisPlugin({
      actor: { companyId: "company-1" },
      readDefinitions: [{ name: "get_invoices", description: "Read invoices", parameters: schema }],
      runReadTool: async () => ({ invoices: [] }),
      actionRegistry: {
        catalogFunctions: () => [{ name: "create_invoice", description: "Create invoice", parameters: schema }],
        validate,
        summarizeForActor: async () => "Create a $1,200 invoice",
      },
      proposeAction,
      presentationFor: (_name, kind) => ({ label: kind === "read" ? "Invoices" : "Invoice proposal",
        rendererKey: kind === "read" ? "spartan.invoices" : "spartan.invoice.proposal" }),
    });
    const source = await plugin.registrations(undefined);
    const registrations = [];
    for await (const registration of source) registrations.push(registration);
    const action = registrations.find((registration) => registration.definition.name === "create_invoice")!;
    const signal = new AbortController().signal;

    await expect(action.executor({}, { applicationContext: { companyId: "company-1" },
      definition: action.definition, signal, toolCallId: "call-1" })).resolves.toEqual({ proposalId: "proposal-1" });
    expect(validate).toHaveBeenCalledWith("create_invoice", {});
    expect(proposeAction).toHaveBeenCalledWith(expect.objectContaining({
      name: "create_invoice", summary: "Create a $1,200 invoice", toolCallId: "call-1",
    }));
    expect(plugin.approvals).toEqual([expect.objectContaining({ toolName: "create_invoice", mode: "never" })]);
    expect(plugin.presentations).toEqual([
      expect.objectContaining({ toolName: "get_invoices", rendererKey: "spartan.invoices" }),
      expect.objectContaining({ toolName: "create_invoice", rendererKey: "spartan.invoice.proposal" }),
    ]);
  });
});
