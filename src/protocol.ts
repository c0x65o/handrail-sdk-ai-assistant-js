import {
  normalizeCitationRecords,
  type AssistantMessageCitationTarget,
  type Citation,
  type CitationRecordSet,
  type CitationSource,
} from "./citations.js";
import { jsonValuesEqual } from "./json-equality.js";

export const AI_RUNTIME_PROTOCOL_VERSION = "handrail.ai-runtime.v1" as const;

export const AI_RUNTIME_STREAM_EVENT_TYPES = [
  "response.started",
  "response.text.delta",
  "response.tool_call",
  "response.citation_batch",
  "response.usage",
  "response.completed",
  "response.cancelled",
  "response.error",
] as const;

export const AI_RUNTIME_COMPLETION_OUTCOMES = [
  "stop",
  "length",
  "tool_calls",
] as const;

export const AI_RUNTIME_CANCELLATION_REASONS = [
  "deadline_exceeded",
  "policy_revoked",
  "runtime_shutdown",
] as const;

export const AI_RUNTIME_ERROR_CATEGORIES = [
  "request",
  "authentication",
  "authorization",
  "policy",
  "capacity",
  "upstream",
  "internal",
] as const;

export const AI_RUNTIME_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "policy_denied",
  "rate_limited",
  "capacity_exceeded",
  "idempotency_conflict",
  "deadline_exceeded",
  "upstream_unavailable",
  "internal_error",
] as const;

export const AI_RUNTIME_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

/**
 * Provider-neutral document inputs supported by the wire protocol. Providers
 * and hosts still advertise the subset they can resolve and process.
 */
export const AI_RUNTIME_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "text/tab-separated-values",
] as const;

/** Canonical fallback filenames shared by browser intake and provider adapters. */
export const AI_RUNTIME_DOCUMENT_EXTENSIONS: Readonly<Record<typeof AI_RUNTIME_DOCUMENT_MIME_TYPES[number], string>> = Object.freeze({
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-excel": ".xls",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
});

export const AI_RUNTIME_ATTACHMENT_ID_GRAMMAR =
  "^att_[A-Za-z0-9][A-Za-z0-9._-]{0,251}$" as const;
export const AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR =
  "^ref_[A-Za-z0-9][A-Za-z0-9._-]{0,251}$" as const;

export const AI_RUNTIME_PROTOCOL_LIMITS = {
  identifierLength: 256,
  textLength: 1_000_000,
  errorMessageLength: 1_024,
  attachmentIdLength: 256,
  attachmentContentReferenceLength: 256,
  attachmentFilenameLength: 255,
  attachmentAltTextLength: 1_024,
  imageAttachmentMinBytes: 1,
  imageAttachmentMaxBytes: 10_485_760,
  imageAttachmentsPerMessage: 4,
  imageAttachmentsPerRequest: 8,
  documentAttachmentMinBytes: 1,
  documentAttachmentMaxBytes: 26_214_400,
  documentAttachmentsPerMessage: 2,
  documentAttachmentsPerRequest: 4,
  jsonDepth: 20,
  jsonNodes: 10_000,
  jsonArrayLength: 2_000,
  jsonObjectKeys: 2_000,
  jsonKeyLength: 256,
  jsonStringLength: 1_000_000,
  metadataDepth: 5,
  metadataNodes: 256,
  metadataArrayLength: 64,
  metadataObjectKeys: 64,
  metadataKeyLength: 128,
  metadataStringLength: 4_096,
  metadataSerializedBytes: 16_384,
} as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type ProtocolMetadata = JsonObject;

export type StreamEventType = (typeof AI_RUNTIME_STREAM_EVENT_TYPES)[number];
export type CompletionOutcome =
  (typeof AI_RUNTIME_COMPLETION_OUTCOMES)[number];
export type CancellationReason =
  (typeof AI_RUNTIME_CANCELLATION_REASONS)[number];
export type PublicErrorCategory =
  (typeof AI_RUNTIME_ERROR_CATEGORIES)[number];
export type PublicErrorCode = (typeof AI_RUNTIME_ERROR_CODES)[number];
export type ImageMimeType = (typeof AI_RUNTIME_IMAGE_MIME_TYPES)[number];
export type DocumentMimeType = (typeof AI_RUNTIME_DOCUMENT_MIME_TYPES)[number];
export type AttachmentMimeType = ImageMimeType | DocumentMimeType;

export interface MessageTextPart {
  type: "text";
  text: string;
}

export interface AttachmentReference<
  TMediaType extends AttachmentMimeType = AttachmentMimeType,
> {
  attachment_id: string;
  content_ref: string;
  media_type: TMediaType;
  byte_size: number;
  filename?: string;
}

/** A trusted host or transport resolves attachment.content_ref before provider input is built. */
export interface MessageImagePart {
  type: "image";
  attachment: AttachmentReference<ImageMimeType>;
  alt_text?: string;
}

/** Document inputs are user-only; hosts resolve content_ref outside this durable protocol. */
export interface MessageDocumentPart {
  type: "document";
  attachment: AttachmentReference<DocumentMimeType>;
}

export type MessageContentPart =
  | MessageTextPart
  | MessageImagePart
  | MessageDocumentPart;

export interface ChatMessage {
  role: "user" | "assistant";
  content: MessageContentPart[];
}

export type JsonSchemaObject = JsonObject & { type: "object" };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

export interface ToolResultTextPart {
  type: "text";
  text: string;
}

export interface ToolResultJsonPart {
  type: "json";
  value: JsonValue;
}

export type ToolResultContentPart = ToolResultTextPart | ToolResultJsonPart;

