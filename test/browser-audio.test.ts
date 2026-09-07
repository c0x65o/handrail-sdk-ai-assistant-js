import { describe, expect, it, vi } from "vitest";

import {
  BrowserAudioCaptureError,
  BrowserAudioCaptureValidationError,
  createBrowserAudioCaptureController,
  intakeBrowserAudio,
  type BrowserAudioClock,
  type BrowserAudioMediaRecorder,
  type BrowserAudioMediaRecorderApi,
  type BrowserAudioRecorderListener,
  type BrowserAudioStream,
  type BrowserAudioTrack,
} from "../src/browser/index.js";
import {
  TRANSCRIPTION_AUDIO_FORMATS,
  TRANSCRIPTION_LIMITS,
} from "../src/transcription.js";

const WEBM = TRANSCRIPTION_AUDIO_FORMATS[5];

class FakeTrack implements BrowserAudioTrack {
  stopCount = 0;

  stop(): void {
    this.stopCount += 1;
  }
}

class FakeStream implements BrowserAudioStream {
  constructor(readonly tracks: readonly FakeTrack[]) {}

  getTracks(): readonly BrowserAudioTrack[] {
    return this.tracks;
  }
}

class FakeRecorder implements BrowserAudioMediaRecorder {
  state = "inactive";
  readonly mimeType = WEBM.media_type;
  readonly listeners = new Map<string, Set<BrowserAudioRecorderListener>>();
  startCount = 0;
  stopCount = 0;
  timeslice: number | undefined;
  emitStopOnCall = true;

