import { createAssistantToolRuntime, assistantToolArgumentReference, type AssistantToolRuntime } from "./assistant-tool-runtime.js";
export { createAssistantToolRuntime, assistantToolArgumentReference, type AssistantToolRuntime, type AssistantToolRuntimeOptions } from "./assistant-tool-runtime.js";
export { createActiveExecutionBudget } from "../tools/active-budget.js";
import { createToolActivityObserver, type HandrailAssistantToolObserver } from "./tool-observer.js";
import { createHash } from "node:crypto";
import { composerApprovalModeFromRequest } from "../composer-approval.js";
import { createAssistantTranscription, type AssistantTranscriptionProvider } from "./transcription.js";
import { DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY } from "../transcription-http.js";
export { openaiTranscription, type HandrailOpenAITranscriptionOptions } from "./openai-transcription.js";
export { createAssistantTranscription, createTranscriptionHttpHandler, type AssistantTranscriptionProvider,
  type TranscriptionHttpServerInput, type AssistantTranscriptionUsage } from "./transcription.js";
import { reconcileDurableConversationTurn } from "./reconcile-conversation.js";
import { replayConversation } from "../conversation/replay.js";
import { findConversationEvent } from "../conversation/find-event.js";
import { createAssistantConversationTitles, type AssistantAutomaticTitleOptions,
  type AssistantTitleProviderRequest } from "./conversation-titles.js";

import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { AuthoritativeAttribution, ChatRequest, JsonObject, StreamEvent } from "../protocol.js";
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
  BoundedToolExecutorLimits } from "../tools/executor.js";
import type { ToolPlugin } from "../tools/plugin.js";
import type { AIRuntimeUsageConfiguration } from "./usage-control.js";
import { createApprovalExecutionCoordinator } from "../tools/approval-execution.js";
import { createApprovalCoordinator } from "../conversation/approval-coordinator.js";
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
export type { AssistantAutomaticTitleOptions, AssistantTitleProviderRequest } from "./conversation-titles.js";

export const HANDRAIL_ASSISTANT_VERSION = "handrail.assistant.v1" as const;

export interface HandrailAssistantAuthorizationContext extends ApplicationGatewayAuthorizationContext {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly attribution: AuthoritativeAttribution;
}