export interface ApplicationToolResult {
  tool_call_id: string;
  name: string;
  content: ToolResultContentPart[];
  is_error: boolean;
  /** Trusted, normalized host-tool provenance. Provider adapters ignore this field. */
  citation_records?: CitationRecordSet;
}

export interface GenerationSettings {
  max_output_tokens: number;
  temperature: number;
}

export interface CorrelationHint {
  external_id: string;
  source: "client";
  trust: "untrusted_correlation_hint";
}

export interface CorrelationHints {
  known_user?: CorrelationHint;
  session?: CorrelationHint;
  automation?: CorrelationHint;
}

export interface ChatRequest {
  protocol_version: typeof AI_RUNTIME_PROTOCOL_VERSION;
  continuation_of: string | null;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  tool_results: ApplicationToolResult[];
  generation: GenerationSettings;
  correlation_hints: CorrelationHints;
  metadata?: ProtocolMetadata;
}

export interface RequiredAttributionMember {
  id: string;
  source: "server_derived";
  trust: "authoritative";
}

export interface OptionalAttributionMember {
  id: string | null;
  source: "server_derived";
  trust: "authoritative";
}

export interface AuthoritativeAttribution {
  organization: RequiredAttributionMember;
  project: RequiredAttributionMember;
  service_environment: RequiredAttributionMember;
  known_user: OptionalAttributionMember;
  session: OptionalAttributionMember;
  automation: OptionalAttributionMember;
}

export interface StreamEventEnvelope {
  type: StreamEventType;
  protocol_version: typeof AI_RUNTIME_PROTOCOL_VERSION;
  request_id: string;
  trace_id: string;
  sequence: number;
  metadata?: ProtocolMetadata;
}

export interface ResponseStartedEvent extends StreamEventEnvelope {
  type: "response.started";
  attribution: AuthoritativeAttribution;
}

export interface ResponseTextDeltaEvent extends StreamEventEnvelope {
  type: "response.text.delta";
  delta: string;
}

export interface ResponseToolCallEvent extends StreamEventEnvelope {
  type: "response.tool_call";
  tool_call_id: string;
  name: string;
  arguments: JsonObject;
}

/**
 * A checked provider-neutral batch linked to one stable assistant output.
 * Providers must emit deterministic, contiguous citation order across batches.
 */
export interface ResponseCitationBatchEvent extends StreamEventEnvelope {
  type: "response.citation_batch";
  target: AssistantMessageCitationTarget;
  sources: readonly CitationSource[];
  citations: readonly Citation[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ResponseUsageEvent extends StreamEventEnvelope {
  type: "response.usage";
  usage: Usage;
}

export interface ResponseCompletedEvent extends StreamEventEnvelope {
  type: "response.completed";
  outcome: CompletionOutcome;
}

export interface ResponseCancelledEvent extends StreamEventEnvelope {
  type: "response.cancelled";
  reason: CancellationReason;
}

export interface PublicError {
  category: PublicErrorCategory;
  code: PublicErrorCode;
  message: string;
  retryable: boolean;
}

export interface ResponseErrorEvent extends StreamEventEnvelope {
  type: "response.error";
  error: PublicError;
}

export type StreamEvent =
  | ResponseStartedEvent
  | ResponseTextDeltaEvent
  | ResponseToolCallEvent
  | ResponseCitationBatchEvent
  | ResponseUsageEvent
  | ResponseCompletedEvent
  | ResponseCancelledEvent
  | ResponseErrorEvent;

export type TerminalStreamEvent =
  | ResponseCompletedEvent
  | ResponseCancelledEvent
  | ResponseErrorEvent;

export class ProtocolValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolValidationError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "managedtoken",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "secretkey",
  "secrets",
  "setcookie",
  "signingkey",
]);

const METADATA_FORBIDDEN_FIELD_NAMES = new Set([
  ...CREDENTIAL_FIELD_NAMES,
  "anthropic",
  "attribution",
  "automation",
  "automationid",
  "chunk",
  "choices",
  "completiontokens",
  "contentblock",
  "contentblockdelta",
  "finishreason",
  "functioncall",
  "functioncallingconfig",
  "gemini",
  "headers",
  "knownuser",
  "knownuserid",
  "model",
  "modelid",
  "modeltransport",
  "nativechunk",
  "nativefinishreason",
  "openai",
  "organization",
  "organizationid",
  "orgid",
  "project",
  "projectid",
  "provider",
  "providerchunk",
  "providererror",
  "providername",
  "providerpayload",
  "providerrequest",
  "providerresponse",
  "promptfeedback",
  "prompttokens",
  "raw",
  "rawerror",
  "rawrequest",
  "rawresponse",
  "requestheaders",
  "requestid",
  "serviceenvironment",
  "serviceenvironmentid",
  "session",
  "sessionid",
  "stopreason",
  "stopsequence",
  "systemfingerprint",
  "tooluse",
  "tooluses",
  "traceid",
  "usagemetadata",
  "xai",
]);

const METADATA_FORBIDDEN_STRING_VALUES = new Set([
  "anthropic",
  "chatcompletion",
  "chatcompletionchunk",
  "contentblockdelta",
  "gemini",
  "openai",
  "xai",
]);

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const ATTACHMENT_ID_PATTERN = new RegExp(AI_RUNTIME_ATTACHMENT_ID_GRAMMAR);
const CONTENT_REFERENCE_PATTERN = new RegExp(AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR);

const normalizeFieldName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

function fail(path: string, message: string): never {
  throw new ProtocolValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, "must be a JSON object");
  }
  return value as UnknownRecord;
}

