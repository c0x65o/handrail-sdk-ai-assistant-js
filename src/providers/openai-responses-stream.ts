/** Correlate Responses wire events before normalizing an application function call.
 * OpenAI puts call_id/namespace on output_item.added, while arguments.done refers
 * to that item by item_id. Never invent an identity or infer a namespace from a
 * tool name: the SDK still checks it against the advertised tools.
 */
export async function* correlateOpenAIResponsesFunctionCalls(source: AsyncIterable<unknown>): AsyncIterable<unknown> {
  const calls = new Map<string, { callId: string; name: string; namespace: string | null; outputIndex: number; done: boolean }>();
  const callIds = new Set<string>();
  for await (const value of source) {
    const event = object(value);
    if (event?.type === "response.output_item.added") {
      const item = object(event.item);
      if (item?.type === "function_call") {
        if (!identifier(item.id) || !identifier(item.call_id) || !identifier(item.name)
          || !(item.namespace == null || identifier(item.namespace))
          || !Number.isSafeInteger(event.output_index) || Number(event.output_index) < 0
          || calls.has(item.id) || callIds.has(item.call_id) || calls.size >= 256) invalid();
        calls.set(item.id, { callId: item.call_id, name: item.name, namespace: item.namespace as string | null ?? null,
          outputIndex: Number(event.output_index), done: false });
        callIds.add(item.call_id);
      }
    } else if (event?.type === "response.function_call_arguments.done" && event.item_id !== undefined) {
      const call = typeof event.item_id === "string" ? calls.get(event.item_id) : undefined;
      if (!call || call.done || event.output_index !== call.outputIndex || event.name !== undefined && event.name !== call.name
        || typeof event.arguments !== "string" || event.call_id !== undefined && event.call_id !== call.callId
        || event.namespace !== undefined && event.namespace !== call.namespace) invalid();
      call.done = true;
      yield { ...event, name: call.name, call_id: call.callId, ...(call.namespace === null ? {} : { namespace: call.namespace }) };
      continue;
    }
    yield value;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
function invalid(): never { throw new Error("The provider function event identity is inconsistent"); }