  start(timeslice?: number): void {
    this.startCount += 1;
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop(): void {
    this.stopCount += 1;
    this.state = "inactive";
    if (this.emitStopOnCall) this.emit("stop", {});
  }

  addEventListener(type: string, listener: BrowserAudioRecorderListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: BrowserAudioRecorderListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitData(size: number, type: string = WEBM.media_type): void {
    this.emit("dataavailable", {
      data: new Blob([new Uint8Array(size)], { type }),
    });
  }

  emitStop(): void {
    this.state = "inactive";
    this.emit("stop", {});
  }

  emitError(nativeValue: unknown = new Error("native details")): void {
    this.emit("error", nativeValue);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeRecorderApi implements BrowserAudioMediaRecorderApi {
  readonly recorder = new FakeRecorder();
  supported = true;
  requestedMediaTypes: string[] = [];

  isTypeSupported(mediaType: string): boolean {
    this.requestedMediaTypes.push(mediaType);
    return this.supported;
  }

  create(): BrowserAudioMediaRecorder {
    return this.recorder;
  }
}

class FakeClock implements BrowserAudioClock {
  current = 1_000;
  nextHandle = 1;
  readonly timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { due: this.current + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.due > this.current) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(overrides: Record<string, unknown> = {}) {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const recorderApi = new FakeRecorderApi();
  const clock = new FakeClock();
  const onResult = vi.fn();
  const getUserMedia = vi.fn(async () => stream);
  const controller = createBrowserAudioCaptureController({
    formats: [WEBM],
    maxBytes: 1_000,
    maxDurationSeconds: 10,
    mediaRecorder: recorderApi,
    mediaDevices: { getUserMedia },
    clock,
    onResult,
    ...overrides,
  });
  return {
    controller,
    track,
    stream,
    recorderApi,
    recorder: recorderApi.recorder,
    clock,
    onResult,
    getUserMedia,
  };
}

describe("browser audio capture", () => {
  it("does not resolve browser globals while constructing the controller", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
    let accesses = 0;
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      get() {
        accesses += 1;
        throw new Error("must remain lazy");
      },
    });
    try {
      createBrowserAudioCaptureController({
        formats: [WEBM],
        maxBytes: 10,
        maxDurationSeconds: 1,
      });
      expect(accesses).toBe(0);
    } finally {
      if (descriptor === undefined) delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
      else Object.defineProperty(globalThis, "MediaRecorder", descriptor);
    }
  });

  it("rejects unavailable declared formats before requesting permission", async () => {
    const capture = setup();
    capture.recorderApi.supported = false;

    const error = await capture.controller.start().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unsupported_format" });
    expect(error).not.toHaveProperty("cause");
    expect(capture.getUserMedia).not.toHaveBeenCalled();
    expect(capture.controller.getState()).toEqual({
      status: "failed",
      error: {
        code: "unsupported_format",
        message: "This browser cannot record audio in a supported format.",
      },
    });
  });

  it("classifies permission denial without retaining the native error", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("device and user details");
    });
    const capture = setup({ mediaDevices: { getUserMedia } });

    await expect(capture.controller.start()).rejects.toEqual(
      new BrowserAudioCaptureError("permission_denied"),
    );
    expect(capture.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "permission_denied" },
    });
    expect(JSON.stringify(capture.controller.getState())).not.toContain("device");
  });

  it("records and hands off a bounded Blob with metadata-only stopped state", async () => {
    const capture = setup({ filename: "voice-note.webm" });
    const states: string[] = [];
    capture.controller.subscribe((state) => states.push(state.status));

    await capture.controller.start();
    capture.clock.advance(750);
    capture.recorder.emitData(40);
    capture.recorder.emitData(60);
    const result = await capture.controller.stop();

    expect(result).toMatchObject({
      format: WEBM,
      byteSize: 100,
      durationSeconds: 0.75,
      filename: "voice-note.webm",
    });
    expect(result?.source).toBeInstanceOf(Blob);
    expect(result?.source.size).toBe(100);
    expect(result?.fingerprint).toMatch(/^browser-audio:[a-f0-9]{16}$/);
    expect(capture.controller.getState()).toMatchObject({
      status: "stopped",
      byteSize: 100,
    });
    expect("source" in capture.controller.getState()).toBe(false);
    expect(states).toEqual(["idle", "requesting", "recording", "recording", "recording", "stopped"]);
    expect(capture.track.stopCount).toBe(1);
    expect(capture.recorder.listeners.get("dataavailable")).toHaveLength(0);
    expect(capture.onResult).toHaveBeenCalledWith(result);

    await expect(capture.controller.stop()).resolves.toBeNull();
    await capture.controller.cancel();
    await capture.controller.cancel();
    await capture.controller.dispose();
    await capture.controller.dispose();
    expect(capture.track.stopCount).toBe(1);
  });

  it.each(["audio/webm;codecs=opus", "Audio/WebM ; codecs=opus"])("accepts native recorder codec parameters: %s", async (mediaType) => {
    const capture = setup();
    await capture.controller.start();
    capture.recorder.emitData(10, mediaType);
    const result = await capture.controller.stop();
    expect(result?.source.type).toBe("audio/webm");
    expect(result?.source.size).toBe(10);
    expect(capture.track.stopCount).toBe(1);
  });

  it("rejects a different container even when codec parameters are present", async () => {
    const capture = setup();
    await capture.controller.start();
    capture.recorder.emitData(10, "audio/mp4;codecs=mp4a.40.2");
    expect(capture.controller.getState()).toMatchObject({ status: "failed", error: { code: "unsupported_format" } });
    expect(capture.onResult).not.toHaveBeenCalled();
    expect(capture.track.stopCount).toBe(1);
  });

  it("automatically stops at the bounded duration", async () => {
    const capture = setup({ maxDurationSeconds: 2 });
    await capture.controller.start();
    capture.recorder.emitData(10);

    capture.clock.advance(2_000);

    expect(capture.recorder.stopCount).toBe(1);
    expect(capture.controller.getState()).toMatchObject({
      status: "stopped",
      durationSeconds: 2,
      byteSize: 10,
    });
    expect(capture.onResult).toHaveBeenCalledTimes(1);
    expect(capture.track.stopCount).toBe(1);
  });

  it("automatically stops at the accumulated-byte limit", async () => {
    const capture = setup({ maxBytes: 100 });
    await capture.controller.start();
    capture.recorder.emitData(40);
    capture.recorder.emitData(60);

    expect(capture.recorder.stopCount).toBe(1);
    expect(capture.controller.getState()).toMatchObject({
      status: "stopped",
      byteSize: 100,
    });
    expect(capture.onResult).toHaveBeenCalledTimes(1);
  });

  it("rejects chunks that cross the byte bound and rejects empty capture", async () => {
    const oversized = setup({ maxBytes: 100 });
    await oversized.controller.start();
    oversized.recorder.emitData(101);
    expect(oversized.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "byte_limit_exceeded" },
    });
    expect(oversized.onResult).not.toHaveBeenCalled();
    expect(oversized.track.stopCount).toBe(1);

    const empty = setup();
    await empty.controller.start();
    await expect(empty.controller.stop()).rejects.toMatchObject({
      code: "empty_capture",
    });
    expect(empty.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "empty_capture" },
    });
    expect(empty.track.stopCount).toBe(1);
  });

  it("cleans up a stream that resolves after cancellation during permission", async () => {
    const pending = deferred<BrowserAudioStream>();
    const capture = setup({
      mediaDevices: { getUserMedia: vi.fn(() => pending.promise) },
    });
    const starting = capture.controller.start();
    expect(capture.controller.getState().status).toBe("requesting");

    await capture.controller.cancel();
    await capture.controller.cancel();
    pending.resolve(capture.stream);

    await expect(starting).rejects.toMatchObject({ code: "cancelled" });
    expect(capture.track.stopCount).toBe(1);
    expect(capture.recorder.startCount).toBe(0);
    expect(capture.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "cancelled" },
    });
  });

  it("shares repeated stop calls made while permission is pending", async () => {
    const pending = deferred<BrowserAudioStream>();
    const capture = setup({
      mediaDevices: { getUserMedia: vi.fn(() => pending.promise) },
    });
    capture.recorder.emitStopOnCall = false;
    const starting = capture.controller.start();
    const firstStop = capture.controller.stop();
    const secondStop = capture.controller.stop();
    expect(secondStop).toBe(firstStop);

    pending.resolve(capture.stream);
    await starting;
    capture.recorder.emitData(10);
    capture.recorder.emitStop();

    const [first, second] = await Promise.all([firstStop, secondStop]);
    expect(first).toBe(second);
    expect(first?.byteSize).toBe(10);
    expect(capture.track.stopCount).toBe(1);
  });

  it("makes cancellation during a recorder-stop race deterministic", async () => {
    const capture = setup();
    capture.recorder.emitStopOnCall = false;
    await capture.controller.start();
    capture.recorder.emitData(10);
    const stopping = capture.controller.stop();

    await capture.controller.cancel();
    await expect(stopping).rejects.toMatchObject({ code: "cancelled" });
    capture.recorder.emitStop();
    await capture.controller.cancel();

    expect(capture.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "cancelled" },
    });
    expect(capture.track.stopCount).toBe(1);
    expect(capture.onResult).not.toHaveBeenCalled();
  });

  it("normalizes recorder errors without retaining native causes", async () => {
    const capture = setup();
    await capture.controller.start();
    capture.recorder.emitError({ token: "secret-native-value" });

    expect(capture.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "recorder_failed" },
    });
    expect(JSON.stringify(capture.controller.getState())).not.toContain("secret");
    expect(capture.track.stopCount).toBe(1);
  });

  it("revokes explicitly requested capture object URLs exactly once", async () => {
    const revokeObjectURL = vi.fn();
    const capture = setup({
      objectUrl: {
        api: {
          createObjectURL: vi.fn(() => "blob:ephemeral"),
          revokeObjectURL,
        },
      },
    });
    await capture.controller.start();
    capture.recorder.emitData(10);
    const result = await capture.controller.stop();

    expect(result?.objectUrl?.url).toBe("blob:ephemeral");
    result?.objectUrl?.revoke();
    result?.objectUrl?.revoke();
    await capture.controller.dispose();
    await capture.controller.dispose();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("validates contract limits before any capture operation", () => {
    expect(() => createBrowserAudioCaptureController({
      formats: [{ media_type: "audio/webm", container: "ogg" }],
      maxBytes: 10,
      maxDurationSeconds: 1,
    })).toThrow(BrowserAudioCaptureValidationError);
    expect(() => createBrowserAudioCaptureController({
      formats: [WEBM],
      maxBytes: TRANSCRIPTION_LIMITS.audioBytesMax + 1,
      maxDurationSeconds: 1,
    })).toThrow(BrowserAudioCaptureValidationError);
    expect(() => createBrowserAudioCaptureController({
      formats: [WEBM],
      maxBytes: 10,
      maxDurationSeconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMax + 1,
    })).toThrow(BrowserAudioCaptureValidationError);
  });
});

