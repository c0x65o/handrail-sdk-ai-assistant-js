import { describe, expect, it, vi } from "vitest";
import { createHandrailAssistant, createProviderToolLoopTransport,
  type HandrailAssistantAuthorizationContext, type HandrailAssistantProvider } from "../src/server/assistant.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import { InMemoryToolExecutionLedger, type ApplicationToolExecutor } from "../src/tools/executor.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import type { ConversationActivityRecord } from "../src/conversation/activity.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type ChatRequest, type StreamEvent } from "../src/protocol.js";
import type { ProviderAdapter } from "../src/providers/index.js";
import type { ConversationTransport } from "../src/transports/types.js";
import { replayConversation } from "../src/conversation/replay.js";

type Context = HandrailAssistantAuthorizationContext;
const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
  total_tokens: 0, provider_cost: { known: false as const } };
const context: Context = { principalId: "user", tenantId: "tenant", scopeId: "project", attribution: {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: "user", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
} };

describe("assistant bulk work", () => {
  it.each([false, true])("runs sequential bulk steps with project approvals required=%s", async (requireApproval) => {
    vi.useFakeTimers();
    try {
      const summaries = ["Tracing prior invoices", "Updating product accounts",
        "Creating corrective journals", "Comparing monthly P&L"];
      const records = new Map<string, ConversationActivityRecord>();
      const reported: string[] = [];
      const events = new InMemoryConversationEventStore();
      const approvals = new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" });
      const bundle = { events, approvals,
        catalog: new InMemoryConversationCatalog<Context>({ authorize: () => "allow" }),
        durableTurns: new InMemoryDurableApplicationTurnStore(), toolLedger: new InMemoryToolExecutionLedger(),
        activity: { async list() { return [...records.values()]; },
          async upsert(record: ConversationActivityRecord) {
            records.set(String(record.conversationId), record);
            if (record.summary) reported.push(record.summary);
            return record;
          }, async markRead() { return null; } },
        usageReceiptSink: null, usageAdmissions: null,
      } as unknown as PostgresAssistantPersistenceBundle<Context>;
      for (const id of ["bulk", "independent"]) await bundle.catalog.create({ authorizationContext: context,
        conversationId: id as never, idempotencyKey: `create-${id}` as never });
      const persistence = { attachmentLimits: { maximumBytes: 1_000,
        acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60_000 }, persistence: {},
        forScope: () => bundle } as unknown as PostgresAssistantPersistence;
      const executed: string[] = [];
      const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context, Context>({
        pluginId: "bulk.test", version: "1.0.0", displayName: "Bulk test",
        registrations: summaries.map((summary, index) => ({
          definition: { name: `step_${index}`, description: summary, input_schema: { type: "object" } },
          executor: async (_arguments, execution) => {
            await execution.reportActivity?.({ summary, progress: { completed: index, total: 4, unit: "steps" } });
            // This exceeds the default 30-second tool timeout.
            await new Promise((resolve) => setTimeout(resolve, 31_000));
            executed.push(summary);
            return { step: index, done: true };
          },
        })),
        approvals: summaries.map((summary, index) => ({ toolName: `step_${index}`,
          mode: "policy", summarize: () => summary })),
      });
      let iteration = 0;
      const adapter: ProviderAdapter = {
        metadata: { provider_id: "test", model_id: "test", capabilities: {
          streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
          document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
          context_window_tokens: null, max_output_tokens: null,
        } },
        provider_context: { supported: false, reason: "provider_not_supported" },
        async *invoke(input) {
          const step = iteration++;
          const frame = (sequence: number, value: object) => ({ ...value, sequence,
            protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: input.context.request_id,
            trace_id: input.context.trace_id }) as StreamEvent;
          if (step > 0) expect(input.tool_results).toMatchObject([{ is_error: false,
            content: [{ type: "json", value: { step: step - 1, done: true } }] }]);
          yield frame(0, { type: "response.started", attribution: context.attribution });
          if (step < summaries.length) {
            yield frame(1, { type: "response.tool_call", tool_call_id: `call-${step}`,
              name: `step_${step}`, arguments: {} });
            return { status: "completed", outcome: "tool_calls", usage };
          }
          yield frame(1, { type: "response.text.delta", delta: "Finished all four steps" });
          return { status: "completed", outcome: "stop", usage };
        },
      };
      let transport!: ConversationTransport<StreamEvent, ChatRequest>;
      let tools!: Parameters<HandrailAssistantProvider<Context>["createTransport"]>[0]["tools"];
      const assistant = await createHandrailAssistant<Context>({ id: "bulk", authorize: () => context,
        persistence, tools: [plugin], toolPolicy: () => ({ outcome: "allow" }),
        approvalPolicy: () => requireApproval ? "require_approval" : "allow_without_approval",
        toolExecutorLimits: { timeoutMs: 60_000 }, toolLoopLimits: { maxElapsedMs: 300_000 },
        provider: { metadata: adapter.metadata, createTransport(input) {
          tools = input.tools;
          transport = createProviderToolLoopTransport({ adapter, tools: [...tools.definitions], limits: input.limits,
            createContext: ({ iteration: index }) => ({ request_id: `request-${index}`, trace_id: "trace",
              attribution: context.attribution, correlation_hints: {} }),
            executeTool: ({ call, signal, ...location }) => tools.execute(call, signal, location),
          });
          return transport;
        } },
      });
      expect((await assistant.handle(new Request("https://example.test/capabilities"))).status).toBe(200);
      if (requireApproval) {
        expect(await tools.execute({ tool_call_id: "requires-review", name: "step_0", arguments: {} },
          new AbortController().signal, { conversationId: "bulk", turnId: "turn" }))
          .toMatchObject({ status: "external_approval_required" });
        expect(executed).toEqual([]);
        const replay = await replayConversation({ conversationId: "bulk" as never, eventStore: events, checkpointPolicy: false });
        expect(replay.state.tool_calls).toHaveLength(1);
        expect(replay.state.tool_calls[0]).toMatchObject({ name: "step_0", started_at: null, result: null });
        expect(replay.state.tool_calls[0]?.approval_required_at).not.toBeNull();
        return;
      }
      const request: ChatRequest = { protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
        messages: [{ role: "user", content: [{ type: "text", text: "Reconcile revenue and compare months" }] }],
        tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };
      const started = await transport.startTurn({ conversationId: "bulk", conversationTurnId: "turn" as never,
        mutationId: "mutation" as never, idempotencyKey: "bulk", request });
      if (!started.ok) throw new Error(started.error.message);
      const frames: StreamEvent[] = [];
      const consume = (async () => { for await (const frame of started.value.observation.events) frames.push(frame); })();
      await vi.advanceTimersByTimeAsync(125_000);
      await consume;
      expect((await started.value.observation.result).status).toBe("completed");
      expect(executed).toEqual(summaries);
      expect(reported).toEqual(summaries);
      expect(records.size).toBe(1);
      const replay = await replayConversation({ conversationId: "bulk" as never, eventStore: events, checkpointPolicy: false });
      expect(replay.state.tool_calls).toHaveLength(4);
      expect(replay.state.tool_calls.every((call) => call.started_at !== null && call.result?.is_error === false)).toBe(true);
      expect(replay.state.tool_calls.map((call) => call.name)).toEqual(["step_0", "step_1", "step_2", "step_3"]);
      await tools.execute({ tool_call_id: "call-0", name: "step_0", arguments: {} }, new AbortController().signal,
        { conversationId: "bulk", turnId: "turn" });
      expect(executed).toEqual(summaries);
      // Another conversation may receive the same provider-local call ID. It
      // gets a separate execution, while retrying the original still reuses it.
      const independent = tools.execute({ tool_call_id: "call-0", name: "step_0", arguments: {} }, new AbortController().signal,
        { conversationId: "independent", turnId: "independent-turn" });
      await vi.advanceTimersByTimeAsync(32_000);
      expect(await independent).toMatchObject({ status: "completed", result: { tool_call_id: "call-0", is_error: false } });
      expect(executed).toEqual([...summaries, summaries[0]]);
      expect((await events.read({ conversationId: "bulk" as never })).entries
        .filter(({ event }) => event.payload.type === "tool_call.result_recorded")).toHaveLength(4);
      expect(frames.filter((frame) => frame.type === "response.started")).toHaveLength(1);
      expect(frames.at(-1)).toMatchObject({ type: "response.completed", outcome: "stop" });
      expect((await events.read({ conversationId: "bulk" as never })).entries
        .filter(({ event }) => event.payload.type === "approval.proposal_created")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
