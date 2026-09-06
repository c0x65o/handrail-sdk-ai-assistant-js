import { parseServerSentEvents } from "./sse.js";
import type { AttachmentReference } from "../protocol.js";
import type { AttachmentUploadAdapter } from "../attachments/types.js";
import type { LivePresenceEnvelope } from "../presence/live-delivery.js";
import type { PresenceRecord } from "../presence/types.js";
import {
  parseConversationActivityRecord,
  type ConversationActivityRecord,
  type DurableConversationActivityStore,
  type LiveConversationActivityDelivery,
} from "../conversation/activity.js";
import {
  ConversationCatalogError,
  type ConversationCatalogAuthorizationAction,
  type ConversationCatalogCapabilities,
  type ConversationCatalogErrorCode,
  type ArchiveConversationInput, type ClearConversationInput, type ConversationCatalog, type CreateConversationInput,
  type GetConversationInput, type ListConversationsInput, type PermanentlyDeleteConversationInput,
  type RenameConversationInput, type RestoreConversationInput, type ArchiveConversationResult,
  type ClearConversationResult, type CreateConversationResult, type GetConversationResult,
  type ListConversationsResult, type PermanentlyDeleteConversationResult,
  type RenameConversationResult, type RestoreConversationResult,
} from "../conversation/catalog.js";
import {
  ApprovalProposalStoreError,
  type ApprovalProposalStore, type CreateApprovalProposalInput, type GetApprovalProposalInput,
  type ListApprovalProposalGroupInput, type TransitionApprovalProposalInput,
} from "../conversation/approval-proposal-store.js";
import type { ConversationApprovalProposalRecord } from "../conversation/state.js";
import type { DocumentInputCapabilityDescriptor, ProviderAdapterMetadata } from "../providers/index.js";
import type { ToolLoopLimits } from "../tools/loop.js";
import { diagnoseAiOperation, emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { AppendMutationsInput, AppendMutationsResult, PullSnapshotInput, PullSnapshotResult,
  ReadSinceInput, ReadSinceResult } from "../sync/types.js";
import type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ConversationTransportCapabilities,
  ResumeTurnInput,
  StartTurnInput,
  TransportError,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "./types.js";

export const APPLICATION_GATEWAY_PROTOCOL_VERSION = "handrail.application-gateway.v1" as const;

export interface ApplicationGatewayCapabilities {
  readonly protocolVersion: typeof APPLICATION_GATEWAY_PROTOCOL_VERSION;
  readonly authoritativeCancellation: boolean;
  readonly attachments: false | {
    readonly maximumFiles: number;
    readonly maximumBytesPerFile: number;
    readonly acceptedMediaTypes: readonly string[];
    readonly uploadUrl?: string;
  };
  readonly documentInput?: false | DocumentInputCapabilityDescriptor;
  readonly presence: boolean;
  readonly synchronization: boolean;
  readonly activity?: boolean;
  readonly resources?: {
    /** Detailed lifecycle capabilities are returned by v1 servers when available. */
    readonly conversations: boolean | ConversationCatalogCapabilities;
    readonly approvals: boolean;
    readonly titleGeneration: boolean;
  };
  /** Present for high-level assistants; older gateways omit this compatibly. */
  readonly assistant?: {
    readonly id: string;
    readonly version: string;
    readonly provider: ProviderAdapterMetadata;
    readonly toolLoopLimits: Readonly<ToolLoopLimits>;
  };
}

export interface ApplicationGatewayEventEnvelope<TEvent> {
  readonly event: TEvent;
  readonly checkpoint: TurnResumePoint;
}

export interface ApplicationGatewayAuthorizationContext {
  readonly principalId: string;
}

export interface ApplicationGatewayRequestAuthorizer<TContext extends ApplicationGatewayAuthorizationContext> {
  authorize(request: Request, action: ApplicationGatewayAction): Promise<TContext>;
}

export type ApplicationGatewayAction = "capabilities" | "start" | "resume" | "cancel" |
  "conversations" | "approvals" | "attachments" | "presence" | "activity" | "synchronization" | "title_generation";

export interface ApplicationGatewayTitleGeneration<TContext> {
  generate(input: { readonly conversationId: string; readonly idempotencyKey: string }, context: TContext, signal: AbortSignal): Promise<string>;
}

export interface ApplicationGatewayResourceHandlers<TContext> {
  readonly attachments?: (request: Request, context: TContext) => Response | Promise<Response>;
  readonly presence?: (request: Request, context: TContext) => Response | Promise<Response>;
  readonly activity?: (request: Request, context: TContext) => Response | Promise<Response>;
  readonly synchronization?: (request: Request, context: TContext) => Response | Promise<Response>;
}

export interface ApplicationGatewayOptions<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext> {
  /** Process-global transport for applications whose transport is not identity scoped. */
  readonly transport?: ConversationTransport<TEvent, TRequest>;
  /**
   * Resolves a request-scoped transport from the server-authoritative identity.
   * Multi-tenant applications should use this instead of accepting identity in
   * TRequest. Exactly one of transport and transportFor must be configured.
   */
  readonly transportFor?: (
    context: TContext,
  ) => ConversationTransport<TEvent, TRequest> | Promise<ConversationTransport<TEvent, TRequest>>;
  readonly authorize: ApplicationGatewayRequestAuthorizer<TContext>["authorize"];
  /** Converts a durable event into the exact resume point acknowledged by clients. */
  readonly checkpointForEvent: (event: TEvent) => TurnResumePoint;
  readonly capabilities?: Partial<Omit<ApplicationGatewayCapabilities, "protocolVersion" | "authoritativeCancellation">>;
  readonly maximumRequestBytes?: number;
  readonly conversations?: ConversationCatalog<TContext>;
  readonly approvals?: ApprovalProposalStore<TContext>;
  readonly titleGeneration?: ApplicationGatewayTitleGeneration<TContext>;
  readonly handlers?: ApplicationGatewayResourceHandlers<TContext>;
  readonly diagnostics?: AiDiagnosticSink;
}

export interface ApplicationGateway {
  /** Mount at any application-owned path. No framework or Node request type is required. */
  handle(request: Request): Promise<Response>;
}

type GatewayStreamMessage<TEvent> =
  | { readonly type: "started"; readonly conversationId: string; readonly turnId: string; readonly mutationId: string }
  | ({ readonly type: "event" } & ApplicationGatewayEventEnvelope<TEvent>)
  | { readonly type: "terminal"; readonly result: TurnObservationResult };

const encoder = new TextEncoder();
const GATEWAY_STREAM_HEARTBEAT_MILLISECONDS = 2_000;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const EMPTY_CHECKPOINT: TurnResumePoint = {
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}
function diagnosticHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name);
  return value && /^[A-Za-z0-9._:@/-]{1,256}$/u.test(value) ? value : undefined;
}

