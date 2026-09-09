import type {
  AttachmentSelection,
  AttachmentUploadKind,
} from "../attachments/types.js";
import {
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type DocumentMimeType,
  type ImageMimeType,
} from "../protocol.js";

export const BROWSER_IMAGE_INTAKE_REJECTION_REASONS = [
  "unsupported_type",
  "too_large",
  "count_overflow",
  "duplicate",
  "empty_file",
] as const;

export type BrowserImageIntakeRejectionReason =
  (typeof BROWSER_IMAGE_INTAKE_REJECTION_REASONS)[number];

/** The browser-owned binary value forwarded unchanged to AttachmentUploader. */
export type BrowserAttachmentSource = Blob;

export interface BrowserObjectUrlApi {
  createObjectURL(source: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserImagePreviewOptions {
  /** Defaults lazily to the browser's URL static methods. */
  readonly objectUrlApi?: BrowserObjectUrlApi;
}

export interface BrowserImageIntakeOptions {
  /** Exact protocol image MIME types to accept. Wildcards are not supported. */
  readonly acceptedMediaTypes: readonly ImageMimeType[];
  /** Positive integer no greater than the protocol's per-image byte limit. */
  readonly maxFileBytes: number;
  /** Positive integer limiting selections after existingSelectionCount. */
  readonly maxSelectionCount: number;
  /** Fingerprints already held by the caller and therefore treated as duplicates. */
  readonly existingFingerprints?: Iterable<string>;
  /** Existing selections that count toward maxSelectionCount. Defaults to zero. */
  readonly existingSelectionCount?: number;
  /** Opt in to object-URL previews, optionally with an injected URL API. */
  readonly previews?: boolean | BrowserImagePreviewOptions;
}

export interface BrowserImageIntakeRejection {
  readonly source: BrowserAttachmentSource;
  readonly filename?: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly fingerprint: string;
  readonly reason: BrowserImageIntakeRejectionReason;
}

export interface BrowserImagePreview {
  readonly fingerprint: string;
  readonly url: string;
  /** Idempotently revokes this preview's object URL. */
  revoke(): void;
}

export interface BrowserImageIntakeResult {
  readonly selections: readonly AttachmentSelection<BrowserAttachmentSource>[];
  readonly rejections: readonly BrowserImageIntakeRejection[];
  readonly previews: readonly BrowserImagePreview[];
  /** Idempotently revokes every preview URL created by this intake operation. */
  dispose(): void;
}

export interface BrowserDropImageIntakeResult extends BrowserImageIntakeResult {
  /** True only when this drop operation produced at least one accepted selection. */
  readonly shouldPreventDefault: boolean;
}

export class BrowserImageIntakeValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserImageIntakeValidationError";
  }
}

export const BROWSER_PDF_INTAKE_REJECTION_REASONS = [
  "unsupported_type",
  "too_large",
  "count_overflow",
  "duplicate",
  "empty_file",
  "unsafe_filename",
] as const;

export type BrowserPdfIntakeRejectionReason =
  (typeof BROWSER_PDF_INTAKE_REJECTION_REASONS)[number];

/** Minimal mixed attachment state used to derive document duplicates and count. */
export interface BrowserPdfExistingSelection {
  readonly fingerprint: string;
  /** Omitted legacy kinds are images and do not consume the document count. */
  readonly kind?: AttachmentUploadKind;
}

export interface BrowserPdfIntakeOptions {
  /** Defaults to all protocol document MIME types. */
  readonly acceptedMediaTypes?: readonly DocumentMimeType[];
  /** Positive integer no greater than the protocol's per-document byte limit. */
  readonly maxFileBytes: number;
  /** Integer from 1 through the protocol's per-request document count. */
  readonly maxSelectionCount: number;
  /** Fingerprints already held by the caller and therefore treated as duplicates. */
  readonly existingFingerprints?: Iterable<string>;
  /**
   * Mixed attachment state. All fingerprints are deduplicated; only document-kind
   * entries consume the document count because legacy omitted kinds are images.
   */
  readonly existingSelections?: Iterable<BrowserPdfExistingSelection>;
  /**
   * Existing document count when the full mixed state is unavailable. The
   * effective count is never lower than document-kind existingSelections.
   */
  readonly existingSelectionCount?: number;
}

