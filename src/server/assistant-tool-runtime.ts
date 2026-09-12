import { jsonValuesEqual } from "../json-equality.js";
import { createHash } from "node:crypto";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { ApplicationToolResult, JsonObject, JsonValue, ResponseToolCallEvent, ToolDefinition } from "../protocol.js";
import type { AiApplication } from "./application.js";
import type { ApplicationToolActivityUpdate, BoundedToolExecutionOutcome } from "../tools/executor.js";
import type { ApprovalExecutionResume } from "../tools/approval-execution.js";
import { ApprovalProposalStoreError, type ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import { ConversationEventStoreConflictError, type ConversationEventStore } from "../conversation/event-store.js";
import { findConversationEvent } from "../conversation/find-event.js";
import { CONVERSATION_EVENT_VERSION, parseConversationEvent } from "../conversation/events.js";
import type { ConversationEventAttribution } from "../conversation/state.js";
import { recordToolLifecycle } from "./tool-lifecycle.js";

type Location = { readonly conversationId: string; readonly turnId: string };
type Call = Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
export interface AssistantToolRuntime {
  readonly definitions: readonly ToolDefinition[];
  execute(call: Call, signal: AbortSignal, location?: Location): Promise<BoundedToolExecutionOutcome>;
  awaitApproval(input: Location & { readonly call: Call; readonly signal: AbortSignal }): Promise<BoundedToolExecutionOutcome>;
}
export interface AssistantToolRuntimeOptions<TContext extends { readonly scopeId: string }> {
  readonly context: TContext;
  /** Install the native execution ledger and approval execution coordinator. */
  readonly application: AiApplication<TContext, TContext, TContext>;
  readonly events: ConversationEventStore;
  readonly proposalStore: ApprovalProposalStore<TContext>;
  /** Current host session/owner and active text turn or live-call authorization.
   * Browser fields, provider arguments and transcripts cannot establish this scope. */
  readonly authorizeLocation: (location: Location, signal: AbortSignal) => void | Promise<void>;
  readonly reportActivity?: (conversationId: string, turnId: string, update: ApplicationToolActivityUpdate) => Promise<void>;
  readonly activityForToolCall?: (input: Location & { readonly context: TContext; readonly toolCallId: string;
    readonly toolName: string; readonly arguments: JsonObject }) => ApplicationToolActivityUpdate | null | Promise<ApplicationToolActivityUpdate | null>;
  readonly approvalTimeoutMilliseconds?: number;
  readonly diagnostics?: AiDiagnosticSink;
}

const SYSTEM_ATTRIBUTION: ConversationEventAttribution = Object.freeze({
  actor: Object.freeze({ type: "system" }), source: Object.freeze({ type: "runtime" }),
});

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assistantToolArgumentReference(arguments_: JsonObject): string {
  return `args-sha256-${digest(canonicalJson(arguments_))}`;
}

function approvalError(call: Pick<ResponseToolCallEvent, "tool_call_id" | "name">, message: string): BoundedToolExecutionOutcome {
  const content = [{ type: "text" as const, text: message }];
  const result: ApplicationToolResult = Object.freeze({ tool_call_id: call.tool_call_id, name: call.name,
    content, is_error: true });
  return Object.freeze({ status: "completed", result });
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, milliseconds);
    const onAbort = () => { clearTimeout(timeout); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function recordProposalCreated(
  eventStore: ConversationEventStore, conversationId: string,
  proposal: Awaited<ReturnType<ApprovalProposalStore<unknown>["create"]>>,
): Promise<void> {
  const eventId = `approval-created:${proposal.proposal_id}`;
  const payload = { type: "approval.proposal_created", proposal_id: proposal.proposal_id,
    ...(proposal.group_id === null ? {} : { group_id: proposal.group_id }), turn_id: proposal.turn_id,
    tool_call_id: proposal.tool_call_id, tool_name: proposal.tool_name, status: "pending", proposal_version: 1,
    expires_at: proposal.expires_at, reviewed_arguments: proposal.reviewed_arguments };
  const retainedMatches = async () => {
    const retained = await findConversationEvent(eventStore, conversationId as never, event => event.event_id === eventId);
    if (!retained) return false;
    if (!jsonValuesEqual(retained.payload, payload) || retained.occurred_at !== proposal.created_at ||
      !jsonValuesEqual(retained.actor, SYSTEM_ATTRIBUTION.actor) || !jsonValuesEqual(retained.source, SYSTEM_ATTRIBUTION.source)) {
      throw new ApprovalProposalStoreError("idempotency_conflict", "create");
    }
    return true;
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await retainedMatches()) return;
    const latest = await eventStore.getLatestRevision(conversationId as never);
    try {
      await eventStore.append({ conversationId: conversationId as never, expectedRevision: latest, events: [parseConversationEvent({
        version: CONVERSATION_EVENT_VERSION, event_id: eventId, conversation_id: conversationId,
        revision: (latest ?? 0) + 1, occurred_at: proposal.created_at, ...SYSTEM_ATTRIBUTION, payload,
      })] });
      return;
    } catch (error) {
      if (!(error instanceof ConversationEventStoreConflictError) || !["revision_conflict", "idempotency_conflict"].includes(error.code)) throw error;
      if (await retainedMatches()) return;
    }
  }
  throw new ApprovalProposalStoreError("unavailable", "create");
}

/** Shared native execution boundary for provider transports and trusted live
 * delegation. It records tool facts only: speech, playback, complete user turns
 * and remote call termination remain independently owned by their transports. */
export function createAssistantToolRuntime<TContext extends { readonly scopeId: string }>(
  options: AssistantToolRuntimeOptions<TContext>,
): AssistantToolRuntime {
  const { context, application } = options;
  const definitions = application.discover({ context });
  const reportActivity = options.reportActivity ?? (async () => {});
  const approvalTimeoutMilliseconds = options.approvalTimeoutMilliseconds ?? 15 * 60_000;
  if (!Number.isSafeInteger(approvalTimeoutMilliseconds) || approvalTimeoutMilliseconds < 1) throw new TypeError("Invalid approval timeout");
  const authorize = async (location: Location | undefined, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!location?.conversationId || !location.turnId) throw new TypeError("Saved tool execution location is required");
    await options.authorizeLocation(location, signal);
    signal.throwIfAborted();
  };
  const recordOutcome = async (
    location: { readonly conversationId: string; readonly turnId: string },
    call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">,
    outcome: BoundedToolExecutionOutcome,
  ): Promise<BoundedToolExecutionOutcome> => {
    const identity = { turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never };
    await recordToolLifecycle(options.events, location.conversationId,
      outcome.status === "external_approval_required"
        ? { ...identity, type: "tool_call.approval_required" }
        : { ...identity, type: "tool_call.result_recorded", content: outcome.result.content,
            is_error: outcome.result.is_error,
            ...(outcome.result.citation_records === undefined ? {} : { citation_records: outcome.result.citation_records }) });
    return outcome;
  };
  const executeTool = async (
    call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">,
    signal: AbortSignal,
    location?: { readonly conversationId: string; readonly turnId: string },
    approval?: Parameters<typeof application.executeTool>[0]["approval"],
  ): Promise<BoundedToolExecutionOutcome> => {
    await authorize(location, signal);
    if (location) {
      const identity = { turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never };
      await recordToolLifecycle(options.events, location.conversationId,
        { ...identity, type: "tool_call.requested", name: call.name, arguments: call.arguments });
      await recordToolLifecycle(options.events, location.conversationId,
        { ...identity, type: "tool_call.discovered" });
    }
    const outcome = await application.executeTool({ discovery: { context }, applicationContext: context, call, signal, preserveDispatchedResultOnCancel: true,
      executionKey: `tool-${digest(JSON.stringify([context.scopeId,
        location?.conversationId ?? null, location?.turnId ?? null, call.tool_call_id]))}`,
      ...(approval === undefined ? {} : { approval }),
      ...(location === undefined ? {} : {
        location,
        onExecutionStarted: () => recordToolLifecycle(options.events, location.conversationId,
          { type: "tool_call.started", turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never }),
        reportActivity: (update: ApplicationToolActivityUpdate) => reportActivity(location.conversationId, location.turnId, update),
      }) });
    return location ? recordOutcome(location, call, outcome) : outcome;
  };
  return Object.freeze<AssistantToolRuntime>({
    definitions,
    async execute(call, signal, location) {
      await authorize(location, signal);
      if (location && options.activityForToolCall) {
        try {
          const initial = await options.activityForToolCall({ context,
            conversationId: location.conversationId, turnId: location.turnId,
            toolCallId: call.tool_call_id, toolName: call.name, arguments: call.arguments });
          if (initial) await reportActivity(location.conversationId, location.turnId, initial);
        } catch (cause) {
          emitAiDiagnostic(options.diagnostics, { domain: "activity", operation: "tool_summary",
            phase: "failed", conversationId: location.conversationId, turnId: location.turnId,
            toolName: call.name, toolCallId: call.tool_call_id,
            code: "activity_summary_failed", retryable: false, cause });
        }
      }
      return executeTool(call, signal, location);
    },
    async awaitApproval({ conversationId, turnId, call, signal }) {
      await authorize({ conversationId, turnId }, signal);
      const finishError = (message: string) => recordOutcome({ conversationId, turnId }, call, approvalError(call, message));
      await reportActivity(conversationId, turnId, { summary: "Waiting for approval to continue" });
      const rawArguments = call.arguments as JsonObject;
      const reference = assistantToolArgumentReference(rawArguments);
      const identity = digest(`${conversationId}\u001f${turnId}\u001f${call.tool_call_id}\u001f${call.name}\u001f${reference}`);
      const proposalId = `proposal-${identity.slice(0, 48)}` as never;
      const proposalStore = options.proposalStore;
      const load = () => proposalStore.get({ permissionContext: context, proposalId });
      let proposal = await load();
      if (!proposal) {
        try {
          proposal = await proposalStore.create({ permissionContext: context, proposalId,
            groupId: conversationId as never, turnId: turnId as never,
            toolCallId: call.tool_call_id as never, toolName: call.name,
            reviewedArguments: { type: "opaque_reference", argument_ref: reference as never },
            expiresAt: new Date(Date.now() + approvalTimeoutMilliseconds).toISOString() as never,
            attribution: SYSTEM_ATTRIBUTION, idempotencyKey: `approval:${identity}`,
            idempotencyFingerprint: `approval:${identity}` });
        } catch (error) {
          // Concurrent observers may choose different creation times. Load the
          // winning immutable proposal; never reset its expiry on reconnection.
          if (!(error instanceof ApprovalProposalStoreError) || error.code !== "idempotency_conflict") throw error;
          proposal = await load();
          if (!proposal) throw error;
        }
      }
      if (proposal.group_id !== conversationId || proposal.turn_id !== turnId || proposal.tool_call_id !== call.tool_call_id ||
        proposal.tool_name !== call.name || proposal.reviewed_arguments.type !== "opaque_reference" ||
        proposal.reviewed_arguments.argument_ref !== reference) throw new ApprovalProposalStoreError("idempotency_conflict", "create");
      const expiresAt = Date.parse(proposal.expires_at);
      await recordProposalCreated(options.events, conversationId, proposal);
      while (!signal.aborted) {
        await authorize({ conversationId, turnId }, signal);
        const retained = await proposalStore.get({ permissionContext: context, proposalId });
        if (retained === null) return finishError("Tool approval is unavailable.");
        if (retained.status === "confirmed") {
          await reportActivity(conversationId, turnId, { summary: "Running approved work" });
          const approval: ApprovalExecutionResume<TContext> = { permissionContext: context, proposalId,
            expectedProposalVersion: retained.proposal_version, executionId: `execute-${identity.slice(0, 48)}`,
            argumentBinding: { type: "opaque_reference", argumentReference: reference as never },
            attribution: SYSTEM_ATTRIBUTION };
          return executeTool(call, signal, { conversationId, turnId },
            { ...approval, conversationId: conversationId as never, turnId: turnId as never });
        }
        if (retained.status === "rejected") return finishError("Tool execution was rejected.");
        if (retained.status === "expired") return finishError("Tool approval expired.");
        if (retained.status === "executed" || retained.status === "executing") {
          return executeTool(call, signal, { conversationId, turnId }, { permissionContext: context, proposalId,
            expectedProposalVersion: 2, executionId: `execute-${identity.slice(0, 48)}`,
            argumentBinding: { type: "opaque_reference", argumentReference: reference as never },
            attribution: SYSTEM_ATTRIBUTION, conversationId: conversationId as never, turnId: turnId as never });
        }
        if (retained.status === "failed") return finishError("Approved tool execution failed.");
        if (Date.now() >= expiresAt) return finishError("Tool approval expired.");
        if (!await wait(Math.min(250, expiresAt - Date.now()), signal)) break;
      }
      // Losing one observer does not decide the retained proposal or create a
      // terminal tool result. A fresh authorized observer may resume this wait.
      signal.throwIfAborted();
      return finishError("Tool approval expired.");
    },
  });
}
