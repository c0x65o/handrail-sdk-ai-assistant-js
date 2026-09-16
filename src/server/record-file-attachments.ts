import { createHash } from "node:crypto";
import { awaitWithSignal } from "../await-signal.js";
import type { JsonObject } from "../protocol.js";
import { ToolFailureError } from "../tools/recovery.js";
import { PostgresAiPersistence, PostgresPersistenceConflictError } from "../postgres/index.js";
import { AttachmentStagingError } from "../attachments/staging.js";
import { SavedConversationFileUnavailableError, SavedConversationPreparationError } from "./saved-conversation-request.js";
import { ConversationCatalogError } from "../conversation/catalog.js";
import type { SavedFileHandles } from "./saved-file-handles.js";
import type { ApplicationToolAdmission, ApplicationToolExecutionLocation } from "../tools/executor.js";

export type RecordFileAttachmentFailure = "invalid_request" | "operation_conflict" | "operation_not_found" |
  "source_changed" | "source_unavailable" | "source_expired" | "unsupported_file" | "forbidden" |
  "destination_mismatch" | "destination_missing" | "unavailable" | "outcome_unknown";
const failures = {
  invalid_request: ["invalid_input", "The file attachment request is invalid."],
  operation_conflict: ["invalid_input", "This attachment operation was already prepared with different input. Review a new operation."],
  operation_not_found: ["not_found", "The prepared attachment operation was not found in this conversation."],
  source_changed: ["invalid_input", "The saved file changed after preparation. Review a new attachment operation."],
  source_unavailable: ["not_found", "The saved source file is unavailable. Upload the file again."],
  source_expired: ["not_found", "The source file upload expired. Upload the file again."],
  unsupported_file: ["invalid_input", "This record destination does not support the selected file's format or size."],
  forbidden: ["permission_denied", "Current access does not permit this file attachment operation."],
  destination_mismatch: ["unknown_outcome", "The saved record attachment did not match the original file, metadata or target. Do not report success or create another copy."],
  destination_missing: ["not_found", "The previously saved record attachment is no longer available. This operation will not recreate it."],
  unavailable: ["transient", "The file attachment could not be prepared or read. Try the same operation again."],
  outcome_unknown: ["unknown_outcome", "The attachment outcome could not be verified. Resume this prepared operation; do not create another copy."],
} as const;
export class RecordFileAttachmentError extends ToolFailureError {
  constructor(readonly code: RecordFileAttachmentFailure) {
    super({ category: failures[code][0], code: `record_file_${code}`, message: failures[code][1] });
    this.name = "RecordFileAttachmentError";
  }
}

/** Hosts supply canonical target identity and document metadata. Optimistic
 * versions or other mutation conditions belong in writeOptions, not metadata. */