function allowedKeys(value: UnknownRecord, keys: readonly string[], path: string) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
}

function requiredKeys(value: UnknownRecord, keys: readonly string[], path: string) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function stringValue(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const { allowEmpty = false, maxLength = AI_RUNTIME_PROTOCOL_LIMITS.identifierLength } =
    options;
  if (typeof value !== "string") fail(path, "must be a string");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) fail(path, `must be at most ${maxLength} characters`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

interface JsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxKeyLength: number;
  maxStringLength: number;
  forbiddenFields?: ReadonlySet<string>;
  forbiddenStringValues?: ReadonlySet<string>;
}

function validateJson(value: unknown, path: string, limits: JsonLimits): asserts value is JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, currentPath: string, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) fail(path, `must contain at most ${limits.maxNodes} JSON values`);
    if (depth > limits.maxDepth) fail(currentPath, `exceeds maximum depth ${limits.maxDepth}`);

    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(currentPath, "must be a finite JSON number");
      return;
    }
    if (typeof current === "string") {
      if (current.length > limits.maxStringLength) {
        fail(currentPath, `must be at most ${limits.maxStringLength} characters`);
      }
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        fail(currentPath, "must not contain credential material");
      }
      if (limits.forbiddenStringValues?.has(normalizeFieldName(current))) {
        fail(currentPath, "must not identify provider-native data");
      }
      return;
    }
    if (typeof current !== "object") fail(currentPath, "must be a JSON value");
    if (ancestors.has(current)) fail(currentPath, "must not contain a circular reference");
    ancestors.add(current);

    if (Array.isArray(current)) {
      if (current.length > limits.maxArrayLength) {
        fail(currentPath, `must contain at most ${limits.maxArrayLength} items`);
      }
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1));
    } else {
      const object = record(current, currentPath);
      const entries = Object.entries(object);
      if (entries.length > limits.maxObjectKeys) {
        fail(currentPath, `must contain at most ${limits.maxObjectKeys} fields`);
      }
      for (const [key, item] of entries) {
        if (key.length === 0 || key.length > limits.maxKeyLength) {
          fail(`${currentPath}.${key}`, `field names must be 1-${limits.maxKeyLength} characters`);
        }
        if (limits.forbiddenFields?.has(normalizeFieldName(key))) {
          fail(`${currentPath}.${key}`, "is forbidden at this public protocol boundary");
        }
        visit(item, `${currentPath}.${key}`, depth + 1);
      }
    }
    ancestors.delete(current);
  };

  visit(value, path, 0);
}

const PUBLIC_JSON_LIMITS: JsonLimits = {
  maxDepth: AI_RUNTIME_PROTOCOL_LIMITS.jsonDepth,
  maxNodes: AI_RUNTIME_PROTOCOL_LIMITS.jsonNodes,
  maxArrayLength: AI_RUNTIME_PROTOCOL_LIMITS.jsonArrayLength,
  maxObjectKeys: AI_RUNTIME_PROTOCOL_LIMITS.jsonObjectKeys,
  maxKeyLength: AI_RUNTIME_PROTOCOL_LIMITS.jsonKeyLength,
  maxStringLength: AI_RUNTIME_PROTOCOL_LIMITS.jsonStringLength,
  forbiddenFields: CREDENTIAL_FIELD_NAMES,
};

const METADATA_LIMITS: JsonLimits = {
  maxDepth: AI_RUNTIME_PROTOCOL_LIMITS.metadataDepth,
  maxNodes: AI_RUNTIME_PROTOCOL_LIMITS.metadataNodes,
  maxArrayLength: AI_RUNTIME_PROTOCOL_LIMITS.metadataArrayLength,
  maxObjectKeys: AI_RUNTIME_PROTOCOL_LIMITS.metadataObjectKeys,
  maxKeyLength: AI_RUNTIME_PROTOCOL_LIMITS.metadataKeyLength,
  maxStringLength: AI_RUNTIME_PROTOCOL_LIMITS.metadataStringLength,
  forbiddenFields: METADATA_FORBIDDEN_FIELD_NAMES,
  forbiddenStringValues: METADATA_FORBIDDEN_STRING_VALUES,
};

const UTF8_ENCODER = new TextEncoder();

function validateMetadata(value: unknown, path: string): asserts value is ProtocolMetadata {
  record(value, path);
  validateJson(value, path, METADATA_LIMITS);
  const serialized = JSON.stringify(value);
  if (UTF8_ENCODER.encode(serialized).byteLength > AI_RUNTIME_PROTOCOL_LIMITS.metadataSerializedBytes) {
    fail(path, `must serialize to at most ${AI_RUNTIME_PROTOCOL_LIMITS.metadataSerializedBytes} bytes`);
  }
}

function validateCredentialsAbsent(value: unknown, path: string) {
  validateJson(value, path, PUBLIC_JSON_LIMITS);
}

const JSON_SCHEMA_TYPES = [
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
] as const;

