import type { ConversationId, ConversationTimestamp } from "./events.js";

export const CONVERSATION_CATALOG_LIMITS = Object.freeze({
  identifierLength: 256,
  titleLength: 256,
  cursorLength: 1_024,
  idempotencyKeyLength: 128,
  pageSizeDefault: 50,
  pageSizeMaximum: 100,
  metadataDepth: 4,
  metadataNodes: 64,
  metadataArrayLength: 16,
  metadataObjectKeys: 16,
  metadataKeyLength: 64,
  metadataStringLength: 256,
  metadataSerializedBytes: 4_096,
} as const);

export const CONVERSATION_CATALOG_ORDER_FIELDS = [
  "updated_at",
  "created_at",
] as const;
export const CONVERSATION_CATALOG_ORDER_DIRECTIONS = ["asc", "desc"] as const;
export const CONVERSATION_CATALOG_LIFECYCLE_STATES = [
  "active",
  "archived",
] as const;
export const CONVERSATION_CATALOG_UNSUPPORTED_REASONS = [
  "not_implemented",
  "policy_disabled",
  "storage_limitation",
] as const;

declare const opaqueConversationCatalogValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaqueConversationCatalogValue]: Name;
};

/** Store-issued keyset position. Callers must not construct or inspect it. */
export type ConversationCatalogCursor = OpaqueString<"ConversationCatalogCursor">;
export type ConversationCatalogIdempotencyKey =
  OpaqueString<"ConversationCatalogIdempotencyKey">;
export type ConversationCatalogVersion = number & {
  readonly [opaqueConversationCatalogValue]: "ConversationCatalogVersion";
};

export type ConversationCatalogOrderField =
  (typeof CONVERSATION_CATALOG_ORDER_FIELDS)[number];
export type ConversationCatalogOrderDirection =
  (typeof CONVERSATION_CATALOG_ORDER_DIRECTIONS)[number];
export type ConversationCatalogLifecycleState =
  (typeof CONVERSATION_CATALOG_LIFECYCLE_STATES)[number];
export type ConversationCatalogUnsupportedReason =
  (typeof CONVERSATION_CATALOG_UNSUPPORTED_REASONS)[number];

export type ConversationCatalogMetadataPrimitive =
  | string
  | number
  | boolean
  | null;
export type ConversationCatalogMetadataValue =
  | ConversationCatalogMetadataPrimitive
  | readonly ConversationCatalogMetadataValue[]
  | ConversationCatalogMetadata;
export interface ConversationCatalogMetadata {
  readonly [key: string]: ConversationCatalogMetadataValue;
}

interface ConversationCatalogDescriptorBase {
  readonly conversationId: ConversationId;
  /** A short selection label, never a prompt or transcript field. */
  readonly title: string | null;
  readonly createdAt: ConversationTimestamp;
  readonly updatedAt: ConversationTimestamp;
  readonly version: ConversationCatalogVersion;
  /**
   * Bounded durable selection metadata only. It must not contain messages,
   * prompt/transcript text, tool data, attachments or content references,
   * credentials, authorization details, or provider-native data.
   */
  readonly metadata: ConversationCatalogMetadata;
}

export interface ActiveConversationCatalogDescriptor
  extends ConversationCatalogDescriptorBase {
  readonly lifecycle: "active";
  readonly archivedAt: null;
}

export interface ArchivedConversationCatalogDescriptor
  extends ConversationCatalogDescriptorBase {
  readonly lifecycle: "archived";
  readonly archivedAt: ConversationTimestamp;
}

/** A bounded durable list/load row; it never contains conversation contents. */
export type ConversationCatalogDescriptor =
  | ActiveConversationCatalogDescriptor
  | ArchivedConversationCatalogDescriptor;

export interface ConversationCatalogOrder {
  readonly field: ConversationCatalogOrderField;
  readonly direction: ConversationCatalogOrderDirection;
}

export const DEFAULT_CONVERSATION_CATALOG_ORDER: Readonly<ConversationCatalogOrder> =
  Object.freeze({ field: "updated_at", direction: "desc" });

export type ConversationCatalogLifecycleFilter =
  | ConversationCatalogLifecycleState
  | "all";

export type ConversationCatalogAuthorizationAction =
  | "list"
  | "create"
  | "get"
  | "rename"
  | "clear"
  | "archive"
  | "restore"
  | "permanent_delete";