function transportStatus(error: TransportError): number {
  return ({ invalid_request: 400, unauthenticated: 401, forbidden: 403, not_found: 404,
    conflict: 409, rate_limited: 429, timeout: 504, unavailable: 503, internal_error: 500 })[error.code];
}

function failure(error: TransportError): Response {
  return json({ ok: false, error }, transportStatus(error));
}

type ApplicationGatewayResourceDomain = "conversation_catalog" | "approval_proposals";

interface ApplicationGatewayResourceFailure {
  readonly domain: ApplicationGatewayResourceDomain;
  readonly code: string;
}

function resourceFailure(
  error: TransportError,
  resourceError: ApplicationGatewayResourceFailure,
): Response {
  return json({ ok: false, error, resourceError }, transportStatus(error));
}

function publicFailure(error: unknown): Response {
  if (error instanceof Response) return error;
  if (error instanceof ConversationCatalogError) {
    const code: TransportError["code"] = error.code === "invalid_input" ? "invalid_request"
      : error.code === "not_found" ? "not_found"
      : error.code === "forbidden" ? "forbidden"
      : error.code === "unavailable" || error.code === "unsupported" ? "unavailable" : "conflict";
    return resourceFailure(
      { code, message: error.message, retryable: error.retryable },
      { domain: "conversation_catalog", code: error.code },
    );
  }
  if (error instanceof ApprovalProposalStoreError) {
    const code: TransportError["code"] = error.code === "invalid_input" ? "invalid_request"
      : error.code === "not_found" ? "not_found"
      : error.code === "permission_denied" ? "forbidden"
      : error.code === "unavailable" || error.code === "capacity_exceeded" ? "unavailable" : "conflict";
    return resourceFailure(
      { code, message: error.message, retryable: error.retryable },
      { domain: "approval_proposals", code: error.code },
    );
  }
  return failure({
    code: "unavailable",
    message: "The application gateway is temporarily unavailable.",
    retryable: true,
  });
}

function authorizationFailure(error: unknown): Response {
  if (error instanceof Response) return error;
  return failure({
    code: "forbidden",
    message: "The request is not authorized.",
    retryable: false,
  });
}

async function body<T>(request: Request, maximumBytes: number): Promise<T> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Response(null, { status: 413 });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw new Response(null, { status: 400 }); }
}

function sse<TEvent>(
  observation: TurnObservation<TEvent>,
  checkpointForEvent: (event: TEvent) => TurnResumePoint,
  started?: Extract<GatewayStreamMessage<TEvent>, { type: "started" }>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: GatewayStreamMessage<TEvent>, id?: string | null) => {
        const prefix = id ? `id: ${id}\n` : "";
        controller.enqueue(encoder.encode(`${prefix}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`));
      };
      const heartbeat = globalThis.setInterval(() => {
        try {
          // SSE comments are ignored by clients but keep ingress/proxy idle
          // timers from severing a turn while a model or tool is working.
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          globalThis.clearInterval(heartbeat);
        }
      }, GATEWAY_STREAM_HEARTBEAT_MILLISECONDS);
      try {
        if (started) send(started);
        for await (const event of observation.events) {
          const checkpoint = checkpointForEvent(event);
          send({ type: "event", event, checkpoint }, checkpoint.lastAppliedCursor ?? checkpoint.lastAppliedEventId);
        }
        send({ type: "terminal", result: await observation.result });
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        globalThis.clearInterval(heartbeat);
      }
    },
    cancel() { observation.disconnect(); },
  });
  return new Response(stream, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(started ? {
      "x-handrail-conversation-id": started.conversationId,
      "x-handrail-turn-id": started.turnId,
      "x-handrail-mutation-id": started.mutationId,
    } : {}),
  }});
}

