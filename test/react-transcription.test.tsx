/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserAudioCaptureError,
  type BrowserAudioCaptureController,
  type BrowserAudioCaptureListener,
  type BrowserAudioCaptureResult,
  type BrowserAudioCaptureState,
} from "../src/browser/index.js";
import {
  TRANSCRIPTION_CONTRACT_VERSION,
  TranscriptionOperationError,
  type SupportedTranscriptionCapability,
  type TranscriptionAudioReference,
  type TranscriptionIdempotencyKey,
  type TranscriptionRequest,
  type TranscriptionRequestId,
  type TranscriptionResult,
} from "../src/index.js";
import {
  TranscriptionControlsCancel,
  TranscriptionControlsRetry,
  TranscriptionControlsRoot,
  TranscriptionControlsStart,
  TranscriptionControlsStatus,
  TranscriptionControlsStop,
  useTranscriptionControls,
  useCapturedAudioTranscription,
  type UseCapturedAudioTranscriptionOptions,
  type TranscriptionCaptureFactoryInput,
  type TranscriptionControlsController,
  type TranscriptionUploadInput,
  type UseTranscriptionControlsOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const format = { media_type: "audio/webm", container: "webm" } as const;
const audio = {
  audio_id: "audio_demo" as never,
  content_ref: "content_demo" as never,
  format,
  byte_size: 4,
  duration_seconds: 1,
} satisfies TranscriptionAudioReference;
const transcript = "private transcript contents";

function captureResult(): BrowserAudioCaptureResult {
  return Object.freeze({
    source: new Blob(["demo"], { type: format.media_type }),
    format,
    byteSize: 4,
    durationSeconds: 1,
    fingerprint: "browser-audio:demo",
  });
}

class FakeCaptureController implements BrowserAudioCaptureController {
  private state: BrowserAudioCaptureState = { status: "idle" };
  private readonly listeners = new Set<BrowserAudioCaptureListener>();
  readonly start = vi.fn(async () => {
    this.publish({ status: "requesting", format });
    this.publish({
      status: "recording",
      format,
      accumulatedBytes: 0,
      elapsedSeconds: 0.001,
    });
  });
  readonly stop = vi.fn(async () => {
    const result = captureResult();
    this.publish({
      status: "stopped",
      format,
      byteSize: result.byteSize,
      durationSeconds: result.durationSeconds,
      fingerprint: result.fingerprint,
    });
    return result;
  });
  readonly cancel = vi.fn(async () => {
    this.publish({
      status: "failed",
      error: { code: "cancelled", message: "Audio capture was cancelled." },
    });
  });
  readonly dispose = vi.fn(async () => undefined);

  getState(): BrowserAudioCaptureState {
    return this.state;
  }

  subscribe(listener: BrowserAudioCaptureListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  publish(state: BrowserAudioCaptureState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function result(request: TranscriptionRequest, text = transcript): TranscriptionResult {
  return {
    status: "completed",
    request_id: request.request_id,
    outputs: [{
      audio_id: audio.audio_id,
      text,
      metadata: { language: null, duration_seconds: 1 },
    }],
  };
}

function supported(
  transcribe: SupportedTranscriptionCapability["transcribe"],
): SupportedTranscriptionCapability {
  return {
    supported: true,
    version: TRANSCRIPTION_CONTRACT_VERSION,
    formats: [format],
    limits: {
      max_inputs: 1,
      max_bytes_per_input: 1024,
      max_duration_seconds: 60,
    },
    transcribe,
  };
}

function baseOptions(
  controller: FakeCaptureController,
  overrides: Partial<UseTranscriptionControlsOptions> = {},
): UseTranscriptionControlsOptions {
  return {
    conversationId: "conversation_a",
    createCaptureController: vi.fn(() => controller),
    uploadAudio: vi.fn(async () => audio),
    createRequestIdentity: vi.fn(() => ({
      requestId: "request_demo" as TranscriptionRequestId,
      idempotencyKey: "transcription:demo" as TranscriptionIdempotencyKey,
    })),
    capability: supported(vi.fn(async (request) => result(request))),
    applyTranscript: vi.fn(),
    ...overrides,
  };
}

function callbackOptions(
  controller: FakeCaptureController,
  transcribe: NonNullable<UseTranscriptionControlsOptions["transcribe"]>,
  overrides: Omit<Partial<UseTranscriptionControlsOptions>, "capability" | "transcribe"> = {},
): UseTranscriptionControlsOptions {
  const { capability, ...base } = baseOptions(controller);
  void capability;
  return { ...base, transcribe, ...overrides };
}

let latestController: TranscriptionControlsController;

function Harness({ options }: { readonly options: UseTranscriptionControlsOptions }) {
  const controller = useTranscriptionControls(options);
  latestController = controller;
  return (
    <TranscriptionControlsRoot controller={controller} aria-label="Dictation">
      <TranscriptionControlsStatus />
      <TranscriptionControlsStart />
      <TranscriptionControlsStop />
      <TranscriptionControlsCancel />
      <TranscriptionControlsRetry />
    </TranscriptionControlsRoot>
  );
}

describe("TranscriptionControls", () => {
  it("does not create or start microphone capture during render or SSR", () => {
    const controller = new FakeCaptureController();
    const options = baseOptions(controller);
    const html = renderToString(<Harness options={options} />);
    expect(html).toContain("Ready to record");
    expect(options.createCaptureController).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();

    render(<Harness options={options} />);
    expect(options.createCaptureController).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it("uses native accessible actions for keyboard/user activation and suppresses duplicates", async () => {
    const controller = new FakeCaptureController();
    const pendingStart = deferred<void>();
    controller.start.mockImplementation(async () => {
      controller.publish({ status: "requesting", format });
      await pendingStart.promise;
      controller.publish({
        status: "recording",
        format,
        accumulatedBytes: 0,
        elapsedSeconds: 0.001,
      });
    });
    render(<Harness options={baseOptions(controller)} />);

    const start = screen.getByRole("button", { name: "Start transcription" });
    expect(start.tagName).toBe("BUTTON");
    expect(start.getAttribute("type")).toBe("button");
    expect((start as HTMLButtonElement).disabled).toBe(false);
    start.focus();
    fireEvent.keyDown(start, { key: "Enter" });
    fireEvent.click(start, { detail: 0 });
    fireEvent.click(start);
    expect(controller.start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByLabelText("Dictation").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "Stop transcription" }) as
      HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel transcription" }) as
      HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Retry transcription" }) as
      HTMLButtonElement).disabled).toBe(true);
    pendingStart.resolve();
    await pendingStart.promise;
  });

  it("runs start-stop-upload-transcribe-apply with exact signals and safe announcements", async () => {
    const controller = new FakeCaptureController();
    const transcribe = vi.fn(async (request: TranscriptionRequest) => result(request));
    const applyTranscript = vi.fn();
    const uploadAudio = vi.fn(async (input: TranscriptionUploadInput) => {
      void input;
      return audio;
    });
    const options = callbackOptions(controller, transcribe, {
      uploadAudio,
      applyTranscript,
    });
    render(<Harness options={options} />);

    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));

    await waitFor(() => expect(applyTranscript).toHaveBeenCalledWith(transcript));
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(uploadAudio).toHaveBeenCalledTimes(1);
    const upload = uploadAudio.mock.calls[0]?.[0];
    expect(upload?.capture.source).toBeInstanceOf(Blob);
    expect(upload?.conversationId).toBe("conversation_a");
    expect(upload?.signal).toBeInstanceOf(AbortSignal);
    expect(transcribe).toHaveBeenCalledTimes(1);
    const request = transcribe.mock.calls[0]?.[0];
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.idempotency_key).toBe("transcription:demo");
    expect(request?.inputs).toEqual([audio]);
    expect(screen.getByRole("status").textContent).toBe("Transcription applied");
    expect(screen.getByRole("status").textContent).not.toContain(transcript);
    expect(document.body.textContent).not.toContain(transcript);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["permission_denied", "Microphone access was not granted."],
    ["unsupported_format", "This browser cannot record audio in a supported format."],
  ] as const)("announces the safe %s capture error", async (code, message) => {
    const controller = new FakeCaptureController();
    controller.start.mockImplementation(async () => {
      throw new BrowserAudioCaptureError(code);
    });
    render(<Harness options={baseOptions(controller)} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(message));
    expect(latestController.error).toMatchObject({ stage: "capture", code, retryable: false });
    expect((screen.getByRole("button", { name: "Retry transcription" }) as
      HTMLButtonElement).disabled).toBe(true);
  });

  it("exposes unsupported transcription as non-retryable", async () => {
    const controller = new FakeCaptureController();
    render(<Harness options={baseOptions(controller, {
      capability: { supported: false, reason: "implementation_not_configured" },
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(latestController.error?.code).toBe("unsupported"));
    expect(screen.getByRole("status").textContent).toBe("Transcription is not supported.");
    expect(latestController.canRetry).toBe(false);
    expect((screen.getByRole("button", { name: "Retry transcription" }) as
      HTMLButtonElement).disabled).toBe(true);
  });

  it("retries only normalized retryable failures with the stable idempotency key", async () => {
    const controller = new FakeCaptureController();
    const transcribe = vi.fn(async (request: TranscriptionRequest) => {
      if (transcribe.mock.calls.length === 1) {
        throw new TranscriptionOperationError("service_unavailable");
      }
      return result(request);
    });
    const applyTranscript = vi.fn();
    render(<Harness options={baseOptions(controller, {
      capability: supported(transcribe),
      applyTranscript,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(latestController.error?.code).toBe("service_unavailable"));
    expect(latestController.canRetry).toBe(true);

    const retry = screen.getByRole("button", { name: "Retry transcription" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(applyTranscript).toHaveBeenCalledWith(transcript));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls.map(([request]) => request.idempotency_key)).toEqual([
      "transcription:demo",
      "transcription:demo",
    ]);
  });

  it("aborts upload and suppresses stale completion after cancellation", async () => {
    const controller = new FakeCaptureController();
    const pendingUpload = deferred<TranscriptionAudioReference>();
    const uploadAudio = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false);
      return pendingUpload.promise;
    });
    const transcribe = vi.fn(async (request: TranscriptionRequest) => result(request));
    const applyTranscript = vi.fn();
    render(<Harness options={callbackOptions(controller, transcribe, {
      uploadAudio,
      applyTranscript,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(latestController.status).toBe("uploading"));
    const signal = uploadAudio.mock.calls[0]?.[0].signal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel transcription" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    pendingUpload.resolve(audio);
    await pendingUpload.promise;
    await Promise.resolve();
    expect(latestController.status).toBe("cancelled");
    expect(transcribe).not.toHaveBeenCalled();
    expect(applyTranscript).not.toHaveBeenCalled();
    expect(controller.cancel).toHaveBeenCalledTimes(1);
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });

  it("suppresses a late automatic capture result after cancellation", async () => {
    const controller = new FakeCaptureController();
    let factoryInput: TranscriptionCaptureFactoryInput | undefined;
    const uploadAudio = vi.fn(async () => audio);
    const options = baseOptions(controller, {
      createCaptureController: vi.fn((input) => {
        factoryInput = input;
        return controller;
      }),
      uploadAudio,
    });
    render(<Harness options={options} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel transcription" }));
    factoryInput?.onResult(captureResult());
    await Promise.resolve();
    expect(uploadAudio).not.toHaveBeenCalled();
    expect(latestController.status).toBe("cancelled");
  });

  it("aborts transcription and cleans up on conversation switch", async () => {
    const controller = new FakeCaptureController();
    const pending = deferred<TranscriptionResult>();
    const transcribe = vi.fn((request: TranscriptionRequest) => pending.promise.then(() =>
      result(request)));
    const applyTranscript = vi.fn();
    const first = callbackOptions(controller, transcribe, {
      applyTranscript,
    });
    const view = render(<Harness options={first} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    const signal = transcribe.mock.calls[0]?.[0].signal;

    view.rerender(<Harness options={{ ...first, conversationId: "conversation_b" }} />);
    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(latestController.status).toBe("idle");
    pending.resolve(result(transcribe.mock.calls[0]![0]));
    await pending.promise;
    await Promise.resolve();
    expect(applyTranscript).not.toHaveBeenCalled();
    expect(controller.dispose).toHaveBeenCalled();
  });

  it("cancels active capture when the conversation identity changes", async () => {
    const firstController = new FakeCaptureController();
    const secondController = new FakeCaptureController();
    const first = baseOptions(firstController);
    const view = render(<Harness options={first} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));

    view.rerender(<Harness options={{
      ...baseOptions(secondController),
      conversationId: "conversation_b",
    }} />);
    await waitFor(() => expect(firstController.cancel).toHaveBeenCalledTimes(1));
    expect(firstController.dispose).toHaveBeenCalledTimes(1);
    expect(secondController.start).not.toHaveBeenCalled();
    expect(latestController.status).toBe("idle");
  });

  it("cancels and disposes capture on unmount", async () => {
    const controller = new FakeCaptureController();
    const view = render(<Harness options={baseOptions(controller)} />);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(latestController.status).toBe("recording"));
    view.unmount();
    await waitFor(() => expect(controller.cancel).toHaveBeenCalledTimes(1));
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});


function CapturedHarness({ options }: { options: UseCapturedAudioTranscriptionOptions }) {
  const controller = useCapturedAudioTranscription(options);
  return <TranscriptionControlsRoot controller={controller}>
    <TranscriptionControlsStart/><TranscriptionControlsStop/><TranscriptionControlsCancel/>
    <TranscriptionControlsRetry/><TranscriptionControlsStatus/>
  </TranscriptionControlsRoot>;
}

describe("direct captured-audio controls", () => {
  it("retries the same recording and identity without recording or uploading again", async () => {
    const capture = new FakeCaptureController();
    const apply = vi.fn();
    const transcribe = vi.fn<UseCapturedAudioTranscriptionOptions["transcribeCapturedAudio"]>()
      .mockRejectedValueOnce(new TranscriptionOperationError("service_unavailable")).mockResolvedValue(transcript);
    render(<CapturedHarness options={{ conversationId: "conversation-1", createCaptureController: () => capture,
      transcribeCapturedAudio: transcribe, applyTranscript: apply }}/>);
    expect(capture.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop transcription" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry transcription" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(transcript));
    expect(capture.start).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(transcribe.mock.calls[0]![0].capture.source).toBe(transcribe.mock.calls[1]![0].capture.source);
    expect(transcribe.mock.calls[0]![0].idempotencyKey).toBe(transcribe.mock.calls[1]![0].idempotencyKey);
    expect(transcribe.mock.calls[0]![0].requestId).toBe(transcribe.mock.calls[1]![0].requestId);
  });

  it.each(["switch", "unmount", "cancel"] as const)("cancels direct transcription on %s and ignores its late text", async (action) => {
    const capture = new FakeCaptureController();
    const pending = deferred<string>();
    const transcribe = vi.fn<UseCapturedAudioTranscriptionOptions["transcribeCapturedAudio"]>(() => pending.promise);
    const apply = vi.fn();
    const options = { conversationId: "conversation-1", createCaptureController: () => capture,
      transcribeCapturedAudio: transcribe, applyTranscript: apply };
    const view = render(<CapturedHarness options={options}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start transcription" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop transcription" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Stop transcription" }));
    await waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    if (action === "switch") view.rerender(<CapturedHarness options={{ ...options, conversationId: "conversation-2" }}/>);
    else if (action === "unmount") view.unmount();
    else fireEvent.click(screen.getByRole("button", { name: "Cancel transcription" }));
    expect(transcribe.mock.calls[0]![0].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(transcript); });
    await waitFor(() => expect(capture.dispose).toHaveBeenCalled());
    expect(apply).not.toHaveBeenCalled();
  });
});
