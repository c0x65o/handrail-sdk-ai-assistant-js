/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { BrowserAudioCaptureError, type BrowserAudioCaptureController, type BrowserAudioCaptureListener,
  type BrowserAudioCaptureState } from "../src/browser/audio.js";
import { useComposerTranscription } from "../src/react/composer-transcription.js";
import { StandardChatComposer } from "../src/react-styled/composer.js";
import type { ConversationComposerResult } from "../src/react/use-conversation-composer.js";
import { TranscriptionOperationError } from "../src/transcription.js";
import { createAttachmentUploader, createConversationStore, type ConversationId,
  type ConversationRuntime } from "../src/index.js";
import { ConversationProvider, useConversationComposer } from "../src/react/index.js";

const disposals: (() => void)[] = [];
afterEach(() => { cleanup(); disposals.splice(0).forEach((dispose) => dispose()); });
const format = { media_type: "audio/webm", container: "webm" } as const;
class Capture implements BrowserAudioCaptureController {
  state: BrowserAudioCaptureState = { status: "idle" };
  listeners = new Set<BrowserAudioCaptureListener>();
  publish(state: BrowserAudioCaptureState) { this.state = state; this.listeners.forEach((listener) => listener(state)); }
  getState() { return this.state; }
  subscribe(listener: BrowserAudioCaptureListener) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  start = vi.fn(async () => { this.publish({ status: "recording", format, accumulatedBytes: 0, elapsedSeconds: 0 }); });
  stop = vi.fn(async () => ({ source: new Blob(["audio"], { type: format.media_type }), format,
    byteSize: 5, durationSeconds: 1, fingerprint: "browser-audio:test" }));
  cancel = vi.fn(async () => { this.publish({ status: "failed", error: { code: "cancelled", message: "Cancelled" } }); });
  dispose = vi.fn(async () => undefined);
}
function composer() {
  const release = vi.fn();
  return { draft: "Current draft", setDraft: vi.fn(), isSending: false, canSend: true,
    attachments: [], errors: [], acquireSubmissionBlock: vi.fn(() => release), release,
    submit: vi.fn(), stop: vi.fn(), getTextareaProps: () => ({ value: "Current draft", onChange: vi.fn() }),
    getFileInputProps: () => ({}), getDropProps: () => ({}),
  } as unknown as ConversationComposerResult & { release: ReturnType<typeof vi.fn> };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("records once and Stop inserts into the latest edited draft without sending", async () => {
  const capture = new Capture(), input = composer(), pending = deferred<string>();
  const transcribe = vi.fn(() => pending.promise);
  const { result, rerender } = renderHook(({ draft }) => useComposerTranscription({
    conversationId: "thread", composer: { ...input, draft }, createCaptureController: () => capture, transcribe,
  }), { initialProps: { draft: input.draft } });
  expect(capture.start).not.toHaveBeenCalled();
  await act(async () => { await Promise.all([result.current.start(), result.current.start()]); });
  expect(capture.start).toHaveBeenCalledOnce();
  expect(input.acquireSubmissionBlock).toHaveBeenCalledOnce();
  expect(input.release).not.toHaveBeenCalled();
  let stop!: Promise<void>;
  act(() => { stop = result.current.stop(); });
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  rerender({ draft: "Edited while transcribing" });
  await act(async () => { pending.resolve("dictated words"); await stop; });
  expect(input.setDraft).toHaveBeenCalledWith("Edited while transcribing dictated words");
  expect(input.submit).not.toHaveBeenCalled();
  expect(input.release).toHaveBeenCalledOnce();
});

function interactiveComposer(initialDraft = "") {
  const capture = new Capture();
  const pending = deferred<string>();
  const transcribe = vi.fn<Parameters<typeof useComposerTranscription>[0]["transcribe"]>(() => pending.promise);
  const store = createConversationStore("thread" as ConversationId);
  const sendMessage = vi.fn<ConversationRuntime<unknown>["sendMessage"]>().mockResolvedValue({
    turnId: "turn" as never, status: "completed", requestId: null, traceId: null, outcome: "stop", usageReceipts: [],
    checkpoint: { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null },
  });
  const runtime = { store, getSnapshot: store.getSnapshot, sendMessage } as unknown as ConversationRuntime<unknown>;
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("Unused"); } });
  disposals.push(() => uploader.dispose());
  let input!: ConversationComposerResult;
  let autoStop!: Parameters<NonNullable<Parameters<typeof useComposerTranscription>[0]["createCaptureController"]>>[0]["onResult"];
  function Host({ conversationId = "thread", disabled = false }) {
    input = useConversationComposer({ uploader, initialDraft, conversationId: conversationId as ConversationId });
    return <StandardChatComposer composer={input} conversationId={conversationId} canStop={disabled}
      transcription={{ transcribe, createCaptureController: ({ onResult }) => { autoStop = onResult; return capture; } }}/>;
  }
  function View({ conversationId = "thread", disabled = false }) {
    return <StrictMode><ConversationProvider runtime={runtime}><Host conversationId={conversationId} disabled={disabled}/></ConversationProvider></StrictMode>;
  }
  const view = render(<View/>);
  return { capture, pending, transcribe, sendMessage, view, View, input: () => input,
    autoStop: async () => { autoStop(await capture.stop()); } };
}

