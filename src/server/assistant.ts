export { createAttachmentContentValidator, AttachmentContentError, STANDARD_ATTACHMENT_MEDIA_TYPES,
  type AttachmentContentFailure, type AttachmentContentInput, type AttachmentContentPolicy, type StandardAttachmentMediaType } from "./attachment-content.js";
export { createTrackedOpenAIResponsesRequest, type TrackedOpenAIResponsesRequestOptions, type OpenAIResponsesExecutionContext } from "./openai-responses-request.js";
export { retainProviderInvocation, type ProviderInvocationOperationStore } from "./provider-invocations.js";
export { createConversationFileStorage, type ConversationFileStorageOptions, type ConversationFileInput,
  type RetainedConversationFile } from "./conversation-files.js";
export { createSavedFileHandles, type SavedFileHandles, type SavedFileHandlesOptions,
  type SavedFileHandleEntry, type SavedFileLocation } from "./saved-file-handles.js";
export { createSavedFileTools, openedSavedFileSelection, SAVED_FILE_LIST_TOOL, SAVED_FILE_OPEN_TOOL,
  type SavedFileToolOptions, type OpenedSavedFile } from "./saved-file-tools.js";
export { createRecordFileAttachments, createRecordFileAttachmentAdmission, createPostgresRecordFileAttachmentStore, RecordFileAttachmentError,
  type RecordFileAttachmentRequest, type RecordFileAttachmentIntent, type RecordFileAttachmentReceipt,
  type RecordFileAttachmentState, type RecordFileAttachmentStore, type RecordFileAttachmentDestination,
  type RecordFileAttachmentSource, type RecordFileAttachmentLocation, type RecordFileDestinationInput,
  type RecordFileAttachmentFailure, type RecordFileAttachments, type RecordFileAttachmentPreparation } from "./record-file-attachments.js";
export { createRecordFileTools, recordFileAttachmentReview, type RecordFileToolDestination, type RecordFileToolOptions } from "./record-file-tools.js";
import { createRecordFileTools, type RecordFileToolDestination } from "./record-file-tools.js";
import { createRecordFileAttachments, createPostgresRecordFileAttachmentStore, type RecordFileAttachmentDestination } from "./record-file-attachments.js";
import type { SavedFileHandles } from "./saved-file-handles.js";
import { createAssistantToolRuntime, assistantToolArgumentReference, type AssistantToolRuntime } from "./assistant-tool-runtime.js";
import { resumeExternalToolApprovals, type ExternalApprovalRuntimeFactory } from "./external-tool-approvals.js";
export { resumeExternalToolApprovals, type ExternalApprovalRuntimeFactory } from "./external-tool-approvals.js";
export { createAssistantToolRuntime, assistantToolArgumentReference, type AssistantToolRuntime, type AssistantToolRuntimeOptions } from "./assistant-tool-runtime.js";
export { createActiveExecutionBudget } from "../tools/active-budget.js";
import { createToolActivityObserver, type HandrailAssistantToolObserver } from "./tool-observer.js";
import { createHash } from "node:crypto";
import { ConversationMaintenanceQueue } from "./conversation-maintenance.js";
import { createLiveConversationProjection, type LiveConversationProjection } from "./live-conversation-projection.js";
import { PostgresConversationDisplayHistory } from "../postgres/display-history.js";
import type { ConversationDisplayHistory, ConversationDisplayPage } from "../conversation/display-history.js";
import { AttachmentStagingError } from "../attachments/staging.js";
import { createAttachmentContentValidator, STANDARD_ATTACHMENT_MEDIA_TYPES } from "./attachment-content.js";
import { createAssistantConversationFiles, assistantConversationFileMaintenanceScope, type AssistantConversationFiles } from "./assistant-conversation-files.js";
import { startPostgresConversationFileStagingCleanupWorker } from "../postgres/conversation-file-staging.js";
export { createAssistantConversationFiles, type AssistantConversationFiles, type AssistantConversationFilesOptions } from "./assistant-conversation-files.js";
import { composerApprovalModeFromRequest } from "../composer-approval.js";
import { createAssistantTranscription, type AssistantTranscriptionProvider } from "./transcription.js";
import { DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY } from "../transcription-http.js";
export { openaiTranscription, createOpenAITranscriptionRequest, createOpenAIAudioTranscriber, type HandrailOpenAITranscriptionOptions } from "./openai-transcription.js";
export { createAssistantTranscription, createTranscriptionHttpHandler, createTranscriptionUsageRecorder, runRetainedTranscription, runTranscriptionAttempt, validateTranscriptionAudio, type RetainedTranscriptionOptions, type TranscriptionAttemptOptions, type AssistantTranscriptionProvider,
  type TranscriptionHttpServerInput, type AssistantTranscriptionUsage } from "./transcription.js";
