import { jsonValuesEqual } from "../json-equality.js";
import { parseToolDefinition, type JsonObject, type JsonSchemaObject } from "../protocol.js";
import { createToolPlugin } from "../tools/plugin.js";
import type { ToolRegistration } from "../tools/registry.js";
import type { ApplicationToolAdmission, ApplicationToolExecutor, ApplicationToolExecutionLocation } from "../tools/executor.js";
import { RecordFileAttachmentError, type RecordFileAttachmentIntent, type RecordFileAttachmentRequest,
  type RecordFileAttachments } from "./record-file-attachments.js";
import { ToolFailureError } from "../tools/recovery.js";

/** Business schemas and labels are host configuration. The SDK owns the two
 * tool phases, immutable operation identity, approval arguments and receipts. */
export interface RecordFileToolDestination {
  readonly destinationId: string;
  /** Stable tool-name component: lowercase letters, digits and underscores. */
  readonly toolKey: string;
  readonly label: string;
  readonly description: string;
  readonly targetSchema: JsonSchemaObject;
  readonly metadataSchema: JsonSchemaObject;
  readonly writeOptionsSchema?: JsonSchemaObject;
}
export interface RecordFileToolOptions<TContext> {
  readonly destinations: readonly RecordFileToolDestination[];
  readonly serviceFor: (context: TContext, location: ApplicationToolExecutionLocation) => RecordFileAttachments | Promise<RecordFileAttachments>;
  /** Standalone plugins require confirmation by default. High-level assistants
   * can use policy to honor their existing trusted approval configuration. */
  readonly approvalMode?: "always" | "policy";
}

const emptyObject: JsonSchemaObject = { type: "object", additionalProperties: false, properties: {}, required: [] };
const sourceSchema: JsonSchemaObject = { type: "object", additionalProperties: false,
  required: ["fileName", "mediaType", "byteSize", "sha256"], properties: {
    fileName: { type: "string", minLength: 1 }, mediaType: { type: "string", minLength: 1 },
    byteSize: { type: "integer", minimum: 1 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  } };
const invalid = (): never => { throw new RecordFileAttachmentError("invalid_request"); };
const safe = async <T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> => {
  try { signal.throwIfAborted(); return await action(); } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ToolFailureError) throw error;
    throw new RecordFileAttachmentError("unavailable");
  }
};
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : invalid();

/** Public review arguments contain the actual frozen source and destination,
 * never storage credentials or bytes. They are compared again before approval,
 * dispatch and cached-result replay; model-edited review text cannot authorize
 * a different file, target, metadata or write condition. */
export function recordFileAttachmentReview(intent: RecordFileAttachmentIntent): JsonObject {
  return structuredClone({ operationId: intent.operationId, review: {
    destinationId: intent.request.destinationId,
    source: { fileName: intent.source.fileName, mediaType: intent.source.mediaType,
      byteSize: intent.source.byteSize, sha256: intent.source.sha256 },
    target: intent.request.target, metadata: intent.request.metadata, writeOptions: intent.request.writeOptions ?? {},
  } });
}

/** Register prepare/attach pairs once in the SDK. Install admission together with
 * the plugin, including on recovery. Preparing retains an intent only; the
 * attach tool uses the normal SDK approval and execution-ledger boundary. */
