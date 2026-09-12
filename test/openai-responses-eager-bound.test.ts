import { expect, it, vi } from "vitest";
import { createOpenAIResponsesProviderAdapter, type OpenAIResponsesRequest } from "../src/providers/openai.js";
import type { ProviderAdapterInvocation } from "../src/providers/index.js";

const attribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
} as const;

it.each([
  { bound: undefined, count: 16, expected: "completed" },
  { bound: undefined, count: 17, expected: "failed" },
  { bound: 128, count: 89, expected: "completed" },
  { bound: 88, count: 89, expected: "failed" },
  { bound: 128, count: 129, expected: "failed" },
  { bound: 1024, count: 257, expected: "failed" },
  ...[0, -1, 1.5, Infinity, NaN, 1025].map(bound => ({ bound, count: 1, expected: "failed" })),
])("enforces eager bound $bound for $count authorized tools ($expected)", async ({ bound, count, expected }) => {
  const request = vi.fn(async function* (input: OpenAIResponsesRequest) {
    void input;
    yield { type: "response.output_text.delta", delta: "Ready." };
    yield { type: "response.completed", response: { status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Ready." }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
  });
  const adapter = createOpenAIResponsesProviderAdapter({ model: "test", request,
    supportsToolSearch: false, hosted: { toolSearch: false, webSearch: false },
    ...(bound === undefined ? {} : { maximumEagerTools: bound }),
  });
  const tools = Array.from({ length: count }, (_, index) => ({ name: `authorized_${index}`,
    description: `Authorized operation ${index}`, input_schema: { type: "object" as const, properties: {} } }));
  const invocation: ProviderAdapterInvocation = { tools, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, signal: new AbortController().signal,
    context: { request_id: "request", trace_id: "trace", attribution, correlation_hints: {} } };
  const stream = adapter.invoke(invocation);
  let step = await stream.next();
  while (!step.done) step = await stream.next();
  expect(step.value.status).toBe(expected);
  if (expected === "completed") {
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toMatchObject({ tools: tools.map(tool => ({ name: tool.name, type: "function" })) });
  } else expect(request).not.toHaveBeenCalled();
});

it.each([undefined, 128])("forwards host eager bound %s through the SDK server provider", async bound => {
  const { openaiResponses } = await import("../src/server/openai-responses.js");
  const { InMemoryOpenAIResponsesContinuationStore } = await import("../src/providers/openai-responses.js");
  const calls: OpenAIResponsesRequest[] = [];
  const provider = openaiResponses({ model: "test", supportsToolSearch: false,
    ...(bound === undefined ? {} : { maximumEagerTools: bound }),
    request: async function* (request) {
      calls.push(request);
      yield { type: "response.output_text.delta", delta: "Ready." };
      yield { type: "response.completed", response: { status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Ready." }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
    },
  });
  const definitions = Array.from({ length: 89 }, (_, index) => ({ name: `authorized_${index}`,
    description: `Authorized operation ${index}`, input_schema: { type: "object" as const, properties: {} } }));
  const execute = vi.fn();
  const input: Parameters<typeof provider.createTransport>[0] = {
    context: { principalId: "user", tenantId: "tenant", scopeId: "owner", attribution }, instructions: [],
    tools: { definitions, execute, awaitApproval: vi.fn() },
    persistence: { continuation: new InMemoryOpenAIResponsesContinuationStore(), usageAdmissions: null, usageReceiptSink: null } as unknown as Parameters<typeof provider.createTransport>[0]["persistence"],
    limits: { maxIterations: 4, maxTotalToolCalls: 4, maxElapsedMs: 10_000, parallelism: 1 },
    toolActivity: { waitForApproval: async () => { throw new Error("Unexpected approval"); },
      observe: async (_location, run) => (await run(async () => {})).value },
  };
  const transport = await provider.createTransport(input);
  const started = await transport.startTurn({ conversationId: "conversation", conversationTurnId: "turn" as never,
    mutationId: "mutation" as never, idempotencyKey: "request", request: {
      protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], tools: [], tool_results: [],
      generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {},
    } });
  if (!started.ok) throw new Error(started.error.message);
  for await (const event of started.value.observation.events) void event;
  expect(await started.value.observation.result).toMatchObject({ status: bound === undefined ? "failed" : "completed" });
  expect(calls).toHaveLength(bound === undefined ? 0 : 1);
  if (bound !== undefined) expect(calls[0]?.tools.map(tool => tool.type === "function" ? tool.name : tool.type)).toEqual(definitions.map(tool => tool.name));
  expect(execute).not.toHaveBeenCalled();
});
