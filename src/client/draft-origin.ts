/** Device-only origin of an exact pending submission. Never send this receipt
 * in provider requests, canonical events, or authorization context. */
export interface ConversationDraftOrigin {
  readonly version: 1;
  readonly textVersion?: string;
  readonly fileIds?: readonly string[];
}
export function parseDraftOrigin(value: unknown): ConversationDraftOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid local draft origin");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || Object.keys(record).some(key => !["version", "textVersion", "fileIds"].includes(key)) ||
      record.textVersion !== undefined && (typeof record.textVersion !== "string" || !record.textVersion || record.textVersion.length > 128)) {
    throw new TypeError("Invalid local draft origin");
  }
  const files = record.fileIds;
  if (files !== undefined && (!Array.isArray(files) || files.length > 64 ||
      files.some(id => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) || new Set(files).size !== files.length)) {
    throw new TypeError("Invalid local draft file identities");
  }
  return Object.freeze({ version: 1,
    ...(record.textVersion === undefined ? {} : { textVersion: record.textVersion as string }),
    ...(files === undefined ? {} : { fileIds: Object.freeze([...(files as string[])]) }) });
}