it("returns to the reusable microphone after Stop without a cancel X or success notice", async () => {
  const { pending, sendMessage } = interactiveComposer("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  expect(screen.queryByRole("button", { name: "Cancel voice input" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));
  await act(async () => { pending.resolve("words"); });
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft words"));
  expect(screen.queryByRole("status")).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeTruthy();
});

it.each(["button", "Enter", "form", "direct"])("finishes recording and sends the latest combined draft once via %s", async (path) => {
  const { capture, pending, transcribe, sendMessage, view, input } = interactiveComposer();
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  const send = screen.getByRole("button", { name: "Send message" });
  expect(send).toHaveProperty("disabled", false);
  act(() => {
    if (path === "button") { fireEvent.click(send); fireEvent.click(send); }
    else if (path === "Enter") fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    else if (path === "form") fireEvent.submit(view.container.querySelector("form")!);
    else void input().submit();
    void input().submit();
  });
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  expect(send).toHaveProperty("disabled", true);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(capture.stop).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited draft" } });
  await act(async () => { pending.resolve("dictated words"); });
  await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  expect(sendMessage.mock.calls[0]![0].content).toBe("Edited draft dictated words");
  expect(screen.getByRole("textbox")).toHaveProperty("value", "");
  expect(screen.getByRole("button", { name: "Start voice input" })).toHaveProperty("disabled", false);
  expect(screen.queryByRole("status")).toBeNull();
});

it.each(["Stop", "automatic limit"])("can send while transcription is already pending after %s", async (stop) => {
  const { capture, pending, transcribe, sendMessage, autoStop } = interactiveComposer("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  if (stop === "Stop") fireEvent.click(screen.getByRole("button", { name: "Stop voice recording" }));
  else await act(autoStop);
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await act(async () => { pending.resolve("words"); });
  await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  expect(capture.stop).toHaveBeenCalledOnce();
  expect(transcribe).toHaveBeenCalledOnce();
});

it("keeps the draft on transcription failure and does not auto-send a later retry", async () => {
  const { transcribe, sendMessage } = interactiveComposer("Draft");
  transcribe.mockRejectedValueOnce(new TranscriptionOperationError("service_unavailable"));
  transcribe.mockResolvedValueOnce("retried words");
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry transcription" })).toBeTruthy());
  expect(sendMessage).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft");
  fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
  await waitFor(() => expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft retried words"));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(transcribe.mock.calls[0]![0].idempotencyKey).toBe(transcribe.mock.calls[1]![0].idempotencyKey);
});

it.each(["switch", "unmount", "response"])("abandons a pending transcribe-and-send on %s", async (action) => {
  const { pending, transcribe, sendMessage, view, View } = interactiveComposer("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  if (action === "switch") view.rerender(<View conversationId="other"/>);
  else if (action === "unmount") view.unmount();
  else view.rerender(<View disabled/>);
  await act(async () => { pending.resolve("late words"); });
  expect(sendMessage).not.toHaveBeenCalled();
  if (action !== "unmount") expect(screen.getByRole("textbox")).toHaveProperty("value", action === "switch" ? "" : "Draft");
});

it("respects other submission blocks before capture finishes and after the transcript arrives", async () => {
  const { capture, pending, transcribe, sendMessage, input } = interactiveComposer("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  let release!: () => void;
  act(() => { release = input().acquireSubmissionBlock(); });
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
  await act(async () => { expect(await input().submit()).toBeNull(); });
  expect(capture.stop).not.toHaveBeenCalled();
  act(release);
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  act(() => { release = input().acquireSubmissionBlock(); });
  await act(async () => { pending.resolve("words"); });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft words");
  act(release);
  expect(sendMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
});

it("does not send an empty message when no speech is returned", async () => {
  const { pending, sendMessage } = interactiveComposer();
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await act(async () => { pending.resolve(" "); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Start voice input" })).toHaveProperty("disabled", false));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", true);
});

it("keeps the combined transcript when sending fails", async () => {
  const { pending, sendMessage } = interactiveComposer("Draft");
  sendMessage.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await act(async () => { pending.resolve("words"); });
  await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft words");
  expect(screen.getByRole("button", { name: "Send message" })).toHaveProperty("disabled", false);
});

it.each(["switch", "unmount", "cancel"])("aborts transcription and ignores a late result after %s", async (action) => {
  const capture = new Capture(), input = composer(), pending = deferred<string>();
  let signal!: AbortSignal;
  const { result, rerender, unmount } = renderHook(({ conversationId }) => useComposerTranscription({
    conversationId, composer: input, createCaptureController: () => capture,
    transcribe: (request) => { signal = request.signal; return pending.promise; },
  }), { initialProps: { conversationId: "old" } });
  await act(async () => { await result.current.start(); });
  let stop!: Promise<void>;
  act(() => { stop = result.current.stop(); });
  await waitFor(() => expect(signal).toBeDefined());
  if (action === "switch") rerender({ conversationId: "new" });
  else if (action === "unmount") unmount();
  else await act(async () => { await result.current.cancel(); });
  expect(signal.aborted).toBe(true);
  expect(input.release).toHaveBeenCalledOnce();
  await act(async () => { pending.resolve("stale transcript"); await stop; });
  expect(input.setDraft).not.toHaveBeenCalled();
});

it("releases failed capture attempts and blocks retries with the same stable request identity", async () => {
  const input = composer(), capture = new Capture(), pending = deferred<string>();
  const factory = vi.fn(() => capture);
  factory.mockImplementationOnce(() => { throw new BrowserAudioCaptureError("permission_denied"); });
  factory.mockImplementationOnce(() => { throw new BrowserAudioCaptureError("permission_denied"); });
  const transcribe = vi.fn<Parameters<typeof useComposerTranscription>[0]["transcribe"]>()
    .mockRejectedValueOnce(new TranscriptionOperationError("service_unavailable"))
    .mockImplementationOnce(() => pending.promise);
  const { result } = renderHook(() => useComposerTranscription({ conversationId: "thread", composer: input,
    createCaptureController: factory, transcribe }));
  for (let count = 1; count <= 2; count++) {
    await act(async () => { await result.current.start(); });
    expect(result.current.status).toBe("error");
    expect(input.release).toHaveBeenCalledTimes(count);
  }
  await act(async () => { await result.current.start(); });
  await act(async () => { await result.current.stop(); });
  expect(input.release).toHaveBeenCalledTimes(3);
  expect(result.current.canRetry).toBe(true);
  let retry!: Promise<void>;
  act(() => { retry = result.current.retry(); void result.current.retry(); });
  await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
  expect(input.acquireSubmissionBlock).toHaveBeenCalledTimes(4);
  expect(input.release).toHaveBeenCalledTimes(3);
  expect(transcribe.mock.calls[0]![0].idempotencyKey).toBe(transcribe.mock.calls[1]![0].idempotencyKey);
  await act(async () => { pending.resolve("retry result"); await retry; });
  expect(input.release).toHaveBeenCalledTimes(4);
});

it("shows host accessories alongside the configured shared microphone and prevents voice during a response", async () => {
  const input = composer(), capture = new Capture();
  const props = { composer: input, conversationId: "thread", actions: <span>13 / 2,000 characters</span>,
    transcription: { transcribe: async () => "words", createCaptureController: () => capture } };
  const { rerender } = render(<StandardChatComposer {...props}/>);
  expect(screen.getByText("13 / 2,000 characters")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start voice input" })); });
  expect(screen.getByRole("button", { name: "Stop voice recording" })).toBeTruthy();
  rerender(<StandardChatComposer {...props} canStop composer={{ ...input, isSending: true, canSend: false }}/>);
  await waitFor(() => expect(input.release).toHaveBeenCalledOnce());
  expect((screen.getByRole("button", { name: "Start voice input" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false);
});