export function createRecordFileTools<TContext>(options: RecordFileToolOptions<TContext>) {
  if (!options.destinations.length || options.approvalMode !== undefined && !["always", "policy"].includes(options.approvalMode)) {
    throw new TypeError("Invalid record-file tool configuration");
  }
  const descriptors = structuredClone(options.destinations);
  const byTool = new Map<string, { destination: RecordFileToolDestination; prepare: boolean }>();
  const destinationIds = new Set<string>();
  const registrations: ToolRegistration<ApplicationToolExecutor<TContext>, TContext>[] = [];
  const approvals: { toolName: string; mode: "never" | "always" | "policy"; summarize: () => string }[] = [];
  const requestFor = (destination: RecordFileToolDestination, args: JsonObject): RecordFileAttachmentRequest => ({
    destinationId: destination.destinationId, fileHandle: typeof args.fileHandle === "string" ? args.fileHandle : invalid(),
    target: object(args.target), metadata: object(args.metadata),
    ...(destination.writeOptionsSchema ? { writeOptions: object(args.writeOptions) } : {}),
  });
  const inspectReview = async (service: RecordFileAttachments, destination: RecordFileToolDestination,
    location: ApplicationToolExecutionLocation, signal: AbortSignal, args: JsonObject) => {
    if (typeof args.operationId !== "string") return invalid();
    const intent = await service.inspect({ conversationId: location.conversationId, signal, operationId: args.operationId });
    if (intent.request.destinationId !== destination.destinationId || !jsonValuesEqual(args, recordFileAttachmentReview(intent))) {
      throw new RecordFileAttachmentError("operation_conflict");
    }
    return intent;
  };
  const execute: ApplicationToolExecutor<TContext> = (args, input) => safe(input.signal, async () => {
    const selected = byTool.get(input.definition.name);
    if (!selected || !input.location || !input.executionKey) return invalid();
    const service = await options.serviceFor(input.applicationContext, input.location);
    const location = { conversationId: input.location.conversationId, signal: input.signal };
    if (selected.prepare) {
      const prepared = await service.prepare({ ...location, idempotencyKey: input.executionKey, request: requestFor(selected.destination, args) });
      return { type: "handrail.record_file_prepared.v1", status: "prepared",
        executeTool: `handrail_files_attach_${selected.destination.toolKey}`, arguments: recordFileAttachmentReview(prepared),
        notice: "No business record was changed. Use these exact arguments with the named attach tool; do not report success until its verified attachment receipt." };
    }
    const intent = await inspectReview(service, selected.destination, input.location, input.signal, args);
    return service.execute({ ...location, operationId: intent.operationId });
  });
  for (const destination of descriptors) {
    if (!/^[a-z][a-z0-9_]{0,39}$/u.test(destination.toolKey) || !destination.destinationId.trim() || destination.destinationId.length > 128 ||
      !destination.label.trim() || destination.label.length > 160 || !destination.description.trim() || destinationIds.has(destination.destinationId)) {
      throw new TypeError("Invalid record-file destination descriptor");
    }
    destinationIds.add(destination.destinationId);
    const prepareName = `handrail_files_prepare_${destination.toolKey}`, attachName = `handrail_files_attach_${destination.toolKey}`;
    if (byTool.has(prepareName)) throw new TypeError("Duplicate record-file tool key");
    byTool.set(prepareName, { destination, prepare: true }); byTool.set(attachName, { destination, prepare: false });
    registrations.push({ executor: execute, definition: parseToolDefinition({ name: prepareName,
      description: `Prepare a saved-file attachment for ${destination.label}. ${destination.description} Use a handle from handrail_files_list. This freezes a reviewable operation without changing the record.`,
      input_schema: { type: "object", additionalProperties: false,
        required: ["fileHandle", "target", "metadata", ...(destination.writeOptionsSchema ? ["writeOptions"] : [])],
        properties: { fileHandle: { type: "string", pattern: "^file_[a-f0-9]{64}$" }, target: destination.targetSchema,
          metadata: destination.metadataSchema, ...(destination.writeOptionsSchema ? { writeOptions: destination.writeOptionsSchema } : {}) } } }) },
    { executor: execute, definition: parseToolDefinition({ name: attachName,
      description: `Attach the reviewed original file to ${destination.label}. Copy the exact operationId and review returned by ${prepareName}. A verified receipt is required before reporting success.`,
      input_schema: { type: "object", additionalProperties: false, required: ["operationId", "review"], properties: {
        operationId: { type: "string", pattern: "^file_save_[a-f0-9]{64}$" },
        review: { type: "object", additionalProperties: false,
          required: ["destinationId", "source", "target", "metadata", "writeOptions"], properties: {
            destinationId: { type: "string", enum: [destination.destinationId] }, source: sourceSchema,
            target: destination.targetSchema, metadata: destination.metadataSchema, writeOptions: destination.writeOptionsSchema ?? emptyObject,
          } },
      } } }) });
    approvals.push({ toolName: prepareName, mode: "never", summarize: () => `Prepare a file for ${destination.label}` },
      { toolName: attachName, mode: options.approvalMode ?? "always", summarize: () => `Attach the reviewed original file to ${destination.label}` });
  }
  const plugin = createToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>({
    pluginId: "handrail.record-files", version: "1.0.0", displayName: "Save conversation files to records", registrations, approvals,
  });
  const admission: ApplicationToolAdmission<TContext> = input => safe(input.signal, async () => {
    const selected = byTool.get(input.definition.name);
    if (!selected) return { outcome: "allow" };
    if (!input.location) return invalid();
    const service = await options.serviceFor(input.applicationContext, input.location);
    if (selected.prepare) await service.inspectPreparation({ conversationId: input.location.conversationId, signal: input.signal,
      idempotencyKey: input.executionKey, request: requestFor(selected.destination, input.arguments) });
    else await inspectReview(service, selected.destination, input.location, input.signal, input.arguments);
    return { outcome: "allow" };
  });
  return Object.freeze({ plugin, admission });
}
