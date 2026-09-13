/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserAudioCaptureError, type BrowserAudioCaptureController, type BrowserAudioCaptureListener,
  type BrowserAudioCaptureState } from "../src/browser/audio.js";
import { useComposerTranscription } from "../src/react/composer-transcription.js";
import { StandardChatComposer } from "../src/react-styled/composer.js";
import type { ConversationComposerResult } from "../src/react/use-conversation-composer.js";
import { TranscriptionOperationError } from "../src/transcription.js";

afterEach(cleanup);
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

it("records once, keeps submission blocked, and inserts into the latest edited draft without sending", async () => {
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