export type ConversationCatalogAuthorizationRequest<TAuthorizationContext> =
  | {
      readonly action: "list";
      readonly authorizationContext: TAuthorizationContext;
    }
  | {
      readonly action: "create";
      readonly authorizationContext: TAuthorizationContext;
      readonly conversationId?: ConversationId;
    }
  | {
      readonly action: Exclude<
        ConversationCatalogAuthorizationAction,
        "list" | "create"
      >;
      readonly authorizationContext: TAuthorizationContext;
      readonly conversationId: ConversationId;
    };

/** Host-owned policy boundary. Requests never include a stored descriptor. */
export type ConversationCatalogAuthorizer<TAuthorizationContext> = (
  request: ConversationCatalogAuthorizationRequest<TAuthorizationContext>,
) => "allow" | "deny" | Promise<"allow" | "deny">;

export interface SupportedConversationCatalogCapability {
  readonly supported: true;
}

export interface UnsupportedConversationCatalogCapability {
  readonly supported: false;
  readonly reason: ConversationCatalogUnsupportedReason;
}

export type ConversationCatalogCapability =
  | SupportedConversationCatalogCapability
  | UnsupportedConversationCatalogCapability;

export interface ConversationCatalogCapabilities {
  readonly rename: ConversationCatalogCapability;
  readonly clear: ConversationCatalogCapability;
  readonly archive: ConversationCatalogCapability;
  readonly restore: ConversationCatalogCapability;
  readonly permanentDelete: ConversationCatalogCapability;
}

export interface ListConversationsInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly lifecycle: ConversationCatalogLifecycleFilter;
  readonly pageSize: number;
  readonly order: ConversationCatalogOrder;
  readonly cursor?: ConversationCatalogCursor;
}

export interface ListConversationsResult {
  readonly items: readonly ConversationCatalogDescriptor[];
  readonly nextCursor: ConversationCatalogCursor | null;
  readonly hasMore: boolean;
  readonly order: ConversationCatalogOrder;
}

export interface CreateConversationInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId?: ConversationId;
  readonly title?: string;
  readonly metadata?: ConversationCatalogMetadata;
  readonly idempotencyKey: ConversationCatalogIdempotencyKey;
}

export interface GetConversationInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
}

export interface ConversationCatalogMutationInput<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly conversationId: ConversationId;
  readonly expectedVersion: ConversationCatalogVersion;
  readonly idempotencyKey: ConversationCatalogIdempotencyKey;
}

export interface RenameConversationInput<TAuthorizationContext>
  extends ConversationCatalogMutationInput<TAuthorizationContext> {
  readonly title: string;
}

export type ClearConversationInput<TAuthorizationContext> =
  ConversationCatalogMutationInput<TAuthorizationContext>;
export type ArchiveConversationInput<TAuthorizationContext> =
  ConversationCatalogMutationInput<TAuthorizationContext>;
export type RestoreConversationInput<TAuthorizationContext> =
  ConversationCatalogMutationInput<TAuthorizationContext>;
export type PermanentlyDeleteConversationInput<TAuthorizationContext> =
  ConversationCatalogMutationInput<TAuthorizationContext>;

export interface CreateConversationResult {
  readonly operation: "create";
  readonly status: "created" | "idempotent";
  readonly descriptor: ActiveConversationCatalogDescriptor;
}

export interface GetConversationResult {
  readonly operation: "get";
  readonly status: "found";
  readonly descriptor: ConversationCatalogDescriptor;
}

export interface RenameConversationResult {
  readonly operation: "rename";
  readonly status: "updated" | "idempotent";
  readonly descriptor: ConversationCatalogDescriptor;
}

export interface ClearConversationResult {
  readonly operation: "clear";
  readonly status: "cleared" | "idempotent";
  /**
   * Clearing removes conversation contents through the host's separate
   * per-conversation persistence boundary. It retains catalog identity and
   * advances this descriptor version; it is not archive or deletion.
   */
  readonly descriptor: ActiveConversationCatalogDescriptor;
}

export interface ArchiveConversationResult {
  readonly operation: "archive";
  readonly status: "archived" | "idempotent";
  /** Archive is reversible and preserves the conversation for restoration. */
  readonly descriptor: ArchivedConversationCatalogDescriptor;
}

