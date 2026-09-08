import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import type {
  AttachmentSelection,
  AttachmentUploadFailure,
  AttachmentUploadItem,
  AttachmentUploadKind,
} from "../attachments/types.js";
import type { AttachmentUploader } from "../attachments/uploader.js";
import {
  intakeClipboardImages,
  intakeDroppedImages,
  intakeDroppedPdfs,
  intakeFileInputImages,
  intakeFileInputPdfs,
  type BrowserAttachmentSource,
  type BrowserDropImageIntakeResult,
  type BrowserDropPdfIntakeResult,
  type BrowserImageIntakeOptions,
  type BrowserImageIntakeRejection,
  type BrowserImageIntakeResult,
  type BrowserImagePreview,
  type BrowserPdfIntakeOptions,
  type BrowserPdfIntakeRejection,
  type BrowserPdfIntakeResult,
} from "../browser/attachments.js";
import type {
  ConversationAttachmentId,
  ConversationAttachmentReference,
  ConversationId,
} from "../conversation/events.js";
import type { PresenceController } from "../presence/controller.js";
import {
  AI_RUNTIME_DOCUMENT_MIME_TYPES,
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type AttachmentReference,
  type AttachmentMimeType,
  type DocumentMimeType,
  type ImageMimeType,
} from "../protocol.js";
import type {
  ConversationRuntimeError,
  ConversationRuntimeTurnResult,
} from "../runtime.js";
import { useConversationActions, useConversationSelector } from "./hooks.js";

export type ConversationComposerEnterBehavior = "newline" | "send";

export interface ConversationComposerImageIntakeOptions {
  readonly acceptedMediaTypes?: readonly ImageMimeType[];
  readonly maxFileBytes?: number;
  readonly maxSelectionCount?: number;
  readonly previews?: BrowserImageIntakeOptions["previews"];
}

export interface ConversationComposerAttachmentIntakeOptions {
  /** Defaults to every protocol image and document MIME type. */
  readonly acceptedMediaTypes?: readonly AttachmentMimeType[];
  /** Per-kind byte limits, bounded by the protocol maxima. */
  readonly maxFileBytes?: Readonly<Partial<Record<AttachmentUploadKind, number>>>;
  /** Per-kind selection limits, bounded by the protocol per-message maxima. */
  readonly maxSelectionCount?: Readonly<Partial<Record<AttachmentUploadKind, number>>>;
  /** Image-only object-URL previews. Documents never create previews. */
  readonly previews?: BrowserImageIntakeOptions["previews"];
}

export interface ConversationComposerSubmission {
  readonly text: string;
  readonly attachments: readonly AttachmentReference[];
}

export interface UseConversationComposerOptions<TRequest = undefined> {
  /** May be shared: the hook removes only upload items created by this instance. */
  readonly uploader: AttachmentUploader<BrowserAttachmentSource>;
  /** Optional ephemeral controller. It remains host-owned. */
  readonly presence?: Pick<
    PresenceController,
    "noteActivity" | "setTyping" | "stopTyping" | "switchConversation"
  >;
  /** Static transport request used when createRequest is omitted. */
  readonly request?: TRequest;
  /** Build the transport request from the exact draft and ready references submitted. */
  readonly createRequest?: (submission: ConversationComposerSubmission) => TRequest;
  /** Defaults to send. Shift+Enter inserts a newline; use newline to opt out. */
  readonly enterBehavior?: ConversationComposerEnterBehavior;
  /** Overrides the provider store identity for lifecycle switching. */
  readonly conversationId?: ConversationId;
  /**
   * Opts into mixed image/document intake. When present, this option takes precedence
   * over imageIntake, including when both are supplied.
   */
  readonly attachmentIntake?: ConversationComposerAttachmentIntakeOptions;
  /**
   * Backward-compatible image-only intake alias. Existing defaults and behavior
   * are retained when imageIntake is explicitly supplied. With neither option, mixed intake is enabled.
   */
  readonly imageIntake?: ConversationComposerImageIntakeOptions;
  /** Narrow cancellation seam; no runtime cancellation contract is assumed here. */
  readonly onCancel?: () => void | Promise<void>;
  readonly initialDraft?: string;
}

export type ConversationComposerAttachmentStatus =
  | AttachmentUploadItem["status"]
  | "missing";

