import { createHash } from "node:crypto";
import { awaitWithSignal } from "../await-signal.js";
import { parseToolDefinition, type JsonObject, type JsonValue } from "../protocol.js";
import type { RequestScopedMcpSession } from "../mcp/index.js";
import { PostgresPersistenceConflictError, PostgresToolExecutionUncertainError, type PostgresAiPersistence } from "../postgres/index.js";
import { createToolPlugin } from "../tools/plugin.js";
import type { ApplicationToolAdmission, ApplicationToolExecutor, ApplicationToolExecutionLocation } from "../tools/executor.js";
import { ToolFailureError } from "../tools/recovery.js";

export type FeedbackKind = "bug" | "enhancement";
export interface FeedbackContext { readonly tenantId: string; readonly scopeId: string; readonly principalId: string }
export const FEEDBACK_SUBMIT_TOOLS = Object.freeze({ bug: "handrail_bug_reporter_v1_submit", enhancement: "handrail_enhancement_reporter_v1_submit" });
export interface FeedbackReceipt extends JsonObject { readonly kind: FeedbackKind; readonly reportId: string }
export interface FeedbackToolsOptions<TContext extends FeedbackContext> {
  readonly persistence: PostgresAiPersistence;
  /** Non-secret project/environment/service identity, immutable for this installation. */
  readonly binding: string;
  readonly enabled: (kind: FeedbackKind) => boolean;
  /** Re-resolve current principal, scope, conversation access and reporting permission. */
  readonly authorize: (context: TContext, kind: FeedbackKind, signal: AbortSignal,
    location?: ApplicationToolExecutionLocation) => boolean | Promise<boolean>;
  /** Resolve a durable explicit user intent from trusted history. Never use a provider call ID.
   * Distinct intents in the same message need distinct IDs; retries must return the original. */
  readonly resolveIntent: (context: TContext, location: ApplicationToolExecutionLocation, kind: FeedbackKind,
    signal: AbortSignal) => string | Promise<string>;
  /** Open a NEW session with current server-resolved credentials. The SDK closes it in finally.
   * Do not capture credentials in context, plugins or a cached session. */
  readonly openSession: (context: TContext, signal: AbortSignal) => Promise<RequestScopedMcpSession>;
}
type FrozenIntent = { version: 1; kind: FeedbackKind; conversationId: string; identity: string; payload: JsonObject };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`;
}
function failure(code: string, message: string): never {
  throw new ToolFailureError({ category: "unknown_outcome", code, message });
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value); }
/** Project only verified canonical fields; never forward connector metadata or error bodies. */
export function parseFeedbackReceipt(result: unknown, kind: FeedbackKind, identity: string): FeedbackReceipt {
  const envelope = object(result), value = object(envelope.structuredContent), response = object(value.response), request = object(value.request);
  if (envelope.isError !== true && kind === "bug" && value.status === "submitted" && identifier(value.bugId)
    && value.bugId === response.bug_id && response.event_id === identity && object(response.reporter_identity).verification_result === true) {
    return { kind, reportId: value.bugId };
  }
  if (envelope.isError !== true && kind === "enhancement" && value.contract_version === "v1" && request.submission_kind === "enhancement"
    && identifier(request.id) && typeof value.replayed === "boolean") return { kind, reportId: request.id };
  return failure("feedback_receipt_unverified", "Feedback outcome is unverified. Retain this intent; do not submit another copy.");
}

/** Server-only plugin composition. Uses existing durable tool admission, not a feedback queue.
 * The host must install admission as well as the plugin, and retain its approval policy. */
export function createFeedbackTools<TContext extends FeedbackContext>(options: FeedbackToolsOptions<TContext>) {
  const kindFor = (name: string) => (Object.keys(FEEDBACK_SUBMIT_TOOLS) as FeedbackKind[]).find(kind => FEEDBACK_SUBMIT_TOOLS[kind] === name);
  const scope = (context: TContext) => `feedback-${digest(JSON.stringify([options.binding, context.tenantId, context.scopeId, context.principalId]))}`;
  const check = async (context: TContext, kind: FeedbackKind, signal: AbortSignal, location?: ApplicationToolExecutionLocation) => {
    signal.throwIfAborted();
    let allowed = false;
    try { allowed = options.enabled(kind) === true && await options.authorize(context, kind, signal, location) === true; } catch { /* fail closed */ }
    if (!allowed) {
      throw new ToolFailureError({ category: "permission_denied", code: "feedback_denied", message: "Current access does not permit this feedback operation." });
    }
    signal.throwIfAborted();
  };
  const withSession = async <T>(context: TContext, signal: AbortSignal, run: (session: RequestScopedMcpSession) => Promise<T>) => {
    let session: RequestScopedMcpSession | undefined;
    try { session = await options.openSession(context, signal); signal.throwIfAborted(); return await run(session); }
    catch (error) {
      if (error instanceof ToolFailureError) throw error;
      return failure("feedback_connection_unavailable", "Feedback connection did not complete. Preserve any admitted intent for reconciliation.");
    } finally {
      try { await session?.close(); } catch {
        failure("feedback_cleanup_failed", "Feedback connection cleanup failed. Preserve any admitted intent for reconciliation.");
      }
    }
  };
  const admission: ApplicationToolAdmission<TContext> = async input => {
    const kind = kindFor(input.definition.name);
    if (!kind) return { outcome: "deny" };
    try {
      await check(input.applicationContext, kind, input.signal, input.location);
      // Current canonical discovery also governs replay, even when a cached catalog remains visible.
      return await withSession(input.applicationContext, input.signal, async session => ({
        outcome: session.tools.some(tool => tool.name === input.definition.name) ? "allow" : "deny",
      }));
    } catch { return { outcome: "deny" }; }
  };
  const prepare = async (context: TContext, location: ApplicationToolExecutionLocation, kind: FeedbackKind, args: JsonObject, signal: AbortSignal) => {
    await check(context, kind, signal, location);
    const intent = await options.resolveIntent(context, location, kind, signal);
    if (typeof intent !== "string" || !intent.trim() || intent.length > 512) throw new TypeError("A durable feedback intent is required.");
    const identity = digest(JSON.stringify([scope(context), location.conversationId, intent, kind]));
    // Identity fields are server-owned and absent from the model-facing schema.
    const payload = JSON.parse(JSON.stringify({ ...args, ...(kind === "bug" ? { event_id: identity }
      : { idempotency_key: identity, external_conversation_id: digest(JSON.stringify([scope(context), location.conversationId])) }) })) as JsonObject;
    const frozen: FrozenIntent = { version: 1, kind, conversationId: location.conversationId, identity, payload };
    const key = { tenantId: context.tenantId, kind: "tool_execution" as const, scopeId: scope(context), recordId: identity };
    try { await options.persistence.compareAndSetDocument({ ...key, expectedVersion: null, value: frozen }); }
    catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const existing = await options.persistence.getDocument<FrozenIntent>(key.tenantId, key.kind, key.scopeId, key.recordId);
      if (!existing || canonical(existing.value as unknown as JsonObject) !== canonical(frozen as unknown as JsonObject)) {
        throw new ToolFailureError({ category: "invalid_input", code: "feedback_intent_conflict", message: "This feedback intent is already bound to different content. Preserve the original request." });
      }
    }
    return { frozen, key: `feedback-${identity}` };
  };
  const plugin = createToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>({
    pluginId: "handrail.feedback", version: "1.0.0", displayName: "Handrail feedback",
    policy: () => ({ outcome: "external_approval_required" }),
    registrations: async context => {
      const permitted: FeedbackKind[] = [];
      for (const kind of ["bug", "enhancement"] as const) {
        try { await check(context, kind, new AbortController().signal); permitted.push(kind); } catch { /* no catalog disclosure */ }
      }
      if (!permitted.length) return [];
      // Retain definitions only. No connection or raw session survives installation.
      return withSession(context, new AbortController().signal, async session => session.tools.flatMap(tool => {
        const kind = kindFor(tool.name);
        if (!kind || !permitted.includes(kind)) return [];
        const schema = JSON.parse(JSON.stringify(tool.inputSchema)) as JsonObject;
        const owned = ["event_id", "idempotency_key", "external_conversation_id"];
        const properties = object(schema.properties);
        for (const key of owned) delete properties[key];
        schema.properties = properties as JsonObject;
        if (Array.isArray(schema.required)) schema.required = schema.required.filter(key => typeof key === "string" && !owned.includes(key));
        schema.additionalProperties = false;
        return [{ definition: parseToolDefinition({ name: tool.name, description: tool.description ?? tool.name, input_schema: schema }),
          discover: (caller: TContext) => scope(caller) === scope(context) && options.enabled(kind) === true,
          executor: async (args: JsonObject, execution: Parameters<ApplicationToolExecutor<TContext>>[1]) => {
            if (!execution.location) throw new TypeError("Feedback requires a trusted conversation and turn.");
            const current = execution.applicationContext, signal = execution.signal;
            try {
              const { frozen, key } = await prepare(current, execution.location, kind, args, signal);
              const receipt = await options.persistence.getOrExecuteTool<FeedbackReceipt>(current.tenantId, key, async () => {
                await check(current, kind, signal, execution.location);
                return withSession(current, signal, async active => {
                  await check(current, kind, signal, execution.location);
                  const result = await awaitWithSignal(signal, () => active.callTool({ name: tool.name,
                    arguments: frozen.payload, toolCallId: frozen.identity, signal }));
                  signal.throwIfAborted();
                  return parseFeedbackReceipt(result, kind, frozen.identity);
                });
              }, canonical(frozen as unknown as JsonObject));
              await check(current, kind, signal, execution.location);
              if (receipt.kind !== kind || !identifier(receipt.reportId)) throw new TypeError("Invalid saved feedback receipt.");
              return { kind: receipt.kind, reportId: receipt.reportId };
            } catch (error) {
              if (error instanceof PostgresToolExecutionUncertainError) return failure("feedback_reconciliation_required",
                "Feedback outcome is uncertain. The connector supports lookup by report ID only; authoritative intent-to-report lookup is required before recovery. Do not redispatch or create a new intent.");
              // Never surface a raw transport, storage or host exception.
              if (error instanceof ToolFailureError) throw error;
              return failure("feedback_outcome_uncertain", "Feedback may have been accepted. Keep this intent for authoritative reconciliation; local cancellation does not cancel remote HTTP.");
            }
          } }];
      })).catch(() => []); // Missing/failed canonical discovery exposes no feedback tools.
    },
  });
  /** Protected host recovery/readback seam. Never accepts a model-supplied report ID,
   * never resets admission, and never dispatches a submission. The current connector
   * cannot find a receipt by event_id/idempotency_key after a completely lost response. */
  const reconcile = async (context: TContext, location: ApplicationToolExecutionLocation, kind: FeedbackKind, signal: AbortSignal): Promise<FeedbackReceipt> => {
    try {
      await check(context, kind, signal, location);
      const intent = await options.resolveIntent(context, location, kind, signal);
      const identity = digest(JSON.stringify([scope(context), location.conversationId, intent, kind]));
      const frozen = await options.persistence.getDocument<FrozenIntent>(context.tenantId, "tool_execution", scope(context), identity);
      if (!frozen) return failure("feedback_intent_missing", "No saved feedback intent exists in this scope.");
      if (frozen.version !== 1 || frozen.value.version !== 1 || frozen.value.identity !== identity || frozen.value.kind !== kind
        || frozen.value.conversationId !== location.conversationId
        || frozen.value.payload[kind === "bug" ? "event_id" : "idempotency_key"] !== identity) {
        return failure("feedback_intent_invalid", "The saved feedback intent cannot be verified. Do not redispatch.");
      }
      const receipt = await options.persistence.getToolResult<FeedbackReceipt>(context.tenantId, `feedback-${identity}`);
      if (!receipt) return failure("feedback_reconciliation_required",
        "Authoritative intent-to-report lookup is required: this connector only accepts a known report ID. The saved intent cannot be redispatched.");
      if (receipt.kind !== kind || !identifier(receipt.reportId)) return failure("feedback_receipt_unverified", "The saved feedback receipt is invalid.");
      // Bug submit receipts are verified above. Its lookup projection has not been
      // qualified here; do not infer it from the enhancement contract.
      if (kind === "bug") return failure("feedback_bug_readback_contract_required", "The canonical bug lookup receipt schema must be qualified before authoritative readback.");
      return await withSession(context, signal, async session => {
        await check(context, kind, signal, location);
        const result = object(await session.callTool({ name: "handrail_enhancement_reporter_v1_lookup",
          arguments: { request_id: receipt.reportId }, toolCallId: identity, signal }));
        const value = object(result.structuredContent);
        if (result.isError === true || value.contract_version !== "v1" || value.id !== receipt.reportId || value.submission_kind !== "enhancement") {
          return failure("feedback_readback_unverified", "Authoritative enhancement readback did not verify the saved receipt. Do not redispatch.");
        }
        await check(context, kind, signal, location);
        return { kind, reportId: receipt.reportId };
      });
    } catch (error) {
      if (error instanceof ToolFailureError) throw error;
      return failure("feedback_reconciliation_unavailable", "Feedback reconciliation is unavailable. Preserve the saved intent; do not redispatch.");
    }
  };
  return Object.freeze({ plugin, admission, reconcile });
}
