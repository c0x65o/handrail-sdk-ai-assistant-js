import { createToolActivityObserver, type HandrailAssistantToolObserver } from "./tool-observer.js";
import { createHash } from "node:crypto";
import { recordToolLifecycle } from "./tool-lifecycle.js";
import { reconcileDurableConversationTurn } from "./reconcile-conversation.js";
import { replayConversation } from "../conversation/replay.js";

import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { ApplicationToolResult, AuthoritativeAttribution, ChatRequest, JsonObject, JsonValue, StreamEvent } from "../protocol.js";
import type { ProviderAdapterMetadata } from "../providers/index.js";
import type { ToolLoopLimits } from "../tools/loop.js";
import type { ConversationTransport, TurnResumePoint } from "../transports/types.js";
import { createApplicationGateway, createConversationActivityHttpHandler,
  type ApplicationGateway, type ApplicationGatewayAction,
  type ApplicationGatewayAuthorizationContext } from "../transports/application-gateway.js";
import { createApplicationGatewayExpressMiddleware, type ExpressLikeNext,
  type ExpressLikeRequest, type ExpressLikeResponse } from "./application-gateway.js";
import { createDurableApplicationTransport, type DurableApplicationTransport } from "../transports/durable.js";
import { ConversationCatalogError, type ConversationCatalog } from "../conversation/catalog.js";
import { createInMemoryLiveConversationActivityDelivery,
  createConversationActivityReporter,
  type LiveConversationActivityDelivery, type LiveConversationActivityPubSub } from "../conversation/activity.js";