export interface BrowserPdfIntakeRejection {
  readonly source: BrowserAttachmentSource;
  /** Omitted when the browser-provided filename itself is unsafe. */
  readonly filename?: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly fingerprint: string;
  readonly reason: BrowserPdfIntakeRejectionReason;
}

export interface BrowserPdfIntakeResult {
  readonly selections: readonly AttachmentSelection<BrowserAttachmentSource>[];
  readonly rejections: readonly BrowserPdfIntakeRejection[];
  /** No-op cleanup retained for intake lifecycle symmetry; documents create no previews. */
  dispose(): void;
}

export interface BrowserDropPdfIntakeResult extends BrowserPdfIntakeResult {
  /** True only when this drop operation produced at least one accepted document. */
  readonly shouldPreventDefault: boolean;
}

export class BrowserPdfIntakeValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserPdfIntakeValidationError";
  }
}

interface ValidatedOptions {
  readonly acceptedMediaTypes: ReadonlySet<ImageMimeType>;
  readonly maxFileBytes: number;
  readonly maxSelectionCount: number;
  readonly existingFingerprints: ReadonlySet<string>;
  readonly existingSelectionCount: number;
  readonly previews: false | BrowserImagePreviewOptions;
}

const PROTOCOL_IMAGE_MIME_TYPES = new Set<string>(AI_RUNTIME_IMAGE_MIME_TYPES);
const PROTOCOL_DOCUMENT_MIME_TYPES = new Set<string>(
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
);
const UNSAFE_FILENAME_CHARACTERS = '<>:"/\\|?*';
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

function validateOptions(options: BrowserImageIntakeOptions): ValidatedOptions {
  if (options === null || typeof options !== "object") {
    throw new BrowserImageIntakeValidationError("options must be an object");
  }
  if (options.acceptedMediaTypes.length === 0) {
    throw new BrowserImageIntakeValidationError(
      "acceptedMediaTypes must contain at least one protocol image MIME type",
    );
  }
  const acceptedMediaTypes = new Set<ImageMimeType>();
  for (const mediaType of options.acceptedMediaTypes) {
    if (!PROTOCOL_IMAGE_MIME_TYPES.has(mediaType)) {
      throw new BrowserImageIntakeValidationError(
        `acceptedMediaTypes contains unsupported MIME type ${JSON.stringify(mediaType)}`,
      );
    }
    acceptedMediaTypes.add(mediaType);
  }
  if (
    !Number.isSafeInteger(options.maxFileBytes) ||
    options.maxFileBytes < AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes ||
    options.maxFileBytes > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes
  ) {
    throw new BrowserImageIntakeValidationError(
      `maxFileBytes must be an integer from ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes} through ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes}`,
    );
  }
  if (!Number.isSafeInteger(options.maxSelectionCount) || options.maxSelectionCount < 1) {
    throw new BrowserImageIntakeValidationError(
      "maxSelectionCount must be a positive integer",
    );
  }
  const existingSelectionCount = options.existingSelectionCount ?? 0;
  if (!Number.isSafeInteger(existingSelectionCount) || existingSelectionCount < 0) {
    throw new BrowserImageIntakeValidationError(
      "existingSelectionCount must be a non-negative integer",
    );
  }

  let previews: false | BrowserImagePreviewOptions = false;
  if (options.previews === true) previews = {};
  else if (options.previews !== undefined && options.previews !== false) {
    if (options.previews === null || typeof options.previews !== "object") {
      throw new BrowserImageIntakeValidationError(
        "previews must be a boolean or preview options object",
      );
    }
    previews = options.previews;
  }

  return {
    acceptedMediaTypes,
    maxFileBytes: options.maxFileBytes,
    maxSelectionCount: options.maxSelectionCount,
    existingFingerprints: new Set(options.existingFingerprints ?? []),
    existingSelectionCount,
    previews,
  };
}

function opaqueHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/**
 * Returns a metadata-derived opaque identity without reading the Blob contents.
 * Files with the same browser metadata intentionally collapse within intake.
 */