export interface RestoreConversationResult {
  readonly operation: "restore";
  readonly status: "restored" | "idempotent";
  readonly descriptor: ActiveConversationCatalogDescriptor;
}

export interface PermanentlyDeleteConversationResult {
  readonly operation: "permanent_delete";
  readonly status: "deleted" | "idempotent";
  /** Permanent deletion is irreversible; this identity cannot be restored. */
  readonly conversationId: ConversationId;
  /** The removed descriptor's version, exactly the accepted expectedVersion.
   * Deletion does not create a new catalog descriptor/version. */
  readonly deletedVersion: ConversationCatalogVersion;
}

/** Local cleanup can fail after the remote deletion has already succeeded.
 * Retrying this error clears device state only; it never reissues the deletion. */
export class ConversationLocalErasureError extends Error {
  constructor(readonly result: PermanentlyDeleteConversationResult, readonly retry: () => Promise<void>) {
    super("The conversation was deleted, but its data could not be cleared from this device. Retry device cleanup.");
    this.name = "ConversationLocalErasureError";
  }
}

/**
 * Provider-, storage-, authentication-, and runtime-neutral lifecycle boundary.
 *
 * Implementations must validate input and invoke their host authorizer before
 * any lookup, existence check, or disclosure. Mutation checks and writes are
 * atomic at `expectedVersion`. A retained idempotency key replays only the same
 * logical operation and otherwise fails with `idempotency_conflict`.
 */
export interface ConversationCatalog<TAuthorizationContext = unknown> {
  readonly capabilities: ConversationCatalogCapabilities;
  list(
    input: ListConversationsInput<TAuthorizationContext>,
  ): Promise<ListConversationsResult>;
  create(
    input: CreateConversationInput<TAuthorizationContext>,
  ): Promise<CreateConversationResult>;
  get(
    input: GetConversationInput<TAuthorizationContext>,
  ): Promise<GetConversationResult>;
  rename(
    input: RenameConversationInput<TAuthorizationContext>,
  ): Promise<RenameConversationResult>;
  clear(
    input: ClearConversationInput<TAuthorizationContext>,
  ): Promise<ClearConversationResult>;
  archive(
    input: ArchiveConversationInput<TAuthorizationContext>,
  ): Promise<ArchiveConversationResult>;
  restore(
    input: RestoreConversationInput<TAuthorizationContext>,
  ): Promise<RestoreConversationResult>;
  permanentlyDelete(
    input: PermanentlyDeleteConversationInput<TAuthorizationContext>,
  ): Promise<PermanentlyDeleteConversationResult>;
}

export type ConversationCatalogErrorCode =
  | "invalid_input"
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "forbidden"
  | "unsupported"
  | "unavailable";

const ERROR_MESSAGES: Readonly<Record<ConversationCatalogErrorCode, string>> =
  Object.freeze({
    invalid_input: "The conversation catalog request is invalid.",
    not_found: "The requested conversation was not found.",
    version_conflict: "The conversation version conflicts with current state.",
    idempotency_conflict: "The idempotency key conflicts with another request.",
    forbidden: "The conversation catalog operation is not permitted.",
    unsupported: "The conversation catalog operation is not supported.",
    unavailable: "The conversation catalog is unavailable.",
  });

/** Normalized safe error with no stored state, host context, cause, or native details. */
export class ConversationCatalogError extends Error {
  readonly code: ConversationCatalogErrorCode;
  readonly operation: ConversationCatalogAuthorizationAction;
  readonly retryable: boolean;