export interface ConversationComposerAttachment {
  readonly id: string;
  readonly fingerprint: string;
  /** The composer-local browser file/blob selected by the user. */
  readonly source: BrowserAttachmentSource;
  readonly filename?: string;
  readonly kind: AttachmentUploadKind;
  readonly mediaType: AttachmentMimeType;
  readonly byteSize: number;
  readonly previewUrl?: string;
  readonly status: ConversationComposerAttachmentStatus;
  readonly progress: {
    readonly uploadedBytes: number;
    readonly totalBytes: number;
  };
  readonly reference?: AttachmentReference;
  readonly error?: AttachmentUploadFailure;
  readonly retryable: boolean;
  readonly cancellable: boolean;
}

export type ConversationComposerError =
  | {
      readonly source: "intake";
      readonly code:
        | BrowserImageIntakeRejection["reason"]
        | BrowserPdfIntakeRejection["reason"]
        | "intake_failed";
      readonly message: string;
      readonly retryable: false;
      readonly fingerprint?: string;
      readonly filename?: string;
    }
  | {
      readonly source: "upload";
      readonly code: AttachmentUploadFailure["code"] | "cancelled" | "missing";
      readonly message: string;
      readonly retryable: boolean;
      readonly attachmentId: string;
    }
  | {
      readonly source: "send";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    }
  | {
      readonly source: "cancel";
      readonly code: "cancel_failed";
      readonly message: string;
      readonly retryable: true;
    };

export interface ConversationComposerTextareaProps {
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onCompositionStart: (event: CompositionEvent<HTMLTextAreaElement>) => void;
  readonly onCompositionEnd: (event: CompositionEvent<HTMLTextAreaElement>) => void;
}

export interface ConversationComposerFileInputProps {
  readonly accept: string;
  readonly multiple: true;
  readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface ConversationComposerDropProps {
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface ConversationComposerResult {
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly attachments: readonly ConversationComposerAttachment[];
  readonly errors: readonly ConversationComposerError[];
  /** Blocks every submit path until the returned idempotent release function is called. */
  readonly acquireSubmissionBlock: () => () => void;
  readonly canSend: boolean;
  readonly isSending: boolean;
  readonly submit: (
    event?: FormEvent<Element>,
  ) => Promise<ConversationRuntimeTurnResult | null>;
  readonly cancel: () => Promise<boolean>;
  readonly stop: () => Promise<boolean>;
  readonly retryAttachment: (attachmentId: string) => boolean;
  readonly cancelAttachment: (attachmentId: string) => boolean;
  readonly removeAttachment: (attachmentId: string) => boolean;
  readonly getTextareaProps: () => ConversationComposerTextareaProps;
  readonly getFileInputProps: () => ConversationComposerFileInputProps;
  readonly getDropProps: () => ConversationComposerDropProps;
}

interface OwnedAttachment {
  readonly id: string;
  readonly fingerprint: string;
  readonly source: BrowserAttachmentSource;
  readonly filename?: string;
  readonly kind: AttachmentUploadKind;
  readonly mediaType: AttachmentMimeType;
  readonly byteSize: number;
  readonly preview?: BrowserImagePreview;
}

type IntakeRejectionReason =
  | BrowserImageIntakeRejection["reason"]
  | BrowserPdfIntakeRejection["reason"];

interface ComposerIntakeRejection {
  readonly reason: IntakeRejectionReason;
  readonly fingerprint?: string;
  readonly filename?: string;
}

interface ComposerIntakeResult {
  readonly selections: readonly AttachmentSelection<BrowserAttachmentSource>[];
  readonly rejections: readonly ComposerIntakeRejection[];
  readonly previews: readonly BrowserImagePreview[];
  readonly shouldPreventDefault: boolean;
  dispose(): void;
}

const INTAKE_MESSAGES: Record<IntakeRejectionReason, string> = {
  unsupported_type: "The selected file is not a supported attachment type.",
  too_large: "The selected attachment is too large.",
  count_overflow: "The attachment selection limit has been reached.",
  duplicate: "The selected attachment is already attached.",
  empty_file: "The selected attachment is empty.",
  unsafe_filename: "The selected attachment has an unsafe filename.",
};

const IMAGE_MIME_TYPES = new Set<string>(AI_RUNTIME_IMAGE_MIME_TYPES);
const DOCUMENT_MIME_TYPES = new Set<string>(AI_RUNTIME_DOCUMENT_MIME_TYPES);

function validateAttachmentIntakeOptions(
  options: ConversationComposerAttachmentIntakeOptions,
): void {
  const accepted = options.acceptedMediaTypes ?? [
    ...AI_RUNTIME_IMAGE_MIME_TYPES,
    ...AI_RUNTIME_DOCUMENT_MIME_TYPES,
  ];
  if (
    accepted.length === 0 ||
    accepted.some((mediaType) =>
      !IMAGE_MIME_TYPES.has(mediaType) && !DOCUMENT_MIME_TYPES.has(mediaType)
    )
  ) {
    throw new TypeError(
      "attachmentIntake.acceptedMediaTypes must contain protocol attachment MIME types",
    );
  }
  const validateBytes = (
    kind: AttachmentUploadKind,
    minimum: number,
    maximum: number,
  ): void => {
    const value = options.maxFileBytes?.[kind];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    ) {
      throw new TypeError(
        `attachmentIntake.maxFileBytes.${kind} must be an integer from ${minimum} through ${maximum}`,
      );
    }
  };
  const validateCount = (kind: AttachmentUploadKind, maximum: number): void => {
    const value = options.maxSelectionCount?.[kind];
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    ) {
      throw new TypeError(
        `attachmentIntake.maxSelectionCount.${kind} must be an integer from 1 through ${maximum}`,
      );
    }
  };
  validateBytes(
    "image",
    AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes,
    AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes,
  );
  validateBytes(
    "document",
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMinBytes,
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes,
  );
  validateCount("image", AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage);
  validateCount("document", AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage);
}