function validateJsonSchemaNode(value: unknown, path: string, root = false, draft07 = false): void {
  if (typeof value === "boolean" && !root) return;
  const schema = record(value, path);
  if (root) draft07 = schema.$schema === "http://json-schema.org/draft-07/schema#";

  if (root && schema.type !== "object") fail(`${path}.type`, 'must equal "object"');
  if (Object.hasOwn(schema, "type")) {
    if (Array.isArray(schema.type)) {
      if (schema.type.length === 0) fail(`${path}.type`, "must not be empty");
      const types = new Set<string>();
      schema.type.forEach((type, index) => {
        const parsed = enumValue(type, JSON_SCHEMA_TYPES, `${path}.type[${index}]`);
        if (types.has(parsed)) fail(`${path}.type[${index}]`, "must be unique");
        types.add(parsed);
      });
    } else {
      enumValue(schema.type, JSON_SCHEMA_TYPES, `${path}.type`);
    }
  }

  for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const schemas = record(schema[keyword], `${path}.${keyword}`);
    for (const [name, child] of Object.entries(schemas)) {
      validateJsonSchemaNode(child, `${path}.${keyword}.${name}`, false, draft07);
    }
  }

  if (Object.hasOwn(schema, "required")) {
    if (!Array.isArray(schema.required)) fail(`${path}.required`, "must be an array");
    const names = new Set<string>();
    schema.required.forEach((item, index) => {
      const name = stringValue(item, `${path}.required[${index}]`);
      if (names.has(name)) fail(`${path}.required[${index}]`, "must be unique");
      names.add(name);
    });
  }

  for (const keyword of ["additionalProperties", "unevaluatedProperties", "items", "contains", "not", "if", "then", "else", "propertyNames"] as const) {
    if (Object.hasOwn(schema, keyword)) {
      const child = schema[keyword];
      if (keyword === "items" && draft07 && Array.isArray(child)) {
        if (child.length === 0) fail(`${path}.items`, "must be a non-empty array of JSON Schemas");
        child.forEach((item, index) => validateJsonSchemaNode(item, `${path}.items[${index}]`, false, draft07));
      } else {
        validateJsonSchemaNode(child, `${path}.${keyword}`, false, draft07);
      }
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const schemas = schema[keyword];
    if (!Array.isArray(schemas) || schemas.length === 0) {
      fail(`${path}.${keyword}`, "must be a non-empty array of JSON Schemas");
    }
    schemas.forEach((child, index) => validateJsonSchemaNode(child, `${path}.${keyword}[${index}]`, false, draft07));
  }

  if (Object.hasOwn(schema, "enum") && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    fail(`${path}.enum`, "must be a non-empty array");
  }

  for (const keyword of [
    "multipleOf",
    "maximum",
    "exclusiveMaximum",
    "minimum",
    "exclusiveMinimum",
    "maxLength",
    "minLength",
    "maxItems",
    "minItems",
    "maxContains",
    "minContains",
    "maxProperties",
    "minProperties",
  ] as const) {
    if (
      Object.hasOwn(schema, keyword) &&
      (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))
    ) {
      fail(`${path}.${keyword}`, "must be a finite number");
    }
  }
}

function validateTextPart(value: unknown, path: string): asserts value is MessageTextPart {
  const object = record(value, path);
  requiredKeys(object, ["type", "text"], path);
  allowedKeys(object, ["type", "text"], path);
  if (object.type !== "text") fail(`${path}.type`, 'must equal "text"');
  stringValue(object.text, `${path}.text`, {
    allowEmpty: true,
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.textLength,
  });
}

function rejectCredentialMaterial(value: string, path: string): void {
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(path, "must not contain credential material");
  }
}

function validateAttachmentIdentifier(value: unknown, path: string): void {
  const parsed = stringValue(value, path, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentIdLength,
  });
  rejectCredentialMaterial(parsed, path);
  if (!ATTACHMENT_ID_PATTERN.test(parsed)) {
    fail(path, `must match ${AI_RUNTIME_ATTACHMENT_ID_GRAMMAR}`);
  }
}

function validateContentReference(value: unknown, path: string): void {
  const parsed = stringValue(value, path, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentContentReferenceLength,
  });
  rejectCredentialMaterial(parsed, path);
  if (/^(?:data|blob|https?):/i.test(parsed) || !CONTENT_REFERENCE_PATTERN.test(parsed)) {
    fail(path, `must be an opaque identifier matching ${AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR}`);
  }
}

function validateSafeFilename(value: unknown, path: string): void {
  const parsed = stringValue(value, path, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength,
  });
  rejectCredentialMaterial(parsed, path);
  const hasUnsafeCharacter = [...parsed].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127 || '<>:"/\\|?*'.includes(character);
  });
  if (parsed === "." || parsed === ".." || hasUnsafeCharacter) {
    fail(path, "must be a safe filename without path separators or control characters");
  }
}

function validateAttachmentReference(
  value: unknown,
  path: string,
  mediaTypes: readonly AttachmentMimeType[],
  minBytes: number,
  maxBytes: number,
): void {
  const attachment = record(value, path);
  requiredKeys(
    attachment,
    ["attachment_id", "content_ref", "media_type", "byte_size"],
    path,
  );
  allowedKeys(
    attachment,
    ["attachment_id", "content_ref", "media_type", "byte_size", "filename"],
    path,
  );
  validateAttachmentIdentifier(attachment.attachment_id, `${path}.attachment_id`);
  validateContentReference(attachment.content_ref, `${path}.content_ref`);
  enumValue(attachment.media_type, mediaTypes, `${path}.media_type`);
  if (
    !Number.isInteger(attachment.byte_size) ||
    (attachment.byte_size as number) < minBytes ||
    (attachment.byte_size as number) > maxBytes
  ) {
    fail(
      `${path}.byte_size`,
      `must be an integer from ${minBytes} through ${maxBytes}`,
    );
  }
  if (Object.hasOwn(attachment, "filename")) {
    validateSafeFilename(attachment.filename, `${path}.filename`);
  }
}