  constructor(
    code: ConversationCatalogErrorCode,
    operation: ConversationCatalogAuthorizationAction,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "ConversationCatalogError";
    this.code = code;
    this.operation = operation;
    this.retryable = code === "unavailable";
  }
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const CURSOR_PREFIX = "handrail.catalog.v1";
const UTF8_ENCODER = new TextEncoder();
const FORBIDDEN_METADATA_FIELDS = new Set([
  "accesstoken",
  "apikey",
  "attachment",
  "attachments",
  "auth",
  "authorization",
  "authorizationcontext",
  "base64",
  "binary",
  "blob",
  "buffer",
  "bytes",
  "content",
  "contentref",
  "contentreference",
  "cookie",
  "credential",
  "credentials",
  "data",
  "file",
  "fileid",
  "filename",
  "headers",
  "href",
  "message",
  "messages",
  "modelid",
  "objectkey",
  "password",
  "payload",
  "permissioncontext",
  "prompt",
  "provider",
  "providerconfig",
  "providerid",
  "providernative",
  "proto",
  "prototype",
  "constructor",
  "ref",
  "reference",
  "refreshtoken",
  "secret",
  "storagekey",
  "token",
  "toolinput",
  "toolinputs",
  "toolresult",
  "toolresults",
  "transcript",
  "uri",
  "url",
]);
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/iu,
  /-----begin (?:rsa |ec |openssh )?private key-----/iu,
] as const;
const CONTENT_REFERENCE_PATTERNS = [
  /^(?:data|blob):/iu,
  /^(?:attachment|content|file|object|storage)[_-]?(?:ref|reference|id):/iu,
] as const;

function invalid(
  operation: ConversationCatalogAuthorizationAction,
): never {
  throw new ConversationCatalogError("invalid_input", operation);
}

function record(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction,
): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(operation);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  required: readonly string[],
  operation: ConversationCatalogAuthorizationAction,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) invalid(operation);
  if (required.some((key) => !Object.hasOwn(value, key))) invalid(operation);
}

function parseIdentifier(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction,
): ConversationId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONVERSATION_CATALOG_LIMITS.identifierLength ||
    !IDENTIFIER.test(value)
  ) {
    invalid(operation);
  }
  return value as ConversationId;
}

function parseTimestamp(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction,
): ConversationTimestamp {
  if (typeof value !== "string" || value.length > 32) invalid(operation);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    invalid(operation);
  }
  return value as ConversationTimestamp;
}

export function parseConversationCatalogVersion(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction = "get",
): ConversationCatalogVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(operation);
  return value as ConversationCatalogVersion;
}

export function parseConversationCatalogTitle(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction = "rename",
): string {
  if (typeof value !== "string") invalid(operation);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > CONVERSATION_CATALOG_LIMITS.titleLength ||
    containsDisallowedControl(normalized, false)
  ) {
    invalid(operation);
  }
  return normalized;
}

export function parseConversationCatalogIdempotencyKey(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction = "create",
): ConversationCatalogIdempotencyKey {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONVERSATION_CATALOG_LIMITS.idempotencyKeyLength ||
    !IDEMPOTENCY_KEY.test(value)
  ) {
    invalid(operation);
  }
  return value as ConversationCatalogIdempotencyKey;
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function containsDisallowedControl(
  value: string,
  allowTextWhitespace: boolean,
): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code === 127 ||
      (code < 32 && (!allowTextWhitespace || (code !== 9 && code !== 10 && code !== 13)))
    ) {
      return true;
    }
  }
  return false;
}

function safeMetadataString(
  value: string,
  operation: ConversationCatalogAuthorizationAction,
): string {
  if (
    value.length > CONVERSATION_CATALOG_LIMITS.metadataStringLength ||
    containsDisallowedControl(value, true) ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    CONTENT_REFERENCE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    invalid(operation);
  }
  return value;
}

export function parseConversationCatalogMetadata(
  value: unknown,
  operation: ConversationCatalogAuthorizationAction = "create",
): ConversationCatalogMetadata {
  let nodes = 0;

  function visit(current: unknown, depth: number): ConversationCatalogMetadataValue {
    nodes += 1;
    if (
      nodes > CONVERSATION_CATALOG_LIMITS.metadataNodes ||
      depth > CONVERSATION_CATALOG_LIMITS.metadataDepth
    ) {
      invalid(operation);
    }
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") return safeMetadataString(current, operation);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid(operation);
      return current;
    }
    if (Array.isArray(current)) {
      if (current.length > CONVERSATION_CATALOG_LIMITS.metadataArrayLength) {
        invalid(operation);
      }
      return Object.freeze(current.map((item) => visit(item, depth + 1)));
    }
    const source = record(current, operation);
    const entries = Object.entries(source);
    if (entries.length > CONVERSATION_CATALOG_LIMITS.metadataObjectKeys) {
      invalid(operation);
    }
    const parsed: Record<string, ConversationCatalogMetadataValue> = {};
    for (const [key, item] of entries) {
      if (
        key.length === 0 ||
        key.length > CONVERSATION_CATALOG_LIMITS.metadataKeyLength ||
        FORBIDDEN_METADATA_FIELDS.has(normalizedFieldName(key)) ||
        Object.hasOwn(parsed, key)
      ) {
        invalid(operation);
      }
      parsed[key] = visit(item, depth + 1);
    }
    return Object.freeze(parsed);
  }

  const parsed = visit(value, 0);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    invalid(operation);
  }
  if (
    UTF8_ENCODER.encode(JSON.stringify(parsed)).byteLength >
    CONVERSATION_CATALOG_LIMITS.metadataSerializedBytes
  ) {
    invalid(operation);
  }
  return parsed as ConversationCatalogMetadata;
}