export interface HandrailAssistantProvider<TContext extends HandrailAssistantAuthorizationContext> {
  readonly metadata: ProviderAdapterMetadata;
  readonly transcription?: AssistantTranscriptionProvider<TContext>;
  /** Text-only generation hook. The SDK owns completion triggers, persistence, and usage attribution. */
  generateTitle?(input: AssistantTitleProviderRequest<TContext>): Promise<string>;
  /** SDK-owned provider packages return this transport with their bounded tool loop already installed. */
  createTransport(input: {
    readonly context: TContext;
    readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
    readonly instructions: readonly string[];
    readonly toolActivity: HandrailAssistantToolObserver;
    readonly tools: AssistantToolRuntime;
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
  /** Defaults to the provider's configured speech service; false disables authenticated dictation. */
  readonly transcription?: false | AssistantTranscriptionProvider<TContext>;
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
  /** Server-owned first-completed-turn titles, enabled when the provider supports generation. */
  readonly automaticTitles?: false | AssistantAutomaticTitleOptions;
  /** Legacy generate endpoint override. Prefer provider.generateTitle so the SDK owns persistence and automatic triggers. */
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

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Assemble the authenticated HTTP surface and all durable ownership once.
 * Tenant and scope selection happen only after authorize() returns.
 */
export async function createHandrailAssistant<TContext extends HandrailAssistantAuthorizationContext>(
  options: CreateHandrailAssistantOptions<TContext>,
): Promise<HandrailAssistant> {
  const assistantId = identifier(options.id, "assistant id");
  const transcriptionProvider = options.transcription ?? options.provider.transcription;
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
  const titles = createAssistantConversationTitles({ assistantId, catalogFor, bundleFor, provider: options.provider,
    ...(options.automaticTitles === undefined ? {} : { automatic: options.automaticTitles }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }) });
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
        approvalPolicy: options.approvalPolicy ?? (async ({ location, signal }) => {
          // Read the admitted request, including during recovery. A later UI
          // preference cannot alter an already running turn. This is only the
          // confirmation policy; application/plugin authorization runs first.
          if (!location) return "require_approval";
          signal.throwIfAborted();
          const document = await bundle.durableTurns.load(location.conversationId, location.turnId);
          signal.throwIfAborted();
          const request = document?.record.request as ChatRequest | null | undefined;
          return request && composerApprovalModeFromRequest(request) === "automatic"
            ? "allow_without_approval" : "require_approval";
        }),
        ...(options.toolExecutorLimits === undefined ? {} : { executorLimits: options.toolExecutorLimits }),
        toolExecutionLedger: bundle.toolLedger,
        approvalCoordinator: createApprovalExecutionCoordinator<TContext>({
          proposalStore: approvalStoreFor(context), eventStore: bundle.events,
          authorize: () => "allow",
          verifyArguments: ({ binding, reviewedArguments, arguments: arguments_ }) => {
            if (binding.type !== "opaque_reference" || reviewedArguments.type !== "opaque_reference") return "mismatch";
            return binding.argumentReference === reviewedArguments.argument_ref &&
              binding.argumentReference === assistantToolArgumentReference(arguments_) ? "match" : "mismatch";
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
      // Retain the SDK's versioned projection checkpoint for long histories.
      // Later authorization-checked reads replay only its canonical event tail.
      const replay = await replayConversation({ conversationId: conversationId as never, eventStore: bundle.events });
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
    // Title work is independent of the observing browser and never delays the answer.
    void titles.afterActivity(conversationId, context);
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
        return options.provider.createTransport({
          context, persistence: bundle, limits, instructions,
          toolActivity: createToolActivityObserver({ events: bundle.events, report: reportActivity }),
          tools: createAssistantToolRuntime({ context, application, events: bundle.events,
            proposalStore: approvalStoreFor(context), reportActivity, approvalTimeoutMilliseconds,
            authorizeLocation: async (location, signal) => {
              signal.throwIfAborted();
              await catalogFor(context).get({ authorizationContext: context, conversationId: location.conversationId as never });
              signal.throwIfAborted();
            },
            ...(options.activityForToolCall ? { activityForToolCall: options.activityForToolCall } : {}),
            ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
          }),
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        });
      }).then(async (delegate) => {
        const durable = createDurableApplicationTransport<StreamEvent, ChatRequest, ChatRequest>({
          delegate: qualifyDurableApplicationTurnStarts(delegate, bundleFor(context).events),
          store: bundleFor(context).durableTurns as never,
          async authorizeRecovery({ conversationId }) {
            try {
              await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
              return true;
            } catch (error) {
              if (error instanceof ConversationCatalogError && (error.code === "not_found" || error.code === "forbidden")) return false;
              throw error;
            }
          },
          requestCodec: {
            encode: (request: ChatRequest) => request,
            decode: (request: ChatRequest) => request,
            fingerprint: (request: ChatRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          },
          checkpointForEvent,
          // Each trusted context owns a distinct transport. A refreshed session
          // or role must not claim another transport's live lease merely because
          // both belong to this assistant host. Its cancellation still reaches
          // the original worker through the shared durable turn record.
          workerId: `context-${digest(JSON.stringify([workerId, key]))}`,
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
    list: async (input: Parameters<ConversationCatalog<TContext>["list"]>[0]) => {
      const page = await catalogFor(input.authorizationContext).list(input);
      for (const descriptor of page.items) {
        await reconcileSafely(input.authorizationContext, descriptor.conversationId);
        // Also covers imported conversations without a durable turn document.
        void titles.afterActivity(descriptor.conversationId, input.authorizationContext);
      }
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
      const created = await findConversationEvent(bundle.events, supplied.conversationId as never,
        (event) => event.payload.type === "approval.proposal_created" && event.payload.proposal_id === input.proposalId);
      if (!created) {
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
    return titles.generate(input.conversationId, context);
  };
  const gateway: ApplicationGateway = {
    handle(request) {
      // The gateway authenticates before reading capabilities. Keep that context
      // local to this request, including when transport resolution overlaps.
      let context: TContext;
      return createApplicationGateway({
        authorize: async (request, action) => {
          context = await options.authorize(request, action);
          return context;
        },
        transportFor,
        checkpointForEvent,
        conversations: { ...catalog, get capabilities() { return catalogFor(context).capabilities; } },
        approvals,
        titleGeneration: { generate: generateTitle },
        handlers: { activity, ...(options.attachmentUpload === false ? {} : { attachments }), synchronization, presence,
          ...(transcriptionProvider ? { transcription: createAssistantTranscription({
            assistantId, provider: transcriptionProvider,
            ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
            catalogFor, bundleFor }) } : {}) },
        capabilities: { activity: true, presence: true, synchronization: true,
          transcription: transcriptionProvider
            ? { ...(transcriptionProvider.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY), url: "transcriptions" } : false,
          attachments: options.attachmentUpload === false ? false : {
            maximumFiles: 16, maximumBytesPerFile: options.persistence.attachmentLimits.maximumBytes,
            acceptedMediaTypes: options.persistence.attachmentLimits.acceptedMediaTypes, uploadUrl: "attachments" },
          documentInput: options.provider.metadata.capabilities.document_input.supported
          ? options.provider.metadata.capabilities.document_input.capability : false,
          assistant: { id: assistantId, version: HANDRAIL_ASSISTANT_VERSION,
            provider: options.provider.metadata, toolLoopLimits: limits } },
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      }).handle(request);
    },
  };
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