import { reconcileDurableConversationTurn } from "./reconcile-conversation.js";
import { parseConversationEvent } from "../conversation/events.js";
import { ConversationEventStoreConflictError } from "../conversation/event-store.js";
import { replayConversation } from "../conversation/replay.js";
import { findConversationEvent } from "../conversation/find-event.js";
import { createAssistantConversationTitles, type AssistantAutomaticTitleOptions,
  type AssistantTitleProviderRequest, type AssistantExternalTitleUserTexts } from "./conversation-titles.js";

import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { AuthoritativeAttribution, ChatRequest, JsonObject, StreamEvent } from "../protocol.js";
import type { ProviderAdapterMetadata } from "../providers/index.js";
import { DEFAULT_TOOL_LOOP_LIMITS, type ToolLoopLimits } from "../tools/loop.js";
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
import type { ApplicationToolActivityUpdate, ApplicationToolExecutor, ApplicationToolPolicy, ApplicationToolAdmission,
  BoundedToolExecutorLimits, ApplicationToolExecutionLocation } from "../tools/executor.js";
import type { ToolPlugin } from "../tools/plugin.js";
import { createAIRuntimeUsageDelivery, type AIRuntimeUsageConfiguration } from "./usage-control.js";
import { createApprovalExecutionCoordinator } from "../tools/approval-execution.js";
import { createApprovalCoordinator } from "../conversation/approval-coordinator.js";
import { createConversationSynchronizationHttpHandler } from "../sync/http.js";
import { createDurableApplicationConversationSync, qualifyDurableApplicationTurnStarts } from "../sync/durable-application-adapter.js";
import { createInMemoryLivePresenceDelivery, createLivePresenceHttpHandler } from "../presence/live-delivery.js";
import type { LivePresenceDelivery, LivePresencePubSub } from "../presence/live-delivery.js";
import { createAssistantActivityTransport } from "../presence/assistant-activity.js";

export { waitForApplicationApproval, ApplicationApprovalWaitExpiredError,
  type ApplicationApprovalWaitOptions, type ApplicationApprovalObservation } from "./application-approval-wait.js";
export type { ApplicationToolAdmission } from "../tools/executor.js";
export type { HandrailAssistantToolObserver } from "./tool-observer.js";
export { openaiResponses, createOpenAIResponsesRequest, DEFAULT_ASSISTANT_DOCUMENT_INPUT,
  type HandrailOpenAIResponsesOptions, type HandrailSavedConversationOptions } from "./openai-responses.js";
export { createProviderToolLoopTransport, type ProviderToolLoopTransportOptions } from "./provider-tool-loop.js";
export type { AssistantAutomaticTitleOptions, AssistantTitleProviderRequest, AssistantExternalTitleUserTexts } from "./conversation-titles.js";

export const HANDRAIL_ASSISTANT_VERSION = "handrail.assistant.v1" as const;

export interface HandrailAssistantAuthorizationContext extends ApplicationGatewayAuthorizationContext {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly attribution: AuthoritativeAttribution;
}

export interface HandrailAssistantProviderScope<TContext extends HandrailAssistantAuthorizationContext> {
  readonly context: TContext;
  readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
  readonly conversationFiles?: AssistantConversationFiles;
  /** Uses the configured catalog, including a host's existing catalog adapter. */
  readonly authorizeConversation?: (conversationId: string) => Promise<void>;
}
export interface HandrailAssistantToolSupport<TContext extends HandrailAssistantAuthorizationContext> {
  readonly plugins: readonly ToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>[];
  readonly admission?: ApplicationToolAdmission<TContext>;
  /** The same scope-bound saved-file service used by provider listing/opening.
   * Each operation checks current access; handles are never reconstructed by hosts. */
  readonly savedFilesFor?: (location: ApplicationToolExecutionLocation) => SavedFileHandles;
}

export interface HandrailAssistantRecordFiles<TContext extends HandrailAssistantAuthorizationContext> {
  readonly destinations: readonly RecordFileToolDestination[];
  /** Current identity/business permissions and atomic domain writes remain in
   * these app adapters. Called anew for admission, execution and receipt replay. */
  readonly destinationsFor: (input: { readonly context: TContext; readonly location: ApplicationToolExecutionLocation }) =>
    readonly RecordFileAttachmentDestination[] | Promise<readonly RecordFileAttachmentDestination[]>;
  readonly approvalMode?: "always" | "policy";
}