function validateImagePart(value: unknown, path: string): asserts value is MessageImagePart {
  const object = record(value, path);
  requiredKeys(object, ["type", "attachment"], path);
  allowedKeys(object, ["type", "attachment", "alt_text"], path);
  if (object.type !== "image") fail(`${path}.type`, 'must equal "image"');

  validateAttachmentReference(
    object.attachment,
    `${path}.attachment`,
    AI_RUNTIME_IMAGE_MIME_TYPES,
    AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes,
    AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes,
  );
  if (Object.hasOwn(object, "alt_text")) {
    const altText = stringValue(object.alt_text, `${path}.alt_text`, {
      maxLength: AI_RUNTIME_PROTOCOL_LIMITS.attachmentAltTextLength,
    });
    rejectCredentialMaterial(altText, `${path}.alt_text`);
  }
}

function validateDocumentPart(
  value: unknown,
  path: string,
): asserts value is MessageDocumentPart {
  const object = record(value, path);
  requiredKeys(object, ["type", "attachment"], path);
  allowedKeys(object, ["type", "attachment"], path);
  if (object.type !== "document") fail(`${path}.type`, 'must equal "document"');

  validateAttachmentReference(
    object.attachment,
    `${path}.attachment`,
    AI_RUNTIME_DOCUMENT_MIME_TYPES,
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes,
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes,
  );
}

function validateMessageContentPart(
  value: unknown,
  path: string,
): asserts value is MessageContentPart {
  const object = record(value, path);
  if (object.type === "text") {
    validateTextPart(value, path);
    return;
  }
  if (object.type === "image") {
    validateImagePart(value, path);
    return;
  }
  if (object.type === "document") {
    validateDocumentPart(value, path);
    return;
  }
  fail(`${path}.type`, 'must equal "text", "image", or "document"');
}

interface MessageAttachmentCounts {
  imageCount: number;
  documentCount: number;
}

function validateMessage(value: unknown, path: string): MessageAttachmentCounts {
  const object = record(value, path);
  requiredKeys(object, ["role", "content"], path);
  allowedKeys(object, ["role", "content"], path);
  const role = enumValue(object.role, ["user", "assistant"], `${path}.role`);
  if (!Array.isArray(object.content) || object.content.length === 0) {
    fail(`${path}.content`, "must be a non-empty array");
  }
  let imageCount = 0;
  let documentCount = 0;
  object.content.forEach((part, index) => {
    const partPath = `${path}.content[${index}]`;
    validateMessageContentPart(part, partPath);
    if (part.type === "image") imageCount += 1;
    if (part.type === "document") {
      if (role !== "user") fail(`${partPath}.type`, "document parts are user-only");
      documentCount += 1;
    }
  });
  if (imageCount > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage) {
    fail(
      `${path}.content`,
      `must contain at most ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage} image parts`,
    );
  }
  if (documentCount > AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage) {
    fail(
      `${path}.content`,
      `must contain at most ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage} document parts`,
    );
  }
  return { imageCount, documentCount };
}

function validateToolDefinition(value: unknown, path: string): asserts value is ToolDefinition {
  const object = record(value, path);
  requiredKeys(object, ["name", "description", "input_schema"], path);
  allowedKeys(object, ["name", "description", "input_schema"], path);
  stringValue(object.name, `${path}.name`);
  stringValue(object.description, `${path}.description`, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.textLength,
  });
  const schema = record(object.input_schema, `${path}.input_schema`);
  validateCredentialsAbsent(schema, `${path}.input_schema`);
  validateJsonSchemaNode(schema, `${path}.input_schema`, true);
}

export function parseToolDefinition(value: unknown): ToolDefinition {
  validateToolDefinition(value, "$tool");
  return value;
}

function validateToolResultPart(
  value: unknown,
  path: string,
): asserts value is ToolResultContentPart {
  const object = record(value, path);
  if (object.type === "text") {
    validateTextPart(value, path);
    return;
  }
  if (object.type === "json") {
    requiredKeys(object, ["type", "value"], path);
    allowedKeys(object, ["type", "value"], path);
    validateCredentialsAbsent(object.value, `${path}.value`);
    return;
  }
  fail(`${path}.type`, 'must equal "text" or "json"');
}

function validateToolResult(value: unknown, path: string): asserts value is ApplicationToolResult {
  const object = record(value, path);
  requiredKeys(object, ["tool_call_id", "name", "content", "is_error"], path);
  allowedKeys(
    object,
    ["tool_call_id", "name", "content", "is_error", "citation_records"],
    path,
  );
  stringValue(object.tool_call_id, `${path}.tool_call_id`);
  stringValue(object.name, `${path}.name`);
  if (!Array.isArray(object.content) || object.content.length === 0) {
    fail(`${path}.content`, "must be a non-empty array");
  }
  object.content.forEach((part, index) => validateToolResultPart(part, `${path}.content[${index}]`));
  if (typeof object.is_error !== "boolean") fail(`${path}.is_error`, "must be a boolean");
  if (Object.hasOwn(object, "citation_records")) {
    let records: CitationRecordSet;
    try {
      records = normalizeCitationRecords(object.citation_records);
    } catch (error) {
      fail(
        `${path}.citation_records`,
        error instanceof Error ? error.message : "contains invalid citation records",
      );
    }
    if (records.citations.length === 0) {
      fail(`${path}.citation_records.citations`, "must contain at least one citation link");
    }
    if (!jsonValuesEqual(records, object.citation_records)) {
      fail(
        `${path}.citation_records`,
        "must already be normalized and identity-deduplicated",
      );
    }
    for (const citation of records.citations) {
      if (
        citation.target.type !== "tool_result" ||
        citation.target.tool_call_id !== object.tool_call_id
      ) {
        fail(
          `${path}.citation_records.citations`,
          "must contain only links to this tool result",
        );
      }
    }
  }
}