export interface RecordFileAttachmentRequest {
  readonly destinationId: string;
  readonly fileHandle: string;
  readonly target: JsonObject;
  readonly metadata: JsonObject;
  readonly writeOptions?: JsonObject;
}
export interface RecordFileAttachmentSource extends JsonObject {
  readonly handle: string;
  readonly attachmentId: string;
  readonly messageId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256: string;
}
export interface RecordFileAttachmentIntent {
  readonly version: 1;
  readonly operationId: string;
  readonly conversationId: string;
  readonly namespace: string;
  readonly fingerprint: string;
  readonly request: RecordFileAttachmentRequest;
  readonly source: RecordFileAttachmentSource;
}
export interface RecordFileAttachmentReceipt extends JsonObject {
  readonly type: "handrail.record_file_attached.v1";
  readonly operationId: string;
  readonly destinationId: string;
  readonly attachmentId: string;
  readonly target: JsonObject;
  readonly metadata: JsonObject;
  readonly source: RecordFileAttachmentSource;
}
export interface RecordFileAttachmentState {
  readonly intent: RecordFileAttachmentIntent;
  readonly receipt: RecordFileAttachmentReceipt | null;
}
export interface RecordFileAttachmentStore {
  read(conversationId: string, operationId: string): Promise<RecordFileAttachmentState | null>;
  /** Atomic insert-or-match; reject any different immutable intent. */
  prepare(intent: RecordFileAttachmentIntent): Promise<RecordFileAttachmentState>;
  /** Atomic completion; exact completion retries must be harmless. */
  complete(intent: RecordFileAttachmentIntent, receipt: RecordFileAttachmentReceipt): Promise<void>;
}
export interface RecordFileAttachmentLocation { readonly conversationId: string; readonly signal: AbortSignal }
export interface RecordFileAttachmentPreparation extends RecordFileAttachmentLocation {
  readonly idempotencyKey: string;
  readonly request: RecordFileAttachmentRequest;
}
export interface RecordFileDestinationInput extends RecordFileAttachmentLocation {
  readonly operationId: string;
  readonly request: RecordFileAttachmentRequest;
  readonly source: RecordFileAttachmentSource;
}
export interface RecordFileAttachmentDestination {
  readonly id: string;
  readonly mediaTypes: readonly string[];
  readonly maximumBytes: number;
  /** Recheck identity, ownership and domain permissions on every call, including
   * receipt replay. May validate required metadata without performing a write. */
  authorize(input: RecordFileDestinationInput): void | Promise<void>;
  /** Authoritative lookup by the SDK operation identity. Null means no completed
   * domain write, not an outage or an indeterminate lookup. */
  lookup(input: RecordFileDestinationInput): Promise<{ readonly attachmentId: string } | null>;
  /** Must atomically bind operationId + immutable input to the domain mutation
   * and deduplicate concurrent calls/retries. This is the host's domain service,
   * never an unguarded insert. Reuse its existing storage/transaction adapter. */
  attach(input: RecordFileDestinationInput & { readonly bytes: Uint8Array }): Promise<{ readonly attachmentId: string }>;
  /** Read original bytes through current domain access. Return the actual stable
   * target and metadata, not copies of the requested values. */
  readBack(input: RecordFileDestinationInput & { readonly attachmentId: string }): Promise<{
    readonly target: JsonObject; readonly metadata: JsonObject; readonly fileName: string;
    readonly mediaType: string; readonly bytes: Uint8Array;
  }>;
}

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const invalid = (): never => { throw new RecordFileAttachmentError("invalid_request"); };
function canonical(value: unknown, depth = 0): string {
  if (depth > 20) return invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(",")}}`;
}
function clone<T>(value: T): T {
  const json = canonical(value);
  if (Buffer.byteLength(json) > 64 * 1024) return invalid();
  return JSON.parse(json) as T;
}
const string = (value: unknown, max = 512): string => typeof value === "string" && value.trim() && value.length <= max ? value : invalid();
function request(value: RecordFileAttachmentRequest): RecordFileAttachmentRequest {
  const result = clone(value);
  string(result.destinationId, 128);
  if (!/^file_[a-f0-9]{64}$/u.test(result.fileHandle) || [result.target, result.metadata, result.writeOptions ?? {}]
    .some(value => !value || typeof value !== "object" || Array.isArray(value)) ||
    Object.keys(result).some(key => !["destinationId", "fileHandle", "target", "metadata", "writeOptions"].includes(key))) invalid();
  return result;
}
function intent(value: RecordFileAttachmentIntent, conversationId: string, operationId: string, namespace: string) {
  const row = clone(value);
  if (row.version !== 1 || row.conversationId !== conversationId || row.operationId !== operationId || row.namespace !== namespace ||
    !/^file_save_[a-f0-9]{64}$/u.test(operationId) || !row.source || row.source.handle !== row.request.fileHandle ||
    Object.keys(row).some(key => !["version", "operationId", "conversationId", "namespace", "fingerprint", "request", "source"].includes(key)) ||
    Object.keys(row.source).some(key => !["handle", "attachmentId", "messageId", "fileName", "mediaType", "byteSize", "sha256"].includes(key))) invalid();
  request(row.request);
  const { fingerprint, ...facts } = row;
  if (fingerprint !== digest(canonical(facts)) || !/^[a-f0-9]{64}$/u.test(row.source.sha256) ||
    !Number.isSafeInteger(row.source.byteSize) || row.source.byteSize < 1) invalid();
  for (const field of [row.source.attachmentId, row.source.messageId, row.source.fileName, row.source.mediaType]) string(field);
  return row;
}
function resultFor(value: RecordFileAttachmentIntent, attachmentId: string): RecordFileAttachmentReceipt {
  return clone({ type: "handrail.record_file_attached.v1", operationId: value.operationId, destinationId: value.request.destinationId,
    attachmentId: string(attachmentId), target: value.request.target, metadata: value.request.metadata, source: value.source });
}
function fail(error: unknown, signal: AbortSignal, writing: boolean): never {
  signal.throwIfAborted();
  if (error instanceof ToolFailureError) throw error;
  if (error instanceof AttachmentStagingError && error.code === "forbidden" ||
    error instanceof ConversationCatalogError && ["forbidden", "not_found"].includes(error.code)) throw new RecordFileAttachmentError("forbidden");
  if (error instanceof SavedConversationPreparationError && error.code === "attachment_changed") throw new RecordFileAttachmentError("source_changed");
  if (error instanceof SavedConversationFileUnavailableError || error instanceof AttachmentStagingError && ["expired", "not_found"].includes(error.code)) {
    throw new RecordFileAttachmentError((error instanceof SavedConversationFileUnavailableError ? error.reason : error.code) === "expired"
      ? "source_expired" : "source_unavailable");
  }
  throw new RecordFileAttachmentError(writing ? "outcome_unknown" : "unavailable");
}

/** Freeze the source/target/metadata before approval; execute only through the
 * host's approved SDK tool path. Preparation is not authorization to write.
 * Domain idempotency and fresh read-back repair lost acknowledgements without
 * trusting a tool result or creating another binary-file copy. */
export function createRecordFileAttachments(options: {
  readonly namespace: readonly string[];
  readonly files: SavedFileHandles;
  readonly store: RecordFileAttachmentStore;
  readonly destinations: readonly RecordFileAttachmentDestination[];
}) {
  const namespace = digest(canonical(options.namespace.map(value => string(value))));
  if (!options.namespace.length) invalid();
  const destinations = new Map(options.destinations.map(value => [string(value.id, 128), value]));
  if (destinations.size !== options.destinations.length) invalid();
  for (const value of destinations.values()) if (!Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1 || !value.mediaTypes.length) invalid();
  const destination = (id: string) => destinations.get(id) ?? invalid();
  const readSource = async (location: RecordFileAttachmentLocation, handle: string) => {
    const file = await options.files.read({ ...location, handle });
    const source: RecordFileAttachmentSource = { handle, attachmentId: file.entry.attachmentId, messageId: file.entry.messageId,
      fileName: file.entry.fileName ?? "attachment", mediaType: file.entry.mediaType, byteSize: file.bytes.byteLength, sha256: file.sha256 };
    return { source, bytes: file.bytes };
  };
  const load = async (location: RecordFileAttachmentLocation, operationId: string) => {
    // Listing checks current conversation access even before returning an
    // operation-not-found result or disclosing stored target/metadata.
    await options.files.list({ ...location, limit: 1 });
    const state = await awaitWithSignal(location.signal, () => options.store.read(location.conversationId, operationId));
    if (!state) throw new RecordFileAttachmentError("operation_not_found");
    const prepared = intent(state.intent, location.conversationId, operationId, namespace);
    if (state.receipt && canonical(state.receipt) !== canonical(resultFor(prepared, state.receipt.attachmentId))) invalid();
    return { ...state, intent: prepared };
  };
  const inspect = async (location: RecordFileAttachmentLocation, operationId: string) => {
    const saved = await load(location, operationId), prepared = saved.intent;
    const adapter = destination(prepared.request.destinationId);
    const call = { ...location, operationId: prepared.operationId, request: prepared.request, source: prepared.source };
    const authorize = () => awaitWithSignal(location.signal, () => adapter.authorize(cloneInput(call)));
    await authorize();
    const file = await readSource(location, prepared.source.handle);
    if (canonical(file.source) !== canonical(prepared.source)) throw new RecordFileAttachmentError("source_changed");
    if (!adapter.mediaTypes.includes(file.source.mediaType) || file.source.byteSize > adapter.maximumBytes) throw new RecordFileAttachmentError("unsupported_file");
    await authorize();
    return { saved, prepared, adapter, call, authorize, file, location };
  };
  const verifyDestination = async (checked: Awaited<ReturnType<typeof inspect>>, receipt: RecordFileAttachmentReceipt) => {
    const { adapter, call, prepared, authorize, location } = checked;
    await authorize();
    const actual = await awaitWithSignal(location.signal, () => adapter.readBack({ ...cloneInput(call), attachmentId: receipt.attachmentId }));
    if (canonical(actual.target) !== canonical(prepared.request.target) || canonical(actual.metadata) !== canonical(prepared.request.metadata) ||
      actual.fileName !== prepared.source.fileName || actual.mediaType !== prepared.source.mediaType ||
      !(actual.bytes instanceof Uint8Array) || actual.bytes.byteLength !== prepared.source.byteSize || digest(actual.bytes) !== prepared.source.sha256) {
      throw new RecordFileAttachmentError("destination_mismatch");
    }
    await authorize();
    const current = await readSource(location, prepared.source.handle);
    if (canonical(current.source) !== canonical(prepared.source)) throw new RecordFileAttachmentError("source_changed");
  };
  const inspectSaved = async (location: RecordFileAttachmentLocation, operationId: string) => {
    const checked = await inspect(location, operationId);
    if (checked.saved.receipt) {
      const current = await awaitWithSignal(location.signal, () => checked.adapter.lookup(cloneInput(checked.call)));
      if (!current) throw new RecordFileAttachmentError("destination_missing");
      if (current.attachmentId !== checked.saved.receipt.attachmentId) throw new RecordFileAttachmentError("destination_mismatch");
      await verifyDestination(checked, checked.saved.receipt);
    }
    return clone(checked.prepared);
  };
  const candidate = async (input: RecordFileAttachmentPreparation) => {
    const location = { conversationId: string(input.conversationId), signal: input.signal };
    const wanted = request(input.request), adapter = destination(wanted.destinationId);
    const operationId = `file_save_${digest(canonical([namespace, location.conversationId, string(input.idempotencyKey)]))}`;
    const { source } = await readSource(location, wanted.fileHandle);
    if (!adapter.mediaTypes.includes(source.mediaType) || source.byteSize > adapter.maximumBytes) throw new RecordFileAttachmentError("unsupported_file");
    const call = { ...location, operationId, request: wanted, source };
    const authorize = () => awaitWithSignal(location.signal, () => adapter.authorize(cloneInput(call)));
    await authorize();
    const facts = { version: 1 as const, operationId, conversationId: location.conversationId, namespace, request: wanted, source };
    const prepared: RecordFileAttachmentIntent = { ...facts, fingerprint: digest(canonical(facts)) };
    return { location, prepared, authorize };
  };
  return Object.freeze({
    /** Read-only admission/review. Use before normal SDK receipt replay as well
     * as before approval; never call execute from an admission hook. */
    async inspect(input: RecordFileAttachmentLocation & { readonly operationId: string }) {
      const location = { conversationId: string(input.conversationId), signal: input.signal };
      try {
        return await inspectSaved(location, input.operationId);
      } catch (error) { return fail(error, location.signal, false); }
    },
    /** Side-effect-free admission for preparation-tool retries. Derive the
     * immutable operation identity here, never in each integrating app. */
    async inspectPreparation(input: RecordFileAttachmentPreparation) {
      try {
        const { location, prepared, authorize } = await candidate(input);
        const saved = await awaitWithSignal(location.signal, () => options.store.read(location.conversationId, prepared.operationId));
        if (saved) {
          if (canonical(saved.intent) !== canonical(prepared)) throw new RecordFileAttachmentError("operation_conflict");
          return await inspectSaved(location, prepared.operationId);
        }
        await authorize();
        return clone(prepared);
      } catch (error) { return fail(error, input.signal, false); }
    },
    async prepare(input: RecordFileAttachmentPreparation) {
      try {
        const { location, prepared, authorize } = await candidate(input);
        const saved = await awaitWithSignal(location.signal, () => options.store.prepare(clone(prepared)));
        if (canonical(saved.intent) !== canonical(prepared)) throw new RecordFileAttachmentError("operation_conflict");
        await authorize();
        return clone(prepared);
      } catch (error) { return fail(error, input.signal, false); }
    },
    async execute(input: RecordFileAttachmentLocation & { readonly operationId: string }): Promise<RecordFileAttachmentReceipt> {
      const location = { conversationId: string(input.conversationId), signal: input.signal };
      let writing = false;
      try {
        const checked = await inspect(location, input.operationId);
        const { saved, prepared, adapter, call, authorize, file } = checked;
        let record = await awaitWithSignal(location.signal, () => adapter.lookup(cloneInput(call)));
        if (saved.receipt && !record) throw new RecordFileAttachmentError("destination_missing");
        writing = record !== null;
        if (!record) {
          await authorize();
          writing = true;
          try { record = await awaitWithSignal(location.signal, () => adapter.attach({ ...cloneInput(call), bytes: new Uint8Array(file.bytes) })); }
          catch (error) {
            location.signal.throwIfAborted();
            // A failed acknowledgement is not proof of a failed domain commit.
            await authorize();
            record = await awaitWithSignal(location.signal, () => adapter.lookup(cloneInput(call)));
            if (!record) throw error;
          }
        }
        const receipt = resultFor(prepared, record.attachmentId);
        if (saved.receipt && canonical(saved.receipt) !== canonical(receipt)) throw new RecordFileAttachmentError("destination_mismatch");
        await verifyDestination(checked, receipt);
        await awaitWithSignal(location.signal, () => options.store.complete(prepared, receipt));
        await authorize();
        return clone(receipt);
      } catch (error) { return fail(error, location.signal, writing); }
    },
  });
}
export type RecordFileAttachments = ReturnType<typeof createRecordFileAttachments>;

/** Compose this with the host's normal admission checks. Fresh checks run even
 * when the SDK tool ledger can return a completed result without its executor. */
export function createRecordFileAttachmentAdmission<TContext>(options: {
  readonly toolNames: readonly string[];
  readonly serviceFor: (context: TContext, location: ApplicationToolExecutionLocation) => RecordFileAttachments | Promise<RecordFileAttachments>;
}): ApplicationToolAdmission<TContext> {
  const names = new Set(options.toolNames.map(name => string(name, 128)));
  return async input => {
    if (!names.has(input.definition.name)) return { outcome: "allow" };
    if (!input.location || typeof input.arguments.operationId !== "string") throw new RecordFileAttachmentError("invalid_request");
    const location = input.location;
    const service = await awaitWithSignal(input.signal, () => options.serviceFor(input.applicationContext, location));
    await service.inspect({ conversationId: location.conversationId, signal: input.signal, operationId: input.arguments.operationId });
    return { outcome: "allow" };
  };
}
function cloneInput(input: RecordFileDestinationInput): RecordFileDestinationInput {
  const { signal, ...facts } = input;
  return { ...clone(facts), signal };
}

/** Shared receipt persistence uses existing SDK documents and deletion fences.
 * No schema migration or separate storage backend is required. */
export function createPostgresRecordFileAttachmentStore(persistence: PostgresAiPersistence, tenantId: string): RecordFileAttachmentStore {
  const read = (conversationId: string, operationId: string) => persistence.getDocument<RecordFileAttachmentState>(tenantId, "checkpoint", conversationId, operationId);
  const same = (state: RecordFileAttachmentState, prepared: RecordFileAttachmentIntent) => {
    if (canonical(state.intent) !== canonical(prepared)) throw new RecordFileAttachmentError("operation_conflict");
    return state;
  };
  return {
    read: async (conversationId, operationId) => (await read(conversationId, operationId))?.value ?? null,
    async prepare(prepared) {
      const prior = await read(prepared.conversationId, prepared.operationId);
      if (prior) return same(prior.value, prepared);
      const value = { intent: prepared, receipt: null };
      try { return (await persistence.compareAndSetDocument({ tenantId, kind: "checkpoint", scopeId: prepared.conversationId,
        recordId: prepared.operationId, expectedVersion: null, value })).value; }
      catch (error) {
        const saved = await read(prepared.conversationId, prepared.operationId);
        if (saved) return same(saved.value, prepared);
        throw error;
      }
    },
    async complete(prepared, receipt) {
      const prior = await read(prepared.conversationId, prepared.operationId);
      if (!prior) throw new RecordFileAttachmentError("operation_not_found");
      same(prior.value, prepared);
      if (prior.value.receipt) {
        if (canonical(prior.value.receipt) !== canonical(receipt)) throw new RecordFileAttachmentError("operation_conflict");
        return;
      }
      try { await persistence.compareAndSetDocument({ tenantId, kind: "checkpoint", scopeId: prepared.conversationId,
        recordId: prepared.operationId, expectedVersion: prior.version, value: { intent: prepared, receipt } }); }
      catch (error) {
        const saved = await read(prepared.conversationId, prepared.operationId);
        if (saved && canonical(same(saved.value, prepared).receipt) === canonical(receipt)) return;
        if (error instanceof PostgresPersistenceConflictError) throw new RecordFileAttachmentError("operation_conflict");
        throw error;
      }
    },
  };
}
