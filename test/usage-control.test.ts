import { describe, expect, it, vi } from "vitest";

import {
  createAIRuntimeUsageClient,
  createAIRuntimeUsageClientFromEnv,
  createAIRuntimeUsageReceiptSink,
  createAIRuntimeUsageDelivery,
  type AIRuntimeUsageOutboxEntry,
} from "../src/server/usage-control.js";
import { createAIRuntimeQuotaLeaseClient } from "../src/server/usage-control.js";
import { parseNormalizedUsageReceipt } from "../src/usage.js";

function receipt(id = "receipt-1") {
  return parseNormalizedUsageReceipt({
    version: 1, usage_receipt_id: id, conversation_id: "conversation-1", turn_id: "turn-1",
    logical_request_id: "logical-1", trace_id: "trace-1",
    attempt: { id: "attempt-0", index: 0 }, continuation: { id: "continuation-0", index: 0 },
    provider_id: "openai", model_id: "gpt-5.1",
    attribution: {
      organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
      project: { id: "project-1", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "service-env-1", source: "server_derived", trust: "authoritative" },
      known_user: { id: null, source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    },
    source: "provider", terminal_status: "completed",
    tokens: {
      input_tokens: { status: "reported", value: 10 }, cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "reported", value: 5 }, reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "reported", value: 15 },
    },
    provider_cost: { status: "unavailable" },
  });
}

describe("AI Runtime usage-control client", () => {
  it("treats blank environment configuration as absent and uses the API URL fallback", async () => {
    const env = { HANDRAIL_AI_RUNTIME_ENABLED: "true", HANDRAIL_AI_RUNTIME_TELEMETRY_URL: "  ",
      HANDRAIL_AI_RUNTIME_API_URL: " https://telemetry.example/api/ai-runtime/v1/ ",
      HANDRAIL_AI_RUNTIME_TOKEN: " server-token ", HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID: " service-env-1 " };
    const fetcher = vi.fn(async () => Response.json({ accepted_count: 1 }));
    const client = createAIRuntimeUsageClientFromEnv(env, { fetch: fetcher });
    expect(client).not.toBeNull();
    await client!.settle({ requestId: "turn-1", receipts: [receipt()] });
    expect(fetcher).toHaveBeenCalledWith("https://telemetry.example/api/ai-usage/v1/receipts", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer server-token" }),
      body: expect.stringContaining('"service_env_id":"service-env-1"'),
    }));
    for (const key of ["HANDRAIL_AI_RUNTIME_TOKEN", "HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID"]) {
      expect(createAIRuntimeUsageClientFromEnv({ ...env, [key]: "  " }, { fetch: fetcher })).toBeNull();
    }
    expect(createAIRuntimeUsageClientFromEnv({ ...env, HANDRAIL_AI_RUNTIME_API_URL: " " })).toBeNull();
    expect(createAIRuntimeUsageClientFromEnv({ ...env, HANDRAIL_AI_RUNTIME_ENABLED: "false" })).toBeNull();
  });

  it("keeps admission local and observe-only so Handrail availability cannot block a provider call", async () => {
    const fetcher = vi.fn();
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" });
    expect(result.request.id).toBe("logical-1");
    expect(result.policy_decision).toMatchObject({ enforcement_mode: "observe", decision: "allow", reason_code: "telemetry_observe_only" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates local admission identities", async () => {
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: vi.fn() });
    await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" });
    expect((await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" })).replayed).toBe(true);
  });

  it("submits validated per-invocation receipts and a terminal request status", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(_url)).toBe("https://telemetry.example/api/ai-usage/v1/receipts");
      expect(body).toMatchObject({ service_env_id: "service-env-1" });
      expect(body.receipts.map((item: { usage_receipt_id: string }) => item.usage_receipt_id)).toEqual(["receipt-1", "receipt-2"]);
      expect(body).not.toHaveProperty("request_status");
      return new Response(JSON.stringify({ accepted_count: 2, duplicate_count: 0 }), { status: 202 });
    });
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.settle({ requestId: "request-1", receipts: [receipt("receipt-1"), receipt("receipt-2")], requestStatus: "cancelled" });
    expect(result.accepted_receipts).toBe(2);
  });

  it("durably enqueues receipts before delivery and retries the same receipt identity", async () => {
    const rows = new Map<string, AIRuntimeUsageOutboxEntry>();
    const outbox = {
      enqueue: vi.fn(async (entry: AIRuntimeUsageOutboxEntry) => { rows.set(entry.receipt.usage_receipt_id, entry); }),
      pending: vi.fn(async (limit: number) => [...rows.values()].slice(0, limit)),
      acknowledge: vi.fn(async (id: string) => { rows.delete(id); }),
      failed: vi.fn(async () => undefined),
    };
    const client = {
      admit: vi.fn(),
      settle: vi.fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ accepted_receipts: 1 }),
    };
    const sink = createAIRuntimeUsageReceiptSink(client as never, outbox);
    await sink.capture(receipt("receipt-durable"));
    await vi.waitFor(() => expect(outbox.failed).toHaveBeenCalled());
    expect(rows.has("receipt-durable")).toBe(true);
    await sink.flush();
    expect(client.settle).toHaveBeenLastCalledWith(expect.objectContaining({
      requestId: "turn-1",
      receipts: [expect.objectContaining({ usage_receipt_id: "receipt-durable" })],
      requestStatus: "succeeded",
    }));
    expect(rows.size).toBe(0);
  });
});