export function fingerprintBrowserImage(source: BrowserAttachmentSource): string {
  const file = source as Blob & {
    readonly name?: unknown;
    readonly lastModified?: unknown;
  };
  const name = typeof file.name === "string" ? file.name : "";
  const lastModified =
    typeof file.lastModified === "number" && Number.isFinite(file.lastModified)
      ? file.lastModified
      : 0;
  const identity = JSON.stringify([name, source.type, source.size, lastModified]);
  return `browser-image:${opaqueHash(identity)}`;
}

function normalizedFilename(
  source: BrowserAttachmentSource,
  fingerprint: string,
): string | undefined {
  const name = (source as Blob & { readonly name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const sanitized = [...name]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 ||
        codePoint === 127 ||
        UNSAFE_FILENAME_CHARACTERS.includes(character)
        ? "_"
        : character;
    })
    .join("")
    .slice(0, AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength);
  if (
    sanitized.length === 0 ||
    sanitized === "." ||
    sanitized === ".." ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(sanitized))
  ) {
    return `image-${fingerprint.slice("browser-image:".length)}.bin`;
  }
  return sanitized;
}

function rejection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  reason: BrowserImageIntakeRejectionReason,
): BrowserImageIntakeRejection {
  const filename = normalizedFilename(source, fingerprint);
  return Object.freeze(
    filename === undefined
      ? {
          source,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        }
      : {
          source,
          filename,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        },
  );
}

function selection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  mediaType: ImageMimeType,
): AttachmentSelection<BrowserAttachmentSource> {
  const filename = normalizedFilename(source, fingerprint);
  const base = {
    source,
    fingerprint,
    idempotencyKey: `browser-intake:${fingerprint.slice("browser-image:".length)}`,
    mediaType,
    byteSize: source.size,
  };
  return Object.freeze(filename === undefined ? base : { ...base, filename });
}

function browserObjectUrlApi(): BrowserObjectUrlApi {
  const candidate = globalThis.URL as unknown as Partial<BrowserObjectUrlApi>;
  if (
    typeof candidate?.createObjectURL !== "function" ||
    typeof candidate.revokeObjectURL !== "function"
  ) {
    throw new BrowserImageIntakeValidationError(
      "Object-URL previews require an injected objectUrlApi or browser URL support",
    );
  }
  return candidate as BrowserObjectUrlApi;
}

function createPreviews(
  selections: readonly AttachmentSelection<BrowserAttachmentSource>[],
  options: false | BrowserImagePreviewOptions,
): {
  readonly previews: readonly BrowserImagePreview[];
  readonly dispose: () => void;
} {
  if (options === false || selections.length === 0) {
    return { previews: Object.freeze([]), dispose: () => undefined };
  }
  const api = options.objectUrlApi ?? browserObjectUrlApi();
  const previews: BrowserImagePreview[] = [];

  const dispose = (): void => {
    for (const preview of previews) {
      try {
        preview.revoke();
      } catch {
        // A failing host URL API must not prevent cleanup of later previews.
      }
    }
  };

  try {
    for (const accepted of selections) {
      const url = api.createObjectURL(accepted.source);
      if (typeof url !== "string" || url.length === 0) {
        throw new BrowserImageIntakeValidationError(
          "objectUrlApi.createObjectURL must return a non-empty string",
        );
      }
      let revoked = false;
      previews.push(
        Object.freeze({
          fingerprint: accepted.fingerprint,
          url,
          revoke(): void {
            if (revoked) return;
            revoked = true;
            api.revokeObjectURL(url);
          },
        }),
      );
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return { previews: Object.freeze(previews), dispose };
}

function intakeImages(
  sources: readonly BrowserAttachmentSource[],
  rawOptions: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  const options = validateOptions(rawOptions);
  const seen = new Set(options.existingFingerprints);
  const selections: AttachmentSelection<BrowserAttachmentSource>[] = [];
  const rejections: BrowserImageIntakeRejection[] = [];

  for (const source of sources) {
    const fingerprint = fingerprintBrowserImage(source);
    const mediaType = source.type;
    if (!options.acceptedMediaTypes.has(mediaType as ImageMimeType)) {
      rejections.push(rejection(source, fingerprint, "unsupported_type"));
      continue;
    }
    if (!Number.isSafeInteger(source.size) || source.size < 1) {
      rejections.push(rejection(source, fingerprint, "empty_file"));
      continue;
    }
    if (source.size > options.maxFileBytes) {
      rejections.push(rejection(source, fingerprint, "too_large"));
      continue;
    }
    if (seen.has(fingerprint)) {
      rejections.push(rejection(source, fingerprint, "duplicate"));
      continue;
    }
    if (
      options.existingSelectionCount + selections.length >=
      options.maxSelectionCount
    ) {
      rejections.push(rejection(source, fingerprint, "count_overflow"));
      continue;
    }
    seen.add(fingerprint);
    selections.push(selection(source, fingerprint, mediaType as ImageMimeType));
  }

  const previewResult = createPreviews(selections, options.previews);
  return Object.freeze({
    selections: Object.freeze(selections),
    rejections: Object.freeze(rejections),
    previews: previewResult.previews,
    dispose: previewResult.dispose,
  });
}

function filesFromList(files: FileList | readonly BrowserAttachmentSource[]): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] ?? ("item" in files ? files.item(index) : undefined);
    if (file !== null && file !== undefined) sources.push(file);
  }
  return sources;
}