type ImageResult = BrowserImageIntakeResult | BrowserDropImageIntakeResult;
type PdfResult = BrowserPdfIntakeResult | BrowserDropPdfIntakeResult;

function filesFromList(files: FileList): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const source = files[index] ?? files.item(index);
    if (source !== null && source !== undefined) sources.push(source);
  }
  return sources;
}

function filesFromItems(items: DataTransferItemList): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "file") continue;
    const source = item.getAsFile();
    if (source !== null) sources.push(source);
  }
  return sources;
}

function filesFromTransfer(dataTransfer: DataTransfer): BrowserAttachmentSource[] {
  const items = filesFromItems(dataTransfer.items);
  return items.length > 0 ? items : filesFromList(dataTransfer.files);
}

type IntakeRecord =
  | { readonly selection: AttachmentSelection<BrowserAttachmentSource> }
  | { readonly rejection: ComposerIntakeRejection };

function recordsBySource(
  result: ImageResult | PdfResult,
): Map<BrowserAttachmentSource, IntakeRecord[]> {
  const records = new Map<BrowserAttachmentSource, IntakeRecord[]>();
  const add = (source: BrowserAttachmentSource, record: IntakeRecord): void => {
    const current = records.get(source);
    if (current === undefined) records.set(source, [record]);
    else current.push(record);
  };
  for (const selection of result.selections) add(selection.source, { selection });
  for (const rejection of result.rejections) {
    add(rejection.source, {
      rejection: {
        reason: rejection.reason,
        fingerprint: rejection.fingerprint,
        ...(rejection.filename === undefined ? {} : { filename: rejection.filename }),
      },
    });
  }
  return records;
}

function combineIntake(
  sources: readonly BrowserAttachmentSource[],
  imageResult: ImageResult | undefined,
  pdfResult: PdfResult | undefined,
): ComposerIntakeResult {
  const imageRecords = imageResult === undefined
    ? new Map<BrowserAttachmentSource, IntakeRecord[]>()
    : recordsBySource(imageResult);
  const pdfRecords = pdfResult === undefined
    ? new Map<BrowserAttachmentSource, IntakeRecord[]>()
    : recordsBySource(pdfResult);
  const selections: AttachmentSelection<BrowserAttachmentSource>[] = [];
  const rejections: ComposerIntakeRejection[] = [];

  for (const source of sources) {
    const imageRecord = imageRecords.get(source)?.shift();
    const pdfRecord = pdfRecords.get(source)?.shift();
    const accepted = imageRecord && "selection" in imageRecord
      ? imageRecord.selection
      : pdfRecord && "selection" in pdfRecord
        ? pdfRecord.selection
        : undefined;
    if (accepted !== undefined) {
      selections.push(accepted);
      continue;
    }
    const preferred = DOCUMENT_MIME_TYPES.has(source.type)
      ? pdfRecord
      : IMAGE_MIME_TYPES.has(source.type)
        ? imageRecord
        : imageRecord ?? pdfRecord;
    rejections.push(
      preferred && "rejection" in preferred
        ? preferred.rejection
        : { reason: "unsupported_type" },
    );
  }

  let disposed = false;
  return Object.freeze({
    selections: Object.freeze(selections),
    rejections: Object.freeze(rejections),
    previews: Object.freeze([...(imageResult?.previews ?? [])]),
    shouldPreventDefault: selections.length > 0,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      imageResult?.dispose();
      pdfResult?.dispose();
    },
  });
}

function compactHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function durableAttachment(reference: AttachmentReference): ConversationAttachmentReference {
  const mediaType = AI_RUNTIME_DOCUMENT_MIME_TYPES.find((type) => type === reference.media_type);
  const attachment = {
    attachment_id: reference.attachment_id as ConversationAttachmentId,
    media_type: reference.media_type,
    ...(reference.filename === undefined ? {} : { filename: reference.filename }),
    size_bytes: reference.byte_size,
  };
  return mediaType ? { ...attachment, kind: "document", media_type: mediaType } : attachment;
}

function sendError(error: ConversationRuntimeError): ConversationComposerError {
  return {
    source: "send",
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
}

/**
 * Coordinate draft, browser attachment intake, uploads, typing, and submission
 * without rendering markup or imposing presentation semantics.
 */
export function useConversationComposer<TRequest = undefined>(
  options: UseConversationComposerOptions<TRequest>,
): ConversationComposerResult {
  const actions = useConversationActions<TRequest>();
  const storeConversationId = useConversationSelector((state) => state.conversation_id);
  const activeTurnId = useConversationSelector((state) => state.active_turn_id);
  const reactId = useId();
  const scope = useMemo(() => compactHash(reactId), [reactId]);
  const {
    uploader,
    presence,
    request,
    createRequest,
    enterBehavior = "send",
    onCancel,
  } = options;
  const conversationId = options.conversationId ?? storeConversationId;
  const generalizedIntake = options.attachmentIntake ?? (options.imageIntake === undefined ? {} : undefined);
  if (generalizedIntake !== undefined) validateAttachmentIntakeOptions(generalizedIntake);
  const acceptedMediaTypes: readonly AttachmentMimeType[] = generalizedIntake === undefined
    ? options.imageIntake?.acceptedMediaTypes ?? AI_RUNTIME_IMAGE_MIME_TYPES
    : generalizedIntake.acceptedMediaTypes ?? [
      ...AI_RUNTIME_IMAGE_MIME_TYPES,
      ...AI_RUNTIME_DOCUMENT_MIME_TYPES,
    ];
  const acceptedImageMediaTypes = acceptedMediaTypes.filter(
    (mediaType): mediaType is ImageMimeType => IMAGE_MIME_TYPES.has(mediaType),
  );
  const acceptedDocumentMediaTypes = acceptedMediaTypes.filter(
    (mediaType): mediaType is DocumentMimeType => DOCUMENT_MIME_TYPES.has(mediaType),
  );
  const maxImageFileBytes = generalizedIntake === undefined
    ? options.imageIntake?.maxFileBytes ??
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes
    : generalizedIntake.maxFileBytes?.image ??
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes;
  const maxDocumentFileBytes = generalizedIntake?.maxFileBytes?.document ??
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes;
  const maxImageSelectionCount = generalizedIntake === undefined
    ? options.imageIntake?.maxSelectionCount ??
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage
    : generalizedIntake.maxSelectionCount?.image ??
      AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage;
  const maxDocumentSelectionCount = generalizedIntake?.maxSelectionCount?.document ??
    AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage;
  const previews = generalizedIntake === undefined
    ? options.imageIntake?.previews ?? true
    : generalizedIntake.previews ?? true;

  const [draft, setDraftState] = useState(options.initialDraft ?? "");
  const [owned, setOwned] = useState<readonly OwnedAttachment[]>([]);
  const [snapshot, setSnapshot] = useState(() => uploader.getSnapshot());
  const [operationErrors, setOperationErrors] = useState<
    readonly ConversationComposerError[]
  >([]);
  const [isSending, setIsSending] = useState(false);
  const sendingRef = useRef(false);
  const submissionBlocks = useRef(new Set<symbol>());
  const [submissionBlockCount, setSubmissionBlockCount] = useState(0);
  const acquireSubmissionBlock = useCallback(() => {
    const token = Symbol("composer task");
    submissionBlocks.current.add(token);
    setSubmissionBlockCount(submissionBlocks.current.size);
    return () => {
      if (submissionBlocks.current.delete(token)) {
        setSubmissionBlockCount(submissionBlocks.current.size);
      }
    };
  }, []);
  const composing = useRef(false);
  const draftRef = useRef(draft);
  const ownedRef = useRef(owned);
  const uploaderRef = useRef(uploader);
  const presenceRef = useRef(presence);
  const lifecycleRef = useRef({
    conversationId,
    uploader,
    presence,
    initialized: false,
  });

  draftRef.current = draft;
  ownedRef.current = owned;
  uploaderRef.current = uploader;
  presenceRef.current = presence;

  useEffect(() => {
    setSnapshot(uploader.getSnapshot());
    return uploader.subscribe(setSnapshot);
  }, [uploader]);

  const releaseOwned = useCallback(
    (
      entries: readonly OwnedAttachment[],
      targetUploader = uploaderRef.current,
    ): void => {
      for (const entry of entries) {
        try {
          targetUploader.remove(entry.id);
        } catch {
          // A host-disposed uploader must not prevent preview cleanup.
        }
        try {
          entry.preview?.revoke();
        } catch {
          // Continue releasing later previews when one host URL call fails.
        }
      }
    },
    [],
  );

  useEffect(() => {
    const previous = lifecycleRef.current;
    if (!previous.initialized) {
      previous.initialized = true;
      return;
    }
    if (
      previous.conversationId === conversationId &&
      previous.uploader === uploader &&
      previous.presence === presence
    ) {
      return;
    }

    const previousOwned = ownedRef.current;
    releaseOwned(previousOwned, previous.uploader);
    ownedRef.current = [];
    setOwned([]);
    draftRef.current = "";
    setDraftState("");
    setOperationErrors([]);
    previous.presence?.stopTyping("conversation_switch");
    if (conversationId !== null) presence?.switchConversation(conversationId);
    lifecycleRef.current = {
      conversationId,
      uploader,
      presence,
      initialized: true,
    };
  }, [conversationId, presence, releaseOwned, uploader]);

  useEffect(() => () => {
    releaseOwned(ownedRef.current, uploaderRef.current);
    presenceRef.current?.stopTyping("destroy");
  }, [releaseOwned]);

  const itemById = useMemo(
    () => new Map(snapshot.items.map((item) => [item.id, item])),
    [snapshot],
  );
  const attachments = useMemo<readonly ConversationComposerAttachment[]>(
    () => owned.map((entry) => {
      const item = itemById.get(entry.id);
      if (item === undefined) {
        return {
          id: entry.id,
          fingerprint: entry.fingerprint,
          source: entry.source,
          ...(entry.filename === undefined ? {} : { filename: entry.filename }),
          kind: entry.kind,
          mediaType: entry.mediaType,
          byteSize: entry.byteSize,
          ...(entry.preview === undefined ? {} : { previewUrl: entry.preview.url }),
          status: "missing",
          progress: { uploadedBytes: 0, totalBytes: entry.byteSize },
          retryable: false,
          cancellable: false,
        };
      }
      return {
        id: entry.id,
        fingerprint: entry.fingerprint,
        source: entry.source,
        ...(entry.filename === undefined ? {} : { filename: entry.filename }),
        kind: entry.kind,
        mediaType: entry.mediaType,
        byteSize: entry.byteSize,
        ...(entry.preview === undefined ? {} : { previewUrl: entry.preview.url }),
        status: item.status,
        progress: item.progress,
        ...(item.status === "ready" ? { reference: item.reference } : {}),
        ...(item.status === "failed" ? { error: item.error } : {}),
        retryable: item.status === "failed" && item.error.retryable,
        cancellable: item.status === "queued" || item.status === "uploading",
      };
    }),
    [itemById, owned],
  );

  const uploadErrors = useMemo<readonly ConversationComposerError[]>(() =>
    attachments.flatMap((attachment): readonly ConversationComposerError[] => {
      if (attachment.status === "failed" && attachment.error !== undefined) {
        return [{
          source: "upload",
          code: attachment.error.code,
          message: attachment.error.message,
          retryable: attachment.error.retryable,
          attachmentId: attachment.id,
        }];
      }
      if (attachment.status === "cancelled" || attachment.status === "missing") {
        return [{
          source: "upload",
          code: attachment.status,
          message: attachment.status === "cancelled"
            ? "The attachment upload was cancelled."
            : "The attachment upload is no longer available.",
          retryable: false,
          attachmentId: attachment.id,
        }];
      }
      return [];
    }), [attachments]);
  const errors = useMemo(
    () => Object.freeze([...operationErrors, ...uploadErrors]),
    [operationErrors, uploadErrors],
  );
  const uploadsReady = attachments.every((attachment) => attachment.status === "ready");
  const hasContent = draft.trim().length > 0 || attachments.length > 0;
  const canSend = submissionBlockCount === 0 && !isSending && activeTurnId === null && hasContent && uploadsReady;

  const updateDraft = useCallback((nextDraft: string): void => {
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    // A send/cancel failure describes the previous attempt. Once the user
    // edits the draft it is no longer actionable and must not linger beside a
    // new message (intake errors remain until the next intake operation).
    setOperationErrors((current) => current.some(
      (error) => error.source === "send" || error.source === "cancel",
    ) ? current.filter(
        (error) => error.source !== "send" && error.source !== "cancel",
      ) : current);
    presence?.noteActivity();
    if (nextDraft.length === 0) presence?.stopTyping("explicit");
    else presence?.setTyping(true);
  }, [presence]);

  const imageOptions = useCallback((): BrowserImageIntakeOptions => ({
    acceptedMediaTypes: acceptedImageMediaTypes,
    maxFileBytes: maxImageFileBytes,
    maxSelectionCount: maxImageSelectionCount,
    existingFingerprints: ownedRef.current.map((entry) => entry.fingerprint),
    existingSelectionCount: ownedRef.current.filter((entry) => entry.kind === "image").length,
    previews,
  }), [acceptedImageMediaTypes, maxImageFileBytes, maxImageSelectionCount, previews]);

  const pdfOptions = useCallback((): BrowserPdfIntakeOptions => ({
    acceptedMediaTypes: acceptedDocumentMediaTypes,
    maxFileBytes: maxDocumentFileBytes,
    maxSelectionCount: maxDocumentSelectionCount,
    existingSelections: ownedRef.current.map((entry) => ({
      fingerprint: entry.fingerprint,
      kind: entry.kind,
    })),
  }), [
    acceptedDocumentMediaTypes,
    maxDocumentFileBytes,
    maxDocumentSelectionCount,
  ]);

  const acceptIntake = useCallback((result: ComposerIntakeResult) => {
    const added: OwnedAttachment[] = [];
    try {
      for (const selection of result.selections) {
        const preview = result.previews.find(
          (candidate) => candidate.fingerprint === selection.fingerprint,
        );
        const id = uploader.enqueue({
          ...selection,
          ...(conversationId === null ? {} : { conversationId }),
          fingerprint: `composer:${scope}:${compactHash(selection.fingerprint)}`,
          idempotencyKey: `composer:${scope}:${compactHash(selection.idempotencyKey)}`,
        });
        added.push({
          id,
          fingerprint: selection.fingerprint,
          source: selection.source,
          ...(selection.filename === undefined ? {} : { filename: selection.filename }),
          kind: selection.kind ?? "image",
          mediaType: selection.mediaType,
          byteSize: selection.byteSize,
          ...(preview === undefined ? {} : { preview }),
        });
      }
    } catch {
      releaseOwned(added);
      result.dispose();
      setOperationErrors([{
        source: "intake",
        code: "intake_failed",
        message: "The selected attachments could not be prepared.",
        retryable: false,
      }]);
      return;
    }

    if (added.length > 0) {
      setOwned((current) => {
        const next = [...current, ...added];
        ownedRef.current = next;
        return next;
      });
    }
    setOperationErrors(result.rejections.map((rejection) => ({
      source: "intake" as const,
      code: rejection.reason,
      message: INTAKE_MESSAGES[rejection.reason],
      retryable: false as const,
      ...(rejection.fingerprint === undefined
        ? {}
        : { fingerprint: rejection.fingerprint }),
      ...(rejection.filename === undefined ? {} : { filename: rejection.filename }),
    })));
  }, [conversationId, releaseOwned, scope, uploader]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const sources = filesFromItems(event.clipboardData.items);
    const imageResult = acceptedImageMediaTypes.length === 0
      ? undefined
      : intakeClipboardImages(event.clipboardData.items, imageOptions());
    const pdfResult = generalizedIntake === undefined || acceptedDocumentMediaTypes.length === 0
      ? undefined
      : intakeFileInputPdfs(sources, pdfOptions());
    const result = combineIntake(sources, imageResult, pdfResult);
    if (result.shouldPreventDefault) event.preventDefault();
    acceptIntake(result);
  }, [
    acceptIntake,
    acceptedDocumentMediaTypes.length,
    acceptedImageMediaTypes.length,
    generalizedIntake,
    imageOptions,
    pdfOptions,
  ]);

  const handleFileInputChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    if (event.currentTarget.files === null) return;
    const files = event.currentTarget.files;
    const sources = filesFromList(files);
    const imageResult = acceptedImageMediaTypes.length === 0
      ? undefined
      : intakeFileInputImages(files, imageOptions());
    const pdfResult = generalizedIntake === undefined || acceptedDocumentMediaTypes.length === 0
      ? undefined
      : intakeFileInputPdfs(files, pdfOptions());
    acceptIntake(combineIntake(sources, imageResult, pdfResult));
  }, [
    acceptIntake,
    acceptedDocumentMediaTypes.length,
    acceptedImageMediaTypes.length,
    generalizedIntake,
    imageOptions,
    pdfOptions,
  ]);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>): void => {
    // Files are hidden during dragover; inspect the transfer types instead.
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>): void => {
    const sources = filesFromTransfer(event.dataTransfer);
    if (sources.length === 0) return;
    // Even a rejected file must not navigate away from the conversation.
    event.preventDefault();
    const imageResult = acceptedImageMediaTypes.length === 0
      ? undefined
      : intakeDroppedImages(event.dataTransfer, imageOptions());
    const pdfResult = generalizedIntake === undefined || acceptedDocumentMediaTypes.length === 0
      ? undefined
      : intakeDroppedPdfs(event.dataTransfer, pdfOptions());
    const result = combineIntake(sources, imageResult, pdfResult);
    acceptIntake(result);
  }, [
    acceptIntake,
    acceptedDocumentMediaTypes.length,
    acceptedImageMediaTypes.length,
    generalizedIntake,
    imageOptions,
    pdfOptions,
  ]);

  const removeAttachment = useCallback((attachmentId: string): boolean => {
    const entry = ownedRef.current.find((candidate) => candidate.id === attachmentId);
    if (entry === undefined) return false;
    releaseOwned([entry]);
    setOwned((current) => {
      const next = current.filter((candidate) => candidate.id !== attachmentId);
      ownedRef.current = next;
      return next;
    });
    return true;
  }, [releaseOwned]);

  const retryAttachment = useCallback((attachmentId: string): boolean => {
    if (!ownedRef.current.some((entry) => entry.id === attachmentId)) return false;
    try {
      return uploader.retry(attachmentId);
    } catch {
      return false;
    }
  }, [uploader]);

  const cancelAttachment = useCallback((attachmentId: string): boolean => {
    const entry = ownedRef.current.find((candidate) => candidate.id === attachmentId);
    if (entry === undefined) return false;
    try {
      if (!uploader.cancel(attachmentId)) return false;
    } catch {
      return false;
    }
    releaseOwned([entry]);
    setOwned((current) => {
      const next = current.filter((candidate) => candidate.id !== attachmentId);
      ownedRef.current = next;
      return next;
    });
    return true;
  }, [releaseOwned, uploader]);

  const submit = useCallback(async (
    event?: FormEvent<Element>,
  ): Promise<ConversationRuntimeTurnResult | null> => {
    event?.preventDefault();
    const currentOwned = ownedRef.current;
    const currentItems = new Map(
      uploader.getSnapshot().items.map((item) => [item.id, item]),
    );
    const readyReferences = currentOwned.flatMap((entry) => {
      const item = currentItems.get(entry.id);
      return item?.status === "ready" ? [item.reference] : [];
    });
    const currentDraft = draftRef.current;
    const eligible = submissionBlocks.current.size === 0 && !sendingRef.current && activeTurnId === null &&
      (currentDraft.trim().length > 0 || currentOwned.length > 0) &&
      readyReferences.length === currentOwned.length;
    if (!eligible) return null;

    sendingRef.current = true;
    setIsSending(true);
    setOperationErrors([]);
    const submission = Object.freeze({
      text: currentDraft,
      attachments: Object.freeze(readyReferences),
    });
    try {
      const outcome = await actions.sendMessage({
        content: currentDraft.trim().length === 0 ? [] : currentDraft,
        attachments: readyReferences.map(durableAttachment),
        request: createRequest === undefined ? request as TRequest : createRequest(submission),
      });
      if (outcome.status !== "completed") {
        setOperationErrors([outcome.error === undefined
          ? {
              source: "send",
              code: `turn_${outcome.status}`,
              message: `The conversation turn ended with status ${outcome.status}.`,
              retryable: outcome.status === "disconnected" || outcome.status === "interrupted",
            }
          : sendError(outcome.error)]);
        return outcome;
      }

      releaseOwned(currentOwned);
      setOwned((current) => {
        const submittedIds = new Set(currentOwned.map((entry) => entry.id));
        const next = current.filter((entry) => !submittedIds.has(entry.id));
        ownedRef.current = next;
        return next;
      });
      setDraftState((current) => {
        const next = current === currentDraft ? "" : current;
        draftRef.current = next;
        return next;
      });
      presence?.stopTyping("send");
      return outcome;
    } catch {
      setOperationErrors([{
        source: "send",
        code: "send_failed",
        message: "The message could not be sent. Check your connection and try again.",
        retryable: true,
      }]);
      return null;
    } finally {
      sendingRef.current = false;
      setIsSending(false);
    }
  }, [actions, activeTurnId, createRequest, presence, releaseOwned, request, uploader]);

  const cancel = useCallback(async (): Promise<boolean> => {
    if (onCancel === undefined) return false;
    try {
      await onCancel();
      presence?.stopTyping("explicit");
      return true;
    } catch {
      setOperationErrors([{
        source: "cancel",
        code: "cancel_failed",
        message: "The active response could not be stopped.",
        retryable: true,
      }]);
      return false;
    }
  }, [onCancel, presence]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
    if (
      event.defaultPrevented ||
      enterBehavior !== "send" ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      composing.current ||
      nativeEvent.isComposing ||
      nativeEvent.keyCode === 229
    ) {
      return;
    }
    // In send-on-Enter mode, plain Enter has one stable meaning. If a turn is
    // already active (or the draft is otherwise ineligible), swallow it
    // instead of unexpectedly inserting a newline. Shift+Enter remains the
    // explicit newline gesture.
    event.preventDefault();
    if (event.repeat || !canSend) return;
    void submit();
  }, [canSend, enterBehavior, submit]);

  const textareaProps = useMemo<ConversationComposerTextareaProps>(() => ({
    value: draft,
    onChange: (event) => updateDraft(event.currentTarget.value),
    onPaste: handlePaste,
    onBlur: () => presence?.stopTyping("blur"),
    onKeyDown: handleKeyDown,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
  }), [draft, handleKeyDown, handlePaste, presence, updateDraft]);
  const fileInputProps = useMemo<ConversationComposerFileInputProps>(() => ({
    accept: acceptedMediaTypes.join(","),
    multiple: true,
    onChange: handleFileInputChange,
  }), [acceptedMediaTypes, handleFileInputChange]);
  const dropProps = useMemo<ConversationComposerDropProps>(() => ({
    onDragOver: handleDragOver,
    onDrop: handleDrop,
  }), [handleDragOver, handleDrop]);

  return useMemo(() => Object.freeze({
    draft,
    setDraft: updateDraft,
    acquireSubmissionBlock,
    attachments,
    errors,
    canSend,
    isSending,
    submit,
    cancel,
    stop: cancel,
    retryAttachment,
    cancelAttachment,
    removeAttachment,
    getTextareaProps: () => textareaProps,
    getFileInputProps: () => fileInputProps,
    getDropProps: () => dropProps,
  }), [
    acquireSubmissionBlock,
    attachments,
    canSend,
    cancelAttachment,
    cancel,
    draft,
    dropProps,
    errors,
    fileInputProps,
    isSending,
    removeAttachment,
    retryAttachment,
    submit,
    textareaProps,
    updateDraft,
  ]);
}