import { ApprovalProposalStoreError, type ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import { createAiApplication, type AiApplication, type ApplicationApprovalPolicy } from "./application.js";
import type { ApplicationToolActivityUpdate, ApplicationToolExecutor, ApplicationToolPolicy,
  BoundedToolExecutionOutcome, BoundedToolExecutorLimits } from "../tools/executor.js";
import type { ToolPlugin } from "../tools/plugin.js";
import type { ResponseToolCallEvent, ToolDefinition } from "../protocol.js";
import type { AIRuntimeUsageConfiguration } from "./usage-control.js";
import { createApprovalExecutionCoordinator, type ApprovalExecutionResume } from "../tools/approval-execution.js";
import { createApprovalCoordinator } from "../conversation/approval-coordinator.js";
import { CONVERSATION_EVENT_VERSION, parseConversationEvent } from "../conversation/events.js";
import type { ConversationEventAttribution } from "../conversation/state.js";
import { ConversationEventStoreConflictError } from "../conversation/event-store.js";
import { createConversationSynchronizationHttpHandler } from "../sync/http.js";
import { createDurableApplicationConversationSync, qualifyDurableApplicationTurnStarts } from "../sync/durable-application-adapter.js";
import { createInMemoryLivePresenceDelivery, createLivePresenceHttpHandler } from "../presence/live-delivery.js";
import type { LivePresenceDelivery, LivePresencePubSub } from "../presence/live-delivery.js";
import { createAssistantActivityTransport } from "../presence/assistant-activity.js";

export { waitForApplicationApproval, ApplicationApprovalWaitExpiredError,
  type ApplicationApprovalWaitOptions, type ApplicationApprovalObservation } from "./application-approval-wait.js";
export type { HandrailAssistantToolObserver } from "./tool-observer.js";
export { openaiResponses, type HandrailOpenAIResponsesOptions } from "./openai-responses.js";
export { createProviderToolLoopTransport, type ProviderToolLoopTransportOptions } from "./provider-tool-loop.js";

export const HANDRAIL_ASSISTANT_VERSION = "handrail.assistant.v1" as const;

export interface HandrailAssistantAuthorizationContext extends ApplicationGatewayAuthorizationContext {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly attribution: AuthoritativeAttribution;
}

export interface HandrailAssistantProvider<TContext extends HandrailAssistantAuthorizationContext> {
  readonly metadata: ProviderAdapterMetadata;
  /** SDK-owned provider packages return this transport with their bounded tool loop already installed. */
  createTransport(input: {
    readonly context: TContext;
    readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
    readonly instructions: readonly string[];
    readonly toolActivity: HandrailAssistantToolObserver;
    readonly tools: {
      readonly definitions: readonly ToolDefinition[];
      execute(call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">,
        signal: AbortSignal, location?: { readonly conversationId: string; readonly turnId: string }):
        Promise<BoundedToolExecutionOutcome>;
      awaitApproval(input: { readonly conversationId: string; readonly turnId: string;
        readonly call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
        readonly signal: AbortSignal }): Promise<BoundedToolExecutionOutcome>;
    };
    readonly limits: Readonly<ToolLoopLimits>;
    readonly diagnostics?: AiDiagnosticSink;
  }): ConversationTransport<StreamEvent, ChatRequest> | Promise<ConversationTransport<StreamEvent, ChatRequest>>;
}

export interface CreateHandrailAssistantOptions<TContext extends HandrailAssistantAuthorizationContext> {
  readonly id: string;
  readonly instructions?: string | readonly string[];
  readonly authorize: (request: Request, action: ApplicationGatewayAction) => TContext | Promise<TContext>;
  readonly provider: HandrailAssistantProvider<TContext>;
  readonly persistence: PostgresAssistantPersistence;
  readonly usage?: AIRuntimeUsageConfiguration;
  /** Durable usage-outbox startup drain and retry worker. Enabled when a usage client is configured. */
  readonly usageDelivery?: {
    readonly flushOnStartup?: boolean;
    /** Set null to disable recurring delivery. Defaults to 30 seconds. */
    readonly retryIntervalMilliseconds?: number | null;
    readonly batchSize?: number;
  };
  readonly tools?: readonly ToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>[];
  readonly toolPolicy?: ApplicationToolPolicy<TContext>;
  /** Project-aware confirmation policy for tools declared with approval mode `policy`. */
  readonly approvalPolicy?: ApplicationApprovalPolicy<TContext>;
  /** Supplies the first safe summary shown when a tool begins. Long-running tools can report later progress. */
  readonly activityForToolCall?: (input: {
    readonly context: TContext;
    readonly conversationId: string;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments: JsonObject;
  }) => ApplicationToolActivityUpdate | null | Promise<ApplicationToolActivityUpdate | null>;
  readonly diagnostics?: AiDiagnosticSink;
  readonly workerId?: string;
  readonly toolLoopLimits?: Partial<ToolLoopLimits>;
  /** Per-tool execution bounds, separate from the total multi-step turn budget. */
  readonly toolExecutorLimits?: Partial<BoundedToolExecutorLimits>;
  readonly createConversationId?: () => string;
  /** Disable SDK byte intake while a migrating host retains its authorized upload route. Defaults to true. */
  readonly attachmentUpload?: boolean;
  /** Migration seam for a host-owned authorized catalog. New integrations use the SDK Postgres catalog. */
  readonly conversationCatalogFor?: (input: {
    readonly context: TContext;
    readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
  }) => ConversationCatalog<TContext>;
  /** Migration seam for an existing approval authority. New integrations use the SDK Postgres store. */
  readonly approvalStoreFor?: (input: {
    readonly context: TContext;
    readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
  }) => ApprovalProposalStore<TContext>;
  /** Enumerates server-trusted scopes at worker startup so pending turns and usage can recover after restart. */
  readonly recoveryContexts?: () => Iterable<TContext> | AsyncIterable<TContext> |
    Promise<Iterable<TContext> | AsyncIterable<TContext>>;
  /**
   * Recover pending work when a trusted context is first authenticated after a
   * restart. Defaults to true. This is the safe recovery path for hosts that
   * cannot reconstruct (and must not persist) opaque user credentials at boot.
   */
  readonly recoverPendingOnContext?: boolean;
  readonly authorizeConversation?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeConversation"];
  readonly authorizeApproval?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeApproval"];
  readonly approvalTimeoutMilliseconds?: number;
  /** Optional multi-instance presence fan-out; process-local delivery remains the zero-config default. */
  readonly presence?: LivePresenceDelivery | { readonly pubSub: LivePresencePubSub; readonly channelPrefix?: string };
  readonly activityPubSub?: LiveConversationActivityPubSub;
  readonly titleGeneration?: (input: { readonly conversationId: string; readonly idempotencyKey: string },
    context: TContext, signal: AbortSignal) => Promise<string>;
}

export interface HandrailAssistant {
  readonly version: typeof HANDRAIL_ASSISTANT_VERSION;
  readonly id: string;
  readonly capabilities: { readonly provider: ProviderAdapterMetadata; readonly toolLoopLimits: Readonly<ToolLoopLimits> };
  handle(request: Request): Promise<Response>;
  express(options: { readonly origin: string }): (
    request: ExpressLikeRequest, response: ExpressLikeResponse, next: ExpressLikeNext,
  ) => Promise<void>;
  recoverPending(limit?: number): Promise<number>;
  flushUsage(limit?: number): Promise<{ readonly delivered: number; readonly pending: number }>;
  /** Stops the process-local usage retry worker without closing host-owned persistence. */
  stopUsageWorker(): void;
}

const DEFAULT_LIMITS: Readonly<ToolLoopLimits> = Object.freeze({
  maxIterations: 8, maxTotalToolCalls: 32, maxElapsedMs: 120_000, parallelism: 1,
});

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function checkpointForEvent(event: StreamEvent): TurnResumePoint {
  const cursor = `${event.request_id}:${event.sequence}`;
  return Object.freeze({ lastAppliedEventId: cursor, lastAppliedCursor: cursor,
    lastAppliedRevision: event.sequence });
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

function argumentReference(arguments_: JsonObject): string {
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
  eventStore: PostgresAssistantPersistenceBundle<unknown>["events"], conversationId: string,
  proposal: Awaited<ReturnType<ApprovalProposalStore<unknown>["create"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = await eventStore.getLatestRevision(conversationId as never);
    try {
      await eventStore.append({ conversationId: conversationId as never, expectedRevision: latest, events: [parseConversationEvent({
        version: CONVERSATION_EVENT_VERSION, event_id: `approval-created:${proposal.proposal_id}`,
        conversation_id: conversationId, revision: (latest ?? 0) + 1, occurred_at: proposal.created_at,
        actor: SYSTEM_ATTRIBUTION.actor, source: SYSTEM_ATTRIBUTION.source,
        payload: { type: "approval.proposal_created", proposal_id: proposal.proposal_id,
          ...(proposal.group_id === null ? {} : { group_id: proposal.group_id }), turn_id: proposal.turn_id,
          tool_call_id: proposal.tool_call_id, tool_name: proposal.tool_name, status: "pending", proposal_version: 1,
          expires_at: proposal.expires_at, reviewed_arguments: proposal.reviewed_arguments },
      })] });
      return;
    } catch (error) {
      if (!(error instanceof ConversationEventStoreConflictError) || error.code !== "revision_conflict") throw error;
      const retained = await eventStore.read({ conversationId: conversationId as never });
      if (retained.entries.some(({ event }) => event.payload.type === "approval.proposal_created" &&
        event.payload.proposal_id === proposal.proposal_id)) return;
    }
  }
  throw new ApprovalProposalStoreError("unavailable", "create");
}

/**
 * Assemble the authenticated HTTP surface and all durable ownership once.
 * Tenant and scope selection happen only after authorize() returns.
 */
export async function createHandrailAssistant<TContext extends HandrailAssistantAuthorizationContext>(
  options: CreateHandrailAssistantOptions<TContext>,
): Promise<HandrailAssistant> {
  const assistantId = identifier(options.id, "assistant id");
  const instructions = Object.freeze(typeof options.instructions === "string"
    ? [options.instructions] : [...(options.instructions ?? [])]);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.toolLoopLimits });
  const approvalTimeoutMilliseconds = options.approvalTimeoutMilliseconds ?? 15 * 60_000;
  if (!Number.isSafeInteger(approvalTimeoutMilliseconds) || approvalTimeoutMilliseconds <= 0) {
    throw new TypeError("approvalTimeoutMilliseconds must be a positive safe integer");
  }
  const workerId = identifier(options.workerId ?? `${assistantId}-${process.pid}`, "workerId");
  const bundles = new Map<string, PostgresAssistantPersistenceBundle<TContext>>();
  const applications = new Map<string, Promise<AiApplication<TContext, TContext, unknown>>>();
  const transports = new Map<string, Promise<ConversationTransport<StreamEvent, ChatRequest>>>();
  const durableTransports = new Map<string, DurableApplicationTransport<StreamEvent, ChatRequest>>();
  const activityDeliveries = new Map<string, LiveConversationActivityDelivery>();
  const presenceDelivery = options.presence === undefined
    ? createInMemoryLivePresenceDelivery()
    : "publish" in options.presence ? options.presence
      : createInMemoryLivePresenceDelivery({ pubSub: options.presence.pubSub,
          ...(options.presence.channelPrefix === undefined ? {} : { channelPrefix: options.presence.channelPrefix }) });
  const scopeKeyFor = (context: TContext) => `${identifier(context.tenantId, "tenantId")}\0${identifier(context.scopeId, "scopeId")}`;
  // Provider transports and installed plugins may close over roles, actor data,
  // attribution, or session identity. Never reuse them for a different trusted context.
  const executionKeyFor = (context: TContext) => `${scopeKeyFor(context)}\0${digest(JSON.stringify(context))}`;
  const bundleFor = (context: TContext) => {
    const key = scopeKeyFor(context);
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = options.persistence.forScope<TContext>({ tenantId: context.tenantId, scopeId: context.scopeId }, {
        createConversationId: () => (options.createConversationId?.() ?? globalThis.crypto.randomUUID()) as never,
        ...(options.authorizeConversation === undefined ? {} : { authorizeConversation: options.authorizeConversation as never }),
        ...(options.authorizeApproval === undefined ? {} : { authorizeApproval: options.authorizeApproval as never }),
        ...(options.usage?.client == null ? {} : { usageClient: options.usage.client }),
      });
      bundles.set(key, bundle);
    }
    return bundle;
  };
  const activityDeliveryFor = (context: TContext) => {
    const key = scopeKeyFor(context);
    let delivery = activityDeliveries.get(key);
    if (!delivery) {
      delivery = createInMemoryLiveConversationActivityDelivery({
        ...(options.activityPubSub === undefined ? {} : { pubSub: options.activityPubSub }),
        channel: `handrail:activity:${digest(key).slice(0, 32)}`,
      });
      activityDeliveries.set(key, delivery);
    }
    return delivery;
  };
  const catalogFor = (context: TContext) => options.conversationCatalogFor?.({
    context, persistence: bundleFor(context),
  }) ?? bundleFor(context).catalog;
  const approvalStoreFor = (context: TContext) => options.approvalStoreFor?.({
    context, persistence: bundleFor(context),
  }) ?? bundleFor(context).approvals;
  const applicationFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let application = applications.get(key);
    if (!application) {
      const bundle = bundleFor(context);
      application = createAiApplication({
        plugins: options.tools ?? [], installContext: context,
        policy: options.toolPolicy ?? (() => ({ outcome: "allow" })),
        ...(options.approvalPolicy === undefined ? {} : { approvalPolicy: options.approvalPolicy }),
        ...(options.toolExecutorLimits === undefined ? {} : { executorLimits: options.toolExecutorLimits }),
        toolExecutionLedger: bundle.toolLedger,
        approvalCoordinator: createApprovalExecutionCoordinator<TContext>({
          proposalStore: approvalStoreFor(context), eventStore: bundle.events,
          authorize: () => "allow",
          verifyArguments: ({ binding, reviewedArguments, arguments: arguments_ }) => {
            if (binding.type !== "opaque_reference" || reviewedArguments.type !== "opaque_reference") return "mismatch";
            return binding.argumentReference === reviewedArguments.argument_ref &&
              binding.argumentReference === argumentReference(arguments_) ? "match" : "mismatch";
          },
        }),
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      });
      applications.set(key, application);
    }
    return application;
  };
  const activityIdentityFor = async (context: TContext, conversationId: string, turnId: string) => {
    const events = bundleFor(context).events;
    let after: Parameters<typeof events.read>[0]["after"];
    for (;;) {
      const page = await events.read({ conversationId: conversationId as never, limit: 500,
        ...(after === undefined ? {} : { after }) });
      const admitted = page.entries.find(({ event }) => event.payload.type === "turn.started" && event.payload.turn_id === turnId);
      if (admitted) return { turnId, turnRevision: Number(admitted.event.revision) };
      if (!page.hasMore) return { turnId };
      if (page.nextCursor === null || after && "cursor" in after && page.nextCursor === after.cursor) {
        throw new TypeError("Activity admission history did not advance");
      }
      after = { cursor: page.nextCursor };
    }
  };
  const reconcileFor = async (context: TContext, conversationId: string, knownTurnId?: string): Promise<void> => {
    const bundle = bundleFor(context);
    let turnId = knownTurnId;
    if (turnId === undefined) {
      const replay = await replayConversation({ conversationId: conversationId as never, eventStore: bundle.events, checkpointPolicy: false });
      turnId = replay.state.turns.at(-1)?.turn_id;
      replay.store.destroy();
    }
    if (turnId === undefined) return;
    const document = await bundle.durableTurns.load(conversationId, turnId);
    if (!document) return;
    const { status, updatedAt } = document.record;
    const running = status === "pending" || status === "running";
    if (!running) {
      await reconcileDurableConversationTurn({ conversationId, turnId, events: bundle.events,
        turns: bundle.durableTurns as never, attribution: context.attribution,
        ...(bundle.usageReceiptSink ? { usageReceiptSink: bundle.usageReceiptSink } : {}) });
    }
    const turnStatus = running ? "running" : status === "failed" ? "error" : "completed";
    const retained = (await bundle.activity.list()).find((record) => record.conversationId === conversationId);
    if (retained?.turnId === turnId && retained.turnStatus === turnStatus) return;
    const record = await bundle.activity.upsert({ conversationId, ...await activityIdentityFor(context, conversationId, turnId),
      turnStatus, unread: !running, updatedAt });
    await activityDeliveryFor(context).publish(record);
  };
  const reconcileSafely = async (context: TContext, conversationId: string, turnId?: string) => {
    try { await reconcileFor(context, conversationId, turnId); }
    catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "conversation_reconciliation",
      phase: "failed", conversationId, ...(turnId ? { turnId } : {}), code: "reconciliation_failed", retryable: true, cause }); }
  };
  const transportFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let transport = transports.get(key);
    if (!transport) {
      transport = applicationFor(context).then((application) => {
        const bundle = bundleFor(context);
        const definitions = application.discover({ context });
        const activityReporter = createConversationActivityReporter({
          store: bundle.activity,
          delivery: activityDeliveryFor(context),
        });
        const reportActivity = async (
          conversationId: string,
          turnId: string,
          update: ApplicationToolActivityUpdate,
        ): Promise<void> => {
          try {
            await activityReporter.report({ conversationId, ...await activityIdentityFor(context, conversationId, turnId), summary: update.summary,
              ...(update.progress === undefined ? {} : { progress: update.progress }) });
          } catch (cause) {
            emitAiDiagnostic(options.diagnostics, { domain: "activity", operation: "tool_progress",
              phase: "failed", conversationId, code: "activity_update_failed", retryable: true, cause });
          }
        };
        const recordOutcome = async (
          location: { readonly conversationId: string; readonly turnId: string },
          call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">,
          outcome: BoundedToolExecutionOutcome,
        ): Promise<BoundedToolExecutionOutcome> => {
          const identity = { turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never };
          await recordToolLifecycle(bundle.events, location.conversationId,
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
          if (location) {
            const identity = { turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never };
            await recordToolLifecycle(bundle.events, location.conversationId,
              { ...identity, type: "tool_call.requested", name: call.name, arguments: call.arguments });
            await recordToolLifecycle(bundle.events, location.conversationId,
              { ...identity, type: "tool_call.discovered" });
          }
          const outcome = await application.executeTool({ discovery: { context }, applicationContext: context, call, signal,
            executionKey: `tool-${digest(JSON.stringify([context.scopeId,
              location?.conversationId ?? null, location?.turnId ?? null, call.tool_call_id]))}`,
            ...(approval === undefined ? {} : { approval }),
            ...(location === undefined ? {} : {
              onExecutionStarted: () => recordToolLifecycle(bundle.events, location.conversationId,
                { type: "tool_call.started", turn_id: location.turnId as never, tool_call_id: call.tool_call_id as never }),
              reportActivity: (update: ApplicationToolActivityUpdate) => reportActivity(location.conversationId, location.turnId, update),
            }) });
          return location ? recordOutcome(location, call, outcome) : outcome;
        };
        return options.provider.createTransport({
          context, persistence: bundle, limits, instructions,
          toolActivity: createToolActivityObserver({ events: bundle.events, report: reportActivity }),
          tools: Object.freeze({
            definitions,
            async execute(call, signal, location) {
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
              const finishError = (message: string) => recordOutcome({ conversationId, turnId }, call, approvalError(call, message));
              await reportActivity(conversationId, turnId, { summary: "Waiting for approval to continue" });
              const rawArguments = call.arguments as JsonObject;
              const reference = argumentReference(rawArguments);
              const identity = digest(`${conversationId}\u001f${turnId}\u001f${call.tool_call_id}\u001f${call.name}\u001f${reference}`);
              const proposalId = `proposal-${identity.slice(0, 48)}` as never;
              const createdAt = Date.now();
              const proposalStore = approvalStoreFor(context);
              const proposal = await proposalStore.create({ permissionContext: context, proposalId,
                groupId: conversationId as never,
                turnId: turnId as never, toolCallId: call.tool_call_id as never, toolName: call.name,
                reviewedArguments: { type: "opaque_reference", argument_ref: reference as never },
                expiresAt: new Date(createdAt + approvalTimeoutMilliseconds).toISOString() as never,
                attribution: SYSTEM_ATTRIBUTION, idempotencyKey: `approval:${identity}`,
                idempotencyFingerprint: `approval:${identity}` });
              await recordProposalCreated(bundle.events, conversationId, proposal);
              while (!signal.aborted && Date.now() - createdAt < approvalTimeoutMilliseconds) {
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
                if (!await wait(250, signal)) break;
              }
              return finishError(signal.aborted ? "Tool execution was cancelled." : "Tool approval expired.");
            },
          }),
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        });
      }).then(async (delegate) => {
        const durable = createDurableApplicationTransport<StreamEvent, ChatRequest, ChatRequest>({
          delegate: qualifyDurableApplicationTurnStarts(delegate, bundleFor(context).events),
          store: bundleFor(context).durableTurns as never,
          requestCodec: {
            encode: (request: ChatRequest) => request,
            decode: (request: ChatRequest) => request,
            fingerprint: (request: ChatRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          },
          checkpointForEvent,
          workerId,
          onTurnStatusChanged: ({ conversationId, turnId }) => reconcileSafely(context, conversationId, turnId),
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        });
        durableTransports.set(key, durable);
        if (options.recoverPendingOnContext !== false) {
          try {
            await durable.recoverPending(25);
          } catch (cause) {
            emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "context_recovery_scan",
              phase: "failed", code: "recovery_scan_failed", retryable: true, cause });
          }
        }
        const cancellationAware: ConversationTransport<StreamEvent, ChatRequest> = {
          ...durable,
          capabilities: { ...durable.capabilities, authoritativeCancellation: { supported: true, capability: {
            async cancelTurn(input) {
              const cancellation = durable.capabilities.authoritativeCancellation;
              if (!cancellation.supported) throw new TypeError("Durable cancellation must be supported");
              const result = await cancellation.capability.cancelTurn(input);
              if (result.ok || result.error.code !== "not_found") return result;
              try {
                const replay = await replayConversation({ conversationId: input.conversationId as never,
                  eventStore: bundleFor(context).events, checkpointPolicy: false });
                try {
                  if (replay.state.replay_error !== null) throw new TypeError("Canonical history is invalid");
                  const turn = replay.state.turns.find((candidate) => candidate.turn_id === input.turnId);
                  if (!turn) return result;
                  if (!turn.remote_may_still_be_running) {
                    return { ok: true as const, value: { status: "already_terminal" as const } };
                  }
                  if (replay.state.active_turn_id !== input.turnId) return result;
                  return await durable.cancelTurnBeforeStart(input);
                } finally { replay.store.destroy(); }
              } catch {
                return { ok: false as const, error: { code: "unavailable" as const,
                  message: "The admitted turn could not be cancelled.", retryable: true } };
              }
            },
          } } },
        };
        return createAssistantActivityTransport({ delegate: cancellationAware, delivery: presenceDelivery,
          participantId: assistantId, sessionId: (_conversationId, turnId) => `${assistantId}:${turnId}`,
          activityForEvent: (event) => event.type === "response.tool_call" ? "using_tool"
            : event.type === "response.text.delta" ? "responding" : null,
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }) });
      });
      transports.set(key, transport);
    }
    return transport;
  };
  const catalog = Object.freeze({
    capabilities: Object.freeze({
      rename: { supported: true as const }, clear: { supported: true as const },
      archive: { supported: true as const }, restore: { supported: true as const },
      permanentDelete: { supported: true as const },
    }),
    list: async (input: Parameters<ConversationCatalog<TContext>["list"]>[0]) => {
      const page = await catalogFor(input.authorizationContext).list(input);
      for (const descriptor of page.items) await reconcileSafely(input.authorizationContext, descriptor.conversationId);
      return page;
    },
    create: (input: Parameters<ConversationCatalog<TContext>["create"]>[0]) => catalogFor(input.authorizationContext).create(input),
    get: (input: Parameters<ConversationCatalog<TContext>["get"]>[0]) => catalogFor(input.authorizationContext).get(input),
    rename: (input: Parameters<ConversationCatalog<TContext>["rename"]>[0]) => catalogFor(input.authorizationContext).rename(input),
    clear: (input: Parameters<ConversationCatalog<TContext>["clear"]>[0]) => catalogFor(input.authorizationContext).clear(input),
    archive: (input: Parameters<ConversationCatalog<TContext>["archive"]>[0]) => catalogFor(input.authorizationContext).archive(input),
    restore: (input: Parameters<ConversationCatalog<TContext>["restore"]>[0]) => catalogFor(input.authorizationContext).restore(input),
    permanentlyDelete: (input: Parameters<ConversationCatalog<TContext>["permanentlyDelete"]>[0]) =>
      catalogFor(input.authorizationContext).permanentlyDelete(input),
  });
  const approvals: ApprovalProposalStore<TContext> = Object.freeze({
    create: (input: Parameters<ApprovalProposalStore<TContext>["create"]>[0]) => {
      void input;
      return Promise.reject(new ApprovalProposalStoreError("permission_denied", "create"));
    },
    get: (input: Parameters<ApprovalProposalStore<TContext>["get"]>[0]) =>
      approvalStoreFor(input.permissionContext).get(input),
    listGroup: (input: Parameters<ApprovalProposalStore<TContext>["listGroup"]>[0]) =>
      approvalStoreFor(input.permissionContext).listGroup(input),
    async transition(input: Parameters<ApprovalProposalStore<TContext>["transition"]>[0]) {
      const supplied = input as typeof input & { readonly conversationId?: unknown };
      if (typeof supplied.conversationId !== "string" ||
        (input.status !== "confirmed" && input.status !== "rejected" && input.status !== "expired")) {
        throw new ApprovalProposalStoreError("invalid_input", "transition");
      }
      const bundle = bundleFor(input.permissionContext);
      const proposalStore = approvalStoreFor(input.permissionContext);
      try {
        await catalogFor(input.permissionContext).get({ authorizationContext: input.permissionContext,
          conversationId: supplied.conversationId as never });
      } catch (error) {
        if (error instanceof ConversationCatalogError) {
          throw new ApprovalProposalStoreError(error.code === "not_found" ? "not_found"
            : error.code === "forbidden" ? "permission_denied" : "unavailable", "transition");
        }
        throw error;
      }
      const history = await bundle.events.read({ conversationId: supplied.conversationId as never });
      if (!history.entries.some(({ event }) => event.payload.type === "approval.proposal_created" &&
        event.payload.proposal_id === input.proposalId)) {
        // Older application proposals may predate the SDK event history. Only
        // an explicitly configured host authority can prove their membership;
        // SDK-owned proposals still require their canonical creation event.
        if (options.approvalStoreFor) {
          const group = await proposalStore.listGroup({ permissionContext: input.permissionContext,
            groupId: supplied.conversationId as never });
          if (group.some((proposal) => proposal.proposal_id === input.proposalId)) {
            return proposalStore.transition({ ...input,
              attribution: { actor: { type: "user", id: input.permissionContext.principalId as never },
                source: { type: "runtime" } } });
          }
        }
        throw new ApprovalProposalStoreError("not_found", "transition");
      }
      const coordinator = createApprovalCoordinator<TContext>({ proposalStore,
        eventStore: bundle.events, authorize: () => "allow" });
      const result = await coordinator.decide({ permissionContext: input.permissionContext,
        conversationId: supplied.conversationId as never, proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        decision: input.status === "confirmed" ? "confirm" : input.status === "rejected" ? "reject" : "expire",
        attribution: { actor: { type: "user", id: input.permissionContext.principalId as never },
          source: { type: "runtime" } }, idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
        signal: new AbortController().signal });
      if (result.outcome === "accepted" || result.outcome === "already_decided") {
        const retained = await proposalStore.get({ permissionContext: input.permissionContext,
          proposalId: input.proposalId });
        if (retained !== null) return retained;
      }
      const code = result.outcome === "forbidden" ? "permission_denied"
        : result.outcome === "not_found" ? "not_found"
        : result.outcome === "persistence_failure" || result.outcome === "cancelled" ? "unavailable"
        : result.outcome === "conflict" && result.conflict === "version" ? "version_conflict"
        : result.outcome === "conflict" && result.conflict === "idempotency" ? "idempotency_conflict"
        : "invalid_input";
      throw new ApprovalProposalStoreError(code, "transition");
    },
  });
  const activity = (request: Request, context: TContext) =>
    createConversationActivityHttpHandler(bundleFor(context).activity,
      { delivery: activityDeliveryFor(context) })(request);
  const ownsConversation = async (context: TContext, conversationId: string) => {
    await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
    return true;
  };
  const attachments = async (request: Request, context: TContext) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    try {
      const form = await request.formData();
      const file = form.get("file"), conversationId = form.get("conversationId"), idempotencyKey = form.get("idempotencyKey");
      if (!(file instanceof Blob) || typeof conversationId !== "string" || typeof idempotencyKey !== "string") {
        return new Response(null, { status: 400 });
      }
      await ownsConversation(context, conversationId);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const reference = await bundleFor(context).attachments.stage({ ownerScopeId: context.scopeId, conversationId,
        idempotencyKey, fingerprint, mediaType: file.type,
        ...(typeof (file as File).name === "string" ? { filename: (file as File).name } : {}), bytes });
      return new Response(JSON.stringify({ ok: true, value: reference }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "Attachment upload denied." } }),
        { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  };
  const synchronization = createConversationSynchronizationHttpHandler<TContext>({
    adapterFor: (context) => createDurableApplicationConversationSync({
      authorizationContext: context,
      principalId: context.principalId,
      eventStore: bundleFor(context).events,
      turnStore: bundleFor(context).durableTurns as never,
      authorizeConversation: async (conversationId) => {
        await ownsConversation(context, conversationId);
        // Repair is retried on each request, but it is not an authorization check.
        // A competing projector or activity-store outage must not block access to
        // already-saved history. The adapter still validates every proposed event.
        await reconcileSafely(context, conversationId);
        return true;
      },
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  const presence = (request: Request, context: TContext) => createLivePresenceHttpHandler({
    delivery: presenceDelivery,
    authorize: async (_request, conversationId) => { await ownsConversation(context, conversationId); return context; },
  })(request);
  const generateTitle = async (input: { readonly conversationId: string; readonly idempotencyKey: string },
    context: TContext, signal: AbortSignal): Promise<string> => {
    if (options.titleGeneration !== undefined) return options.titleGeneration(input, context, signal);
    await ownsConversation(context, input.conversationId);
    const history = await bundleFor(context).events.read({ conversationId: input.conversationId as never });
    const first = history.entries.map(({ event }) => event.payload).find((payload) =>
      payload.type === "message.created" && payload.role === "user");
    if (first?.type !== "message.created") return "New conversation";
    const text = first.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ")
      .replace(/\s+/gu, " ").trim();
    return text.length === 0 ? "New conversation" : text.slice(0, 80);
  };
  const gateway: ApplicationGateway = createApplicationGateway({
    authorize: async (request, action) => options.authorize(request, action),
    transportFor,
    checkpointForEvent,
    conversations: catalog as unknown as ConversationCatalog<TContext>,
    approvals,
    titleGeneration: { generate: generateTitle },
    handlers: { activity, ...(options.attachmentUpload === false ? {} : { attachments }), synchronization, presence },
    capabilities: { activity: true, presence: true, synchronization: true,
      attachments: options.attachmentUpload === false ? false : {
        maximumFiles: 16, maximumBytesPerFile: options.persistence.attachmentLimits.maximumBytes,
        acceptedMediaTypes: options.persistence.attachmentLimits.acceptedMediaTypes, uploadUrl: "attachments" },
      documentInput: options.provider.metadata.capabilities.document_input.supported
      ? options.provider.metadata.capabilities.document_input.capability : false,
      assistant: { id: assistantId, version: HANDRAIL_ASSISTANT_VERSION,
        provider: options.provider.metadata, toolLoopLimits: limits } },
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  const primeRecoveryContexts = async () => {
    const source = await options.recoveryContexts?.();
    if (source === undefined) return;
    for await (const context of source) await transportFor(context);
  };
  const flushUsage = async (limit?: number) => {
    await primeRecoveryContexts();
    let delivered = 0, pending = 0;
    for (const bundle of bundles.values()) {
      if (!bundle.usageReceiptSink) continue;
      const result = await bundle.usageReceiptSink.flush(limit);
      delivered += result.delivered; pending += result.pending;
    }
    return Object.freeze({ delivered, pending });
  };
  const usageBatchSize = options.usageDelivery?.batchSize;
  if (usageBatchSize !== undefined && (!Number.isSafeInteger(usageBatchSize) || usageBatchSize <= 0)) {
    throw new TypeError("usageDelivery.batchSize must be a positive safe integer");
  }
  const retryIntervalMilliseconds = options.usageDelivery?.retryIntervalMilliseconds === undefined
    ? 30_000 : options.usageDelivery.retryIntervalMilliseconds;
  if (retryIntervalMilliseconds !== null &&
    (!Number.isSafeInteger(retryIntervalMilliseconds) || retryIntervalMilliseconds <= 0)) {
    throw new TypeError("usageDelivery.retryIntervalMilliseconds must be null or a positive safe integer");
  }
  let usageFlushRunning = false;
  const runUsageFlush = async () => {
    if (usageFlushRunning) return;
    usageFlushRunning = true;
    try { await flushUsage(usageBatchSize); }
    catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "usage_outbox_flush",
      phase: "failed", code: "usage_delivery_failed", retryable: true, cause }); }
    finally { usageFlushRunning = false; }
  };
  if (options.usage?.client != null && options.usageDelivery?.flushOnStartup !== false) await runUsageFlush();
  const usageTimer = options.usage?.client != null && retryIntervalMilliseconds !== null
    ? setInterval(() => void runUsageFlush(), retryIntervalMilliseconds)
    : null;
  usageTimer?.unref?.();
  return Object.freeze({
    version: HANDRAIL_ASSISTANT_VERSION,
    id: assistantId,
    capabilities: Object.freeze({ provider: options.provider.metadata, toolLoopLimits: limits }),
    handle: (request: Request) => gateway.handle(request),
    express: (expressOptions: { readonly origin: string }) =>
      createApplicationGatewayExpressMiddleware(gateway, expressOptions),
    async recoverPending(limit = 100) {
      await primeRecoveryContexts();
      let recovered = 0;
      for (const transport of durableTransports.values()) recovered += (await transport.recoverPending(limit)).length;
      return recovered;
    },
    flushUsage,
    stopUsageWorker() { if (usageTimer !== null) clearInterval(usageTimer); },
  });
}
