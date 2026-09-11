import {
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type AttachmentReference,
  type ApplicationToolResult,
  type AuthoritativeAttribution,
  type CancellationReason,
  type ChatMessage,
  type CompletionOutcome,
  type CorrelationHints,
  type DocumentMimeType,
  type GenerationSettings,
  type ProtocolMetadata,
  type StreamEvent,
  type ToolDefinition,
} from "../protocol.js";
import type {
  ProviderContextCapability,
  ProviderContextCapabilityDescriptor,
} from "../provider-context.js";

export interface DocumentInputCapabilityDescriptor {
  readonly supported_mime_types: readonly DocumentMimeType[];
  readonly max_document_count: number;
  readonly max_document_bytes: number;
  readonly requires_host_resolution: boolean;
}

export interface UnsupportedProviderDocumentInputCapability {
  readonly supported: false;
}

export interface SupportedProviderDocumentInputCapability {
  readonly supported: true;
  readonly capability: DocumentInputCapabilityDescriptor;
}

export type ProviderDocumentInputCapability =
  | UnsupportedProviderDocumentInputCapability
  | SupportedProviderDocumentInputCapability;

export interface UnsupportedProviderCitationProjectionCapability {
  readonly supported: false;
}

export interface SupportedProviderCitationProjectionCapability {
  readonly supported: true;
}

/**
 * Declares whether an adapter can emit checked provider-neutral citation
 * batches. An omitted declaration is treated as unsupported for compatibility
 * with adapters authored before citation projection was added.
 */
export type ProviderCitationProjectionCapability =
  | UnsupportedProviderCitationProjectionCapability
  | SupportedProviderCitationProjectionCapability;

export const UNSUPPORTED_PROVIDER_DOCUMENT_INPUT = Object.freeze({
  supported: false,
}) satisfies UnsupportedProviderDocumentInputCapability;

export const UNSUPPORTED_PROVIDER_CITATION_PROJECTION = Object.freeze({
  supported: false,
}) satisfies UnsupportedProviderCitationProjectionCapability;

function documentCapabilityRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactDocumentCapabilityKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw new TypeError(`${label} contains invalid fields`);
  }
}

/** Validates and copies an untrusted provider document capability descriptor. */
export function parseProviderDocumentInputCapability(
  value: unknown,
): ProviderDocumentInputCapability {
  const capability = documentCapabilityRecord(value, "document_input");
  if (capability.supported === false) {
    exactDocumentCapabilityKeys(capability, ["supported"], "document_input");
    return UNSUPPORTED_PROVIDER_DOCUMENT_INPUT;
  }
  if (capability.supported !== true) {
    throw new TypeError("document_input.supported must be a boolean literal");
  }
  exactDocumentCapabilityKeys(
    capability,
    ["supported", "capability"],
    "document_input",
  );

  const descriptor = documentCapabilityRecord(
    capability.capability,
    "document_input.capability",
  );
  exactDocumentCapabilityKeys(
    descriptor,
    [
      "supported_mime_types",
      "max_document_count",
      "max_document_bytes",
      "requires_host_resolution",
    ],
    "document_input.capability",
  );

  const supportedMimeTypes = descriptor.supported_mime_types;
  if (!Array.isArray(supportedMimeTypes) || supportedMimeTypes.length === 0) {
    throw new TypeError(
      "document_input.capability.supported_mime_types must be a non-empty array",
    );
  }
  const protocolMimeTypes = new Set<string>(AI_RUNTIME_DOCUMENT_MIME_TYPES);
  const uniqueMimeTypes = new Set<string>();
  for (const mediaType of supportedMimeTypes) {
    if (typeof mediaType !== "string" || !protocolMimeTypes.has(mediaType)) {
      throw new TypeError(
        "document_input.capability.supported_mime_types contains an unsupported MIME type",
      );
    }
    if (uniqueMimeTypes.has(mediaType)) {
      throw new TypeError(
        "document_input.capability.supported_mime_types must not contain duplicates",
      );
    }
    uniqueMimeTypes.add(mediaType);
  }

  const maxDocumentCount = descriptor.max_document_count;
  if (
    !Number.isSafeInteger(maxDocumentCount) ||
    (maxDocumentCount as number) < 1 ||
    (maxDocumentCount as number) >
      AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest
  ) {
    throw new TypeError(
      `document_input.capability.max_document_count must be between 1 and ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest}`,
    );
  }

  const maxDocumentBytes = descriptor.max_document_bytes;
  if (
    !Number.isSafeInteger(maxDocumentBytes) ||
    (maxDocumentBytes as number) < AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes ||
    (maxDocumentBytes as number) > AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes
  ) {
    throw new TypeError(
      `document_input.capability.max_document_bytes must be between ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes} and ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes}`,
    );
  }
  if (typeof descriptor.requires_host_resolution !== "boolean") {
    throw new TypeError(
      "document_input.capability.requires_host_resolution must be a boolean",
    );
  }

  return Object.freeze({
    supported: true,
    capability: Object.freeze({
      supported_mime_types: Object.freeze(
        [...supportedMimeTypes] as DocumentMimeType[],
      ),
      max_document_count: maxDocumentCount as number,
      max_document_bytes: maxDocumentBytes as number,
      requires_host_resolution: descriptor.requires_host_resolution,
    }),
  });
}

/** Strictly validates the serializable citation-projection declaration. */
export function parseProviderCitationProjectionCapability(
  value: unknown,
): ProviderCitationProjectionCapability {
  const capability = documentCapabilityRecord(value, "citation_projection");
  exactDocumentCapabilityKeys(
    capability,
    ["supported"],
    "citation_projection",
  );
  if (capability.supported === false) {
    return UNSUPPORTED_PROVIDER_CITATION_PROJECTION;
  }
  if (capability.supported !== true) {
    throw new TypeError(
      "citation_projection.supported must be a boolean literal",
    );
  }
  return Object.freeze({ supported: true });
}