function filesFromItems(items: DataTransferItemList): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) sources.push(file);
  }
  return sources;
}

/** Extracts file-kind clipboard items in source order and ignores string items. */
export function intakeClipboardImages(
  items: DataTransferItemList,
  options: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  return intakeImages(filesFromItems(items), options);
}

/** Accepts a file input's FileList, or host-owned Blobs, in source order. */
export function intakeFileInputImages(
  files: FileList | readonly BrowserAttachmentSource[],
  options: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  return intakeImages(filesFromList(files), options);
}

/** Extracts file-kind drop items and reports whether the host should consume the drop. */
export function intakeDroppedImages(
  dataTransfer: DataTransfer,
  options: BrowserImageIntakeOptions,
): BrowserDropImageIntakeResult {
  const itemFiles = filesFromItems(dataTransfer.items);
  const result = intakeImages(
    itemFiles.length > 0 ? itemFiles : filesFromList(dataTransfer.files),
    options,
  );
  return Object.freeze({
    ...result,
    shouldPreventDefault: result.selections.length > 0,
  });
}

interface ValidatedPdfOptions {
  readonly acceptedMediaTypes: ReadonlySet<DocumentMimeType>;
  readonly maxFileBytes: number;
  readonly maxSelectionCount: number;
  readonly existingFingerprints: ReadonlySet<string>;
  readonly existingSelectionCount: number;
}

