import { parseNormalizedUsageReceipt, type NormalizedUsageReceipt } from "../usage.js";

export const AI_RUNTIME_USAGE_API_VERSION = "v1" as const;
export const AI_RUNTIME_TELEMETRY_RECEIPTS_PATH = "/api/ai-usage/v1/receipts" as const;
export const AI_RUNTIME_TELEMETRY_LEASES_PATH = "/api/ai-usage/v1/leases" as const;

export interface AIRuntimeUsageClientOptions { readonly apiUrl: string; readonly token: string; readonly serviceEnvId: string; readonly organizationId?: string; readonly projectId?: string; readonly serviceId?: string; readonly environment?: string; readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number; readonly retryLimit?: number; }
export interface AIRuntimeReservationRequest { readonly tokens?: number; readonly output_tokens?: number; readonly provider_cost?: string; readonly expires_in_seconds?: number; }
export interface AIRuntimeAdmissionInput { readonly idempotency_key: string; readonly provider: string; readonly model: string; readonly credential_mode?: "handrail_managed" | "customer_provided"; readonly runtime_session_id?: string; readonly client_request_id?: string; readonly trace_id?: string; readonly reservation?: AIRuntimeReservationRequest; }
export interface AIRuntimePolicyDecision { readonly id: string; readonly policy_id: string | null; readonly policy_version: number | null; readonly enforcement_mode: "observe" | "warn" | "deny"; readonly decision: "allow" | "warn" | "deny"; readonly reason_code: string; readonly created_at: string; }
export interface AIRuntimeAdmissionResult { readonly contract_version: typeof AI_RUNTIME_USAGE_API_VERSION; readonly replayed: boolean; readonly request: { readonly id: string; readonly status: string; readonly project_id: string; readonly capability_id: string; readonly service_id: string; readonly environment: string; readonly provider: string; readonly model: string; }; readonly policy_decision: AIRuntimePolicyDecision; readonly reservation: Readonly<Record<string, unknown>> | null; }
export interface AIRuntimeSettlementResult { readonly contract_version: typeof AI_RUNTIME_USAGE_API_VERSION; readonly request: Readonly<Record<string, unknown>>; readonly reservation: null; readonly accepted_receipts: number; readonly replayed_receipts: number; }
export class AIRuntimeUsageClientError extends Error { readonly status: number; readonly code: string; readonly retryable: boolean; constructor(message: string, options: { status: number; code: string; retryable: boolean }) { super(message); this.name = "AIRuntimeUsageClientError"; this.status = options.status; this.code = options.code; this.retryable = options.retryable; } }
/** Retained for source compatibility; Telemetry-first observe-only admission never throws it. */
export class AIRuntimePreflightDeniedError extends AIRuntimeUsageClientError { readonly result: AIRuntimeAdmissionResult; constructor(result: AIRuntimeAdmissionResult) { super(`AI Runtime preflight denied: ${result.policy_decision.reason_code}`, { status: 403, code: result.policy_decision.reason_code, retryable: false }); this.name = "AIRuntimePreflightDeniedError"; this.result = result; } }
export interface AIRuntimeUsageClient { admit(input: AIRuntimeAdmissionInput): Promise<AIRuntimeAdmissionResult>; settle(input: { readonly requestId: string; readonly receipts: readonly NormalizedUsageReceipt[]; readonly requestStatus?: "succeeded" | "failed" | "cancelled"; }): Promise<AIRuntimeSettlementResult>; }
export interface AIRuntimeUsageConfiguration { readonly client: AIRuntimeUsageClient | null; }
export interface AIRuntimeUsageOutboxEntry { readonly receipt: NormalizedUsageReceipt; readonly enqueuedAt: string; readonly attempts: number; }
/** Host implementations must make enqueue idempotent by usage_receipt_id and durable before resolving. */
export interface AIRuntimeUsageOutbox {
  enqueue(entry: AIRuntimeUsageOutboxEntry): Promise<void>;
  pending(limit: number): Promise<readonly AIRuntimeUsageOutboxEntry[]>;
  acknowledge(usageReceiptId: string): Promise<void>;
  failed(usageReceiptId: string, error: { readonly code: string; readonly retryable: boolean }): Promise<void>;
}
export interface AIRuntimeUsageReceiptSink {
  capture(receipt: NormalizedUsageReceipt): Promise<void>;
  flush(limit?: number): Promise<{ readonly delivered: number; readonly pending: number }>;
}
export interface AIRuntimeQuotaLease { readonly lease_id: string; readonly logical_request_id: string; readonly enforcement_mode: "observe" | "warn" | "deny"; readonly decision: "allow" | "warn" | "deny"; readonly reason_code: string; readonly reserved_tokens: number; readonly reserved_provider_cost: number; readonly provider_cost_currency: string; readonly output_token_limit: number | null; readonly strict: boolean; readonly expires_at: string; }