function validateGeneration(value: unknown, path: string): asserts value is GenerationSettings {
  const object = record(value, path);
  requiredKeys(object, ["max_output_tokens", "temperature"], path);
  allowedKeys(object, ["max_output_tokens", "temperature"], path);
  if (!Number.isInteger(object.max_output_tokens) || (object.max_output_tokens as number) <= 0) {
    fail(`${path}.max_output_tokens`, "must be a positive integer");
  }
  if (
    typeof object.temperature !== "number" ||
    !Number.isFinite(object.temperature) ||
    object.temperature < 0 ||
    object.temperature > 2
  ) {
    fail(`${path}.temperature`, "must be a finite number from 0 through 2");
  }
}

function validateCorrelationHint(value: unknown, path: string): asserts value is CorrelationHint {
  const object = record(value, path);
  requiredKeys(object, ["external_id", "source", "trust"], path);
  allowedKeys(object, ["external_id", "source", "trust"], path);
  stringValue(object.external_id, `${path}.external_id`);
  if (object.source !== "client") fail(`${path}.source`, 'must equal "client"');
  if (object.trust !== "untrusted_correlation_hint") {
    fail(`${path}.trust`, 'must equal "untrusted_correlation_hint"');
  }
}

function validateCorrelationHints(value: unknown, path: string): asserts value is CorrelationHints {
  const object = record(value, path);
  allowedKeys(object, ["known_user", "session", "automation"], path);
  for (const key of ["known_user", "session", "automation"] as const) {
    if (Object.hasOwn(object, key)) validateCorrelationHint(object[key], `${path}.${key}`);
  }
}

export function parseChatRequest(value: unknown): ChatRequest {
  const object = record(value, "$request");
  requiredKeys(
    object,
    [
      "protocol_version",
      "continuation_of",
      "messages",
      "tools",
      "tool_results",
      "generation",
      "correlation_hints",
    ],
    "$request",
  );
  allowedKeys(
    object,
    [
      "protocol_version",
      "continuation_of",
      "messages",
      "tools",
      "tool_results",
      "generation",
      "correlation_hints",
      "metadata",
    ],
    "$request",
  );
  if (object.protocol_version !== AI_RUNTIME_PROTOCOL_VERSION) {
    fail("$request.protocol_version", `must equal "${AI_RUNTIME_PROTOCOL_VERSION}"`);
  }
  if (object.continuation_of !== null) {
    stringValue(object.continuation_of, "$request.continuation_of");
  }
  if (!Array.isArray(object.messages) || object.messages.length === 0) {
    fail("$request.messages", "must be a non-empty array");
  }
  let requestImageCount = 0;
  let requestDocumentCount = 0;
  object.messages.forEach((message, index) => {
    const counts = validateMessage(message, `$request.messages[${index}]`);
    requestImageCount += counts.imageCount;
    requestDocumentCount += counts.documentCount;
  });
  if (requestImageCount > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest) {
    fail(
      "$request.messages",
      `must contain at most ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest} image parts across the request`,
    );
  }
  if (requestDocumentCount > AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest) {
    fail(
      "$request.messages",
      `must contain at most ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest} document parts across the request`,
    );
  }
  if (!Array.isArray(object.tools)) fail("$request.tools", "must be an array");
  const toolNames = new Set<string>();
  object.tools.forEach((tool, index) => {
    validateToolDefinition(tool, `$request.tools[${index}]`);
    if (toolNames.has(tool.name)) fail(`$request.tools[${index}].name`, "must be unique");
    toolNames.add(tool.name);
  });
  if (!Array.isArray(object.tool_results)) fail("$request.tool_results", "must be an array");
  const callIds = new Set<string>();
  object.tool_results.forEach((result, index) => {
    validateToolResult(result, `$request.tool_results[${index}]`);
    if (!toolNames.has(result.name)) {
      fail(`$request.tool_results[${index}].name`, "must match a declared tool");
    }
    if (callIds.has(result.tool_call_id)) {
      fail(`$request.tool_results[${index}].tool_call_id`, "must be unique");
    }
    callIds.add(result.tool_call_id);
  });
  if (object.tool_results.length === 0 && object.continuation_of !== null) {
    fail("$request.continuation_of", "must be null when tool_results is empty");
  }
  if (object.tool_results.length > 0 && object.continuation_of === null) {
    fail("$request.continuation_of", "must identify the preceding request when tool_results is non-empty");
  }
  validateGeneration(object.generation, "$request.generation");
  validateCorrelationHints(object.correlation_hints, "$request.correlation_hints");
  if (Object.hasOwn(object, "metadata")) validateMetadata(object.metadata, "$request.metadata");
  return value as ChatRequest;
}

function validateEnvelope(object: UnknownRecord, path: string, allowed: readonly string[]) {
  requiredKeys(object, ["type", "protocol_version", "request_id", "trace_id", "sequence"], path);
  allowedKeys(
    object,
    ["type", "protocol_version", "request_id", "trace_id", "sequence", "metadata", ...allowed],
    path,
  );
  if (object.protocol_version !== AI_RUNTIME_PROTOCOL_VERSION) {
    fail(`${path}.protocol_version`, `must equal "${AI_RUNTIME_PROTOCOL_VERSION}"`);
  }
  stringValue(object.request_id, `${path}.request_id`);
  stringValue(object.trace_id, `${path}.trace_id`);
  if (!Number.isInteger(object.sequence) || (object.sequence as number) < 0) {
    fail(`${path}.sequence`, "must be a non-negative integer");
  }
  if (Object.hasOwn(object, "metadata")) validateMetadata(object.metadata, `${path}.metadata`);
}