/** Protected activity endpoint; the application gateway authorizes and scope-binds the store first. */
export function createConversationActivityHttpHandler(
  store: DurableConversationActivityStore,
  options: { readonly delivery?: LiveConversationActivityDelivery } = {},
) {
  return async (request: Request): Promise<Response> => {
    if (request.method === "GET" && options.delivery) {
      const subscription = options.delivery.subscribe(request.signal);
      const initial = await store.list();
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (const record of initial) {
              controller.enqueue(encoder.encode(`event: activity\ndata: ${JSON.stringify({ record })}\n\n`));
            }
            for await (const envelope of subscription) {
              controller.enqueue(encoder.encode(`id: ${envelope.deliveryId}\nevent: activity\ndata: ${JSON.stringify(envelope)}\n\n`));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() { subscription.close(); },
      }), { headers: { "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405,
        headers: { allow: options.delivery ? "GET, POST" : "POST" } });
    }
    try {
      const input = await request.json() as { readonly operation?: unknown; readonly conversationId?: unknown; readonly observed?: unknown };
      let value: readonly ConversationActivityRecord[] | ConversationActivityRecord | null;
      if (input.operation === "list") value = await store.list();
      else if (input.operation === "mark_read" && typeof input.conversationId === "string") {
        let observed: ConversationActivityRecord | undefined;
        if (input.observed !== undefined) {
          try { observed = parseConversationActivityRecord(input.observed as ConversationActivityRecord); }
          catch { return new Response(null, { status: 400 }); }
          if (observed.conversationId !== input.conversationId) return new Response(null, { status: 400 });
        }
        const record = await store.markRead(input.conversationId, observed);
        if (record !== null) await options.delivery?.publish(record);
        value = record;
      } else return new Response(null, { status: 400 });
      return new Response(JSON.stringify({ ok: true, value }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: { code: "unavailable",
        message: "Conversation activity is unavailable.", retryable: true } }),
      { status: 503, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  };
}

export function createApplicationGateway<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext>(
  options: ApplicationGatewayOptions<TEvent, TRequest, TContext>,
): ApplicationGateway {
  if ((options.transport === undefined) === (options.transportFor === undefined)) {
    throw new TypeError("Exactly one application gateway transport source must be configured");
  }
  const maximumBytes = options.maximumRequestBytes ?? 1_048_576;
  const resolveTransport = async (context: TContext) =>
    options.transport ?? await options.transportFor!(context);
  const capabilitiesFor = (transport: ConversationTransport<TEvent, TRequest>): ApplicationGatewayCapabilities => Object.freeze({
    protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
    authoritativeCancellation: transport.capabilities.authoritativeCancellation.supported,
    attachments: options.capabilities?.attachments ?? false,
    presence: options.capabilities?.presence ?? false,
    activity: options.capabilities?.activity ?? false,
    synchronization: options.capabilities?.synchronization ?? false,
    ...(options.capabilities?.documentInput === undefined ? {} : { documentInput: options.capabilities.documentInput }),
    ...(options.capabilities?.assistant === undefined ? {} : { assistant: options.capabilities.assistant }),
    resources: Object.freeze({ conversations: options.conversations?.capabilities ?? false,
      approvals: options.approvals !== undefined, titleGeneration: options.titleGeneration !== undefined }),
  });
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      let diagnosticAction: ApplicationGatewayAction | "route" = "route";
      const requestStartedAt = Date.now();
      const requestId = diagnosticHeader(request, "x-request-id"), traceId = diagnosticHeader(request, "traceparent");
      const diagnosticCorrelation = {
        ...(requestId ? { requestId } : {}), ...(traceId ? { traceId } : {}),
      };
      try {
        const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
        const action: ApplicationGatewayAction | null = pathname.endsWith("/capabilities") ? "capabilities"
          : pathname.endsWith("/turns/start") ? "start"
          : pathname.endsWith("/turns/resume") ? "resume"
          : pathname.endsWith("/turns/cancel") ? "cancel"
          : pathname.includes("/conversations/") ? "conversations"
          : pathname.includes("/approvals/") ? "approvals"
          : pathname.endsWith("/attachments") ? "attachments"
          : pathname.endsWith("/presence") ? "presence"
          : pathname.endsWith("/activity") ? "activity"
          : pathname.endsWith("/synchronization") ? "synchronization"
          : pathname.endsWith("/titles/generate") ? "title_generation" : null;
        if (action === null) return new Response(null, { status: 404 });
        diagnosticAction = action;
        if ((action === "capabilities" && request.method !== "GET") ||
          (action !== "capabilities" && action !== "presence" && action !== "activity" &&
            action !== "attachments" && request.method !== "POST")) {
          return new Response(null, { status: 405, headers: { allow: action === "capabilities" ? "GET" : "POST" } });
        }
        let authorizationContext: TContext;
        try {
          authorizationContext = await options.authorize(request, action);
        } catch (error) {
          return authorizationFailure(error);
        }
        if (action === "capabilities") {
          return json({ ok: true, value: capabilitiesFor(await resolveTransport(authorizationContext)) });
        }
        if (action === "attachments" || action === "presence" || action === "activity" || action === "synchronization") {
          const handler = options.handlers?.[action];
          return handler ? handler(request, authorizationContext) : new Response(null, { status: 501 });
        }
        if (action === "conversations") {
          if (!options.conversations) return new Response(null, { status: 501 });
          const input = await body<Record<string, unknown>>(request, maximumBytes);
          const operation = pathname.slice(pathname.lastIndexOf("/") + 1);
          const value = operation === "list" ? await options.conversations.list({ ...input, authorizationContext } as unknown as ListConversationsInput<TContext>)
            : operation === "create" ? await options.conversations.create({ ...input, authorizationContext } as unknown as CreateConversationInput<TContext>)
            : operation === "get" ? await options.conversations.get({ ...input, authorizationContext } as unknown as GetConversationInput<TContext>)
            : operation === "rename" ? await options.conversations.rename({ ...input, authorizationContext } as unknown as RenameConversationInput<TContext>)
            : operation === "clear" ? await options.conversations.clear({ ...input, authorizationContext } as unknown as ClearConversationInput<TContext>)
            : operation === "archive" ? await options.conversations.archive({ ...input, authorizationContext } as unknown as ArchiveConversationInput<TContext>)
            : operation === "restore" ? await options.conversations.restore({ ...input, authorizationContext } as unknown as RestoreConversationInput<TContext>)
            : operation === "permanent-delete" ? await options.conversations.permanentlyDelete({ ...input, authorizationContext } as unknown as PermanentlyDeleteConversationInput<TContext>)
            : null;
          return value === null ? new Response(null, { status: 404 }) : json({ ok: true, value });
        }
        if (action === "approvals") {
          if (!options.approvals) return new Response(null, { status: 501 });
          const input = await body<Record<string, unknown>>(request, maximumBytes);
          const operation = pathname.slice(pathname.lastIndexOf("/") + 1);
          const value = operation === "create" ? await options.approvals.create({ ...input, permissionContext: authorizationContext } as unknown as CreateApprovalProposalInput<TContext>)
            : operation === "get" ? await options.approvals.get({ ...input, permissionContext: authorizationContext } as unknown as GetApprovalProposalInput<TContext>)
            : operation === "list-group" ? await options.approvals.listGroup({ ...input, permissionContext: authorizationContext } as unknown as ListApprovalProposalGroupInput<TContext>)
            : operation === "transition" ? await options.approvals.transition({ ...input, permissionContext: authorizationContext } as unknown as TransitionApprovalProposalInput<TContext>)
            : null;
          return value === null && operation !== "get" ? new Response(null, { status: 404 }) : json({ ok: true, value });
        }
        if (action === "title_generation") {
          if (!options.titleGeneration) return new Response(null, { status: 501 });
          const input = await body<{ conversationId: string; idempotencyKey: string }>(request, maximumBytes);
          return json({ ok: true, value: await options.titleGeneration.generate(input, authorizationContext, request.signal) });
        }
        if (action === "start") {
          const transport = await resolveTransport(authorizationContext);
          const input = await body<StartTurnInput<TRequest>>(request, maximumBytes);
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "started",
            conversationId: input.conversationId, turnId: input.conversationTurnId, ...diagnosticCorrelation });
          const result = await transport.startTurn(input);
          if (!result.ok) {
            emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "failed",
              conversationId: input.conversationId, turnId: input.conversationTurnId,
              code: result.error.code, retryable: result.error.retryable, durationMs: Date.now() - requestStartedAt,
              ...diagnosticCorrelation });
            return failure(result.error);
          }
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "succeeded",
            conversationId: result.value.conversationId, turnId: result.value.turnId,
            durationMs: Date.now() - requestStartedAt, ...diagnosticCorrelation });
          return sse(result.value.observation, options.checkpointForEvent, {
            type: "started", conversationId: result.value.conversationId,
            turnId: result.value.turnId, mutationId: result.value.mutationId,
          });
        }
        if (action === "resume") {
          const transport = await resolveTransport(authorizationContext);
          const input = await body<ResumeTurnInput>(request, maximumBytes);
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "resume", phase: "started",
            conversationId: input.conversationId, turnId: input.turnId, ...diagnosticCorrelation });
          const result = await transport.resumeTurn(input);
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "resume",
            phase: result.ok ? "succeeded" : "failed", conversationId: input.conversationId, turnId: input.turnId,
            durationMs: Date.now() - requestStartedAt, ...diagnosticCorrelation,
            ...(!result.ok ? { code: result.error.code, retryable: result.error.retryable } : {}) });
          return result.ok ? sse(result.value, options.checkpointForEvent) : failure(result.error);
        }
        const transport = await resolveTransport(authorizationContext);
        const cancel = transport.capabilities.authoritativeCancellation;
        if (!cancel.supported) return new Response(null, { status: 501 });
        const input = await body<CancelTurnInput>(request, maximumBytes);
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "cancel", phase: "started",
          conversationId: input.conversationId, turnId: input.turnId, ...diagnosticCorrelation });
        const result = await cancel.capability.cancelTurn(input);
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "cancel",
          phase: result.ok ? "succeeded" : "failed", conversationId: input.conversationId, turnId: input.turnId,
          durationMs: Date.now() - requestStartedAt, ...diagnosticCorrelation,
          ...(!result.ok ? { code: result.error.code, retryable: result.error.retryable } : {}) });
        return result.ok ? json(result) : failure(result.error);
      } catch (error) {
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: diagnosticAction,
          phase: "failed", code: error instanceof Error ? error.name : "unknown", retryable: false,
          durationMs: Date.now() - requestStartedAt, ...diagnosticCorrelation, cause: error });
        return publicFailure(error);
      }
    },
  });
}