function required(value: string | undefined, label: string): string { const normalized = String(value || "").trim(); if (!normalized) throw new TypeError(`${label} is required`); return normalized; }
function telemetryOrigin(value: string): string { return required(value, "AI Runtime apiUrl").replace(/\/+$/u, "").replace(/\/api\/ai-runtime\/v1$/u, ""); }
async function responseError(response: Response): Promise<AIRuntimeUsageClientError> { let body: { error?: unknown; code?: unknown } = {}; try { body = await response.json() as typeof body; } catch { /* bounded error */ } return new AIRuntimeUsageClientError(typeof body.error === "string" ? body.error : `AI Runtime telemetry request failed with HTTP ${response.status}`, { status: response.status, code: typeof body.code === "string" ? body.code : "ai_runtime_telemetry_http_error", retryable: response.status === 408 || response.status === 429 || response.status >= 500 }); }

export function createAIRuntimeUsageClient(options: AIRuntimeUsageClientOptions): AIRuntimeUsageClient {
  const baseUrl = telemetryOrigin(options.apiUrl); const token = required(options.token, "AI Runtime token"); const serviceEnvId = required(options.serviceEnvId, "AI Runtime serviceEnvId");
  const fetcher = options.fetch ?? globalThis.fetch; if (typeof fetcher !== "function") throw new TypeError("AI Runtime fetch implementation is required");
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000); const retryLimit = Math.max(0, Math.min(5, options.retryLimit ?? 2)); const admissions = new Map<string, AIRuntimeAdmissionResult>();
  const postReceipts = async (receipts: readonly NormalizedUsageReceipt[]) => {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(`${baseUrl}${AI_RUNTIME_TELEMETRY_RECEIPTS_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Handrail-API-Contract-Version": AI_RUNTIME_USAGE_API_VERSION }, body: JSON.stringify({ service_env_id: serviceEnvId, receipts }), signal: controller.signal });
        if (response.ok) return await response.json() as { accepted_count?: number; duplicate_count?: number };
        const error = await responseError(response); if (!error.retryable || attempt >= retryLimit) throw error;
      } catch (error) { if (attempt >= retryLimit || (error instanceof AIRuntimeUsageClientError && !error.retryable)) throw error; }
      finally { clearTimeout(timeout); }
      attempt += 1; await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 100 * (2 ** (attempt - 1)))));
    }
  };
  const client: AIRuntimeUsageClient = {
    async admit(input: AIRuntimeAdmissionInput): Promise<AIRuntimeAdmissionResult> {
      const id = required(input.idempotency_key, "AI Runtime idempotency_key"); const existing = admissions.get(id); if (existing) return { ...existing, replayed: true };
      const created: AIRuntimeAdmissionResult = { contract_version: "v1", replayed: false, request: { id, status: "observing", project_id: options.projectId ?? "", capability_id: "", service_id: options.serviceId ?? "", environment: options.environment ?? "", provider: required(input.provider, "AI Runtime provider"), model: required(input.model, "AI Runtime model") }, policy_decision: { id: `observe:${id}`, policy_id: null, policy_version: null, enforcement_mode: "observe", decision: "allow", reason_code: "telemetry_observe_only", created_at: new Date().toISOString() }, reservation: null };
      admissions.set(id, created); return created;
    },
    async settle({ requestId, receipts, requestStatus }: { readonly requestId: string; readonly receipts: readonly NormalizedUsageReceipt[]; readonly requestStatus?: "succeeded" | "failed" | "cancelled" }): Promise<AIRuntimeSettlementResult> {
      const id = required(requestId, "AI Runtime requestId"); const normalized = receipts.map((receipt) => parseNormalizedUsageReceipt(receipt));
      if (normalized.length === 0) return { contract_version: AI_RUNTIME_USAGE_API_VERSION, request: { id, status: requestStatus ?? "observing" }, reservation: null, accepted_receipts: 0, replayed_receipts: 0 };
      const response = await postReceipts(normalized);
      return { contract_version: AI_RUNTIME_USAGE_API_VERSION, request: { id, status: requestStatus ?? "observing" }, reservation: null, accepted_receipts: Number(response.accepted_count ?? normalized.length), replayed_receipts: Number(response.duplicate_count ?? 0) };
    }
  };
  return Object.freeze(client);
}

/**
 * Connects ConversationRuntime receipts to Telemetry through a host-owned
 * durable outbox. Capture succeeds once the receipt is durable; transient
 * delivery failure never drops it, and Telemetry deduplicates retries by the
 * stable receipt identity.
 */
export function createAIRuntimeUsageReceiptSink(
  client: AIRuntimeUsageClient,
  outbox: AIRuntimeUsageOutbox,
  options: { readonly now?: () => Date; readonly flushBatchSize?: number } = {},
): AIRuntimeUsageReceiptSink {
  const now = options.now ?? (() => new Date());
  const batchSize = Math.max(1, Math.min(100, options.flushBatchSize ?? 25));
  let flushing: Promise<{ delivered: number; pending: number }> | null = null;
  const flush = (limit = batchSize): Promise<{ delivered: number; pending: number }> => {
    if (flushing) return flushing;
    flushing = (async () => {
      const entries = await outbox.pending(Math.max(1, Math.min(100, limit)));
      let delivered = 0;
      for (const entry of entries) {
        try {
          const status = entry.receipt.terminal_status === "completed" ? "succeeded"
            : entry.receipt.terminal_status === "cancelled" ? "cancelled" : "failed";
          await client.settle({ requestId: entry.receipt.turn_id, receipts: [entry.receipt], requestStatus: status });
          await outbox.acknowledge(entry.receipt.usage_receipt_id);
          delivered += 1;
        } catch (cause) {
          const error = cause instanceof AIRuntimeUsageClientError
            ? { code: cause.code, retryable: cause.retryable }
            : { code: "ai_runtime_usage_delivery_failed", retryable: true };
          await outbox.failed(entry.receipt.usage_receipt_id, error);
          if (error.retryable) break;
        }
      }
      return { delivered, pending: Math.max(0, entries.length - delivered) };
    })().finally(() => { flushing = null; });
    return flushing;
  };
  return Object.freeze({
    async capture(receipt: NormalizedUsageReceipt): Promise<void> {
      const normalized = parseNormalizedUsageReceipt(receipt);
      await outbox.enqueue({ receipt: normalized, enqueuedAt: now().toISOString(), attempts: 0 });
      // Delivery is intentionally best effort after the durable write. Hosts
      // should also call flush at startup and from a retry worker.
      void flush().catch(() => undefined);
    },
    flush,
  });
}

/** Opt-in enforcement foundation. Observe-only integrations must not call this until rollout is enabled. */
export function createAIRuntimeQuotaLeaseClient(options: AIRuntimeUsageClientOptions) {
  const baseUrl = telemetryOrigin(options.apiUrl); const token = required(options.token, "AI Runtime token"); const serviceEnvId = required(options.serviceEnvId, "AI Runtime serviceEnvId"); const fetcher = options.fetch ?? globalThis.fetch;
  return Object.freeze({
    async acquire(input: { readonly logicalRequestId: string; readonly requestedTokens?: number; readonly requestedOutputTokens?: number; readonly requestedProviderCost?: number; readonly expiresInSeconds?: number }): Promise<AIRuntimeQuotaLease> {
      const response = await fetcher(`${baseUrl}${AI_RUNTIME_TELEMETRY_LEASES_PATH}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ service_env_id: serviceEnvId, logical_request_id: required(input.logicalRequestId, "logicalRequestId"), requested_tokens: input.requestedTokens ?? 0, requested_output_tokens: input.requestedOutputTokens ?? 0, requested_provider_cost: input.requestedProviderCost ?? 0, expires_in_seconds: input.expiresInSeconds ?? 300 }) });
      const body = await response.json() as AIRuntimeQuotaLease & { error?: { code?: string } };
      if (!response.ok && response.status !== 429) throw await responseError(new Response(JSON.stringify(body), { status: response.status }));
      return Object.freeze(body);
    },
    assertCanInvoke(lease: AIRuntimeQuotaLease, outputTokensSoFar = 0): void {
      if (lease.strict && lease.decision === "deny") throw new AIRuntimePreflightDeniedError({ contract_version: "v1", replayed: false, request: { id: lease.logical_request_id, status: "denied", project_id: "", capability_id: "", service_id: "", environment: "", provider: "", model: "" }, policy_decision: { id: lease.lease_id, policy_id: null, policy_version: null, enforcement_mode: "deny", decision: "deny", reason_code: lease.reason_code, created_at: new Date().toISOString() }, reservation: lease as unknown as Readonly<Record<string, unknown>> });
      if (lease.strict && lease.output_token_limit != null && outputTokensSoFar >= lease.output_token_limit) throw new AIRuntimeUsageClientError("AI Runtime output-token lease is exhausted before the next provider invocation", { status: 429, code: "per_request_output_lease_exhausted", retryable: false });
    }
  });
}