export function parseConversationCatalogDescriptor(
  value: unknown,
): ConversationCatalogDescriptor {
  const operation = "get" as const;
  const source = record(value, operation);
  exactKeys(
    source,
    [
      "conversationId",
      "title",
      "createdAt",
      "updatedAt",
      "version",
      "lifecycle",
      "archivedAt",
      "metadata",
    ],
    [
      "conversationId",
      "title",
      "createdAt",
      "updatedAt",
      "version",
      "lifecycle",
      "archivedAt",
      "metadata",
    ],
    operation,
  );
  const conversationId = parseIdentifier(source.conversationId, operation);
  const title = source.title === null
    ? null
    : parseConversationCatalogTitle(source.title, operation);
  const createdAt = parseTimestamp(source.createdAt, operation);
  const updatedAt = parseTimestamp(source.updatedAt, operation);
  if (updatedAt < createdAt) invalid(operation);
  const version = parseConversationCatalogVersion(source.version, operation);
  const metadata = parseConversationCatalogMetadata(source.metadata, operation);

  if (source.lifecycle === "active" && source.archivedAt === null) {
    return Object.freeze({
      conversationId,
      title,
      createdAt,
      updatedAt,
      version,
      lifecycle: "active",
      archivedAt: null,
      metadata,
    });
  }
  if (source.lifecycle === "archived") {
    const archivedAt = parseTimestamp(source.archivedAt, operation);
    if (archivedAt < createdAt || updatedAt < archivedAt) invalid(operation);
    return Object.freeze({
      conversationId,
      title,
      createdAt,
      updatedAt,
      version,
      lifecycle: "archived",
      archivedAt,
      metadata,
    });
  }
  return invalid(operation);
}

export function parseConversationCatalogOrder(
  value: unknown = DEFAULT_CONVERSATION_CATALOG_ORDER,
): ConversationCatalogOrder {
  const operation = "list" as const;
  const source = record(value, operation);
  exactKeys(source, ["field", "direction"], ["field", "direction"], operation);
  if (
    !CONVERSATION_CATALOG_ORDER_FIELDS.includes(
      source.field as ConversationCatalogOrderField,
    ) ||
    !CONVERSATION_CATALOG_ORDER_DIRECTIONS.includes(
      source.direction as ConversationCatalogOrderDirection,
    )
  ) {
    invalid(operation);
  }
  return Object.freeze({
    field: source.field as ConversationCatalogOrderField,
    direction: source.direction as ConversationCatalogOrderDirection,
  });
}

export function parseConversationCatalogPageSize(value: unknown = undefined): number {
  const resolved = value === undefined
    ? CONVERSATION_CATALOG_LIMITS.pageSizeDefault
    : value;
  if (
    !Number.isSafeInteger(resolved) ||
    (resolved as number) < 1 ||
    (resolved as number) > CONVERSATION_CATALOG_LIMITS.pageSizeMaximum
  ) {
    invalid("list");
  }
  return resolved as number;
}

interface DecodedCursor {
  readonly order: ConversationCatalogOrder;
  readonly primary: ConversationTimestamp;
  readonly conversationId: ConversationId;
}

function encodeCursorPart(value: string): string {
  return encodeURIComponent(value);
}