export interface ApplicationGatewayTransportOptions<TEvent, TSynchronization = unknown> {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Supplies application-owned cookies, bearer tokens, CSRF headers, and correlation metadata. */
  readonly protectedRequest?: (input: RequestInit & { readonly url: string }) => Promise<RequestInit> | RequestInit;
  readonly decodeEvent?: (value: unknown) => TEvent;
  readonly capabilities?: ApplicationGatewayCapabilities;
  /** Application-specific durable sync adapter, enabled only when the server also negotiates it. */
  readonly synchronization?: TSynchronization;
  readonly diagnostics?: AiDiagnosticSink;
}

export type ApplicationGatewayAttachmentSource = Blob;

export interface ApplicationGatewayPresenceClient {
  publish(conversationId: string, kind: "upsert" | "leave", record: PresenceRecord): Promise<void>;
  subscribe(conversationId: string, signal?: AbortSignal): AsyncIterable<LivePresenceEnvelope>;
}

function createGatewayPresenceClient<TEvent>(options: ApplicationGatewayTransportOptions<TEvent>): ApplicationGatewayPresenceClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const urlFor = (conversationId: string) => `${options.baseUrl.replace(/\/+$/, "")}/presence?conversationId=${encodeURIComponent(conversationId)}`;
  return Object.freeze({
    async publish(conversationId: string, kind: "upsert" | "leave", record: PresenceRecord) {
      const url = urlFor(conversationId);
      const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, record }) };
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      if (!response.ok) throw new TypeError("Presence publish failed");
    },
    subscribe(conversationId: string, signal?: AbortSignal) {
      const url = urlFor(conversationId);
      return (async function* () {
        const initial: RequestInit = { method: "GET", ...(signal ? { signal } : {}) };
        const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
        if (!response.ok || !response.body) throw new TypeError("Presence subscription failed");
        for await (const frame of parseServerSentEvents(response.body)) {
          if (frame.data) yield JSON.parse(frame.data) as LivePresenceEnvelope;
        }
      })();
    },
  });
}

