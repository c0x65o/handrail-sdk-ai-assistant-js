import { AttachmentStagingError } from "../attachments/staging.js";

/** Signature checks for common assistant inputs; provider/domain parsing remains separate. */
export const STANDARD_ATTACHMENT_MEDIA_TYPES = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
  "text/csv", "text/tab-separated-values",
] as const;
export type StandardAttachmentMediaType = typeof STANDARD_ATTACHMENT_MEDIA_TYPES[number];
export type AttachmentContentFailure = "file_count" | "total_size" | "file_size" | "unsupported_type" | "type_mismatch";
export class AttachmentContentError extends AttachmentStagingError {
  constructor(readonly reason: AttachmentContentFailure) { super("invalid_input"); }
}
export interface AttachmentContentInput<T extends Uint8Array = Uint8Array> {
  readonly fileName: string;
  readonly declaredMediaType: string;
  readonly data: T;
}
export interface AttachmentContentPolicy {
  readonly maximumFiles?: number;
  readonly maximumBytesPerFile?: number;
  readonly maximumTotalBytes?: number;
  readonly acceptedMediaTypes?: readonly StandardAttachmentMediaType[];
}

/** Validates the entire batch synchronously and preserves the caller's byte type.
 * Storage adapters must freeze bytes before asynchronous persistence. */
export function createAttachmentContentValidator(policy: AttachmentContentPolicy = {}) {
  const maximumFiles = policy.maximumFiles ?? 5;
  const maximumBytesPerFile = policy.maximumBytesPerFile ?? 10 * 1024 * 1024;
  const maximumTotalBytes = policy.maximumTotalBytes ?? 20 * 1024 * 1024;
  const accepted = new Set(policy.acceptedMediaTypes ?? STANDARD_ATTACHMENT_MEDIA_TYPES);
  if (![maximumFiles, maximumBytesPerFile, maximumTotalBytes].every(value => Number.isSafeInteger(value) && value > 0) ||
    accepted.size === 0 || [...accepted].some(type => !SUPPORTED_DECLARED_ATTACHMENT_TYPES.has(type))) {
    throw new TypeError("Invalid attachment content policy");
  }
  return function validate<T extends Uint8Array>(incoming: readonly AttachmentContentInput<T>[]) {
    if (incoming.length > maximumFiles) throw new AttachmentContentError("file_count");
    if (incoming.reduce((total, file) => total + file.data.byteLength, 0) > maximumTotalBytes) {
      throw new AttachmentContentError("total_size");
    }
    return incoming.map(file => {
      if (file.data.byteLength === 0 || file.data.byteLength > maximumBytesPerFile) throw new AttachmentContentError("file_size");
      const intended = intendedAttachmentMediaType(file.declaredMediaType, file.fileName);
      const bytes = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
      const mediaType = mediaTypeFromSignature(bytes, intended);
      if (!mediaType || !accepted.has(mediaType)) throw new AttachmentContentError("unsupported_type");
      if (intended !== null && intended !== mediaType) throw new AttachmentContentError("type_mismatch");
      return { fileName: safeAttachmentFileName(file.fileName, mediaType), mediaType,
        byteSize: file.data.byteLength, data: file.data };
    });
  };
}

const SUPPORTED_DECLARED_ATTACHMENT_TYPES = new Set<string>(STANDARD_ATTACHMENT_MEDIA_TYPES);

function intendedAttachmentMediaType(
  declaredMediaType: string,
  fileName: string,
): StandardAttachmentMediaType | null {
  if (SUPPORTED_DECLARED_ATTACHMENT_TYPES.has(declaredMediaType)) {
    return declaredMediaType as StandardAttachmentMediaType;
  }
  if (!["", "application/octet-stream", "text/plain"].includes(declaredMediaType)) return null;
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lowerName.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lowerName.endsWith(".csv")) return "text/csv";
  if (lowerName.endsWith(".tsv")) return "text/tab-separated-values";
  return null;
}

function mediaTypeFromSignature(
  data: Buffer,
  intendedMediaType: StandardAttachmentMediaType | null,
): StandardAttachmentMediaType | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const header = data.subarray(0, 12).toString("ascii");
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") return "image/webp";
  if (data.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (
    intendedMediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" &&
    data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    data.includes(Buffer.from("[Content_Types].xml")) &&
    data.includes(Buffer.from("xl/"))
  ) return intendedMediaType;
  if (
    intendedMediaType === "application/vnd.ms-excel" &&
    data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) return intendedMediaType;
  if (
    (intendedMediaType === "text/csv" || intendedMediaType === "text/tab-separated-values") &&
    isSafeSpreadsheetText(data)
  ) return intendedMediaType;
  return null;
}

function isSafeSpreadsheetText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  const decoded = data.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(data) && /[,\t\r\n]/.test(decoded);
}

function safeAttachmentFileName(value: string, mediaType: StandardAttachmentMediaType) {
  const extension = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
  }[mediaType];
  const leaf = value.split(/[/\\]/).at(-1) ?? "";
  const cleaned = [...leaf.normalize("NFKC")]
    .filter((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 170);
  if (!cleaned) return `attachment${extension}`;
  const withoutKnownExtension = cleaned.replace(/\.(?:png|jpe?g|webp|gif|pdf|xlsx?|csv|tsv)$/i, "");
  return `${withoutKnownExtension || "attachment"}${extension}`.slice(0, 180);
}

