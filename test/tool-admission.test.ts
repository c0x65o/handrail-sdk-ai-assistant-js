import { expect, it, vi } from "vitest";
import { BoundedToolExecutor, InMemoryToolExecutionLedger, ToolRegistry,
  type ApplicationToolExecutor, type ApplicationToolAdmission } from "../src/index.js";

function fixture(admission: ApplicationToolAdmission<{ allowed: boolean }>, gate: "policy" | "executor" = "executor") {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const effect = vi.fn<ApplicationToolExecutor<{ allowed: boolean }>>(async args => {
    if (gate === "executor") await wait;
    return { protectedReceipt: args.value! };
  });
  const registry = new ToolRegistry<ApplicationToolExecutor<{ allowed: boolean }>>();
  registry.register({ definition: { name: "save", description: "Save", input_schema: { type: "object" } }, executor: effect });
  const policy = vi.fn(async () => { if (gate === "policy") await wait; return { outcome: "allow" as const }; });
  const ledger = new InMemoryToolExecutionLedger();
  const executor = new BoundedToolExecutor({ registry, policy, ledger, admission, limits: { timeoutMs: 1000 } });
  const request = { call: { tool_call_id: "exact", name: "save", arguments: { value: "private" } },
    executionKey: "scoped-exact", discoveredTools: registry.discover({ context: undefined }), applicationContext: { allowed: true } };
  return { executor, request, effect, policy, ledger, release };
}

it.each(["policy", "executor"] as const)("authorizes each caller before joining at the %s stage", async stage => {
  const admission = vi.fn<ApplicationToolAdmission<{ allowed: boolean }>>(input => ({ outcome: input.applicationContext.allowed ? "allow" : "deny" }));
  const f = fixture(admission, stage);
  const first = f.executor.executeDetailed(f.request);
  try {
    await vi.waitFor(() => expect(stage === "policy" ? f.policy : f.effect).toHaveBeenCalledOnce());
    const denied = await f.executor.executeDetailed({ ...f.request, applicationContext: { allowed: false } });
    expect(denied).toMatchObject({ result: { is_error: true } });
    expect(JSON.stringify(denied)).not.toContain("protectedReceipt");
    const permitted = f.executor.executeDetailed(f.request);
    await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(3));
    const conflict = await f.executor.executeDetailed({ ...f.request, call: { ...f.request.call, arguments: { value: "changed" } } });
    expect(conflict).toMatchObject({ result: { is_error: true, content: [{ text: "Tool call identity conflicts with its original request." }] } });
    f.release();
    const original = await first;
    expect(original).toMatchObject({ result: { is_error: false } });
    expect(await permitted).toEqual(original);
    expect(await f.executor.executeDetailed({ ...f.request, applicationContext: { allowed: false } })).toEqual(denied);
    expect(await f.executor.executeDetailed(f.request)).toEqual(original);
    expect(await f.executor.executeDetailed({ ...f.request, discoveredTools: [] })).toMatchObject({ result: { is_error: true } });
    expect(f.effect).toHaveBeenCalledOnce();
    expect(f.policy).toHaveBeenCalledOnce();
  } finally { f.release(); await first; }
});

it.each(["throws", "invalid", "cancelled", "timeout"])("fails admission closed (%s) without retaining a denial", async mode => {
  let allow = false;
  const admission: ApplicationToolAdmission<{ allowed: boolean }> = async () => {
    if (allow) return { outcome: "allow" };
    if (mode === "throws") throw new Error("private resolver failure");
    if (mode === "timeout") return new Promise(() => {});
    return { outcome: "external_approval_required" } as never;
  };
  const f = fixture(admission);
  f.release();
  const result = await f.executor.executeDetailed({ ...f.request,
    ...(mode === "cancelled" ? { signal: AbortSignal.abort() } : {}) });
  expect(result).toMatchObject({ result: { is_error: true } });
  expect(JSON.stringify(result)).not.toContain("private resolver failure");
  expect(f.policy).not.toHaveBeenCalled();
  expect(f.effect).not.toHaveBeenCalled();
  expect(f.ledger.get(f.request.executionKey)).toBeUndefined();
  allow = true;
  expect(await f.executor.executeDetailed(f.request)).toMatchObject({ result: { is_error: false } });
  expect(f.effect).toHaveBeenCalledOnce();
});

it("isolates admission arguments from the immutable retry identity and dispatch", async () => {
  const f = fixture(input => { input.arguments.value = "tampered"; return { outcome: "allow" }; });
  f.release();
  const result = await f.executor.executeDetailed(f.request);
  expect(result).toMatchObject({ result: { content: [{ value: { protectedReceipt: "private" } }] } });
  expect(await f.executor.executeDetailed(f.request)).toEqual(result);
  expect(f.effect).toHaveBeenCalledOnce();
});
