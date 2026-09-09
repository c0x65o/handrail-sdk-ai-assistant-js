import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolWithRecovery, ToolFailureError, type ToolRecoveryContext, type ToolRecoveryPolicy } from "../src/tools/recovery.js";
import { BoundedToolExecutor, type ApplicationToolExecutor } from "../src/tools/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";

const transient = () => new ToolFailureError({ category: "transient", code: "service_busy", message: "Try again shortly." });
const missing = () => new ToolFailureError({ category: "not_found", code: "invoice_not_found", message: "Resolve the invoice number first." });
const context: ToolRecoveryContext<{ tenant: string }> = { applicationContext: { tenant: "tenant-a" },
  definition: { name: "get_invoice_detail", description: "Invoice read", input_schema: { type: "object", properties: { invoiceId: { type: "string" } }, required: ["invoiceId"], additionalProperties: false } },
  arguments: { invoiceId: "INV-1006" }, toolCallId: "call-1", executionKey: "intent-1", signal: new AbortController().signal };
function run(execute: (current: typeof context) => Promise<unknown>, policy: Partial<ToolRecoveryPolicy<typeof context.applicationContext, unknown>> = {}, signal = context.signal) {
  return runToolWithRecovery({ context: { ...context, signal }, execute,
    validateAndAuthorize: async () => undefined, policy: { effect: () => "read", initialDelayMs: 0, ...policy } });
}
afterEach(() => vi.useRealTimers());