const PDF_CREDENTIAL_VALUE_PATTERNS = [
  ...CREDENTIAL_VALUE_PATTERNS,
  /(?:^|[^a-z0-9])(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+/i,
] as const;

function isSafeOpaqueFingerprint(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) &&
    !/^(?:data|blob|https?):/i.test(value) &&
    !PDF_CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function validatePdfOptions(
  options: BrowserPdfIntakeOptions,
): ValidatedPdfOptions {
  if (options === null || typeof options !== "object") {
    throw new BrowserPdfIntakeValidationError("options must be an object");
  }

  const rawAcceptedMediaTypes =
    options.acceptedMediaTypes ?? AI_RUNTIME_DOCUMENT_MIME_TYPES;
  if (!Array.isArray(rawAcceptedMediaTypes) || rawAcceptedMediaTypes.length === 0) {
    throw new BrowserPdfIntakeValidationError(
      "acceptedMediaTypes must contain at least one protocol document MIME type",
    );
  }
  const acceptedMediaTypes = new Set<DocumentMimeType>();
  for (const mediaType of rawAcceptedMediaTypes) {
    if (!PROTOCOL_DOCUMENT_MIME_TYPES.has(mediaType)) {
      throw new BrowserPdfIntakeValidationError(
        `acceptedMediaTypes contains unsupported MIME type ${JSON.stringify(mediaType)}`,
      );
    }
    acceptedMediaTypes.add(mediaType);
  }

  if (
    !Number.isSafeInteger(options.maxFileBytes) ||
    options.maxFileBytes < AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes ||
    options.maxFileBytes > AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes
  ) {
    throw new BrowserPdfIntakeValidationError(
      `maxFileBytes must be an integer from ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes} through ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes}`,
    );
  }
  if (
    !Number.isSafeInteger(options.maxSelectionCount) ||
    options.maxSelectionCount < 1 ||
    options.maxSelectionCount >
      AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest
  ) {
    throw new BrowserPdfIntakeValidationError(
      `maxSelectionCount must be an integer from 1 through ${AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest}`,
    );
  }

  const existingFingerprints = new Set<string>();
  for (const fingerprint of options.existingFingerprints ?? []) {
    if (!isSafeOpaqueFingerprint(fingerprint)) {
      throw new BrowserPdfIntakeValidationError(
        "existingFingerprints must contain safe opaque identifiers",
      );
    }
    existingFingerprints.add(fingerprint);
  }

  let derivedDocumentCount = 0;
  for (const existing of options.existingSelections ?? []) {
    if (
      existing === null ||
      typeof existing !== "object" ||
      !isSafeOpaqueFingerprint(existing.fingerprint) ||
      (existing.kind !== undefined &&
        existing.kind !== "image" &&
        existing.kind !== "document")
    ) {
      throw new BrowserPdfIntakeValidationError(
        "existingSelections must contain safe attachment identities",
      );
    }
    existingFingerprints.add(existing.fingerprint);
    if (existing.kind === "document") derivedDocumentCount += 1;
  }

  const rawExistingSelectionCount = options.existingSelectionCount ?? 0;
  if (
    !Number.isSafeInteger(rawExistingSelectionCount) ||
    rawExistingSelectionCount < 0
  ) {
    throw new BrowserPdfIntakeValidationError(
      "existingSelectionCount must be a non-negative integer",
    );
  }
  const existingSelectionCount = Math.max(
    rawExistingSelectionCount,
    derivedDocumentCount,
  );

  return {
    acceptedMediaTypes,
    maxFileBytes: options.maxFileBytes,
    maxSelectionCount: options.maxSelectionCount,
    existingFingerprints,
    existingSelectionCount,
  };
}

/**
 * Returns a metadata-derived opaque identity without reading the Blob contents.
 * Files with the same browser metadata intentionally collapse within intake.
 */
export function fingerprintBrowserPdf(source: BrowserAttachmentSource): string {
  const file = source as Blob & {
    readonly name?: unknown;
    readonly lastModified?: unknown;
  };
  const name = typeof file.name === "string" ? file.name : "";
  const lastModified =
    typeof file.lastModified === "number" && Number.isFinite(file.lastModified)
      ? file.lastModified
      : 0;
  const identity = JSON.stringify([name, source.type, source.size, lastModified]);
  return `browser-pdf:${opaqueHash(identity)}`;
}

function safePdfFilename(
  source: BrowserAttachmentSource,
  fingerprint: string,
): string | null {
  const name = (source as Blob & { readonly name?: unknown }).name;
  if (name === undefined || name === "") {
    return `document-${fingerprint.slice("browser-pdf:".length)}${documentExtension(source.type as DocumentMimeType)}`;
  }
  if (
    typeof name !== "string" ||
    name.length > AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength ||
    name === "." ||
    name === ".." ||
    PDF_CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(name)) ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 ||
        codePoint === 127 ||
        UNSAFE_FILENAME_CHARACTERS.includes(character);
    })
  ) {
    return null;
  }
  return name;
}

function documentExtension(mediaType: DocumentMimeType): string {
  const extensions: Record<DocumentMimeType, string> = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "text/csv": ".csv",
    "text/tab-separated-values": ".tsv",
  };
  return extensions[mediaType] ?? ".bin";
}

function pdfRejection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  reason: BrowserPdfIntakeRejectionReason,
  filename: string | null,
): BrowserPdfIntakeRejection {
  return Object.freeze(
    filename === null
      ? {
          source,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        }
      : {
          source,
          filename,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        },
  );
}

function pdfSelection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  mediaType: DocumentMimeType,
  filename: string,
): AttachmentSelection<BrowserAttachmentSource> {
  return Object.freeze({
    source,
    kind: "document",
    fingerprint,
    idempotencyKey: `browser-pdf-intake:${fingerprint.slice("browser-pdf:".length)}`,
    mediaType,
    byteSize: source.size,
    filename,
  });
}