function createGatewayAttachmentUploadAdapter<TEvent>(
  options: ApplicationGatewayTransportOptions<TEvent>,
  capability: Exclude<ApplicationGatewayCapabilities["attachments"], false>,
): AttachmentUploadAdapter<ApplicationGatewayAttachmentSource> | null {
  const uploadUrl = capability.uploadUrl;
  if (!uploadUrl || typeof FormData === "undefined") return null;
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async upload(request) {
      if (request.metadata.byteSize > capability.maximumBytesPerFile ||
        !capability.acceptedMediaTypes.some((accepted) => accepted.endsWith("/*")
          ? request.metadata.mediaType.startsWith(accepted.slice(0, -1)) : accepted === request.metadata.mediaType)) {
        throw new TypeError("Attachment does not satisfy negotiated gateway limits");
      }
      const url = /^[a-z][a-z0-9+.-]*:/iu.test(uploadUrl) || uploadUrl.startsWith("/")
        ? new URL(uploadUrl, options.baseUrl).toString()
        : `${options.baseUrl.replace(/\/+$/u, "")}/${uploadUrl.replace(/^\/+/, "")}`;
      const form = new FormData();
      form.set("file", request.source, request.metadata.filename ?? "attachment");
      form.set("idempotencyKey", request.idempotencyKey);
      form.set("kind", request.metadata.kind ?? "image");
      if (request.metadata.conversationId) form.set("conversationId", request.metadata.conversationId);
      const initial: RequestInit = { method: "POST", body: form, signal: request.signal };
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      if (!response.ok) throw new TypeError("Attachment upload failed");
      request.onProgress({ uploadedBytes: request.metadata.byteSize, totalBytes: request.metadata.byteSize });
      const result = await response.json() as { readonly ok?: boolean; readonly value?: unknown };
      if (!result.ok) throw new TypeError("Attachment upload failed");
      const value = result.value as Partial<AttachmentReference> | undefined;
      if (!value || typeof value.attachment_id !== "string" || typeof value.content_ref !== "string" ||
        value.media_type !== request.metadata.mediaType || value.byte_size !== request.metadata.byteSize) {
        throw new TypeError("Attachment gateway returned an invalid reference");
      }
      return Object.freeze({ attachment_id: value.attachment_id, content_ref: value.content_ref,
        media_type: value.media_type, byte_size: value.byte_size,
        ...(typeof value.filename === "string" ? { filename: value.filename } : {}) });
    },
  };
}

