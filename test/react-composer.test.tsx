/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttachmentUploadAdapterError,
  createAttachmentUploader,
  createConversationStore,
  type AttachmentReference,
  type AttachmentUploadRequest,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeTurnResult,
} from "../src/index.js";
import {
  ConversationProvider,
  useConversationComposer,
  type ConversationComposerAttachmentIntakeOptions,
  type ConversationComposerResult,
  type UseConversationComposerOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

it("clears the failed Stop error after a successful retry and preserves the draft", async () => {
  const { runtime } = fakeRuntime();
  const uploader = immediateUploader();
  const onCancel = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
  const { result, unmount } = renderHook(() => useConversationComposer({ uploader, onCancel, initialDraft: "My next question" }),
    { wrapper: wrapper(runtime) });
  await act(async () => { expect(await result.current.cancel()).toBe(false); });
  expect(result.current.errors).toContainEqual(expect.objectContaining({ source: "cancel" }));
  await act(async () => { expect(await result.current.cancel()).toBe(true); });
  expect(result.current.errors).toEqual([]);
  expect(result.current.draft).toBe("My next question");
  unmount(); uploader.dispose();
});

const completed = (status: ConversationRuntimeTurnResult["status"] = "completed") => ({
  turnId: "turn_composer",
  status,
  checkpoint: {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  },
}) as ConversationRuntimeTurnResult;

it.each(["completed", "failed", "cancelled", "disconnected"] as const)(
  "clears on admission and preserves an identical next draft after %s", async (status) => {
    const { runtime, sendMessage } = fakeRuntime();
    const uploader = immediateUploader();
    let settle!: (value: ConversationRuntimeTurnResult) => void;
    sendMessage.mockImplementation((input) => {
      input.onAccepted?.({ conversationId: "conversation_composer" as never, messageId: "accepted" as never, turnId: "turn_composer" as never });
      return new Promise((resolve) => { settle = resolve; });
    });
    const { result, unmount } = renderHook(() => useConversationComposer({ uploader, initialDraft: "Repeat" }), { wrapper: wrapper(runtime) });
    let sending!: ReturnType<ConversationComposerResult["submit"]>;
    act(() => { sending = result.current.submit(); });
    expect(result.current.draft).toBe("");
    expect(result.current.isSending).toBe(true);
    act(() => { result.current.setDraft("Repeat"); });
    expect(result.current.canSend).toBe(false);
    await act(async () => { expect(await result.current.submit()).toBeNull(); });
    expect(sendMessage).toHaveBeenCalledOnce();
    await act(async () => { settle(completed(status)); await sending; });
    expect(result.current.draft).toBe("Repeat");
    expect(result.current.isSending).toBe(false);
    unmount(); uploader.dispose();
  });

it("preserves edits made before admission even when changed back to submitted text", async () => {
  const { runtime, sendMessage } = fakeRuntime();
  const uploader = immediateUploader();
  let accept!: () => void;
  let settle!: (value: ConversationRuntimeTurnResult) => void;
  sendMessage.mockImplementation((input) => {
    accept = () => input.onAccepted?.({ conversationId: "conversation_composer" as never, messageId: "accepted" as never, turnId: "turn_composer" as never });
    return new Promise((resolve) => { settle = resolve; });
  });
  const { result, unmount } = renderHook(() => useConversationComposer({ uploader, initialDraft: "Repeat" }), { wrapper: wrapper(runtime) });
  let sending!: ReturnType<ConversationComposerResult["submit"]>;
  act(() => { sending = result.current.submit(); });
  act(() => { result.current.setDraft("Edited"); result.current.setDraft("Repeat"); });
  act(() => { accept(); });
  expect(result.current.draft).toBe("Repeat");
  await act(async () => { settle(completed()); await sending; });
  expect(result.current.draft).toBe("Repeat");
  unmount(); uploader.dispose();
});

function fakeRuntime<TRequest>(conversationId = "conversation_composer") {
  const store = createConversationStore(conversationId as ConversationId);
  const sendMessage = vi.fn<ConversationRuntime<TRequest>["sendMessage"]>();
  sendMessage.mockResolvedValue(completed());
  const runtime = {
    store,
    getSnapshot: store.getSnapshot,
    observe(observer: Parameters<ConversationRuntime<TRequest>["observe"]>[0]) {
      return store.subscribe(() => observer(store.getSnapshot()));
    },
    sendMessage,
    resumeTurn: vi.fn(),
    restoreActiveTurn: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ConversationRuntime<TRequest>;
  return { runtime, sendMessage };
}

it("does not apply a previous conversation's late admission or failure to the current draft", async () => {
  const { runtime, sendMessage } = fakeRuntime();
  const uploader = immediateUploader();
  let accept!: () => void;
  let settle!: (value: ConversationRuntimeTurnResult) => void;
  sendMessage.mockImplementation((input) => {
    accept = () => input.onAccepted?.({ conversationId: "first" as never, messageId: "accepted" as never, turnId: "turn_composer" as never });
    return new Promise((resolve) => { settle = resolve; });
  });
  const { result, rerender, unmount } = renderHook(({ conversationId }) => useConversationComposer({ uploader, conversationId, initialDraft: "First" }),
    { wrapper: wrapper(runtime), initialProps: { conversationId: "first" as ConversationId } });
  let sending!: ReturnType<ConversationComposerResult["submit"]>;
  act(() => { sending = result.current.submit(); });
  rerender({ conversationId: "second" as ConversationId });
  act(() => { result.current.setDraft("Second"); accept(); });
  await act(async () => { settle(completed("failed")); await sending; });
  expect(result.current.draft).toBe("Second");
  expect(result.current.errors).toEqual([]);
  expect(result.current.isSending).toBe(false);
  unmount(); uploader.dispose();
});

it("keeps text editable without accepting files during an active submission", async () => {
  const { runtime, sendMessage } = fakeRuntime();
  const uploader = immediateUploader();
  let settle!: (value: ConversationRuntimeTurnResult) => void;
  sendMessage.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
  const { result, unmount } = renderHook(() => useConversationComposer({ uploader, initialDraft: "First" }), { wrapper: wrapper(runtime) });
  let sending!: ReturnType<ConversationComposerResult["submit"]>;
  const preventPaste = vi.fn(), preventDrop = vi.fn();
  const source = file("during-turn.png");
  act(() => {
    sending = result.current.submit();
    result.current.getTextareaProps().onChange({ currentTarget: { value: "Second" } } as never);
    result.current.getTextareaProps().onPaste({ clipboardData: { items: itemList(fileItem(source)) }, preventDefault: preventPaste } as never);
    result.current.getFileInputProps().onChange({ currentTarget: { files: fileList(source) } } as never);
    result.current.getDropProps().onDrop({ dataTransfer: { files: fileList(source), items: itemList(fileItem(source)) }, preventDefault: preventDrop } as never);
  });
  expect(result.current.draft).toBe("Second");
  expect(preventPaste).toHaveBeenCalled();
  expect(preventDrop).toHaveBeenCalled();
  expect(uploader.getSnapshot().items).toEqual([]);
  await act(async () => { settle(completed()); await sending; });
  expect(result.current.draft).toBe("Second");
  unmount(); uploader.dispose();
});

function wrapper<TRequest>(runtime: ConversationRuntime<TRequest>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ConversationProvider runtime={runtime}>{children}</ConversationProvider>;
  };
}

function file(name: string, type = "image/png", contents = "image"): File {
  return new File([contents], name, { type, lastModified: 1_700_000_000_000 });
}

function fileList(...files: File[]): FileList {
  return Object.assign([...files], {
    item(index: number) {
      return files[index] ?? null;
    },
  }) as unknown as FileList;
}

function fileItem(source: File): DataTransferItem {
  return {
    kind: "file",
    type: source.type,
    getAsFile: () => source,
  } as DataTransferItem;
}

function itemList(...items: DataTransferItem[]): DataTransferItemList {
  return Object.assign([...items], {
    item(index: number) {
      return items[index] ?? null;
    },
  }) as unknown as DataTransferItemList;
}

function reference(request: AttachmentUploadRequest<Blob>): AttachmentReference {
  const suffix = request.idempotencyKey.slice(-8);
  return {
    attachment_id: `att_${suffix}`,
    content_ref: `ref_${suffix}`,
    media_type: request.metadata.mediaType,
    byte_size: request.metadata.byteSize,
    ...(request.metadata.filename === undefined
      ? {}
      : { filename: request.metadata.filename }),
  };
}

function immediateUploader() {
  return createAttachmentUploader<Blob>({
    async upload(request) {
      return reference(request);
    },
  });
}

function objectUrls() {
  const created: Blob[] = [];
  const revoked: string[] = [];
  let next = 0;
  return {
    created,
    revoked,
    api: {
      createObjectURL(source: Blob) {
        created.push(source);
        next += 1;
        return `blob:composer-${next}`;
      },
      revokeObjectURL(url: string) {
        revoked.push(url);
      },
    },
  };
}

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("useConversationComposer", () => {
  it("sends on Enter by default, supports explicit newline mode, and stays IME-safe", async () => {
    const { runtime, sendMessage } = fakeRuntime<{ model: string }>();
    const uploader = immediateUploader();
    const presence = {
      noteActivity: vi.fn(),
      setTyping: vi.fn(),
      stopTyping: vi.fn(),
      switchConversation: vi.fn(),
    };
    const onCancel = vi.fn();
    const { result, rerender } = renderHook(
      ({ enterBehavior }: { enterBehavior: "newline" | "send" | undefined }) =>
        useConversationComposer({
          uploader,
          presence,
          request: { model: "test" },
          ...(enterBehavior === undefined ? {} : { enterBehavior }),
          onCancel,
          imageIntake: { previews: false },
        }),
      {
        initialProps: {
          enterBehavior: "newline" as "newline" | "send" | undefined,
        },
        wrapper: wrapper(runtime),
      },
    );

    act(() => result.current.setDraft("hello"));
    expect(result.current.canSend).toBe(true);
    expect(presence.noteActivity).toHaveBeenCalled();
    expect(presence.setTyping).toHaveBeenCalledWith(true);

    const newline = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(newline as never));
    expect(newline.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({ enterBehavior: undefined });
    for (const overrides of [
      { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
      { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } },
      { defaultPrevented: true },
    ]) {
      const event = keyEvent(overrides);
      act(() => result.current.getTextareaProps().onKeyDown(event as never));
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    }
    const repeat = keyEvent({ repeat: true });
    act(() => result.current.getTextareaProps().onKeyDown(repeat as never));
    expect(repeat.preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    act(() => result.current.getTextareaProps().onCompositionStart({} as never));
    const composing = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(composing as never));
    expect(sendMessage).not.toHaveBeenCalled();
    act(() => result.current.getTextareaProps().onCompositionEnd({} as never));

    const sending = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(sending as never));
    expect(sending.preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.draft).toBe(""));
    expect(sendMessage).toHaveBeenCalledWith({
      content: "hello",
      attachments: [],
      onAccepted: expect.any(Function),
      request: { model: "test" },
    });
    expect(presence.stopTyping).toHaveBeenCalledWith("send");

    const ineligible = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(ineligible as never));
    expect(ineligible.preventDefault).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();

    act(() => result.current.getTextareaProps().onBlur());
    expect(presence.stopTyping).toHaveBeenCalledWith("blur");
    await expect(result.current.cancel()).resolves.toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("enables file drops and prevents rejected files from navigating away", () => {
    const { runtime } = fakeRuntime();
    const uploader = immediateUploader();
    const { result } = renderHook(() => useConversationComposer({
      uploader, createRequest: () => ({}),
    }), { wrapper: wrapper(runtime) });
    const fileDrag = { dataTransfer: { types: ["Files"], dropEffect: "none" }, preventDefault: vi.fn() };
    act(() => result.current.getDropProps().onDragOver(fileDrag as never));
    expect(fileDrag.preventDefault).toHaveBeenCalledOnce();
    expect(fileDrag.dataTransfer.dropEffect).toBe("copy");
    const textDrag = { dataTransfer: { types: ["text/plain"] }, preventDefault: vi.fn() };
    act(() => result.current.getDropProps().onDragOver(textDrag as never));
    expect(textDrag.preventDefault).not.toHaveBeenCalled();
    const rejected = file("script.exe", "application/octet-stream");
    const drop = { dataTransfer: { items: itemList(fileItem(rejected)), files: fileList(rejected) },
      preventDefault: vi.fn() };
    act(() => result.current.getDropProps().onDrop(drop as never));
    expect(drop.preventDefault).toHaveBeenCalledOnce();
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.errors).toHaveLength(1);
    uploader.dispose();
  });

  it.each(["paste", "drop"] as const)("accepts %s files when each clipboard read returns a new File", async (method) => {
    const { runtime, sendMessage } = fakeRuntime();
    const uploader = immediateUploader();
    const urls = objectUrls();
    const { result, unmount } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });
    const sources = [
      file("screenshot.png"),
      file("report.pdf", "application/pdf", "pdf"),
    ];
    const readers = sources.map((source) => vi.fn(() => new File([source], source.name, {
      type: source.type, lastModified: source.lastModified,
    })));
    const items = itemList(...sources.map((source, index) => ({
      kind: "file", type: source.type, getAsFile: readers[index]!,
    }) as unknown as DataTransferItem));
    const transfer = { items, files: fileList(...sources) };
    const preventDefault = vi.fn();
    act(() => {
      if (method === "paste") {
        result.current.getTextareaProps().onPaste({ clipboardData: transfer, preventDefault } as never);
      } else {
        result.current.getDropProps().onDrop({ dataTransfer: transfer, preventDefault } as never);
      }
    });
    expect(result.current.errors).toEqual([]);
    expect(preventDefault).toHaveBeenCalledOnce();
    for (const read of readers) expect(read).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.attachments.map(({ status }) => status)).toEqual(["ready", "ready"]));
    expect(result.current.attachments.map(({ filename }) => filename)).toEqual(["screenshot.png", "report.pdf"]);
    expect(urls.created).toHaveLength(1);
    await act(() => result.current.submit());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ attachments: [
      expect.objectContaining({ filename: "screenshot.png", media_type: "image/png" }),
      expect.objectContaining({ filename: "report.pdf", kind: "document" }),
    ] }));
    expect(urls.revoked).toEqual(["blob:composer-1"]);
    unmount(); uploader.dispose();
  });

  it("accepts paste, picker, and drop images and sends a ready image-only message", async () => {
    const { runtime, sendMessage } = fakeRuntime<{ refs: readonly string[] }>();
    const uploader = immediateUploader();
    const urls = objectUrls();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      createRequest: ({ attachments }) => ({
        refs: attachments.map((attachment) => attachment.content_ref),
      }),
      imageIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });

    const pasted = file("paste.png", "image/png", "pasted");
    const picked = file("picker.jpg", "image/jpeg", "picked");
    const dropped = file("drop.webp", "image/webp", "dropped");
    const pastePreventDefault = vi.fn();
    act(() => result.current.getTextareaProps().onPaste({
      clipboardData: { items: itemList(fileItem(pasted)) },
      preventDefault: pastePreventDefault,
    } as never));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(picked) },
    } as never));
    const dropPreventDefault = vi.fn();
    act(() => result.current.getDropProps().onDrop({
      dataTransfer: {
        items: itemList(fileItem(dropped)),
        files: fileList(dropped),
      },
      preventDefault: dropPreventDefault,
    } as never));

    expect(pastePreventDefault).toHaveBeenCalledOnce();
    expect(dropPreventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.attachments.map(({ status }) => status)).toEqual([
      "ready",
      "ready",
      "ready",
    ]));
    expect(result.current.draft).toBe("");
    expect(result.current.canSend).toBe(true);

    await act(() => result.current.submit());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: [],
      attachments: [
        expect.objectContaining({ filename: "paste.png" }),
        expect.objectContaining({ filename: "picker.jpg" }),
        expect.objectContaining({ filename: "drop.webp" }),
      ],
      request: { refs: expect.any(Array) },
    }));
    expect(result.current.attachments).toEqual([]);
    expect(urls.revoked).toEqual([
      "blob:composer-1",
      "blob:composer-2",
      "blob:composer-3",
    ]);
  });

  it("accepts mixed picker and drop attachments and submits in selection order", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    const pending = new Map<string, {
      request: AttachmentUploadRequest<Blob>;
      resolve: (value: AttachmentReference) => void;
    }>();
    const uploader = createAttachmentUploader<Blob>({
      upload(request) {
        return new Promise<AttachmentReference>((resolve) => {
          pending.set(request.metadata.filename ?? "", { request, resolve });
        });
      },
    });
    const urls = objectUrls();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });

    expect(result.current.getFileInputProps().accept).toBe(
      "image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/tab-separated-values",
    );
    const pickedPdf = file("picked.pdf", "application/pdf", "pdf");
    const pickedImage = file("picked.png", "image/png", "image");
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(pickedPdf, pickedImage) },
    } as never));
    await waitFor(() => expect(pending.size).toBe(2));

    act(() => pending.get("picked.png")!.request.onProgress({
      uploadedBytes: 3,
      totalBytes: pickedImage.size,
    }));
    expect(result.current.attachments).toEqual([
      expect.objectContaining({
        filename: "picked.pdf",
        kind: "document",
        mediaType: "application/pdf",
        status: "uploading",
        retryable: false,
        cancellable: true,
      }),
      expect.objectContaining({
        filename: "picked.png",
        kind: "image",
        mediaType: "image/png",
        status: "uploading",
        progress: { uploadedBytes: 3, totalBytes: pickedImage.size },
      }),
    ]);
    expect(result.current.attachments[0]?.previewUrl).toBeUndefined();
    expect(result.current.attachments[1]?.previewUrl).toBe("blob:composer-1");
    expect(urls.created).toEqual([pickedImage]);

    act(() => pending.get("picked.png")!.resolve(reference(
      pending.get("picked.png")!.request,
    )));
    await waitFor(() => expect(result.current.attachments[1]?.status).toBe("ready"));
    act(() => pending.get("picked.pdf")!.resolve(reference(
      pending.get("picked.pdf")!.request,
    )));
    await waitFor(() => expect(result.current.canSend).toBe(true));

    await act(() => result.current.submit());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [
        expect.objectContaining({ filename: "picked.pdf", media_type: "application/pdf", kind: "document" }),
        expect.objectContaining({ filename: "picked.png", media_type: "image/png" }),
      ],
    }));
    expect(urls.revoked).toEqual(["blob:composer-1"]);

    const droppedImage = file("drop.gif", "image/gif", "gif");
    const droppedPdf = file("drop.pdf", "application/pdf", "drop-pdf");
    const preventDefault = vi.fn();
    act(() => result.current.getDropProps().onDrop({
      dataTransfer: {
        items: itemList(fileItem(droppedImage), fileItem(droppedPdf)),
        files: fileList(droppedImage, droppedPdf),
      },
      preventDefault,
    } as never));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(result.current.attachments.map(({ filename, kind }) => ({ filename, kind })))
      .toEqual([
        { filename: "drop.gif", kind: "image" },
        { filename: "drop.pdf", kind: "document" },
      ]);
  });

  it("accepts only file-kind clipboard PDFs and never creates document previews", async () => {
    const { runtime } = fakeRuntime<undefined>();
    const urls = objectUrls();
    const uploader = immediateUploader();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });
    const pdf = file("clipboard.pdf", "application/pdf", "pdf");
    const preventDefault = vi.fn();
    act(() => result.current.getTextareaProps().onPaste({
      clipboardData: {
        items: itemList(
          { kind: "string", type: "text/plain", getAsFile: () => null } as DataTransferItem,
          fileItem(pdf),
        ),
      },
      preventDefault,
    } as never));
    expect(preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    expect(result.current.attachments[0]).toEqual(expect.objectContaining({
      kind: "document",
      mediaType: "application/pdf",
      filename: "clipboard.pdf",
    }));
    expect(result.current.attachments[0]?.previewUrl).toBeUndefined();
    expect(urls.created).toEqual([]);
    expect(urls.revoked).toEqual([]);
  });

  it("gives attachmentIntake deterministic precedence over imageIntake", async () => {
    const { runtime } = fakeRuntime<undefined>();
    const uploader = immediateUploader();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: {
        acceptedMediaTypes: ["application/pdf"],
        previews: false,
      },
      imageIntake: {
        acceptedMediaTypes: ["image/png"],
        previews: false,
      },
    }), { wrapper: wrapper(runtime) });
    expect(result.current.getFileInputProps().accept).toBe("application/pdf");
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: {
        files: fileList(
          file("ignored.png", "image/png", "image"),
          file("accepted.pdf", "application/pdf", "pdf"),
        ),
      },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.attachments[0]).toEqual(expect.objectContaining({
      filename: "accepted.pdf",
      kind: "document",
    }));
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      code: "unsupported_type",
    }));
  });

  it("reports bounded provider-neutral intake rejection messages", async () => {
    const { runtime } = fakeRuntime<undefined>();
    const uploader = immediateUploader();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: {
        previews: false,
        maxFileBytes: { image: 4, document: 4 },
        maxSelectionCount: { image: 1, document: 1 },
      },
    }), { wrapper: wrapper(runtime) });
    const first = file("first.png", "image/png", "a");
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(
        first,
        first,
        file("overflow.png", "image/png", "b"),
        file("large.pdf", "application/pdf", "large"),
        file("empty.pdf", "application/pdf", ""),
        file("unsafe/name.pdf", "application/pdf", "x"),
        file("notes.txt", "text/plain", "x"),
      ) },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.errors.map(({ code, message }) => ({ code, message }))).toEqual([
      { code: "duplicate", message: "The selected attachment is already attached." },
      { code: "count_overflow", message: "The attachment selection limit has been reached." },
      { code: "too_large", message: "The selected attachment is too large." },
      { code: "empty_file", message: "The selected attachment is empty." },
      { code: "unsafe_filename", message: "The selected attachment has an unsafe filename." },
      { code: "unsupported_type", message: "The selected file is not a supported attachment type." },
    ]);
  });

  it("cancels only owned uploads and exactly cleans image previews after partial intake failure", async () => {
    const { runtime } = fakeRuntime<undefined>();
    const urls = objectUrls();
    const uploader = createAttachmentUploader<Blob>({
      upload(request) {
        return new Promise<AttachmentReference>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    }, { maxImageCount: 1 });
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: {
        previews: { objectUrlApi: urls.api },
        maxSelectionCount: { image: 2 },
      },
    }), { wrapper: wrapper(runtime) });
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("one.png"), file("two.png")) },
    } as never));
    await waitFor(() => expect(result.current.errors).toContainEqual(expect.objectContaining({
      code: "intake_failed",
      message: "The selected attachments could not be prepared.",
    })));
    expect(result.current.attachments).toEqual([]);
    expect(uploader.getSnapshot().items).toEqual([]);
    expect(urls.created).toHaveLength(2);
    expect(urls.revoked).toEqual(["blob:composer-1", "blob:composer-2"]);

    const shared = createAttachmentUploader<Blob>({
      upload(request) {
        return new Promise<AttachmentReference>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    });
    const externalId = shared.enqueue({
      source: file("external.png"),
      fingerprint: "external-fingerprint",
      idempotencyKey: "external-key",
      mediaType: "image/png",
      byteSize: 5,
      filename: "external.png",
    });
    const owned = renderHook(() => useConversationComposer({
      uploader: shared,
      attachmentIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });
    act(() => owned.result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("owned.pdf", "application/pdf", "pdf")) },
    } as never));
    await waitFor(() => expect(owned.result.current.attachments).toHaveLength(1));
    act(() => {
      expect(owned.result.current.cancelAttachment(owned.result.current.attachments[0]!.id))
        .toBe(true);
    });
    expect(owned.result.current.attachments).toEqual([]);
    expect(shared.getSnapshot().items.some(({ id }) => id === externalId)).toBe(true);
    owned.unmount();
  });

  it("gates pending and failed uploads, then supports retry and removal", async () => {
    let resolvePending: ((value: AttachmentReference) => void) | undefined;
    const attempts = new Map<string, number>();
    const uploader = createAttachmentUploader<Blob>({
      upload(request) {
        const name = request.metadata.filename ?? "";
        const attempt = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, attempt);
        if (name === "retry.pdf" && attempt === 1) {
          return Promise.reject(new AttachmentUploadAdapterError({ retryable: true }));
        }
        if (name === "pending.png") {
          return new Promise<AttachmentReference>((resolve, reject) => {
            resolvePending = resolve;
            request.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return Promise.resolve(reference(request));
      },
    });
    const { runtime } = fakeRuntime<undefined>();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      attachmentIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });

    act(() => result.current.getFileInputProps().onChange({
      currentTarget: {
        files: fileList(
          file("retry.pdf", "application/pdf", "pdf"),
          file("pending.png"),
        ),
      },
    } as never));
    await waitFor(() => expect(result.current.attachments.map(({ status }) => status)).toEqual([
      "failed",
      "uploading",
    ]));
    expect(result.current.canSend).toBe(false);
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      source: "upload",
      retryable: true,
    }));

    const [failed, pending] = result.current.attachments;
    expect(failed).toBeDefined();
    expect(pending).toBeDefined();
    act(() => {
      expect(result.current.retryAttachment(failed!.id)).toBe(true);
    });
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    act(() => {
      expect(result.current.removeAttachment(pending!.id)).toBe(true);
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.canSend).toBe(true);
    expect(resolvePending).toBeDefined();
  });

  it("retains recoverable input after failure and clears only after success", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    sendMessage
      .mockResolvedValueOnce({
        ...completed("failed"),
        error: { code: "provider_failed", message: "Try again.", retryable: true },
      })
      .mockResolvedValueOnce(completed());
    const uploader = immediateUploader();
    const urls = objectUrls();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });

    act(() => result.current.setDraft("recover me"));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("recover.png")) },
    } as never));
    await waitFor(() => expect(result.current.canSend).toBe(true));

    await act(() => result.current.submit());
    expect(result.current.draft).toBe("recover me");
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      source: "send",
      code: "provider_failed",
    }));
    expect(urls.revoked).toEqual([]);

    await act(() => result.current.submit());
    expect(result.current.draft).toBe("");
    expect(result.current.attachments).toEqual([]);
    expect(urls.revoked).toEqual(["blob:composer-1"]);
  });

  it("clears stale send errors when the user edits the retained draft", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    sendMessage.mockResolvedValueOnce({
      ...completed("failed"),
      error: { code: "provider_failed", message: "Try again.", retryable: true },
    });
    const uploader = immediateUploader();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
    }), { wrapper: wrapper(runtime) });

    act(() => result.current.setDraft("first attempt"));
    await act(() => result.current.submit());
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      source: "send",
      code: "provider_failed",
    }));

    act(() => result.current.setDraft("revised attempt"));
    expect(result.current.errors).toEqual([]);
    expect(result.current.draft).toBe("revised attempt");
  });

  it("cleans up previews and typing across conversation switches and unmount", async () => {
    const { runtime } = fakeRuntime<undefined>("conversation_one");
    const firstUploader = immediateUploader();
    const secondUploader = immediateUploader();
    const urls = objectUrls();
    const presence = {
      noteActivity: vi.fn(),
      setTyping: vi.fn(),
      stopTyping: vi.fn(),
      switchConversation: vi.fn(),
    };
    const firstId = "conversation_one" as ConversationId;
    const secondId = "conversation_two" as ConversationId;
    const { result, rerender, unmount } = renderHook(
      ({ conversationId, uploader }: {
        conversationId: ConversationId;
        uploader: ReturnType<typeof immediateUploader>;
      }) =>
        useConversationComposer({
          uploader,
          presence,
          conversationId,
          attachmentIntake: { previews: { objectUrlApi: urls.api } },
        }),
      {
        initialProps: { conversationId: firstId, uploader: firstUploader },
        wrapper: wrapper(runtime),
      },
    );
    act(() => result.current.setDraft("typing"));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: {
        files: fileList(file("first.png"), file("first.pdf", "application/pdf", "pdf")),
      },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(2));

    rerender({ conversationId: firstId, uploader: secondUploader });
    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(firstUploader.getSnapshot().items).toEqual([]);
    expect(urls.revoked).toEqual(["blob:composer-1"]);

    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("switch.png")) },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    rerender({ conversationId: secondId, uploader: secondUploader });
    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(urls.revoked).toEqual(["blob:composer-1", "blob:composer-2"]);
    expect(presence.stopTyping).toHaveBeenCalledWith("conversation_switch");
    expect(presence.switchConversation).toHaveBeenCalledWith(secondId);

    act(() => result.current.getFileInputProps().onChange({
      currentTarget: {
        files: fileList(file("second.pdf", "application/pdf", "pdf"), file("second.png")),
      },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(2));
    unmount();
    expect(urls.revoked).toEqual([
      "blob:composer-1",
      "blob:composer-2",
      "blob:composer-3",
    ]);
    expect(presence.stopTyping).toHaveBeenCalledWith("destroy");
  });

  it("isolates two composer drafts and upload ownership on one runtime and uploader", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    const uploader = immediateUploader();
    const first = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });
    const second = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });

    act(() => first.result.current.setDraft("first draft"));
    act(() => second.result.current.setDraft("second draft"));
    const sameMetadata = file("same.png", "image/png", "same");
    act(() => first.result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(sameMetadata) },
    } as never));
    act(() => second.result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(sameMetadata) },
    } as never));
    await waitFor(() => {
      expect(first.result.current.canSend).toBe(true);
      expect(second.result.current.canSend).toBe(true);
    });
    expect(uploader.getSnapshot().items).toHaveLength(2);

    await act(() => first.result.current.submit());
    expect(first.result.current.draft).toBe("");
    expect(first.result.current.attachments).toEqual([]);
    expect(second.result.current.draft).toBe("second draft");
    expect(second.result.current.attachments).toHaveLength(1);
    expect(uploader.getSnapshot().items).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves the generic request type in the public option contract", () => {
    type Request = { readonly model: string };
    const options = {} as UseConversationComposerOptions<Request>;
    const composer = {} as ConversationComposerResult;
    const intake = {} as ConversationComposerAttachmentIntakeOptions;
    expect(options).toBeDefined();
    expect(composer).toBeDefined();
    expect(intake).toBeDefined();
  });
});