export function createAIRuntimeUsageClientFromEnv(env: Record<string, string | undefined> = process.env,
  options: Pick<AIRuntimeUsageClientOptions, "fetch" | "retryLimit" | "timeoutMs"> = {}): AIRuntimeUsageClient | null {
  if (env.HANDRAIL_AI_RUNTIME_ENABLED !== "true") return null;
  const apiUrl = env.HANDRAIL_AI_RUNTIME_TELEMETRY_URL?.trim() || env.HANDRAIL_AI_RUNTIME_API_URL?.trim();
  const token = env.HANDRAIL_AI_RUNTIME_TOKEN?.trim();
  const serviceEnvId = env.HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID?.trim();
  if (!apiUrl || !token || !serviceEnvId) return null;
  return createAIRuntimeUsageClient({ ...options, apiUrl, token, serviceEnvId,
    ...(env.HANDRAIL_AI_RUNTIME_ORG_ID ? { organizationId: env.HANDRAIL_AI_RUNTIME_ORG_ID } : {}),
    ...(env.HANDRAIL_AI_RUNTIME_PROJECT_ID ? { projectId: env.HANDRAIL_AI_RUNTIME_PROJECT_ID } : {}),
    ...(env.HANDRAIL_AI_RUNTIME_SERVICE_ID ? { serviceId: env.HANDRAIL_AI_RUNTIME_SERVICE_ID } : {}),
    ...(env.HANDRAIL_AI_RUNTIME_ENV ? { environment: env.HANDRAIL_AI_RUNTIME_ENV } : {}) });
}

