import { describe, expect, it } from "vitest";

import { AI_RUNTIME_PROTOCOL_VERSION, parseStreamEvents, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import type { ProviderAdapter, ProviderAdapterInvocation, ProviderAdapterResult } from "../src/providers/index.js";
import { createProviderToolLoopTransport } from "../src/server/provider-tool-loop.js";
import type { NormalizedUsageReceipt } from "../src/usage.js";

const attribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
  known_user: { id: "user", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
} as const;

const usage = { input_tokens: 2, cached_input_tokens: 0, output_tokens: 1, reasoning_tokens: 0,
  total_tokens: 3, provider_cost: { known: false as const } };

function event(invocation: ProviderAdapterInvocation, sequence: number, value: object): StreamEvent {
  return { ...value, protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id, sequence } as StreamEvent;
}

describe("createProviderToolLoopTransport", () => {
  it.each([false, true])("runs continuations and reports unfinished iteration limits (limited=%s)", async (limited) => {
    let invocations = 0;
    const adapter: ProviderAdapter = {
      metadata: { provider_id: "fake", model_id: "fake-model", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null,
      } },
      provider_context: { supported: false, reason: "provider_not_supported" },
      async *invoke(input) {
        const current = invocations++;
        yield event(input, 0, { type: "response.started", attribution });
        if (current === 0) {
          yield event(input, 1, { type: "response.tool_call", tool_call_id: "call-1", name: "lookup",
            arguments: { id: "42" } });
          yield event(input, 2, { type: "response.completed", outcome: "tool_calls" });
          return { status: "completed", outcome: "tool_calls", usage } satisfies ProviderAdapterResult;
        }
        expect(input.continuation_of).toBe("request-0");
        expect(input.tool_results).toMatchObject([{ tool_call_id: "call-1", name: "lookup", is_error: false }]);
        yield event(input, 1, { type: "response.text.delta", delta: "Found it" });
        yield event(input, 2, { type: "response.completed", outcome: "stop" });
        return { status: "completed", outcome: "stop", usage } satisfies ProviderAdapterResult;
      },
    };
    const receipts: NormalizedUsageReceipt[] = [];
    const transport = createProviderToolLoopTransport({
      adapter, tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object" } }],
      limits: { maxIterations: limited ? 1 : 4, maxTotalToolCalls: 4, maxElapsedMs: 10_000, parallelism: 1 },
      createContext: ({ iteration }) => ({ request_id: `request-${iteration}`, trace_id: "trace-1", attribution,
        correlation_hints: {} }),
      executeTool: ({ call }) => ({ status: "completed", result: { tool_call_id: call.tool_call_id,
        name: call.name, content: [{ type: "json", value: { ok: true } }], is_error: false } }),
      captureUsage: (receipt) => { receipts.push(receipt); },
    });
    const request: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Find 42" }] }], tools: [], tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
    const started = await transport.startTurn({ conversationId: "conversation-1", conversationTurnId: "turn-1" as never,
      mutationId: "mutation-1" as never, idempotencyKey: "idem-1", request });
    if (!started.ok) throw new Error(started.error.message);
    const events: StreamEvent[] = [];
    for await (const item of started.value.observation.events) events.push(item);

    if (limited) {
      expect(await started.value.observation.result).toMatchObject({ status: "failed", error: { retryable: false } });
      expect(events.at(-1)).toMatchObject({ type: "response.error" });
      expect(events.some((item) => item.type === "response.completed")).toBe(false);
      expect(receipts).toHaveLength(1);
      return;
    }
    expect((await started.value.observation.result).status).toBe("completed");
    expect(parseStreamEvents(events).map((item) => item.type)).toEqual([
      "response.started", "response.tool_call", "response.text.delta", "response.usage", "response.completed",
    ]);
    expect(invocations).toBe(2);
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.continuation.index)).toEqual([0, 1]);
  });

  it("pauses an approval-gated call and continues with the confirmed result", async () => {
    let invocations = 0, executions = 0, approvals = 0;
    const adapter: ProviderAdapter = {
      metadata: { provider_id: "fake", model_id: "fake-model", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null,
      } },
      provider_context: { supported: false, reason: "provider_not_supported" },
      async *invoke(input) {
        const current = invocations++;
        yield event(input, 0, { type: "response.started", attribution });
        if (current === 0) {
          yield event(input, 1, { type: "response.tool_call", tool_call_id: "call-approved", name: "delete",
            arguments: { id: "42" } });
          return { status: "completed", outcome: "tool_calls", usage } satisfies ProviderAdapterResult;
        }
        expect(input.tool_results).toMatchObject([{ tool_call_id: "call-approved", is_error: false }]);
        yield event(input, 1, { type: "response.text.delta", delta: "Deleted" });
        return { status: "completed", outcome: "stop", usage } satisfies ProviderAdapterResult;
      },
    };
    const transport = createProviderToolLoopTransport({ adapter,
      tools: [{ name: "delete", description: "Delete", input_schema: { type: "object" } }],
      limits: { maxIterations: 4, maxTotalToolCalls: 4, maxElapsedMs: 10_000, parallelism: 1 },
      createContext: ({ iteration }) => ({ request_id: `approval-${iteration}`, trace_id: "trace-approval",
        attribution, correlation_hints: {} }),
      executeTool: ({ call }) => ({ status: "external_approval_required", toolCallId: call.tool_call_id,
        name: call.name }),
      async awaitApproval({ call }) {
        approvals += 1; executions += 1;
        return { status: "completed", result: { tool_call_id: call.tool_call_id, name: call.name,
          content: [{ type: "json", value: { deleted: true } }], is_error: false } };
      },
    });
    const request: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Delete 42" }] }], tools: [], tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
    const started = await transport.startTurn({ conversationId: "conversation-approval",
      conversationTurnId: "turn-approval" as never, mutationId: "mutation-approval" as never,
      idempotencyKey: "idem-approval", request });
    if (!started.ok) throw new Error(started.error.message);
    const events: StreamEvent[] = [];
    for await (const item of started.value.observation.events) events.push(item);

    expect((await started.value.observation.result).status).toBe("completed");
    expect(parseStreamEvents(events).at(-1)?.type).toBe("response.completed");
    expect({ invocations, approvals, executions }).toEqual({ invocations: 2, approvals: 1, executions: 1 });
  });
});