it("blocks synchronous, keyboard and direct submissions until all local tasks release", async () => {
  const { runtime, sendMessage } = fakeRuntime();
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("Unused"); } });
  const { result } = renderHook(() => useConversationComposer({ uploader, initialDraft: "Draft" }), {
    wrapper: wrapper(runtime),
  });
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  await act(async () => {
    releaseFirst = result.current.acquireSubmissionBlock();
    releaseSecond = result.current.acquireSubmissionBlock();
    expect(await result.current.submit()).toBeNull();
  });
  expect(result.current.canSend).toBe(false);
  act(() => result.current.getTextareaProps().onKeyDown({ key: "Enter", shiftKey: false,
    nativeEvent: { isComposing: false }, preventDefault: vi.fn(),
  } as unknown as Parameters<ReturnType<ConversationComposerResult["getTextareaProps"]>["onKeyDown"]>[0]));
  act(() => { releaseFirst(); releaseFirst(); });
  expect(result.current.canSend).toBe(false);
  expect(sendMessage).not.toHaveBeenCalled();
  act(() => releaseSecond());
  expect(result.current.canSend).toBe(true);
  await act(async () => { await result.current.submit(); });
  expect(sendMessage).toHaveBeenCalledTimes(1);
});


it("accepts PDF documents with the default composer intake", async () => {
  const { runtime } = fakeRuntime();
  const uploader = immediateUploader();
  const { result } = renderHook(() => useConversationComposer({ uploader }), { wrapper: wrapper(runtime) });
  expect(result.current.getFileInputProps().accept).toContain("application/pdf");
  act(() => result.current.getFileInputProps().onChange({ currentTarget: { files: fileList(file("report.pdf", "application/pdf", "%PDF-1.4")), value: "" } } as never));
  await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
  expect(result.current.attachments[0]?.kind).toBe("document");
  expect(result.current.errors).toEqual([]);
});