const disposePdfIntake = (): void => undefined;

function intakePdfs(
  sources: readonly BrowserAttachmentSource[],
  rawOptions: BrowserPdfIntakeOptions,
): BrowserPdfIntakeResult {
  const options = validatePdfOptions(rawOptions);
  const seen = new Set(options.existingFingerprints);
  const selections: AttachmentSelection<BrowserAttachmentSource>[] = [];
  const rejections: BrowserPdfIntakeRejection[] = [];

  for (const source of sources) {
    const fingerprint = fingerprintBrowserPdf(source);
    const filename = safePdfFilename(source, fingerprint);
    const mediaType = source.type;
    if (filename === null) {
      rejections.push(
        pdfRejection(source, fingerprint, "unsafe_filename", filename),
      );
      continue;
    }
    if (!options.acceptedMediaTypes.has(mediaType as DocumentMimeType)) {
      rejections.push(
        pdfRejection(source, fingerprint, "unsupported_type", filename),
      );
      continue;
    }
    if (!Number.isSafeInteger(source.size) || source.size < 1) {
      rejections.push(pdfRejection(source, fingerprint, "empty_file", filename));
      continue;
    }
    if (source.size > options.maxFileBytes) {
      rejections.push(pdfRejection(source, fingerprint, "too_large", filename));
      continue;
    }
    if (seen.has(fingerprint)) {
      rejections.push(pdfRejection(source, fingerprint, "duplicate", filename));
      continue;
    }
    if (
      options.existingSelectionCount + selections.length >=
      options.maxSelectionCount
    ) {
      rejections.push(
        pdfRejection(source, fingerprint, "count_overflow", filename),
      );
      continue;
    }
    seen.add(fingerprint);
    selections.push(
      pdfSelection(source, fingerprint, mediaType as DocumentMimeType, filename),
    );
  }

  return Object.freeze({
    selections: Object.freeze(selections),
    rejections: Object.freeze(rejections),
    dispose: disposePdfIntake,
  });
}

function pdfSourcesFromList(
  files: FileList | readonly BrowserAttachmentSource[],
): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  const item = "item" in files && typeof files.item === "function"
    ? files.item.bind(files)
    : undefined;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] ?? item?.(index);
    if (file !== null && file !== undefined) sources.push(file);
  }
  return sources;
}

/** Accepts a file input's FileList, or host-owned Blobs, in source order. */
export function intakeFileInputPdfs(
  files: FileList | readonly BrowserAttachmentSource[],
  options: BrowserPdfIntakeOptions,
): BrowserPdfIntakeResult {
  return intakePdfs(pdfSourcesFromList(files), options);
}

/** Extracts file-kind drop items and recommends consuming only accepted document drops. */
export function intakeDroppedPdfs(
  dataTransfer: DataTransfer,
  options: BrowserPdfIntakeOptions,
): BrowserDropPdfIntakeResult {
  const itemFiles = filesFromItems(dataTransfer.items);
  const result = intakePdfs(
    itemFiles.length > 0 ? itemFiles : filesFromList(dataTransfer.files),
    options,
  );
  return Object.freeze({
    ...result,
    shouldPreventDefault: result.selections.length > 0,
  });
}

/** Generic names for document intake. The PDF names remain as compatibility aliases. */
export const BROWSER_DOCUMENT_INTAKE_REJECTION_REASONS =
  BROWSER_PDF_INTAKE_REJECTION_REASONS;
export type BrowserDocumentIntakeRejectionReason = BrowserPdfIntakeRejectionReason;
export type BrowserDocumentExistingSelection = BrowserPdfExistingSelection;
export type BrowserDocumentIntakeOptions = BrowserPdfIntakeOptions;
export type BrowserDocumentIntakeRejection = BrowserPdfIntakeRejection;
export type BrowserDocumentIntakeResult = BrowserPdfIntakeResult;
export type BrowserDropDocumentIntakeResult = BrowserDropPdfIntakeResult;
export { BrowserPdfIntakeValidationError as BrowserDocumentIntakeValidationError };
export const fingerprintBrowserDocument = fingerprintBrowserPdf;
export const intakeFileInputDocuments = intakeFileInputPdfs;
export const intakeDroppedDocuments = intakeDroppedPdfs;