function decodeCursorPart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function decodeCursor(
  value: unknown,
  expectedOrder?: ConversationCatalogOrder,
): DecodedCursor {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONVERSATION_CATALOG_LIMITS.cursorLength
  ) {
    invalid("list");
  }
  const parts = value.split("|");
  if (parts.length !== 5 || parts[0] !== CURSOR_PREFIX) invalid("list");
  const order = parseConversationCatalogOrder({
    field: parts[1],
    direction: parts[2],
  });
  if (
    expectedOrder !== undefined &&
    (order.field !== expectedOrder.field ||
      order.direction !== expectedOrder.direction)
  ) {
    invalid("list");
  }
  const primaryValue = decodeCursorPart(parts[3] ?? "");
  const conversationIdValue = decodeCursorPart(parts[4] ?? "");
  if (primaryValue === null || conversationIdValue === null) invalid("list");
  return {
    order,
    primary: parseTimestamp(primaryValue, "list"),
    conversationId: parseIdentifier(conversationIdValue, "list"),
  };
}

export function parseConversationCatalogCursor(
  value: unknown,
  expectedOrder?: ConversationCatalogOrder,
): ConversationCatalogCursor {
  decodeCursor(value, expectedOrder);
  return value as ConversationCatalogCursor;
}

export function createConversationCatalogCursor(
  descriptor: ConversationCatalogDescriptor,
  order: ConversationCatalogOrder = DEFAULT_CONVERSATION_CATALOG_ORDER,
): ConversationCatalogCursor {
  const parsedDescriptor = parseConversationCatalogDescriptor(descriptor);
  const parsedOrder = parseConversationCatalogOrder(order);
  const primary = parsedOrder.field === "updated_at"
    ? parsedDescriptor.updatedAt
    : parsedDescriptor.createdAt;
  return [
    CURSOR_PREFIX,
    parsedOrder.field,
    parsedOrder.direction,
    encodeCursorPart(primary),
    encodeCursorPart(parsedDescriptor.conversationId),
  ].join("|") as ConversationCatalogCursor;
}

function compareKey(
  leftPrimary: string,
  leftId: string,
  rightPrimary: string,
  rightId: string,
  direction: ConversationCatalogOrderDirection,
): number {
  if (leftPrimary !== rightPrimary) {
    const comparison = leftPrimary < rightPrimary ? -1 : 1;
    return direction === "asc" ? comparison : -comparison;
  }
  // Conversation ID is an ascending stable tie-breaker in both directions.
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}

export function compareConversationCatalogDescriptors(
  left: ConversationCatalogDescriptor,
  right: ConversationCatalogDescriptor,
  order: ConversationCatalogOrder = DEFAULT_CONVERSATION_CATALOG_ORDER,
): number {
  const parsedOrder = parseConversationCatalogOrder(order);
  const leftDescriptor = parseConversationCatalogDescriptor(left);
  const rightDescriptor = parseConversationCatalogDescriptor(right);
  const leftPrimary = parsedOrder.field === "updated_at"
    ? leftDescriptor.updatedAt
    : leftDescriptor.createdAt;
  const rightPrimary = parsedOrder.field === "updated_at"
    ? rightDescriptor.updatedAt
    : rightDescriptor.createdAt;
  return compareKey(
    leftPrimary,
    leftDescriptor.conversationId,
    rightPrimary,
    rightDescriptor.conversationId,
    parsedOrder.direction,
  );
}

export interface ConversationCatalogPaginationInput {
  readonly pageSize?: unknown;
  readonly order?: unknown;
  readonly cursor?: unknown;
}

/** Pure keyset pagination helper for adapters; it retains no catalog state. */
export function paginateConversationCatalogDescriptors(
  descriptors: readonly ConversationCatalogDescriptor[],
  input: ConversationCatalogPaginationInput = {},
): ListConversationsResult {
  const pageSize = parseConversationCatalogPageSize(input.pageSize);
  const order = parseConversationCatalogOrder(input.order);
  const cursor = input.cursor === undefined
    ? null
    : decodeCursor(input.cursor, order);
  const sorted = descriptors
    .map((descriptor) => parseConversationCatalogDescriptor(descriptor))
    .sort((left, right) =>
      compareConversationCatalogDescriptors(left, right, order));
  const afterCursor = cursor === null
    ? sorted
    : sorted.filter((descriptor) => {
        const primary = order.field === "updated_at"
          ? descriptor.updatedAt
          : descriptor.createdAt;
        return compareKey(
          primary,
          descriptor.conversationId,
          cursor.primary,
          cursor.conversationId,
          order.direction,
        ) > 0;
      });
  const hasMore = afterCursor.length > pageSize;
  const items = Object.freeze(afterCursor.slice(0, pageSize));
  const finalItem = items.at(-1);
  return Object.freeze({
    items,
    nextCursor: hasMore && finalItem !== undefined
      ? createConversationCatalogCursor(finalItem, order)
      : null,
    hasMore,
    order,
  });
}