describe("bounded tool recovery", () => {
  it("does not report successful first attempts", async () => {
    const record = vi.fn();
    expect(await run(async () => 1, { record })).toEqual({ value: 1 });
    expect(record).not.toHaveBeenCalled();
  });
  it("recovers after two transient failures and records one bounded receipt", async () => {
    const execute = vi.fn().mockRejectedValueOnce(transient()).mockRejectedValueOnce(transient()).mockResolvedValue(42);
    const record = vi.fn();
    expect(await run(execute, { record })).toMatchObject({ value: 42,
      recovery: { status: "recovered", attempts: 3, failedAttempts: 2 } });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]![0]).not.toHaveProperty("arguments");
  });
  it("stops after three executions", async () => {
    const execute = vi.fn(async () => { throw transient(); });
    await expect(run(execute)).rejects.toMatchObject({ summary: { attempts: 3, reason: "attempt_limit" } });
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("resolves the displayed invoice number and reauthorizes the corrected read", async () => {
    const execute = vi.fn(async (input: typeof context) => {
      if (input.arguments.invoiceId === "INV-1006") throw missing();
      return input.arguments.invoiceId;
    });
    const authorize = vi.fn(async () => undefined);
    const result = await runToolWithRecovery({ context, execute, validateAndAuthorize: authorize,
      policy: { effect: () => "read", repairArguments: async (input) => {
        expect(input.applicationContext).toBe(context.applicationContext);
        return { invoiceId: "subledger_document_03851b3114f17077" };
      } } });
    expect(result).toMatchObject({ value: "subledger_document_03851b3114f17077", recovery: { attempts: 2 } });
    expect(authorize).toHaveBeenCalledOnce();
    expect(context.arguments.invoiceId).toBe("INV-1006");
  });
  it.each([null, { invoiceId: "INV-1006" }])("stops when a repair supplies no new evidence (%s)", async (candidate) => {
    const execute = vi.fn(async () => { throw missing(); });
    await expect(run(execute, { repairArguments: async () => candidate })).rejects.toMatchObject({ summary: { reason: "no_progress" } });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("detects cycles in corrected arguments", async () => {
    const execute = vi.fn(async () => { throw missing(); });
    const repairArguments = vi.fn().mockResolvedValueOnce({ invoiceId: "other" }).mockResolvedValueOnce(context.arguments);
    await expect(run(execute, { repairArguments })).rejects.toMatchObject({ summary: { attempts: 2, reason: "no_progress" } });
  });
  it.each(["permission_denied", "business_rule", "cancelled", "bug", "missing_capability"] as const)("does not retry %s", async (category) => {
    const execute = vi.fn(async () => { throw new ToolFailureError({ category, code: "terminal_failure", message: "Unavailable." }); });
    const repairArguments = vi.fn();
    await expect(run(execute, { repairArguments })).rejects.toMatchObject({ failure: { category } });
    expect(execute).toHaveBeenCalledOnce();
    expect(repairArguments).not.toHaveBeenCalled();
  });
  it("does not replay a write whose outcome is unknown", async () => {
    const execute = vi.fn(async () => { throw transient(); });
    await expect(run(execute, { effect: () => "write" })).rejects.toMatchObject({ summary: { reason: "unknown_outcome" } });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("recovers an already completed write from its authoritative receipt", async () => {
    const execute = vi.fn(async () => { throw transient(); });
    expect(await run(execute, { effect: () => "write", verifyWriteOutcome: async () => ({ status: "completed", value: { journalId: "journal-1" } }) }))
      .toMatchObject({ value: { journalId: "journal-1" }, recovery: { status: "recovered", attempts: 1 } });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("reuses the exact identity only after proof that a write was not applied", async () => {
    const execute = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("posted");
    const verify = vi.fn(async () => ({ status: "not_applied" as const }));
    expect(await run(execute, { effect: () => "write", verifyWriteOutcome: verify })).toMatchObject({ value: "posted" });
    expect(execute.mock.calls.map(([input]) => [input.executionKey, input.arguments])).toEqual([
      ["intent-1", { invoiceId: "INV-1006" }], ["intent-1", { invoiceId: "INV-1006" }],
    ]);
    expect(verify).toHaveBeenCalledOnce();
  });
  it("stops a corrected call when authorization changes", async () => {
    const execute = vi.fn(async () => { throw missing(); });
    await expect(runToolWithRecovery({ context, execute,
      validateAndAuthorize: async () => { throw new ToolFailureError({ category: "permission_denied", code: "denied", message: "Denied." }); },
      policy: { effect: () => "read", repairArguments: async () => ({ invoiceId: "resolved" }) },
    })).rejects.toMatchObject({ failure: { category: "permission_denied" } });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("honors cancellation while waiting and never starts another call", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const execute = vi.fn(async () => { throw transient(); });
    const promise = run(execute, { initialDelayMs: 500 }, controller.signal);
    const rejected = expect(promise).rejects.toMatchObject({ failure: { category: "cancelled" } });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await rejected;
    expect(execute).toHaveBeenCalledOnce();
  });
  it("charges failed reauthorization to the recovery budget instead of spinning without execution", async () => {
    const execute = vi.fn(async () => { throw transient(); });
    const validateAndAuthorize = vi.fn(async () => { throw transient(); });
    await expect(runToolWithRecovery({ context, execute, validateAndAuthorize,
      policy: { effect: () => "read", initialDelayMs: 0 },
    })).rejects.toMatchObject({ summary: { attempts: 1, failedAttempts: 3, reason: "attempt_limit" } });
    expect(execute).toHaveBeenCalledOnce();
    expect(validateAndAuthorize).toHaveBeenCalledTimes(2);
  });
  it("bounds stalled calls and ignores late results", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise(() => undefined));
    const result = expect(run(execute, { attemptTimeoutMs: 10, maxElapsedMs: 25 })).rejects.toMatchObject({ summary: { status: "failed" } });
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(execute).toHaveBeenCalledTimes(3);
  });
  it("does not shorten Retry-After to squeeze in another call", async () => {
    const execute = vi.fn(async () => { throw new ToolFailureError({ ...transient().failure, retryAfterMs: 60_000 }); });
    await expect(run(execute, { maxElapsedMs: 100 })).rejects.toMatchObject({ summary: { reason: "deadline" } });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("keeps reporting errors from replacing recovered results", async () => {
    const execute = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("safe");
    expect(await run(execute, { record: async () => { throw new Error("reporter down"); } })).toMatchObject({ value: "safe" });
  });
  it("preserves ledger replay and validates repaired inputs through the real executor", async () => {
    const registry = new ToolRegistry<ApplicationToolExecutor<typeof context.applicationContext>, typeof context.applicationContext>();
    const execute = vi.fn(async () => { throw missing(); });
    registry.register({ definition: context.definition, executor: execute });
    const executor = new BoundedToolExecutor({ registry, policy: () => ({ outcome: "allow" }),
      recovery: { effect: () => "read", repairArguments: async () => ({ invoiceId: "resolved", tenant: "other" }) } });
    const request = { call: { name: context.definition.name, tool_call_id: "call-1", arguments: context.arguments },
      applicationContext: context.applicationContext, discoveredTools: registry.discover({ context: context.applicationContext }) };
    expect((await executor.execute(request)).is_error).toBe(true);
    expect((await executor.execute(request)).is_error).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});