describe("browser audio file/blob intake", () => {
  function unreadableFile(type: string, size: number): File {
    return {
      name: "recording.webm",
      lastModified: 1_700_000_000_000,
      type,
      size,
      arrayBuffer: () => { throw new Error("must not read"); },
      bytes: () => { throw new Error("must not read"); },
      slice: () => { throw new Error("must not read"); },
      stream: () => { throw new Error("must not read"); },
      text: () => { throw new Error("must not read"); },
    } as unknown as File;
  }

  it("preserves a valid source without reading it and returns safe metadata", () => {
    const source = unreadableFile(WEBM.media_type, 64);
    const result = intakeBrowserAudio(source, {
      acceptedFormats: [WEBM],
      maxBytes: 100,
      maxDurationSeconds: 10,
      durationSeconds: 3.5,
    });

    expect(result).toMatchObject({
      source,
      format: WEBM,
      byteSize: 64,
      durationSeconds: 3.5,
      filename: "recording.webm",
    });
    expect(result.fingerprint).toMatch(/^browser-audio:[a-f0-9]{16}$/);
    expect(result.objectUrl).toBeUndefined();
    result.dispose();
  });

  it("rejects undeclared, empty, oversized, and invalid-duration sources", () => {
    expect(() => intakeBrowserAudio(unreadableFile("audio/ogg", 10), {
      acceptedFormats: [WEBM],
      maxBytes: 100,
    })).toThrow(new BrowserAudioCaptureError("unsupported_format"));
    expect(() => intakeBrowserAudio(unreadableFile(WEBM.media_type, 0), {
      acceptedFormats: [WEBM],
      maxBytes: 100,
    })).toThrow(new BrowserAudioCaptureError("empty_capture"));
    expect(() => intakeBrowserAudio(unreadableFile(WEBM.media_type, 101), {
      acceptedFormats: [WEBM],
      maxBytes: 100,
    })).toThrow(new BrowserAudioCaptureError("byte_limit_exceeded"));
    expect(() => intakeBrowserAudio(unreadableFile(WEBM.media_type, 10), {
      acceptedFormats: [WEBM],
      maxBytes: 100,
      maxDurationSeconds: 2,
      durationSeconds: 3,
    })).toThrow(BrowserAudioCaptureValidationError);
  });

  it("creates and revokes an intake object URL only when explicitly requested", () => {
    const source = unreadableFile(WEBM.media_type, 10);
    const createObjectURL = vi.fn(() => "blob:selected");
    const revokeObjectURL = vi.fn();
    const result = intakeBrowserAudio(source, {
      acceptedFormats: [WEBM],
      maxBytes: 100,
      objectUrl: { api: { createObjectURL, revokeObjectURL } },
    });

    expect(createObjectURL).toHaveBeenCalledWith(source);
    result.dispose();
    result.dispose();
    result.objectUrl?.revoke();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