/** Optional startup/periodic delivery. Stop prevents new scheduled flushes but
 * never deletes receipts or abandons a flush already writing acknowledgements.
 */
export function createAIRuntimeUsageDelivery(options: {
  readonly flush: () => Promise<unknown>;
  readonly enabled?: boolean;
  readonly flushOnStartup?: boolean;
  readonly retryIntervalMilliseconds?: number | null;
  readonly onError?: (error: unknown) => void;
}) {
  const interval = options.retryIntervalMilliseconds === undefined ? 30_000 : options.retryIntervalMilliseconds;
  if (interval !== null && (!Number.isSafeInteger(interval) || interval <= 0)) {
    throw new TypeError("usageDelivery.retryIntervalMilliseconds must be null or a positive safe integer");
  }
  let running: Promise<void> | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const run = (): Promise<void> => {
    if (stopped || options.enabled === false) return Promise.resolve();
    return running ??= Promise.resolve().then(options.flush).then(() => undefined).catch(error => {
      // Reporting must not turn background delivery into an unhandled rejection.
      try { options.onError?.(error); } catch { /* Best-effort diagnostics. */ }
    }).finally(() => { running = null; });
  };
  const ready = options.flushOnStartup === false ? Promise.resolve() : run();
  void ready.then(() => {
    if (!stopped && options.enabled !== false && interval !== null) {
      timer = setInterval(() => { void run(); }, interval);
      timer.unref?.();
    }
  });
  return Object.freeze({ ready, stop(): Promise<void> {
    stopped = true; if (timer !== null) clearInterval(timer);
    return running ?? Promise.resolve();
  } });
}

/** High-level constructor input with an explicit disabled state when environment configuration is absent. */
export function usageFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): AIRuntimeUsageConfiguration {
  return Object.freeze({ client: createAIRuntimeUsageClientFromEnv(env) });
}