export async function negotiateApplicationGatewayCapabilities(
  options: Pick<ApplicationGatewayTransportOptions<unknown>, "baseUrl" | "fetch" | "protectedRequest" | "diagnostics">,
): Promise<ApplicationGatewayCapabilities> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/capabilities`;
  const initial: RequestInit = { method: "GET" };
  return diagnoseAiOperation(options.diagnostics,
    { domain: "gateway", operation: "capabilities" }, async () => {
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      if (!response.ok) throw new TypeError("Application gateway capability negotiation failed");
      const result = await response.json() as { readonly ok?: boolean; readonly value?: ApplicationGatewayCapabilities };
      if (!result.ok || result.value?.protocolVersion !== APPLICATION_GATEWAY_PROTOCOL_VERSION) {
        throw new TypeError("Application gateway returned an incompatible protocol version");
      }
      return Object.freeze(result.value);
    });
}

type WithoutAuthorization<T> = Omit<T, "authorizationContext" | "permissionContext">;

export type ApplicationGatewayApprovalTransitionInput =
  Omit<WithoutAuthorization<TransitionApprovalProposalInput<unknown>>, "attribution"> & {
    readonly conversationId: string;
  };

export interface ApplicationGatewayResourceClient {
  /** Available when the negotiated gateway reports `activity: true`. */
  listActivity?(): Promise<readonly ConversationActivityRecord[]>;
  /** Available when the negotiated gateway reports `activity: true`. */
  markActivityRead?(input: { readonly conversationId: string; readonly observed?: ConversationActivityRecord }): Promise<ConversationActivityRecord | null>;
  /** Protected SSE stream; callers should retain polling as a convergence fallback. */
  subscribeActivity?(signal?: AbortSignal): AsyncIterable<ConversationActivityRecord>;
  listConversations(input: WithoutAuthorization<ListConversationsInput<unknown>>): Promise<ListConversationsResult>;
  createConversation(input: WithoutAuthorization<CreateConversationInput<unknown>>): Promise<CreateConversationResult>;
  getConversation(input: WithoutAuthorization<GetConversationInput<unknown>>): Promise<GetConversationResult>;
  renameConversation(input: WithoutAuthorization<RenameConversationInput<unknown>>): Promise<RenameConversationResult>;
  clearConversation(input: WithoutAuthorization<ClearConversationInput<unknown>>): Promise<ClearConversationResult>;
  archiveConversation(input: WithoutAuthorization<ArchiveConversationInput<unknown>>): Promise<ArchiveConversationResult>;
  restoreConversation(input: WithoutAuthorization<RestoreConversationInput<unknown>>): Promise<RestoreConversationResult>;
  permanentlyDeleteConversation(input: WithoutAuthorization<PermanentlyDeleteConversationInput<unknown>>): Promise<PermanentlyDeleteConversationResult>;
  createApproval(input: WithoutAuthorization<CreateApprovalProposalInput<unknown>>): Promise<ConversationApprovalProposalRecord>;
  getApproval(input: WithoutAuthorization<GetApprovalProposalInput<unknown>>): Promise<ConversationApprovalProposalRecord | null>;
  listApprovalGroup(input: WithoutAuthorization<ListApprovalProposalGroupInput<unknown>>): Promise<readonly ConversationApprovalProposalRecord[]>;
  transitionApproval(input: ApplicationGatewayApprovalTransitionInput): Promise<ConversationApprovalProposalRecord>;
  generateTitle(input: { readonly conversationId: string; readonly idempotencyKey: string }): Promise<string>;
  pullSnapshot(input: PullSnapshotInput): Promise<PullSnapshotResult>;
  readSince(input: ReadSinceInput): Promise<ReadSinceResult>;
  appendMutations(input: AppendMutationsInput): Promise<AppendMutationsResult>;
}

export class ApplicationGatewayResourceError extends Error {
  readonly transportCode: TransportError["code"];
  readonly retryable: boolean;
  readonly resourceDomain: ApplicationGatewayResourceDomain | undefined;
  readonly resourceCode: string | undefined;

  constructor(input: {
    readonly message: string;
    readonly transportCode: TransportError["code"];
    readonly retryable: boolean;
    readonly resourceError?: ApplicationGatewayResourceFailure;
  }) {
    super(input.message);
    this.name = "ApplicationGatewayResourceError";
    this.transportCode = input.transportCode;
    this.retryable = input.retryable;
    this.resourceDomain = input.resourceError?.domain;
    this.resourceCode = input.resourceError?.code;
  }
}

function fallbackCatalogCapabilities(): ConversationCatalogCapabilities {
  const unsupported = Object.freeze({ supported: false as const, reason: "not_implemented" as const });
  return Object.freeze({
    rename: unsupported,
    clear: unsupported,
    archive: unsupported,
    restore: unsupported,
    permanentDelete: unsupported,
  });
}

function catalogErrorCode(
  error: unknown,
): ConversationCatalogErrorCode {
  if (error instanceof ApplicationGatewayResourceError) {
    const resourceCode = error.resourceDomain === "conversation_catalog"
      ? error.resourceCode
      : undefined;
    if (resourceCode === "invalid_input" || resourceCode === "not_found" ||
      resourceCode === "version_conflict" || resourceCode === "idempotency_conflict" ||
      resourceCode === "forbidden" || resourceCode === "unsupported" ||
      resourceCode === "unavailable") return resourceCode;
    if (error.transportCode === "not_found") return "not_found";
    if (error.transportCode === "forbidden" || error.transportCode === "unauthenticated") {
      return "forbidden";
    }
    if (error.transportCode === "conflict") return "version_conflict";
    if (error.transportCode === "invalid_request") return "invalid_input";
  }
  return "unavailable";
}

function catalogOperation<T>(
  operation: ConversationCatalogAuthorizationAction,
  execute: () => Promise<T>,
): Promise<T> {
  return execute().catch((error: unknown) => {
    if (error instanceof ConversationCatalogError) throw error;
    throw new ConversationCatalogError(catalogErrorCode(error), operation);
  });
}

function withoutAuthorization<T extends { readonly authorizationContext: unknown }>(
  input: T,
): Omit<T, "authorizationContext"> {
  const request: Record<string, unknown> = { ...input };
  Reflect.deleteProperty(request, "authorizationContext");
  return request as Omit<T, "authorizationContext">;
}

/**
 * Adapts the protected gateway resource client to the exact ConversationCatalog
 * contract consumed by useConversationPicker and ConversationRuntimeRegistry.
 * The authorization context is intentionally ignored: the gateway derives it
 * from the protected request and never trusts a client-supplied identity.
 */
export function createApplicationGatewayConversationCatalog<TAuthorizationContext = unknown>(
  client: ApplicationGatewayResourceClient,
  capabilities?: ApplicationGatewayCapabilities,
): ConversationCatalog<TAuthorizationContext> {
  const negotiated = capabilities?.resources?.conversations;
  const catalogCapabilities = negotiated && typeof negotiated === "object"
    ? negotiated
    : fallbackCatalogCapabilities();
  return Object.freeze({
    capabilities: catalogCapabilities,
    list: (input: ListConversationsInput<TAuthorizationContext>) => catalogOperation("list",
      () => client.listConversations(withoutAuthorization(input))),
    create: (input: CreateConversationInput<TAuthorizationContext>) => catalogOperation("create",
      () => client.createConversation(withoutAuthorization(input))),
    get: (input: GetConversationInput<TAuthorizationContext>) => catalogOperation("get",
      () => client.getConversation(withoutAuthorization(input))),
    rename: (input: RenameConversationInput<TAuthorizationContext>) => catalogOperation("rename",
      () => client.renameConversation(withoutAuthorization(input))),
    clear: (input: ClearConversationInput<TAuthorizationContext>) => catalogOperation("clear",
      () => client.clearConversation(withoutAuthorization(input))),
    archive: (input: ArchiveConversationInput<TAuthorizationContext>) => catalogOperation("archive",
      () => client.archiveConversation(withoutAuthorization(input))),
    restore: (input: RestoreConversationInput<TAuthorizationContext>) => catalogOperation("restore",
      () => client.restoreConversation(withoutAuthorization(input))),
    permanentlyDelete: (input: PermanentlyDeleteConversationInput<TAuthorizationContext>) => catalogOperation(
      "permanent_delete",
      () => client.permanentlyDeleteConversation(withoutAuthorization(input)),
    ),
  });
}

/** Typed, cross-platform resource client paired with the application gateway. */
export function createApplicationGatewayResourceClient(
  options: Pick<ApplicationGatewayTransportOptions<unknown>, "baseUrl" | "fetch" | "protectedRequest" | "diagnostics">,
): ApplicationGatewayResourceClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const invoke = async <T>(path: string, input: unknown): Promise<T> => {
    const startedAt = Date.now();
    const domain = path.startsWith("/approvals/") ? "approval" as const : "gateway" as const;
    emitAiDiagnostic(options.diagnostics, { domain, operation: path, phase: "started" });
    const url = `${base}${path}`;
    const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
    let statusCode: number | undefined;
    try {
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      statusCode = response.status;
      const result = await response.json() as {
        readonly ok?: boolean;
        readonly value?: T;
        readonly error?: Partial<TransportError>;
        readonly resourceError?: ApplicationGatewayResourceFailure;
      };
      if (!response.ok || !result.ok) {
        throw new ApplicationGatewayResourceError({
          message: result.error?.message ?? "Application gateway request failed",
          transportCode: result.error?.code ?? "unavailable",
          retryable: result.error?.retryable ?? response.status >= 500,
          ...(result.resourceError === undefined ? {} : { resourceError: result.resourceError }),
        });
      }
      emitAiDiagnostic(options.diagnostics, { domain, operation: path, phase: "succeeded",
        durationMs: Date.now() - startedAt, statusCode: response.status });
      return result.value as T;
    } catch (cause) {
      const resourceError = cause instanceof ApplicationGatewayResourceError ? cause : undefined;
      emitAiDiagnostic(options.diagnostics, {
        domain: resourceError?.resourceDomain === "approval_proposals" ? "approval" : domain,
        operation: path, phase: "failed", durationMs: Date.now() - startedAt,
        code: resourceError?.resourceCode ?? resourceError?.transportCode ??
          (cause instanceof Error ? cause.name : "unknown"),
        retryable: resourceError?.retryable ?? true,
        ...(statusCode === undefined ? {} : { statusCode }), cause,
      });
      throw cause;
    }
  };
  const client: ApplicationGatewayResourceClient = {
    listActivity: () => invoke<readonly ConversationActivityRecord[]>("/activity", { operation: "list" }),
    markActivityRead: (input) => invoke<ConversationActivityRecord | null>("/activity", { operation: "mark_read", ...input }),
    subscribeActivity(signal?: AbortSignal) {
      const url = `${base}/activity`;
      return (async function* () {
        const initial: RequestInit = { method: "GET", ...(signal ? { signal } : {}) };
        const response = await fetcher(url,
          await options.protectedRequest?.({ url, ...initial }) ?? initial);
        if (!response.ok || !response.body) throw new TypeError("Activity subscription failed");
        for await (const frame of parseServerSentEvents(response.body)) {
          if (!frame.data) continue;
          const value = JSON.parse(frame.data) as { readonly record?: ConversationActivityRecord };
          if (value.record) yield parseConversationActivityRecord(value.record);
        }
      })();
    },
    listConversations: (input) => invoke<ListConversationsResult>("/conversations/list", input),
    createConversation: (input) => invoke<CreateConversationResult>("/conversations/create", input),
    getConversation: (input) => invoke<GetConversationResult>("/conversations/get", input),
    renameConversation: (input) => invoke<RenameConversationResult>("/conversations/rename", input),
    clearConversation: (input) => invoke<ClearConversationResult>("/conversations/clear", input),
    archiveConversation: (input) => invoke<ArchiveConversationResult>("/conversations/archive", input),
    restoreConversation: (input) => invoke<RestoreConversationResult>("/conversations/restore", input),
    permanentlyDeleteConversation: (input) => invoke<PermanentlyDeleteConversationResult>("/conversations/permanent-delete", input),
    createApproval: (input) => invoke<ConversationApprovalProposalRecord>("/approvals/create", input),
    getApproval: (input) => invoke<ConversationApprovalProposalRecord | null>("/approvals/get", input),
    listApprovalGroup: (input) => invoke<readonly ConversationApprovalProposalRecord[]>("/approvals/list-group", input),
    transitionApproval: (input) => invoke<ConversationApprovalProposalRecord>("/approvals/transition", input),
    generateTitle: (input) => invoke<string>("/titles/generate", input),
    pullSnapshot: (input) => invoke<PullSnapshotResult>("/synchronization", { operation: "pull_snapshot", input }),
    readSince: (input) => invoke<ReadSinceResult>("/synchronization", { operation: "read_since", input }),
    appendMutations: (input) => invoke<AppendMutationsResult>("/synchronization", { operation: "append_mutations", input }),
  };
  return Object.freeze(client);
}

async function readGatewayStream<TEvent>(
  response: Response,
  decodeEvent: (value: unknown) => TEvent,
  started: (value: Extract<GatewayStreamMessage<TEvent>, { type: "started" }>) => void,
  disconnectRequest: () => void,
): Promise<TurnObservation<TEvent>> {
  if (!response.ok || response.body === null) throw response;
  let resolveResult!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => { resolveResult = resolve; });
  let checkpoint = EMPTY_CHECKPOINT;
  const streamController = new AbortController();
  const events = (async function* () {
    let terminal = false;
    try {
      for await (const frame of parseServerSentEvents(response.body!, { signal: streamController.signal })) {
        if (!frame.data) continue;
        const message = JSON.parse(frame.data) as GatewayStreamMessage<unknown>;
        if (message.type === "started") started(message);
        else if (message.type === "event") { checkpoint = message.checkpoint; yield decodeEvent(message.event); }
        else if (message.type === "terminal") { terminal = true; resolveResult(message.result); }
      }
      if (!terminal) resolveResult({ status: "disconnected", checkpoint });
    } catch { resolveResult({ status: "disconnected", checkpoint }); }
  })();
  return { events, result, disconnect() {
    streamController.abort();
    disconnectRequest();
    resolveResult({ status: "disconnected", checkpoint });
  } };
}

/** Browser and React-Native-compatible transport for an application-owned gateway. */
export function createApplicationGatewayTransport<TEvent = unknown, TRequest = unknown, TSynchronization = unknown>(
  options: ApplicationGatewayTransportOptions<TEvent, TSynchronization>,
): ConversationTransport<TEvent, TRequest, AttachmentUploadAdapter<ApplicationGatewayAttachmentSource>, ApplicationGatewayPresenceClient, TSynchronization> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const decode = options.decodeEvent ?? ((value: unknown) => value as TEvent);
  const invoke = async (path: string, payload: unknown, signal?: AbortSignal): Promise<Response> => {
    const url = `${base}${path}`;
    const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), ...(signal ? { signal } : {}) };
    return fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
  };
  const cancellation = {
    async cancelTurn(input: CancelTurnInput): Promise<TransportResult<AuthoritativeCancelTurnResult>> {
      const startedAt = Date.now();
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "cancel", phase: "started",
        conversationId: input.conversationId, turnId: input.turnId });
      try {
        const response = await invoke("/turns/cancel", input);
        const result = await response.json() as TransportResult<AuthoritativeCancelTurnResult>;
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "cancel",
          phase: result.ok ? "succeeded" : "failed", conversationId: input.conversationId,
          turnId: input.turnId, durationMs: Date.now() - startedAt, statusCode: response.status,
          ...(!result.ok ? { code: result.error.code, retryable: result.error.retryable } : {}) });
        return result;
      } catch (cause) {
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "cancel", phase: "failed",
          conversationId: input.conversationId, turnId: input.turnId, durationMs: Date.now() - startedAt,
          code: cause instanceof Error ? cause.name : "unknown", retryable: true, cause });
        return { ok: false, error: { code: "unavailable", message: "The application gateway is unavailable.", retryable: true } };
      }
    },
  };
  const negotiated = options.capabilities;
  const attachmentUpload = negotiated?.attachments
    ? createGatewayAttachmentUploadAdapter(options, negotiated.attachments)
    : null;
  const capabilities: ConversationTransportCapabilities<AttachmentUploadAdapter<ApplicationGatewayAttachmentSource>, ApplicationGatewayPresenceClient, TSynchronization> = {
    authoritativeCancellation: negotiated?.authoritativeCancellation === true
      ? { supported: true, capability: cancellation }
      : { supported: false },
    documentInput: negotiated?.documentInput
      ? { supported: true, capability: negotiated.documentInput }
      : { supported: false }, attachmentUpload: attachmentUpload
      ? { supported: true, capability: attachmentUpload }
      : { supported: false },
    presence: negotiated?.presence === true
      ? { supported: true, capability: createGatewayPresenceClient(options) }
      : { supported: false },
    synchronization: negotiated?.synchronization === true && options.synchronization !== undefined
      ? { supported: true, capability: options.synchronization }
      : { supported: false },
  };
  return Object.freeze({
    capabilities,
    async startTurn(input: StartTurnInput<TRequest>): Promise<TransportResult<TurnHandle<TEvent>>> {
      const startedAt = Date.now();
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "started",
        conversationId: input.conversationId, turnId: input.conversationTurnId });
      try {
        const connection = new AbortController();
        const response = await invoke("/turns/start", input, connection.signal);
        if (!response.ok) {
          const result = await response.json() as TransportResult<TurnHandle<TEvent>>;
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "failed",
            conversationId: input.conversationId, turnId: input.conversationTurnId,
            durationMs: Date.now() - startedAt, statusCode: response.status,
            ...(!result.ok ? { code: result.error.code, retryable: result.error.retryable } : {}) });
          return result;
        }
        const observation = await readGatewayStream(response, decode, () => undefined, () => connection.abort());
        observeGatewayTurnDiagnostics(options.diagnostics, "start", input.conversationId,
          response.headers.get("x-handrail-turn-id") ?? input.conversationTurnId, observation, startedAt);
        return { ok: true, value: {
          conversationId: response.headers.get("x-handrail-conversation-id") ?? input.conversationId,
          turnId: response.headers.get("x-handrail-turn-id") ?? input.conversationTurnId,
          mutationId: response.headers.get("x-handrail-mutation-id") ?? input.mutationId,
          observation,
        } };
      } catch (cause) {
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "start", phase: "failed",
          conversationId: input.conversationId, turnId: input.conversationTurnId,
          durationMs: Date.now() - startedAt, code: cause instanceof Error ? cause.name : "unknown",
          retryable: true, cause });
        return { ok: false, error: { code: "unavailable", message: "The application gateway is unavailable.", retryable: true } };
      }
    },
    async resumeTurn(input: ResumeTurnInput): Promise<TransportResult<TurnObservation<TEvent>>> {
      const startedAt = Date.now();
      emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "resume", phase: "started",
        conversationId: input.conversationId, turnId: input.turnId });
      try {
        const connection = new AbortController();
        const response = await invoke("/turns/resume", input, connection.signal);
        if (!response.ok) {
          const result = await response.json() as TransportResult<TurnObservation<TEvent>>;
          emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "resume", phase: "failed",
            conversationId: input.conversationId, turnId: input.turnId,
            durationMs: Date.now() - startedAt, statusCode: response.status,
            ...(!result.ok ? { code: result.error.code, retryable: result.error.retryable } : {}) });
          return result;
        }
        const observation = await readGatewayStream(response, decode, () => undefined, () => connection.abort());
        observeGatewayTurnDiagnostics(options.diagnostics, "resume", input.conversationId,
          input.turnId, observation, startedAt);
        return { ok: true, value: observation };
      } catch (cause) {
        emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "resume", phase: "failed",
          conversationId: input.conversationId, turnId: input.turnId,
          durationMs: Date.now() - startedAt, code: cause instanceof Error ? cause.name : "unknown",
          retryable: true, cause });
        return { ok: false, error: { code: "unavailable", message: "The application gateway is unavailable.", retryable: true } };
      }
    },
  });
}

function observeGatewayTurnDiagnostics<TEvent>(
  sink: AiDiagnosticSink | undefined,
  operation: "start" | "resume",
  conversationId: string,
  turnId: string,
  observation: TurnObservation<TEvent>,
  startedAt: number,
): void {
  void observation.result.then((result) => {
    emitAiDiagnostic(sink, { domain: "gateway", operation,
      phase: result.status === "completed" ? "succeeded" :
        result.status === "cancelled" ? "cancelled" : "failed",
      conversationId, turnId, durationMs: Date.now() - startedAt,
      ...(result.status === "failed"
        ? { code: result.error.code, retryable: result.error.retryable }
        : result.status === "disconnected" ? { code: "disconnected", retryable: true } : {}) });
  }, (cause: unknown) => {
    emitAiDiagnostic(sink, { domain: "gateway", operation, phase: "failed",
      conversationId, turnId, durationMs: Date.now() - startedAt,
      code: cause instanceof Error ? cause.name : "unknown", retryable: true, cause });
  });
}
