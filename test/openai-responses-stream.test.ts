import { describe, expect, it } from "vitest";
import { correlateOpenAIResponsesFunctionCalls } from "../src/providers/openai-responses-stream.js";

const added = (id = "fc_1", callId = "call_1", outputIndex = 0) => ({ type: "response.output_item.added", output_index: outputIndex,
  item: { type: "function_call", id, call_id: callId, name: "get_billable_expense_receipt", namespace: "billable_expenses", arguments: "" } });
const done = (itemId = "fc_1", outputIndex = 0) => ({ type: "response.function_call_arguments.done", item_id: itemId,
  output_index: outputIndex, name: "get_billable_expense_receipt", arguments: '{"purchaseId":"synthetic"}' });
async function collect(events: unknown[]) {
  const result = [];
  for await (const event of correlateOpenAIResponsesFunctionCalls((async function* () { yield* events; })())) result.push(event);
  return result;
}
describe("Responses wire function identities", () => {
  it("correlates interleaved items by item ID and preserves native output and unrelated events", async () => {
    const text = { type: "response.output_text.delta", delta: "Synthetic" };
    const events = [added(), added("fc_2", "call_2", 2), text, done("fc_2", 2), done()];
    const result = await collect(events);
    expect(result.slice(0, 3)).toEqual(events.slice(0, 3));
    expect(result[3]).toEqual({ ...done("fc_2", 2), call_id: "call_2", namespace: "billable_expenses" });
    expect(result[4]).toEqual({ ...done(), call_id: "call_1", namespace: "billable_expenses" });
  });
  it.each([
    [done()], [added(), done("unknown")], [added(), done("fc_1", 9)], [added(), { ...done(), name: "create_bill" }],
    [added(), { ...done(), call_id: "different" }], [added(), { ...done(), namespace: "other" }],
    [added(), done(), done()], [added(), added()], [added(), added("fc_2")],
  ])("rejects missing, conflicting or repeated identity without exposing arguments %#", async (...events) => {
    await expect(collect(events)).rejects.toThrow("The provider function event identity is inconsistent");
  });
  it("leaves explicitly projected events compatible with injected request adapters", async () => {
    const event = { type: "response.function_call_arguments.done", call_id: "call_1", name: "read", arguments: "{}" };
    expect(await collect([event])).toEqual([event]);
  });
  it("uses the paired output item when the arguments event omits the function name", async () => {
    expect((await collect([added(), { ...done(), name: undefined }]))[1]).toEqual({ ...done(), call_id: "call_1", namespace: "billable_expenses" });
  });
});
