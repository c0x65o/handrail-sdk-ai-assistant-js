import {
  createApplicationGatewayConversationCatalog,
  createApplicationGatewayDisplayHistory,
  createApplicationGatewayResourceClient,
  createApplicationGatewayTransport,
  negotiateApplicationGatewayCapabilities,
  type ApplicationGatewayCapabilities,
  type ApplicationGatewayAttachmentSource,
  type ApplicationGatewayPresenceClient,
  type ApplicationGatewayResourceClient,
  type ApplicationGatewayTransportOptions,
} from "../transports/application-gateway.js";
import { PollingConversationActivity, type ConversationActivityRecord } from "../conversation/activity.js";
import { ConversationRuntimeRegistry, type ConversationRuntimeFactory,
  type ConversationRuntimeRegistryPolicy } from "../conversation/runtime-registry.js";
import { ConversationWorkspace } from "../conversation/workspace.js";
import type { ConversationTransport } from "../transports/types.js";
import type { ConversationCatalog } from "../conversation/catalog.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import type { ConversationClientId, ConversationDeviceId, ConversationId } from "../conversation/events.js";
import { createConversationRuntime, type ConversationRuntime } from "../runtime.js";
import type { AttachmentUploadAdapter } from "../attachments/types.js";
import { createApplicationGatewaySyncAdapter } from "./synchronization.js";
import { createApplicationGatewayPresenceAdapter } from "./presence.js";
import type { ConversationSyncAdapter } from "../sync/types.js";
import { createSynchronizedConversationEventStore } from "../sync/conversation-event-store.js";
import {
  createPresenceController,
  type PresenceController,
  type PresenceControllerTimingOptions,
} from "../presence/controller.js";
import type { PresenceParticipantKind } from "../presence/types.js";
import { emitAiDiagnostic } from "../diagnostics.js";
import { createTranscriptionHttpClient, resolveTranscriptionEndpoint } from "../transcription-http.js";
import { createAttachmentDownloadClient, resolveAttachmentDownloadEndpoint } from "../attachments/downloader.js";
import { ConversationDisplayWindow } from "./display-window.js";
import { createApplicationConversationRuntime } from "./application-runtime.js";
import { InMemoryApplicationConversationPendingStore, type ApplicationConversationPendingStore } from "./session-submission.js";
import type { ConversationPresentationRuntime } from "../conversation/presentation.js";
import { InMemoryConversationLocalStateStore, isConversationLocalStateStore, type ConversationLocalStateStore } from "./local-state.js";

export interface HandrailAiClientBootstrapOptions<TEvent, TRequest, TAuthorizationContext, TSynchronization = unknown>
extends ApplicationGatewayTransportOptions<TEvent, TSynchronization> {
  /** Account/API-scoped durable admission journal. Omitted: account-lifetime memory only. */
  readonly pendingStore?: ApplicationConversationPendingStore<TRequest>;
  /** Account/API-scoped drafts and positions; inferred from a capable pendingStore. */
  readonly localStateStore?: ConversationLocalStateStore;
  readonly createRuntime?: ConversationRuntimeFactory<TRequest, TAuthorizationContext>;
  readonly authorizeRuntime?: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
  /** Standard runtime assembly; mutually exclusive with createRuntime. */
  readonly runtime?: {
    readonly clientId: ConversationClientId;
    readonly deviceId?: ConversationDeviceId;
    /**
     * Optional local/custom event store. When omitted, a negotiated server
     * synchronization capability becomes the runtime's canonical event store.
     */
    readonly eventStoreFor?: (input: Parameters<ConversationRuntimeFactory<TRequest, TAuthorizationContext>>[0]) =>
      ConversationEventStore | Promise<ConversationEventStore>;
    readonly authorize: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
  };
  /**
   * Recommended high-level conversation ownership. `single` creates exactly
   * one runtime and no catalog registry/workspace; `multiple` owns the full
   * registry/workspace graph. Mutually exclusive with the legacy runtime and
   * createRuntime/authorizeRuntime options.
   */
  readonly conversations?:
    | {
        readonly mode: "single";
        readonly conversationId: ConversationId;
        readonly clientId: ConversationClientId;
        readonly deviceId?: ConversationDeviceId;
        readonly eventStore?: ConversationEventStore | (() => ConversationEventStore | Promise<ConversationEventStore>);
      }
    | {
        readonly mode: "multiple";
        readonly clientId: ConversationClientId;
        readonly deviceId?: ConversationDeviceId;
        readonly eventStoreFor?: (input: Parameters<ConversationRuntimeFactory<TRequest, TAuthorizationContext>>[0]) =>
          ConversationEventStore | Promise<ConversationEventStore>;
        readonly authorize: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
      };
  readonly buildRequest?: (input: { readonly content: string; readonly attachments: readonly unknown[] }) => TRequest;
  readonly activityPollingMilliseconds?: number;
  /** Canonical event polling for built-in server-backed runtimes. Defaults 1000ms. */
  readonly synchronizationPollingMilliseconds?: number;
  /** Maximum interval for unchanged, inactive built-in runtimes. Defaults to at least 15000ms. */
  readonly idleSynchronizationPollingMilliseconds?: number;
  readonly startActivityPolling?: boolean;
  /** Resume durably recorded active turns whenever a conversation is first opened. Defaults true. */
  readonly restoreActiveTurns?: boolean;
  /** Optional high-level identity used to own one connected presence controller per conversation. */
  readonly presenceIdentity?: PresenceControllerTimingOptions & {
    readonly participantId: string;
    readonly sessionId: string;
    readonly participantKind?: PresenceParticipantKind;
    readonly deviceId?: string;
    /** Defaults true. Set false when the host wants to connect controllers explicitly. */
    readonly autoConnect?: boolean;
  };
}