export function parseConversationCatalogCapabilities(
  value: unknown,
): ConversationCatalogCapabilities {
  const source = record(value, "get");
  const keys = ["rename", "clear", "archive", "restore", "permanentDelete"];
  exactKeys(source, keys, keys, "get");
  const capability = (candidate: unknown): ConversationCatalogCapability => {
    const item = record(candidate, "get");
    if (item.supported === true) {
      exactKeys(item, ["supported"], ["supported"], "get");
      return Object.freeze({ supported: true });
    }
    exactKeys(item, ["supported", "reason"], ["supported", "reason"], "get");
    if (
      item.supported !== false ||
      !CONVERSATION_CATALOG_UNSUPPORTED_REASONS.includes(
        item.reason as ConversationCatalogUnsupportedReason,
      )
    ) {
      invalid("get");
    }
    return Object.freeze({
      supported: false,
      reason: item.reason as ConversationCatalogUnsupportedReason,
    });
  };
  return Object.freeze({
    rename: capability(source.rename),
    clear: capability(source.clear),
    archive: capability(source.archive),
    restore: capability(source.restore),
    permanentDelete: capability(source.permanentDelete),
  });
}

function parseLifecycle(value: unknown): ConversationCatalogLifecycleFilter {
  if (value !== "active" && value !== "archived" && value !== "all") {
    invalid("list");
  }
  return value;
}