function validateAttributionMember(value: unknown, path: string, nullable: boolean) {
  const object = record(value, path);
  requiredKeys(object, ["id", "source", "trust"], path);
  allowedKeys(object, ["id", "source", "trust"], path);
  if (nullable && object.id === null) {
    // Explicit null is the only absent authoritative identifier representation.
  } else {
    stringValue(object.id, `${path}.id`);
  }
  if (object.source !== "server_derived") fail(`${path}.source`, 'must equal "server_derived"');
  if (object.trust !== "authoritative") fail(`${path}.trust`, 'must equal "authoritative"');
}

function validateAttribution(value: unknown, path: string): asserts value is AuthoritativeAttribution {
  const object = record(value, path);
  const keys = [
    "organization",
    "project",
    "service_environment",
    "known_user",
    "session",
    "automation",
  ] as const;
  requiredKeys(object, keys, path);
  allowedKeys(object, keys, path);
  validateAttributionMember(object.organization, `${path}.organization`, false);
  validateAttributionMember(object.project, `${path}.project`, false);
  validateAttributionMember(object.service_environment, `${path}.service_environment`, false);
  validateAttributionMember(object.known_user, `${path}.known_user`, true);
  validateAttributionMember(object.session, `${path}.session`, true);
  validateAttributionMember(object.automation, `${path}.automation`, true);
}

function validateUsage(value: unknown, path: string): asserts value is Usage {
  const object = record(value, path);
  const keys = ["input_tokens", "output_tokens", "total_tokens"] as const;
  requiredKeys(object, keys, path);
  allowedKeys(object, keys, path);
  for (const key of keys) {
    if (!Number.isInteger(object[key]) || (object[key] as number) < 0) {
      fail(`${path}.${key}`, "must be a non-negative integer");
    }
  }
}

function validateCitationBatch(
  object: UnknownRecord,
  path: string,
): void {
  validateEnvelope(object, path, ["target", "sources", "citations"]);
  requiredKeys(object, ["target", "sources", "citations"], path);

  let records: CitationRecordSet;
  try {
    records = normalizeCitationRecords({
      sources: object.sources,
      citations: object.citations,
    });
  } catch (error) {
    fail(
      path,
      error instanceof Error
        ? error.message
        : "contains invalid citation records",
    );
  }
  if (records.citations.length === 0) {
    fail(`${path}.citations`, "must contain at least one citation link");
  }
  if (
    !jsonValuesEqual(records.sources, object.sources) ||
    !jsonValuesEqual(records.citations, object.citations)
  ) {
    fail(
      path,
      "citation records must already be normalized and identity-deduplicated",
    );
  }

  const target = record(object.target, `${path}.target`);
  requiredKeys(target, ["type", "message_id"], `${path}.target`);
  allowedKeys(target, ["type", "message_id"], `${path}.target`);
  if (target.type !== "assistant_message") {
    fail(`${path}.target.type`, 'must equal "assistant_message"');
  }

  let previousOrder: number | undefined;
  for (const [index, citation] of records.citations.entries()) {
    if (
      citation.target.type !== "assistant_message" ||
      citation.target.message_id !== target.message_id
    ) {
      fail(
        `${path}.citations[${index}].target`,
        "must match the assistant output target",
      );
    }
    if (
      previousOrder !== undefined &&
      citation.order !== previousOrder + 1
    ) {
      fail(
        `${path}.citations[${index}].order`,
        "must be contiguous and strictly increasing within the batch",
      );
    }
    previousOrder = citation.order;
  }
}

function validatePublicError(value: unknown, path: string): asserts value is PublicError {
  const object = record(value, path);
  const keys = ["category", "code", "message", "retryable"] as const;
  requiredKeys(object, keys, path);
  allowedKeys(object, keys, path);
  enumValue(object.category, AI_RUNTIME_ERROR_CATEGORIES, `${path}.category`);
  enumValue(object.code, AI_RUNTIME_ERROR_CODES, `${path}.code`);
  stringValue(object.message, `${path}.message`, {
    maxLength: AI_RUNTIME_PROTOCOL_LIMITS.errorMessageLength,
  });
  if (typeof object.retryable !== "boolean") fail(`${path}.retryable`, "must be a boolean");
}