export interface HandrailAiClient<TEvent, TRequest, TAuthorizationContext> {
  readonly conversationMode: "none" | "single" | "multiple";
  /** Present only in single-conversation mode. */
  readonly conversation: ConversationPresentationRuntime<TRequest> | null;
  readonly capabilities: ApplicationGatewayCapabilities;
  readonly transport: ConversationTransport<TEvent, TRequest>;
  readonly resources: ApplicationGatewayResourceClient;
  readonly activity: PollingConversationActivity | null;
  readonly catalog: ConversationCatalog<TAuthorizationContext>;
  readonly registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext, ConversationPresentationRuntime<TRequest>> | null;
  readonly workspace: ConversationWorkspace<TRequest, TAuthorizationContext, ConversationPresentationRuntime<TRequest>> | null;
  readonly attachmentUpload: AttachmentUploadAdapter<ApplicationGatewayAttachmentSource> | null;
  readonly transcription: ReturnType<typeof createTranscriptionHttpClient> | null;
  readonly attachmentDownload: ReturnType<typeof createAttachmentDownloadClient> | null;
  readonly presence: ApplicationGatewayPresenceClient | null;
  readonly synchronization: ConversationSyncAdapter | null;
  /** Presentation-only bounded history. Never use its pages as canonical state. */
  readonly displayHistory: ReturnType<typeof createApplicationGatewayDisplayHistory> | null;
  readonly displayWindow: ConversationDisplayWindow | null;
  /** Returns a stable, client-owned controller for the conversation when presence was negotiated/configured. */
  presenceControllerFor(conversationId: ConversationId): PresenceController | null;
  buildRequest(input: { readonly content: string; readonly attachments?: readonly unknown[] }): TRequest;
  markActivityRead(conversationId: string, observed?: ConversationActivityRecord): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Negotiates once and assembles the common cross-platform client graph. Low-level
 * factories remain public for applications that need different ownership.
 */
export async function createHandrailAiClient<TEvent = unknown, TRequest = unknown,
  TAuthorizationContext = unknown, TSynchronization = unknown>(
  options: HandrailAiClientBootstrapOptions<TEvent, TRequest, TAuthorizationContext, TSynchronization>,
): Promise<HandrailAiClient<TEvent, TRequest, TAuthorizationContext>> {
  const highLevel = options.conversations;
  if ((options.createRuntime === undefined) !== (options.authorizeRuntime === undefined)) {
    throw new TypeError("createRuntime and authorizeRuntime must be configured together");
  }
  if (options.runtime !== undefined && options.createRuntime !== undefined) {
    throw new TypeError("runtime cannot be combined with createRuntime/authorizeRuntime");
  }
  if (highLevel !== undefined && (options.runtime !== undefined || options.createRuntime !== undefined)) {
    throw new TypeError("conversations cannot be combined with legacy runtime ownership options");
  }
  const capabilities = options.capabilities ?? await negotiateApplicationGatewayCapabilities(options);
  const attachmentDownload = capabilities.attachmentDownloads ? createAttachmentDownloadClient({
    endpoint: resolveAttachmentDownloadEndpoint(options.baseUrl, capabilities.attachmentDownloads),
    capability: capabilities.attachmentDownloads,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.protectedRequest ? { protectedRequest: options.protectedRequest } : {}),
  }) : null;
  const transcription = capabilities.transcription ? createTranscriptionHttpClient({
    endpoint: resolveTranscriptionEndpoint(options.baseUrl, capabilities.transcription),
    capability: capabilities.transcription,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.protectedRequest ? { protectedRequest: options.protectedRequest } : {}),
  }) : null;
  const transport = createApplicationGatewayTransport<TEvent, TRequest, TSynchronization>({ ...options, capabilities });
  const resources = createApplicationGatewayResourceClient(options);
  const displayHistory = capabilities.displayHistory ? createApplicationGatewayDisplayHistory(options) : null;
  const displayWindow = displayHistory ? new ConversationDisplayWindow({ reader: displayHistory }) : null;
  const memoryPendingStore = options.pendingStore ? null : new InMemoryApplicationConversationPendingStore<TRequest>();
  const pendingStore = options.pendingStore ?? memoryPendingStore!;
  const providedLocalState = options.localStateStore ?? (isConversationLocalStateStore(pendingStore) ? pendingStore : undefined);
  const memoryLocalState = providedLocalState ? null : new InMemoryConversationLocalStateStore();
  const localStateStore = providedLocalState ?? memoryLocalState!;
  const localFlushes = new Set<Promise<void>>();
  const serverSession = Boolean(capabilities.displayHistory && capabilities.displayHistory.control === true && displayHistory !== null);
  const applicationRuntime = (conversationId: ConversationId, clientId: ConversationClientId) => createApplicationConversationRuntime({
    conversationId, clientId, reader: displayHistory!, resources, transport, pendingStore, localStateStore,
    onLocalStateFlush: operation => { localFlushes.add(operation); void operation.finally(() => localFlushes.delete(operation)); },
    ...(options.synchronizationPollingMilliseconds === undefined ? {} : { pollMilliseconds: options.synchronizationPollingMilliseconds }),
    ...(options.idleSynchronizationPollingMilliseconds === undefined ? {} : { idlePollMilliseconds: options.idleSynchronizationPollingMilliseconds }),
  });
  const activity = capabilities.activity === true && resources.listActivity
    ? new PollingConversationActivity({ load: () => resources.listActivity!(),
      ...(resources.subscribeActivity === undefined ? {} : {
        subscribe: (signal: AbortSignal) => resources.subscribeActivity!(signal),
      }),
      ...(options.activityPollingMilliseconds === undefined ? {} : { intervalMilliseconds: options.activityPollingMilliseconds }),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }) }) : null;
  if (activity && options.startActivityPolling !== false) activity.start();
  const catalog = createApplicationGatewayConversationCatalog<TAuthorizationContext>(resources, capabilities);
  const attachmentUpload = transport.capabilities.attachmentUpload.supported
    ? transport.capabilities.attachmentUpload.capability : null;
  const presence = transport.capabilities.presence.supported ? transport.capabilities.presence.capability : null;
  const synchronization = capabilities.synchronization === true
    ? createApplicationGatewaySyncAdapter({ resources, ...(presence ? { presence } : {}) }) : null;
  const presenceAdapter = presence === null ? null
    : synchronization ?? createApplicationGatewayPresenceAdapter(presence);
  const presenceControllers = new Map<ConversationId, PresenceController>();
  const multiple = highLevel?.mode === "multiple" ? highLevel : options.runtime;
  if (multiple && multiple.eventStoreFor === undefined && synchronization === null && !serverSession) {
    throw new TypeError("A standard runtime requires eventStoreFor or negotiated synchronization");
  }
  const runtimeFactory = multiple ? (async (input: Parameters<ConversationRuntimeFactory<TRequest, TAuthorizationContext>>[0]) =>
    serverSession && !multiple.eventStoreFor ? applicationRuntime(input.conversationId, multiple.clientId) :
    createConversationRuntime<TRequest>({ conversationId: input.conversationId, clientId: multiple.clientId,
      ...(multiple.deviceId === undefined ? {} : { deviceId: multiple.deviceId }), transport,
      ...(multiple.eventStoreFor ? {} : {
        synchronizationIntervalMilliseconds: options.synchronizationPollingMilliseconds ?? 1_000,
        idleSynchronizationIntervalMilliseconds: options.idleSynchronizationPollingMilliseconds ??
          Math.max(options.synchronizationPollingMilliseconds ?? 1_000, 15_000),
        onSynchronizationError: (cause: unknown) => emitAiDiagnostic(options.diagnostics, {
          domain: "persistence", operation: "conversation_synchronization", phase: "failed",
          conversationId: input.conversationId, code: "synchronization_failed", retryable: true, cause,
        }),
      }),
      eventStore: multiple.eventStoreFor
        ? await multiple.eventStoreFor(input)
        : createSynchronizedConversationEventStore({ adapter: synchronization! }) })) : options.createRuntime;
  const runtimeAuthorization = multiple?.authorize ?? options.authorizeRuntime;
  const registry = runtimeFactory && runtimeAuthorization
    ? new ConversationRuntimeRegistry<TRequest, TAuthorizationContext, ConversationPresentationRuntime<TRequest>>({
      catalog,
      createRuntime: runtimeFactory, authorize: runtimeAuthorization,
    }) : null;
  const workspace = registry ? new ConversationWorkspace(registry, {
    ...(serverSession && !multiple?.eventStoreFor && !options.createRuntime ? { maximumCachedIdleThreads: 4 } : {}),
    restoreActiveTurns: options.restoreActiveTurns !== false,
    onRecoveryError(conversationId, cause) {
      emitAiDiagnostic(options.diagnostics, {
        domain: "persistence", operation: "startup_recovery", phase: "failed",
        conversationId, code: "active_turn_recovery_failed", retryable: true, cause,
      });
    },
  }) : null;
  const singleConfiguration = highLevel?.mode === "single" ? highLevel : null;
  if (singleConfiguration && !singleConfiguration.eventStore && !serverSession && !synchronization) throw new TypeError("A single conversation requires an event store or negotiated server history");
  const conversation = singleConfiguration === null ? null : serverSession && !singleConfiguration.eventStore
    ? applicationRuntime(singleConfiguration.conversationId, singleConfiguration.clientId) : await createConversationRuntime<TRequest>({
    conversationId: singleConfiguration.conversationId,
    clientId: singleConfiguration.clientId,
    ...(singleConfiguration.deviceId === undefined ? {} : { deviceId: singleConfiguration.deviceId }),
    transport,
    eventStore: typeof singleConfiguration.eventStore === "function"
      ? await singleConfiguration.eventStore()
      : singleConfiguration.eventStore ?? createSynchronizedConversationEventStore({ adapter: synchronization! }),
  });
  if (conversation !== null && options.restoreActiveTurns !== false) {
    void Promise.resolve().then(() => conversation.restoreActiveTurn()).catch((cause: unknown) => {
      emitAiDiagnostic(options.diagnostics, {
        domain: "persistence", operation: "startup_recovery", phase: "failed",
        conversationId: singleConfiguration!.conversationId,
        code: "active_turn_recovery_failed", retryable: true, cause,
      });
    });
  }
  const conversationMode = singleConfiguration !== null ? "single" : multiple ? "multiple" : "none";
  return Object.freeze({ conversationMode, conversation, capabilities, transport, resources, activity, catalog, registry, workspace,
    attachmentUpload, attachmentDownload, transcription, presence, synchronization, displayHistory, displayWindow,
    presenceControllerFor(conversationId: ConversationId) {
      if (presenceAdapter === null || options.presenceIdentity === undefined) return null;
      const existing = presenceControllers.get(conversationId);
      if (existing) return existing;
      const { autoConnect, ...identity } = options.presenceIdentity;
      const controller = createPresenceController({
        ...identity,
        conversationId,
        participantKind: identity.participantKind ?? "human",
        adapter: presenceAdapter,
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      });
      presenceControllers.set(conversationId, controller);
      if (autoConnect !== false) controller.connect();
      return controller;
    },
    buildRequest(input: { readonly content: string; readonly attachments?: readonly unknown[] }) {
      if (!options.buildRequest) throw new TypeError("No application request builder is configured");
      return options.buildRequest({ content: input.content, attachments: input.attachments ?? [] });
    },
    async markActivityRead(conversationId: string, seen?: ConversationActivityRecord) {
      if (!activity || !resources.markActivityRead) return;
      const observed = seen ?? activity.getSnapshot().find((record) => record.conversationId === conversationId);
      if (!observed?.unread) return;
      const saved = await resources.markActivityRead({ conversationId, observed });
      if (saved) activity.accept(saved);
      await activity.refresh();
    },
    async dispose() {
      displayWindow?.dispose();
      activity?.stop();
      for (const controller of presenceControllers.values()) controller.destroy();
      presenceControllers.clear();
      conversation?.destroy();
      await workspace?.dispose();
      await Promise.all([...localFlushes]);
      memoryLocalState?.dispose();
      memoryPendingStore?.dispose();
    } });
}
