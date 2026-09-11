import { expect, it, vi } from "vitest";
import { BoundedToolExecutor, ToolRegistry, ToolFailureError, type ApplicationToolExecutor,
  type ApplicationToolPolicy, type ApplicationToolExecutionLocation, type ToolDefinition } from "../src/index.js";

const applicationContext = { userId: "alice" };
const definition: ToolDefinition = { name: "lookup", description: "Read an authorized household record",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const call = { tool_call_id: "provider-call", name: "lookup", arguments: { query: "record" } };
const location = { conversationId: "conversation-a", turnId: "turn-a" };

function fixture(executor: ApplicationToolExecutor<typeof applicationContext>, policy: ApplicationToolPolicy<typeof applicationContext>) {
  const registry = new ToolRegistry<ApplicationToolExecutor<typeof applicationContext>, undefined>();
  registry.register({ definition, executor });
  return { registry, discoveredTools: registry.discover({ context: undefined }), policy };
}

it("isolates concurrent tool locations, snapshots them before awaiting, and preserves scoped replay", async () => {
  const seen: ApplicationToolExecutionLocation[] = [];
  const execute = vi.fn<ApplicationToolExecutor<typeof applicationContext>>(async (_arguments, context) => {
    await Promise.resolve();
    expect(context.applicationContext).toBe(applicationContext);
    expect(Object.isFrozen(context.location)).toBe(true);
    seen.push(context.location!);
    return { done: true };
  });
  const policy = vi.fn<ApplicationToolPolicy<typeof applicationContext>>(() => ({ outcome: "allow" }));
  const input = fixture(execute, policy), bounded = new BoundedToolExecutor(input);
  const mutable = { ...location };
  const request = { applicationContext, discoveredTools: input.discoveredTools, call, executionKey: "scoped-a", location: mutable };
  const first = bounded.execute(request);
  mutable.conversationId = "changed-after-dispatch";
  const other = { ...location, conversationId: "conversation-b", turnId: "turn-b" };
  const second = bounded.execute({ ...request, executionKey: "scoped-b", location: other });
  expect((await Promise.all([first, second])).every(result => !result.is_error)).toBe(true);
  expect(seen).toEqual([location, other]);
  expect(policy.mock.calls.map(([context]) => context.location)).toEqual([location, other]);
  expect((await bounded.execute({ ...request, location })).is_error).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
});

it("keeps completed execution identities from before location metadata was available", async () => {
  const execute = vi.fn<ApplicationToolExecutor<typeof applicationContext>>(async () => ({ retained: true }));
  const input = fixture(execute, () => ({ outcome: "allow" })), bounded = new BoundedToolExecutor(input);
  const request = { applicationContext, discoveredTools: input.discoveredTools, call, executionKey: "existing-scoped-identity" };
  const completed = await bounded.execute(request);
  expect(await bounded.execute({ ...request, location })).toEqual(completed);
  expect(execute).toHaveBeenCalledOnce();
});

it("rejects a location different from persisted approval evidence before policy or dispatch", async () => {
  const execute = vi.fn<ApplicationToolExecutor<typeof applicationContext>>(async () => ({ changed: true }));
  const policy = vi.fn<ApplicationToolPolicy<typeof applicationContext>>(() => ({ outcome: "allow" }));
  const input = fixture(execute, policy), bounded = new BoundedToolExecutor(input);
  const result = await bounded.execute({ applicationContext, discoveredTools: input.discoveredTools, call, location,
    approval: { conversationId: "different-conversation", turnId: location.turnId } as never });
  expect(result.is_error).toBe(true);
  expect(policy).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it("preserves the location during authorized recovery and its repeated policy check", async () => {
  const execute = vi.fn<ApplicationToolExecutor<typeof applicationContext>>()
    .mockRejectedValueOnce(new ToolFailureError({ category: "transient", code: "temporary", message: "Temporary" }))
    .mockImplementation(async (_arguments, context) => {
      expect(context.location).toEqual(location);
      return { read: true };
    });
  const policy = vi.fn<ApplicationToolPolicy<typeof applicationContext>>(() => ({ outcome: "allow" }));
  const input = fixture(execute, policy);
  const effect = vi.fn(() => "read" as const);
  const bounded = new BoundedToolExecutor({ ...input, recovery: { effect, initialDelayMs: 0 } });
  expect((await bounded.execute({ applicationContext, discoveredTools: input.discoveredTools, call, location })).is_error).toBe(false);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(policy.mock.calls.every(([context]) => JSON.stringify(context.location) === JSON.stringify(location))).toBe(true);
  expect(policy).toHaveBeenCalledTimes(2);
  expect(effect).toHaveBeenCalledWith(expect.objectContaining({ location }));
});