export function parseListConversationsInput<TAuthorizationContext>(
  value: unknown,
): ListConversationsInput<TAuthorizationContext> {
  const source = record(value, "list");
  exactKeys(
    source,
    ["authorizationContext", "lifecycle", "pageSize", "order", "cursor"],
    ["authorizationContext"],
    "list",
  );
  const order = parseConversationCatalogOrder(source.order);
  const cursor = source.cursor === undefined
    ? undefined
    : parseConversationCatalogCursor(source.cursor, order);
  return Object.freeze({
    authorizationContext: source.authorizationContext as TAuthorizationContext,
    lifecycle: parseLifecycle(source.lifecycle ?? "active"),
    pageSize: parseConversationCatalogPageSize(source.pageSize),
    order,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

export function parseCreateConversationInput<TAuthorizationContext>(
  value: unknown,
): CreateConversationInput<TAuthorizationContext> {
  const source = record(value, "create");
  exactKeys(
    source,
    ["authorizationContext", "conversationId", "title", "metadata", "idempotencyKey"],
    ["authorizationContext", "idempotencyKey"],
    "create",
  );
  return Object.freeze({
    authorizationContext: source.authorizationContext as TAuthorizationContext,
    ...(source.conversationId === undefined
      ? {}
      : { conversationId: parseIdentifier(source.conversationId, "create") }),
    ...(source.title === undefined
      ? {}
      : { title: parseConversationCatalogTitle(source.title, "create") }),
    ...(source.metadata === undefined
      ? {}
      : { metadata: parseConversationCatalogMetadata(source.metadata, "create") }),
    idempotencyKey: parseConversationCatalogIdempotencyKey(
      source.idempotencyKey,
      "create",
    ),
  });
}

export function parseGetConversationInput<TAuthorizationContext>(
  value: unknown,
): GetConversationInput<TAuthorizationContext> {
  const source = record(value, "get");
  exactKeys(
    source,
    ["authorizationContext", "conversationId"],
    ["authorizationContext", "conversationId"],
    "get",
  );
  return Object.freeze({
    authorizationContext: source.authorizationContext as TAuthorizationContext,
    conversationId: parseIdentifier(source.conversationId, "get"),
  });
}

function parseMutationInput<TAuthorizationContext>(
  value: unknown,
  operation: Exclude<ConversationCatalogAuthorizationAction, "list" | "create" | "get">,
  extraKeys: readonly string[] = [],
): ConversationCatalogMutationInput<TAuthorizationContext> & UnknownRecord {
  const source = record(value, operation);
  exactKeys(
    source,
    [
      "authorizationContext",
      "conversationId",
      "expectedVersion",
      "idempotencyKey",
      ...extraKeys,
    ],
    [
      "authorizationContext",
      "conversationId",
      "expectedVersion",
      "idempotencyKey",
      ...extraKeys,
    ],
    operation,
  );
  return {
    ...source,
    authorizationContext: source.authorizationContext as TAuthorizationContext,
    conversationId: parseIdentifier(source.conversationId, operation),
    expectedVersion: parseConversationCatalogVersion(source.expectedVersion, operation),
    idempotencyKey: parseConversationCatalogIdempotencyKey(
      source.idempotencyKey,
      operation,
    ),
  };
}

export function parseRenameConversationInput<TAuthorizationContext>(
  value: unknown,
): RenameConversationInput<TAuthorizationContext> {
  const parsed = parseMutationInput<TAuthorizationContext>(value, "rename", ["title"]);
  return Object.freeze({
    authorizationContext: parsed.authorizationContext,
    conversationId: parsed.conversationId,
    expectedVersion: parsed.expectedVersion,
    idempotencyKey: parsed.idempotencyKey,
    title: parseConversationCatalogTitle(parsed.title, "rename"),
  });
}

function parsePlainMutationInput<TAuthorizationContext>(
  value: unknown,
  operation: "clear" | "archive" | "restore" | "permanent_delete",
): ConversationCatalogMutationInput<TAuthorizationContext> {
  const parsed = parseMutationInput<TAuthorizationContext>(value, operation);
  return Object.freeze({
    authorizationContext: parsed.authorizationContext,
    conversationId: parsed.conversationId,
    expectedVersion: parsed.expectedVersion,
    idempotencyKey: parsed.idempotencyKey,
  });
}

export function parseClearConversationInput<TAuthorizationContext>(
  value: unknown,
): ClearConversationInput<TAuthorizationContext> {
  return parsePlainMutationInput(value, "clear");
}

export function parseArchiveConversationInput<TAuthorizationContext>(
  value: unknown,
): ArchiveConversationInput<TAuthorizationContext> {
  return parsePlainMutationInput(value, "archive");
}

export function parseRestoreConversationInput<TAuthorizationContext>(
  value: unknown,
): RestoreConversationInput<TAuthorizationContext> {
  return parsePlainMutationInput(value, "restore");
}

export function parsePermanentlyDeleteConversationInput<TAuthorizationContext>(
  value: unknown,
): PermanentlyDeleteConversationInput<TAuthorizationContext> {
  return parsePlainMutationInput(value, "permanent_delete");
}

/**
 * Invokes host policy on the exact non-record request shape. Host exceptions
 * are deliberately collapsed to `forbidden` and are never attached as causes.
 */
export async function authorizeConversationCatalogRequest<TAuthorizationContext>(
  authorize: ConversationCatalogAuthorizer<TAuthorizationContext>,
  request: ConversationCatalogAuthorizationRequest<TAuthorizationContext>,
): Promise<void> {
  if (typeof authorize !== "function") invalid(request.action);
  const safeRequest = request.action === "list"
    ? Object.freeze({
        action: request.action,
        authorizationContext: request.authorizationContext,
      })
    : request.action === "create"
      ? Object.freeze({
          action: request.action,
          authorizationContext: request.authorizationContext,
          ...(request.conversationId === undefined
            ? {}
            : { conversationId: parseIdentifier(request.conversationId, request.action) }),
        })
      : Object.freeze({
          action: request.action,
          authorizationContext: request.authorizationContext,
          conversationId: parseIdentifier(request.conversationId, request.action),
        });
  try {
    if (await authorize(safeRequest) !== "allow") {
      throw new ConversationCatalogError("forbidden", request.action);
    }
  } catch (error) {
    if (error instanceof ConversationCatalogError && error.code === "forbidden") {
      throw error;
    }
    throw new ConversationCatalogError("forbidden", request.action);
  }
}

/** Collapses host/storage exceptions without retaining or exposing their cause. */
export function normalizeConversationCatalogError(
  error: unknown,
  operation: ConversationCatalogAuthorizationAction,
): ConversationCatalogError {
  return error instanceof ConversationCatalogError
    ? error
    : new ConversationCatalogError("unavailable", operation);
}