export function parseStreamEvent(value: unknown): StreamEvent {
  const object = record(value, "$event");
  const type = enumValue(object.type, AI_RUNTIME_STREAM_EVENT_TYPES, "$event.type");

  switch (type) {
    case "response.started":
      validateEnvelope(object, "$event", ["attribution"]);
      if (object.sequence !== 0) fail("$event.sequence", "must be 0 for response.started");
      requiredKeys(object, ["attribution"], "$event");
      validateAttribution(object.attribution, "$event.attribution");
      break;
    case "response.text.delta":
      validateEnvelope(object, "$event", ["delta"]);
      requiredKeys(object, ["delta"], "$event");
      stringValue(object.delta, "$event.delta", {
        allowEmpty: true,
        maxLength: AI_RUNTIME_PROTOCOL_LIMITS.textLength,
      });
      break;
    case "response.tool_call":
      validateEnvelope(object, "$event", ["tool_call_id", "name", "arguments"]);
      requiredKeys(object, ["tool_call_id", "name", "arguments"], "$event");
      stringValue(object.tool_call_id, "$event.tool_call_id");
      stringValue(object.name, "$event.name");
      record(object.arguments, "$event.arguments");
      validateCredentialsAbsent(object.arguments, "$event.arguments");
      break;
    case "response.citation_batch":
      validateCitationBatch(object, "$event");
      break;
    case "response.usage":
      validateEnvelope(object, "$event", ["usage"]);
      requiredKeys(object, ["usage"], "$event");
      validateUsage(object.usage, "$event.usage");
      break;
    case "response.completed":
      validateEnvelope(object, "$event", ["outcome"]);
      requiredKeys(object, ["outcome"], "$event");
      enumValue(object.outcome, AI_RUNTIME_COMPLETION_OUTCOMES, "$event.outcome");
      break;
    case "response.cancelled":
      validateEnvelope(object, "$event", ["reason"]);
      requiredKeys(object, ["reason"], "$event");
      enumValue(object.reason, AI_RUNTIME_CANCELLATION_REASONS, "$event.reason");
      break;
    case "response.error":
      validateEnvelope(object, "$event", ["error"]);
      requiredKeys(object, ["error"], "$event");
      validatePublicError(object.error, "$event.error");
      break;
  }

  if (type !== "response.started" && object.sequence === 0) {
    fail("$event.sequence", "must be greater than 0 after response.started");
  }
  return value as StreamEvent;
}

export function parseStreamEvents(value: unknown): StreamEvent[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("$events", "must be a non-empty array");
  }
  const events = value.map((event) => parseStreamEvent(event));
  if (events[0]?.type !== "response.started") fail("$events[0].type", "must be response.started");

  const requestId = events[0].request_id;
  const traceId = events[0].trace_id;
  let terminalCount = 0;
  let lastUsage: Usage | undefined;
  let toolCallCount = 0;
  const toolCallIds = new Set<string>();
  let citationTargetId: string | undefined;
  let nextCitationOrder = 0;
  const citationIds = new Set<string>();
  const citationSources = new Map<string, string>();

  events.forEach((event, index) => {
    if (event.request_id !== requestId) fail(`$events[${index}].request_id`, "must match the stream request_id");
    if (event.trace_id !== traceId) fail(`$events[${index}].trace_id`, "must match the stream trace_id");
    if (event.sequence !== index) fail(`$events[${index}].sequence`, `must equal ${index}`);
    if (index > 0 && event.type === "response.started") {
      fail(`$events[${index}].type`, "response.started may appear only once");
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.cancelled" ||
      event.type === "response.error"
    ) {
      terminalCount += 1;
      if (index !== events.length - 1) fail(`$events[${index}]`, "terminal event must be last");
    }
    if (event.type === "response.usage") {
      if (
        lastUsage &&
        (event.usage.input_tokens < lastUsage.input_tokens ||
          event.usage.output_tokens < lastUsage.output_tokens ||
          event.usage.total_tokens < lastUsage.total_tokens)
      ) {
        fail(`$events[${index}].usage`, "cumulative usage must not decrease");
      }
      lastUsage = event.usage;
    }
    if (event.type === "response.tool_call") {
      toolCallCount += 1;
      if (toolCallIds.has(event.tool_call_id)) {
        fail(`$events[${index}].tool_call_id`, "must be unique within the stream");
      }
      toolCallIds.add(event.tool_call_id);
    }
    if (event.type === "response.citation_batch") {
      if (
        citationTargetId !== undefined &&
        event.target.message_id !== citationTargetId
      ) {
        fail(
          `$events[${index}].target.message_id`,
          "must match the stream assistant output target",
        );
      }
      citationTargetId ??= event.target.message_id;
      for (const [sourceIndex, source] of event.sources.entries()) {
        const fingerprint = JSON.stringify(source);
        const previous = citationSources.get(source.source_id);
        if (previous !== undefined && previous !== fingerprint) {
          fail(
            `$events[${index}].sources[${sourceIndex}].source_id`,
            "conflicts with an earlier source identity",
          );
        }
        citationSources.set(source.source_id, fingerprint);
      }
      for (const [citationIndex, citation] of event.citations.entries()) {
        if (citation.order !== nextCitationOrder) {
          fail(
            `$events[${index}].citations[${citationIndex}].order`,
            `must equal ${nextCitationOrder}`,
          );
        }
        if (citationIds.has(citation.citation_id)) {
          fail(
            `$events[${index}].citations[${citationIndex}].citation_id`,
            "must be unique within the stream",
          );
        }
        citationIds.add(citation.citation_id);
        nextCitationOrder += 1;
      }
    }
  });

  if (terminalCount !== 1) fail("$events", "must contain exactly one terminal event");
  const terminal = events.at(-1);
  if (
    terminal?.type === "response.completed" &&
    terminal.outcome === "tool_calls" &&
    toolCallCount === 0
  ) {
    fail(`$events[${events.length - 1}].outcome`, "tool_calls requires at least one tool call event");
  }
  return value as StreamEvent[];
}

export function validateChatRequest(value: unknown): asserts value is ChatRequest {
  parseChatRequest(value);
}

export function validateStreamEvent(value: unknown): asserts value is StreamEvent {
  parseStreamEvent(value);
}

export function validateStreamEvents(value: unknown): asserts value is StreamEvent[] {
  parseStreamEvents(value);
}

export function isChatRequest(value: unknown): value is ChatRequest {
  try {
    parseChatRequest(value);
    return true;
  } catch {
    return false;
  }
}

export function isStreamEvent(value: unknown): value is StreamEvent {
  try {
    parseStreamEvent(value);
    return true;
  } catch {
    return false;
  }
}