describe("AI Runtime quota lease foundation", () => {
  it("hard-stops before the next invocation only for an explicit strict deny lease", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ lease_id: "lease-1", logical_request_id: "logical-1", enforcement_mode: "deny", decision: "deny", reason_code: "period_token_ceiling_exceeded", reserved_tokens: 0, output_token_limit: 100, strict: true, expires_at: new Date().toISOString() }), { status: 429 }));
    const client = createAIRuntimeQuotaLeaseClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const lease = await client.acquire({ logicalRequestId: "logical-1", requestedTokens: 10 });
    expect(() => client.assertCanInvoke(lease)).toThrow(/preflight denied/i);
    expect(fetcher).toHaveBeenCalledWith("https://telemetry.example/api/ai-usage/v1/leases", expect.any(Object));
  });
});


describe("shared usage delivery worker", () => {
  it("coalesces periodic delivery, survives failure and stops future work", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.fn(async () => {});
    const onError = vi.fn();
    const worker = createAIRuntimeUsageDelivery({ flush, onError, retryIntervalMilliseconds: 10 });
    try {
      await worker.ready;
      expect(flush).toHaveBeenCalledOnce();
      flush.mockImplementationOnce(() => held);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(50);
      expect(flush).toHaveBeenCalledTimes(2);
      release();
      await vi.advanceTimersByTimeAsync(0);
      flush.mockRejectedValueOnce(new Error("delivery offline"));
      await vi.advanceTimersByTimeAsync(10);
      expect(onError).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(flush).toHaveBeenCalledTimes(4);
      worker.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(flush).toHaveBeenCalledTimes(4);
    } finally { worker.stop(); vi.useRealTimers(); }
  });

  it("stop during startup prevents creating a later timer, while disabled mode stays idle", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const flush = vi.fn(() => held);
    const worker = createAIRuntimeUsageDelivery({ flush, retryIntervalMilliseconds: 10 });
    const disabled = createAIRuntimeUsageDelivery({ flush, enabled: false });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(flush).toHaveBeenCalledOnce();
      let stopped = false;
      const stopping = worker.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping;
      await worker.ready; await disabled.ready;
      await vi.advanceTimersByTimeAsync(100);
      expect(flush).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { worker.stop(); disabled.stop(); vi.useRealTimers(); }
  });
});