/** Provider-neutral bytes produced by a trusted host from an opaque content_ref. */
export interface ResolvedProviderDocument {
  readonly media_type: DocumentMimeType;
  readonly bytes: Uint8Array;
}

export interface ProviderDocumentResolutionContext {
  readonly signal: AbortSignal;
}

export type ProviderDocumentReferenceResolver = (
  reference: Readonly<AttachmentReference<DocumentMimeType>>,
  context: ProviderDocumentResolutionContext,
) => ResolvedProviderDocument | Promise<ResolvedProviderDocument>;

/** Trusted host resolution for either image or document references. The adapter
 * validates returned type and byte count against the admitted reference. */
export type ProviderAttachmentReferenceResolver = (
  reference: Readonly<AttachmentReference>,
  context: ProviderDocumentResolutionContext,
) => { readonly media_type: string; readonly bytes: Uint8Array } |
  Promise<{ readonly media_type: string; readonly bytes: Uint8Array }>;

export interface ProviderModelCapabilities {
  readonly streaming: true;
  readonly text: true;
  readonly tool_calls: boolean;
  readonly parallel_tool_calls: boolean;
  readonly reasoning: boolean;
  readonly document_input: ProviderDocumentInputCapability;
  /** Absence is the legacy-compatible equivalent of supported:false. */
  readonly citation_projection?: ProviderCitationProjectionCapability;
  /** Serializable model-specific provider-context support declaration. */
  readonly provider_context: ProviderContextCapabilityDescriptor;
  readonly context_window_tokens: number | null;
  readonly max_output_tokens: number | null;
}

export interface ProviderAdapterMetadata {
  readonly provider_id: string;
  readonly model_id: string;
  readonly capabilities: ProviderModelCapabilities;
}

export interface ProviderRequestContext {
  readonly request_id: string;
  readonly trace_id: string;
  readonly attribution: AuthoritativeAttribution;
  readonly correlation_hints: CorrelationHints;
  readonly metadata?: ProtocolMetadata;
}

export interface ProviderAdapterInvocation {
  /** Provider-neutral identity of the immediately preceding tool-call response. */
  readonly continuation_of?: string | null;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly tool_results: readonly ApplicationToolResult[];
  readonly generation: GenerationSettings;
  readonly signal: AbortSignal;
  readonly context: ProviderRequestContext;
  /** A trusted host resolves opaque document content_ref values before native input is built. */
  readonly resolve_document_reference?: ProviderDocumentReferenceResolver;
  readonly resolve_attachment_reference?: ProviderAttachmentReferenceResolver;
}

export interface KnownProviderCost {
  readonly known: true;
  /** Exact base-10 amount as reported or calculated by the provider. */
  readonly amount: string;
  /** ISO 4217 alphabetic currency code, such as USD. */
  readonly currency: string;
}

export interface UnknownProviderCost {
  readonly known: false;
}

/** An explicit union keeps unknown cost distinct from a known zero amount. */
export type ProviderCost = KnownProviderCost | UnknownProviderCost;

export interface ProviderUsage {
  /** All input tokens, including cached input tokens. */
  readonly input_tokens: number;
  /** The subset of input_tokens served from a provider cache; never additive. */
  readonly cached_input_tokens: number;
  /** The subset of input_tokens written to provider cache when reported. */
  readonly cache_write_input_tokens?: number;
  /** All generated output tokens, including reasoning tokens when reported. */
  readonly output_tokens: number;
  /** The subset of output_tokens used for reasoning; never additive. */
  readonly reasoning_tokens: number;
  /** input_tokens + output_tokens; cached and reasoning subsets are not added again. */
  readonly total_tokens: number;
  readonly provider_cost: ProviderCost;
}

export interface RetryableProviderError {
  readonly kind: "provider";
  readonly retryable: true;
  readonly code: "rate_limited" | "deadline_exceeded" | "upstream_unavailable";
  readonly message: string;
}

export interface ClientRequestError {
  readonly kind: "client";
  readonly retryable: false;
  readonly code: "invalid_request" | "unauthenticated" | "forbidden" | "idempotency_conflict";
  readonly message: string;
}

export interface PolicyDeniedError {
  readonly kind: "policy";
  readonly retryable: false;
  readonly code: "policy_denied";
  readonly message: string;
}

export type ProviderAdapterError =
  | RetryableProviderError
  | ClientRequestError
  | PolicyDeniedError;

export interface ProviderAdapterCompletedResult {
  readonly status: "completed";
  readonly outcome: CompletionOutcome;
  readonly usage: ProviderUsage;
}

export interface ProviderAdapterCancelledResult {
  readonly status: "cancelled";
  readonly reason: CancellationReason;
  readonly usage: ProviderUsage | null;
}

export interface ProviderAdapterFailedResult {
  readonly status: "failed";
  readonly error: ProviderAdapterError;
  readonly usage: ProviderUsage | null;
}

export type ProviderAdapterResult =
  | ProviderAdapterCompletedResult
  | ProviderAdapterCancelledResult
  | ProviderAdapterFailedResult;

/**
 * Implementations yield only v1 StreamEvent values, ending with exactly one
 * matching terminal event before returning the normalized terminal result.
 */
export type ProviderAdapterStream = AsyncGenerator<
  StreamEvent,
  ProviderAdapterResult,
  void
>;

export interface ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  /** Operational provider-context capability; unsupported adapters expose no callbacks. */
  readonly provider_context: ProviderContextCapability;
  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream;
}
