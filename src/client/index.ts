/** Cross-platform client entry point: no React, Node, database, or provider dependencies. */
export * from "./bootstrap.js";
export * from "../transcription-http.js";
export * from "./presence.js";
export * from "./synchronization.js";
export {
  APPLICATION_GATEWAY_PROTOCOL_VERSION,
  ApplicationGatewayResourceError,
  createApplicationGatewayConversationCatalog,
  createApplicationGatewayTransport,
  createApplicationGatewayResourceClient,
  negotiateApplicationGatewayCapabilities,
  type ApplicationGatewayCapabilities,
  type ApplicationGatewayAttachmentSource,
  type ApplicationGatewayEventEnvelope,
  type ApplicationGatewayPresenceClient,
  type ApplicationGatewayTransportOptions,
  type ApplicationGatewayResourceClient,
} from "../transports/application-gateway.js";
export type {
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
} from "../transports/types.js";
export {
  LIVE_PRESENCE_PROTOCOL_VERSION,
  type LivePresenceEnvelope,
} from "../presence/live-delivery.js";
export type { PresenceRecord } from "../presence/types.js";
export type { AttachmentReference, ApplicationToolResult, StreamEvent } from "../protocol.js";
export type { CitationSource } from "../citations.js";
export {
  ConversationWorkspace,
  type ConversationWorkspaceOpenInput,
  type ConversationWorkspaceSnapshot,
  type ConversationWorkspaceThreadSnapshot,
  type ConversationWorkspaceTurnStatus,
} from "../conversation/workspace.js";
export {
  createRetryDiagnosticHooks,
  createAiDiagnosticLoggerSink,
  diagnoseAiOperation,
  emitAiDiagnostic,
  publicAiDiagnostic,
  type AiDiagnosticDomain,
  type AiDiagnosticEvent,
  type AiDiagnosticPhase,
  type AiDiagnosticSink,
  type AiDiagnosticLogger,
} from "../diagnostics.js";
export {
  createConversationRuntime,
  type ConversationRuntime,
  type ConversationRuntimeCancellationResult,
  type ConversationRuntimeTurnResult,
} from "../runtime.js";
export {
  InMemoryConversationEventStore,
  type ConversationEventStore,
  type StoredConversationEvent,
} from "../conversation/event-store.js";
export {
  isConversationEvent,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationEventPayload,
} from "../conversation/events.js";
export {
  createInitialConversationState,
  type ConversationState,
} from "../conversation/state.js";

export { conversationTimeline, type ConversationTimelineEntry, type ConversationTimelineOptions } from "../conversation/timeline.js";

export { assistantToolArgumentReference, reviewedToolArguments } from "../conversation/approval-arguments.js";