export interface HandrailAssistantProvider<TContext extends HandrailAssistantAuthorizationContext> {
  readonly metadata: ProviderAdapterMetadata;
  readonly transcription?: AssistantTranscriptionProvider<TContext>;
  /** Text-only generation hook. The SDK owns completion triggers, persistence, and usage attribution. */
  generateTitle?(input: AssistantTitleProviderRequest<TContext>): Promise<string>;
  /** SDK provider tools share the assistant's normal durable execution boundary. */
  createToolSupport?(input: HandrailAssistantProviderScope<TContext>): HandrailAssistantToolSupport<TContext> | Promise<HandrailAssistantToolSupport<TContext>>;
  /** SDK-owned provider packages return this transport with their bounded tool loop already installed. */
  createTransport(input: HandrailAssistantProviderScope<TContext> & {
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
  /** SDK-owned saved-file preparation, review, approval and verified record
   * receipts. Requires provider saved-file support (for OpenAI: savedConversation). */
  readonly recordFiles?: HandrailAssistantRecordFiles<TContext>;
  readonly toolPolicy?: ApplicationToolPolicy<TContext>;
  /** Resolves current principal/operation access for every tool attempt, including recovered exact retries. */
  readonly toolAdmission?: ApplicationToolAdmission<TContext>;
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
  /** Explicit policy for new SDK uploads. Conversation retention atomically
   * retains files with admitted user messages. Temporary preserves legacy TTL.
   * Existing storage is never adopted or rewritten when this option changes. */
  readonly attachmentRetention?: "conversation" | "temporary";
  /** Idle expiry for new SDK-managed uploads. Defaults to one bounded service
   * worker; false is for hosts that schedule the SDK cleanup explicitly. */
  readonly attachmentCleanup?: false | { readonly intervalMs?: number; readonly batchSize?: number };
  /** Protected reads of retained saved files. Defaults true, independent of upload controls. */
  readonly attachmentDownloads?: boolean;
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
  /** Trusted external transports (for example live voice) can resume exact saved
   * decisions with fresh authorization, independently of expired media leases. */
  readonly externalApprovalRuntimeFor?: ExternalApprovalRuntimeFactory<TContext>;
  readonly authorizeConversation?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeConversation"];
  readonly authorizeApproval?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeApproval"];
  /** @deprecated Approval requests do not expire. Ignored. */
  readonly approvalTimeoutMilliseconds?: number;
  /** Optional multi-instance presence fan-out; process-local delivery remains the zero-config default. */
  readonly presence?: LivePresenceDelivery | { readonly pubSub: LivePresencePubSub; readonly channelPrefix?: string };
  readonly activityPubSub?: LiveConversationActivityPubSub;
  /** Server-owned first-completed-turn titles, enabled when the provider supports generation. */
  readonly automaticTitles?: false | AssistantAutomaticTitleOptions;
  /** Freshly authorized user speech for conversations without text messages.
   * This never creates chat turns or reopens the external transport. */
  readonly externalTitleUserTextsFor?: AssistantExternalTitleUserTexts<TContext>;
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
  /** Stops and joins SDK background maintenance before host-owned persistence closes. */
  stopBackgroundWorkers(): Promise<void>;
  /** @deprecated Use stopBackgroundWorkers. This compatible alias now also
   * joins file maintenance when awaited; it does not cancel admitted turns. */
  stopUsageWorker(): Promise<void>;
}

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
  const limits = Object.freeze({ ...DEFAULT_TOOL_LOOP_LIMITS, ...options.toolLoopLimits });
  const workerId = identifier(options.workerId ?? `${assistantId}-${process.pid}`, "workerId");
  const bundles = new Map<string, PostgresAssistantPersistenceBundle<TContext>>();
  const applications = new Map<string, Promise<AiApplication<TContext, TContext, unknown>>>();
  const transports = new Map<string, Promise<ConversationTransport<StreamEvent, ChatRequest>>>();
  const durableTransports = new Map<string, DurableApplicationTransport<StreamEvent, ChatRequest>>();
  const liveProjectionClosers = new Set<() => Promise<void>>();
  let liveProjectionStopped = false;
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
  const filesFor = (context: TContext) => options.attachmentRetention === "conversation"
    ? createAssistantConversationFiles({ persistence: bundleFor(context).persistence,
      tenantId: context.tenantId, scopeId: context.scopeId, principalId: context.principalId, assistantId,
      limits: options.persistence.attachmentLimits, authorizeConversation: async conversationId => {
        await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
      } }) : undefined;
  const titles = createAssistantConversationTitles({ assistantId, catalogFor, bundleFor, provider: options.provider,
    ...(options.externalTitleUserTextsFor === undefined ? {} : { externalUserTextsFor: options.externalTitleUserTextsFor }),
    ...(options.automaticTitles === undefined ? {} : { automatic: options.automaticTitles }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }) });
  const approvalStoreFor = (context: TContext) => options.approvalStoreFor?.({
    context, persistence: bundleFor(context),
  }) ?? bundleFor(context).approvals;
  const providerScopeFor = (context: TContext): HandrailAssistantProviderScope<TContext> => {
    const bundle = bundleFor(context), conversationFiles = filesFor(context);
    return { context, persistence: conversationFiles ? { ...bundle, events: conversationFiles.events } : bundle,
      ...(conversationFiles ? { conversationFiles } : {}), authorizeConversation: async conversationId => {
        await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
      } };
  };
  const toolSupports = new Map<string, Promise<HandrailAssistantToolSupport<TContext>>>();
  const toolSupportFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let support = toolSupports.get(key);
    if (!support) {
      support = Promise.resolve(options.provider.createToolSupport?.(providerScopeFor(context)) ?? { plugins: [] });
      toolSupports.set(key, support);
    }
    return support;
  };
  const applicationFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let application = applications.get(key);
    if (!application) {
      const bundle = bundleFor(context);
      application = toolSupportFor(context).then(support => {
        if (options.recordFiles && !support.savedFilesFor) throw new TypeError("Record attachments require provider saved-file support");
        const recordTools = options.recordFiles ? createRecordFileTools<TContext>({
          destinations: options.recordFiles.destinations, approvalMode: options.recordFiles.approvalMode ?? "policy",
          serviceFor: async (current, location) => createRecordFileAttachments({
            namespace: [current.tenantId, current.scopeId, assistantId, "record-files"],
            files: support.savedFilesFor!(location),
            store: createPostgresRecordFileAttachmentStore(bundle.persistence, current.tenantId),
            destinations: await options.recordFiles!.destinationsFor({ context: current, location }),
          }),
        }) : undefined;
        const admissions = [options.toolAdmission, support.admission, recordTools?.admission]
          .filter((admission): admission is ApplicationToolAdmission<TContext> => admission !== undefined);
        return createAiApplication({
          plugins: [...(options.tools ?? []), ...support.plugins, ...(recordTools ? [recordTools.plugin] : [])], installContext: context,
          policy: options.toolPolicy ?? (() => ({ outcome: "allow" })),
          ...(admissions.length === 0 ? {} : { toolAdmission: async input => {
            for (const admission of admissions) if ((await admission(input)).outcome !== "allow") return { outcome: "deny" as const };
            return { outcome: "allow" as const };
          } }),
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
      });
      applications.set(key, application);
    }
    return application;
  };
  const activityIdentityFor = async (context: TContext, conversationId: string, turnId: string) => {
    const events = bundleFor(context).events;
    let after: Parameters<typeof events.read>[0]["after"];
    let turnRevision: number | undefined;
    for (;;) {
      const page = await events.read({ conversationId: conversationId as never, limit: 500,
        ...(after === undefined ? {} : { after }) });
      for (const { event } of page.entries) {
        if ((event.payload.type === "turn.started" || event.payload.type === "turn.status_changed" &&
          event.payload.status === "running" && event.actor.type === "system") && event.payload.turn_id === turnId) {
          turnRevision = Number(event.revision);
        }
      }
      if (!page.hasMore) return { turnId, ...(turnRevision === undefined ? {} : { turnRevision }) };
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
      turnId = replay.state.active_turn_id ?? replay.state.turns.at(-1)?.turn_id;
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
  const continueApprovedTurns = async (context: TContext, conversationId: string): Promise<void> => {
    // Decisions are durable. If another message is running, its settlement (or
    // the next authorized read after a restart) will dispatch the saved action.
    await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
    const bundle = bundleFor(context);
    if (options.externalApprovalRuntimeFor) {
      try {
        await resumeExternalToolApprovals({ context, conversationId, events: bundle.events,
          proposals: approvalStoreFor(context), turns: bundle.durableTurns,
          runtimeFor: options.externalApprovalRuntimeFor });
      } catch (cause) {
        emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "external_approval_resumption",
          phase: "failed", conversationId, code: "approval_resumption_failed", retryable: true, cause });
      }
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const replay = await replayConversation({ conversationId: conversationId as never, eventStore: bundle.events });
      const state = replay.state;
      replay.store.destroy();
      const proposals = await approvalStoreFor(context).listGroup({ permissionContext: context, groupId: conversationId as never });
      let conflicted = false;
      for (const turn of state.turns) {
        if (state.active_turn_id !== null && state.active_turn_id !== turn.turn_id) continue;
        if (turn.status !== "waiting_for_approval" && state.active_turn_id !== turn.turn_id) continue;
        const saved = await bundle.durableTurns.load(conversationId, turn.turn_id);
        if (saved?.record.status !== "waiting_for_approval" || saved.record.terminal?.status !== "waiting_for_approval" || saved.record.cancellation) continue;
        const pending = saved.record.terminal.pendingToolCallIds;
        if (!proposals.some(proposal => proposal.turn_id === turn.turn_id && pending.includes(proposal.tool_call_id) &&
          proposal.status !== "pending")) continue;
        if (state.active_turn_id === null) {
          try {
            await bundle.events.append({ conversationId: conversationId as never, expectedRevision: state.revision,
              events: [parseConversationEvent({ version: 1, conversation_id: conversationId,
                event_id: `approval-resume:${turn.turn_id}:${saved.version}`,
                revision: (state.revision ?? 0) + 1, occurred_at: new Date().toISOString(),
                actor: { type: "system" }, source: { type: "runtime" },
                payload: { type: "turn.status_changed", turn_id: turn.turn_id, status: "running" } })] });
          } catch (cause) {
            if (cause instanceof ConversationEventStoreConflictError) { conflicted = true; break; }
            throw cause;
          }
        }
        // Recover the narrow crash window between canonical admission and
        // durable wake-up as well as an ordinary new approval decision.
        const key = executionKeyFor(context);
        if (!durableTransports.has(key)) await transportFor(context);
        const outcome = await durableTransports.get(key)!.resumeApprovalTurn(conversationId, turn.turn_id);
        if (!outcome.ok) throw new Error(outcome.error.message);
        return;
      }
      if (!conflicted) return;
    }
    throw new Error("Approval resumption conflicted repeatedly");
  };
  const continueApprovalsSafely = async (context: TContext, conversationId: string) => {
    try { await continueApprovedTurns(context, conversationId); }
    catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "approval_resumption",
      phase: "failed", conversationId, code: "approval_resumption_failed", retryable: true, cause }); }
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
          ...providerScopeFor(context), limits, instructions,
          toolActivity: createToolActivityObserver({ events: bundle.events, report: reportActivity }),
          tools: createAssistantToolRuntime({ context, application, events: bundle.events,
            proposalStore: approvalStoreFor(context), reportActivity,
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
        type ProjectionEntry = { projection: Promise<LiveConversationProjection | null>; delivered: number; failed: boolean;
          close: () => Promise<void> };
        // This map belongs to the trusted context's active workers, never to
        // browser selection. Worker settlement/lease loss removes every entry.
        const projections = new Map<string, ProjectionEntry>();
        const projectionKey = (conversationId: string, turnId: string) => JSON.stringify([conversationId, turnId]);
        const reportProjectionFailure = (conversationId: string, turnId: string, cause: unknown) => {
          emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "live_conversation_projection",
            phase: "failed", conversationId, turnId, code: "projection_failed", retryable: true, cause });
        };
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
          async onEventPersisted(document) {
            if (liveProjectionStopped) return;
            const { conversationId, turnId } = document.record, id = projectionKey(conversationId, turnId);
            let entry = projections.get(id);
            if (!entry) {
              const bundle = bundleFor(context);
              const created: ProjectionEntry = {
                delivered: 0, failed: false,
                projection: createLiveConversationProjection({ conversationId, turnId, events: bundle.events,
                  authorize: async () => {
                    if (liveProjectionStopped) throw new Error("Live projection is shutting down");
                    await catalogFor(context).get({ authorizationContext: context, conversationId: conversationId as never });
                  }, ...(bundle.usageReceiptSink ? { usageReceiptSink: bundle.usageReceiptSink } : {}) }),
                close: async () => {
                  if (projections.get(id) === created) projections.delete(id);
                  liveProjectionClosers.delete(created.close);
                  await created.projection.then(projection => projection?.disconnect()).catch(() => {});
                },
              };
              entry = created; projections.set(id, entry); liveProjectionClosers.add(entry.close);
            }
            if (entry.failed) return;
            try {
              const projection = await entry.projection;
              if (!projection || liveProjectionStopped) return;
              // On a worker restart the canonical runtime verifies the saved
              // prefix; steady-state delivery indexes only newly persisted frames.
              while (entry.delivered < document.record.events.length) {
                const item = document.record.events[entry.delivered]!;
                if (item.sequence !== entry.delivered + 1) throw new Error("Durable frame order is invalid");
                await projection.push(item.event); entry.delivered++;
              }
            } catch (cause) {
              // Do not repeatedly replay history for every subsequent token
              // after a failure. Terminal reconciliation remains durable fallback.
              entry.failed = true;
              await entry.projection.then(projection => projection?.disconnect()).catch(() => {});
              reportProjectionFailure(conversationId, turnId, cause);
            }
          },
          async onWorkerStopped({ conversationId, turnId }) {
            await projections.get(projectionKey(conversationId, turnId))?.close();
          },
          onTurnStatusChanged: async ({ conversationId, turnId, status }, document) => {
            if (status !== "pending" && status !== "running") {
              const entry = projections.get(projectionKey(conversationId, turnId));
              if (entry) {
                try {
                  const projection = await entry.projection;
                  if (!entry.failed && projection && document.record.terminal) await projection.finish(document.record.terminal);
                } catch (cause) { reportProjectionFailure(conversationId, turnId, cause); }
                finally { await entry.close(); }
              }
            }
            await reconcileSafely(context, conversationId, turnId);
            if (status !== "pending" && status !== "running") await continueApprovalsSafely(context, conversationId);
          },
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
    list: (input: Parameters<ConversationCatalog<TContext>["list"]>[0]) => catalogFor(input.authorizationContext).list(input),
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
        (input.status !== "confirmed" && input.status !== "rejected")) {
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
      // Return the immutable decision receipt, even if execution has advanced
      // the proposal before this reply or an exact idempotent retry arrives.
      let decisionReceipt: Awaited<ReturnType<typeof proposalStore.transition>> | undefined;
      const coordinator = createApprovalCoordinator<TContext>({ proposalStore: {
        create: (request) => proposalStore.create(request),
        get: (request) => proposalStore.get(request),
        listGroup: (request) => proposalStore.listGroup(request),
        async transition(request) {
          decisionReceipt = await proposalStore.transition(request);
          return decisionReceipt;
        },
      }, eventStore: bundle.events, authorize: () => "allow" });
      const result = await coordinator.decide({ permissionContext: input.permissionContext,
        conversationId: supplied.conversationId as never, proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        decision: input.status === "confirmed" ? "confirm" : "reject",
        attribution: { actor: { type: "user", id: input.permissionContext.principalId as never },
          source: { type: "runtime" } }, idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
        signal: new AbortController().signal });
      if (result.outcome === "accepted" || result.outcome === "already_decided") {
        await continueApprovalsSafely(input.permissionContext, supplied.conversationId);
        if (decisionReceipt !== undefined) return decisionReceipt;
        // A later, different decision against terminal work does not produce a
        // transition receipt. Return the authorized terminal state, as before,
        // without replacing the immutable receipt of an exact decision replay.
        if (result.outcome === "already_decided") {
          const current = await proposalStore.get({ permissionContext: input.permissionContext,
            proposalId: input.proposalId });
          if (current !== null && current.status !== "pending") return current;
          throw new ApprovalProposalStoreError("unavailable", "transition");
        }
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
  const attachmentDownload = async (request: Request, context: TContext) => {
    const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
    const query = new URL(request.url).searchParams;
    const conversationId = query.get("conversationId"), attachmentId = query.get("attachmentId");
    if (!conversationId || !attachmentId) return new Response(null, { status: 400, headers });
    try { await ownsConversation(context, conversationId); }
    catch { return new Response(null, { status: 404, headers }); }
    try {
      const files = filesFor(context);
      const download = files ? await files.download(conversationId, attachmentId) : undefined;
      const { record, bytes } = download ? { record: { filename: download.file.fileName, mediaType: download.file.mediaType }, bytes: download.file.data }
        : await bundleFor(context).attachments.download({ ownerScopeId: context.scopeId, conversationId, attachmentId });
      const filename = (record.filename ?? "attachment").replace(/[^A-Za-z0-9._ -]/gu, "_").slice(0, 180) || "attachment";
      return new Response(new Uint8Array(bytes), { headers: { ...headers, "content-type": record.mediaType,
        "content-length": String(bytes.byteLength), "content-disposition": `attachment; filename="${filename}"` } });
    } catch (error) {
      const status = error instanceof AttachmentStagingError ? error.code === "expired" ? 410
        : error.code === "not_found" || error.code === "forbidden" ? 404 : error.code === "invalid_input" ? 400 : 503 : 503;
      return new Response(null, { status, headers });
    }
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
      if (file.size < 1 || file.size > options.persistence.attachmentLimits.maximumBytes) throw new AttachmentStagingError("invalid_input");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let mediaType = file.type;
      let filename = typeof (file as File).name === "string" ? (file as File).name : "attachment";
      // Preserve explicitly allowed legacy text storage. Protocol file formats
      // use the same signature/size/filename validation as host storage adapters.
      if (mediaType !== "text/plain" || /\.(?:docx|xlsx?|csv|tsv)$/iu.test(filename)) {
        const limits = options.persistence.attachmentLimits;
        const acceptedMediaTypes = STANDARD_ATTACHMENT_MEDIA_TYPES.filter(type => limits.acceptedMediaTypes.some(
          accepted => accepted === type || accepted.endsWith("/*") && type.startsWith(accepted.slice(0, -1))));
        if (acceptedMediaTypes.length === 0) throw new AttachmentStagingError("invalid_input");
        const validated = createAttachmentContentValidator({ maximumFiles: 1, maximumBytesPerFile: limits.maximumBytes,
          maximumTotalBytes: limits.maximumBytes, acceptedMediaTypes })([{ fileName: filename, declaredMediaType: mediaType, data: bytes }])[0]!;
        mediaType = validated.mediaType;
        filename = validated.fileName;
      }
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const files = filesFor(context);
      const reference = files ? await files.stage(conversationId, { idempotencyKey, fileName: filename, mediaType, data: bytes })
        : await bundleFor(context).attachments.stage({ ownerScopeId: context.scopeId, conversationId,
          idempotencyKey, fingerprint, mediaType, filename, bytes });
      return new Response(JSON.stringify({ ok: true, value: reference }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (error) {
      const code = error instanceof AttachmentStagingError ? error.code
        : error instanceof ConversationCatalogError ? "forbidden" : "unavailable";
      const status = { invalid_input: 400, forbidden: 403, not_found: 404, expired: 410, conflict: 409, unavailable: 503 }[code];
      const message = { invalid_input: "The attachment is invalid or its file type is not supported.",
        forbidden: "Attachment upload denied.", not_found: "The attachment was not found.",
        expired: "The attachment upload expired. Select the file again.",
        conflict: "This upload does not match its saved file.", unavailable: "Attachment storage is unavailable. Try again." }[code];
      return new Response(JSON.stringify({ ok: false, error: { code, message, retryable: code === "unavailable" } }),
        { status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  };
  const synchronization = createConversationSynchronizationHttpHandler<TContext>({
    adapterFor: (context) => createDurableApplicationConversationSync({
      authorizationContext: context,
      principalId: context.principalId,
      eventStore: filesFor(context)?.events ?? bundleFor(context).events,
      turnStore: bundleFor(context).durableTurns as never,
      authorizeConversation: async (conversationId) => {
        await ownsConversation(context, conversationId);
        // Repair is retried on each request, but it is not an authorization check.
        // A competing projector or activity-store outage must not block access to
        // already-saved history. The adapter still validates every proposed event.
        await reconcileSafely(context, conversationId);
        await continueApprovalsSafely(context, conversationId);
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
  const maintenance = new ConversationMaintenanceQueue({ onError: cause => emitAiDiagnostic(options.diagnostics, {
    domain: "persistence", operation: "conversation_maintenance", phase: "failed",
    code: "maintenance_failed", retryable: true, cause,
  }) });
  const maintenanceIdentity = (context: TContext) => JSON.stringify([
    context.tenantId, context.scopeId, context.principalId, context.attribution.session?.id ?? null,
  ]);
  const gateway: ApplicationGateway = {
    handle(request) {
      // The gateway authenticates before reading capabilities. Keep that context
      // local to this request, including when transport resolution overlaps.
      let context: TContext;
      // Retain only list requests, before the gateway consumes their bodies.
      // The bounded queue releases these credentials on completion/shutdown.
      const maintenanceRequest = new URL(request.url).pathname.replace(/\/+$/u, "").endsWith("/conversations/list")
        ? request.clone() : null;
      const historyRequest = new URL(request.url).pathname.replace(/\/+$/u, "").endsWith("/conversations/history")
        ? request.clone() : null;
      return createApplicationGateway({
        authorize: async (request, action) => {
          context = await options.authorize(request, action);
          return context;
        },
        transportFor,
        checkpointForEvent,
        displayControl: true,
        displayHistoryFor(current): ConversationDisplayHistory {
          const identity = maintenanceIdentity(current);
          const authorize = async (conversationId: string) => {
            const fresh = historyRequest ? await options.authorize(historyRequest.clone(), "conversations") : current;
            if (maintenanceIdentity(fresh) !== identity) throw new Response(null, { status: 403 });
            await ownsConversation(fresh, conversationId);
          };
          const history = new PostgresConversationDisplayHistory(options.persistence.persistence.client,
            current.tenantId, current.scopeId, authorize);
          const prepare = <T extends Pick<ConversationDisplayPage, "status" | "conversationId">>(page: T): T => {
              if (page.status === "preparing" && historyRequest) {
                const key = JSON.stringify(["history-backfill", identity, page.conversationId]);
                const step = async () => {
                  const progress = await history.backfill(page.conversationId);
                  const controls = !progress.hasMore ? await history.backfillControls(page.conversationId) : null;
                  // Durable watermark survives process restarts; each small step
                  // reauthenticates and goes to the back of the shared work queue.
                  if (progress.hasMore || controls?.hasMore) maintenance.enqueue(key, step);
                };
                maintenance.enqueue(key, step);
              }
              return page;
          };
          return {
            control: async input => prepare(await history.control(input)),
            page: async input => prepare(await history.page(input)),
            changes: async input => prepare(await history.changes(input)),
            content: input => history.content(input),
          };
        },
        conversations: { ...catalog, get capabilities() { return catalogFor(context).capabilities; },
          async list(input) {
            const page = await catalog.list(input);
            if (maintenanceRequest) {
              const identity = maintenanceIdentity(context);
              for (const descriptor of page.items) {
                maintenance.enqueue(JSON.stringify([identity, descriptor.conversationId]), async () => {
                  // A session may have expired or changed permissions since listing.
                  // Authenticate again before accessing history or resuming approvals.
                  const current = await options.authorize(maintenanceRequest.clone(), "conversations");
                  if (maintenanceIdentity(current) !== identity) return;
                  await ownsConversation(current, descriptor.conversationId);
                  await reconcileSafely(current, descriptor.conversationId);
                  await continueApprovalsSafely(current, descriptor.conversationId);
                  // Imported conversations may have no durable turn document.
                  // Keep title work within this background concurrency slot.
                  await titles.afterActivity(descriptor.conversationId, current);
                });
              }
            }
            return page;
          },
        },
        approvals,
        titleGeneration: { generate: generateTitle },
        handlers: { activity, ...(options.attachmentUpload === false ? {} : { attachments }), synchronization, presence,
          ...(options.attachmentDownloads === false ? {} : { attachment_download: attachmentDownload }),
          ...(transcriptionProvider ? { transcription: createAssistantTranscription({
            assistantId, provider: transcriptionProvider,
            ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
            catalogFor, bundleFor }) } : {}) },
        capabilities: { activity: true, presence: true, synchronization: true,
          attachmentDownloads: options.attachmentDownloads === false ? false : {
            maximumBytes: options.persistence.attachmentLimits.maximumBytes, url: "attachments/content" },
          transcription: transcriptionProvider
            ? { ...(transcriptionProvider.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY), url: "transcriptions" } : false,
          attachments: options.attachmentUpload === false ? false : {
            maximumFiles: 16, maximumBytesPerFile: options.persistence.attachmentLimits.maximumBytes,
            acceptedMediaTypes: options.attachmentRetention === "conversation" ? STANDARD_ATTACHMENT_MEDIA_TYPES.filter(type =>
              options.persistence.attachmentLimits.acceptedMediaTypes.some(accepted => accepted === type ||
                accepted.endsWith("/*") && type.startsWith(accepted.slice(0, -1)))) : options.persistence.attachmentLimits.acceptedMediaTypes,
            uploadUrl: "attachments" },
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
  const usageDelivery = createAIRuntimeUsageDelivery({
    enabled: options.usage?.client != null,
    flushOnStartup: options.usageDelivery?.flushOnStartup !== false,
    ...(options.usageDelivery?.retryIntervalMilliseconds === undefined ? {} : {
      retryIntervalMilliseconds: options.usageDelivery.retryIntervalMilliseconds,
    }),
    flush: () => flushUsage(usageBatchSize),
    onError: cause => emitAiDiagnostic(options.diagnostics, { domain: "persistence", operation: "usage_outbox_flush",
      phase: "failed", code: "usage_delivery_failed", retryable: true, cause }),
  });
  await usageDelivery.ready;
  let attachmentCleanup: ReturnType<NonNullable<PostgresAssistantPersistence["startAttachmentCleanupWorker"]>> | undefined;
  let retainedDraftCleanup: ReturnType<typeof startPostgresConversationFileStagingCleanupWorker> | undefined;
  try {
    if (options.attachmentCleanup !== false) attachmentCleanup = options.persistence.startAttachmentCleanupWorker?.({
      ...options.attachmentCleanup,
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    });
    if (options.attachmentCleanup !== false && options.attachmentRetention === "conversation") {
      retainedDraftCleanup = startPostgresConversationFileStagingCleanupWorker({ persistence: options.persistence.persistence,
        maintenanceScopeId: assistantConversationFileMaintenanceScope(assistantId), ...options.attachmentCleanup,
        onResult: () => {}, onError: () => emitAiDiagnostic(options.diagnostics, { domain: "attachment", operation: "retained_draft_cleanup",
          phase: "failed", code: "unavailable", retryable: true }) });
    }
  } catch (error) { usageDelivery.stop(); await attachmentCleanup?.stop(); throw error; }
  const stopBackgroundWorkers = async () => {
    usageDelivery.stop();
    liveProjectionStopped = true;
    await Promise.all([...liveProjectionClosers].map(close => close()));
    await Promise.all([maintenance.stop(), attachmentCleanup?.stop(), retainedDraftCleanup?.stop()]);
  };
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
    stopBackgroundWorkers,
    stopUsageWorker: stopBackgroundWorkers,
  });
}
export { prepareSavedConversationRequest, createSavedConversationRequestPreparer, SavedConversationPreparationError, SavedConversationFileUnavailableError,
  type SavedConversationRequestOptions, type SavedConversationFile, type SavedConversationContextInput,
  type SavedConversationPreparerOptions, type SavedConversationTurnInput } from "./saved-conversation-request.js";
