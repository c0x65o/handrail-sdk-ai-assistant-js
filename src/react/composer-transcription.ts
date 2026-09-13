import { useEffect, useRef, useState } from "react";
import { createBrowserAudioCaptureController } from "../browser/audio.js";
import { DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY, validateTranscriptionHttpCapability,
  type TranscriptionHttpCapability, type TranscriptionHttpInput } from "../transcription-http.js";
import { useCapturedAudioTranscription, type TranscriptionCaptureFactory } from "./transcription.js";
import type { ConversationComposerResult } from "./use-conversation-composer.js";

export interface ComposerTranscriptionOptions {
  readonly transcribe: (input: TranscriptionHttpInput) => Promise<string>;
  readonly capability?: TranscriptionHttpCapability;
  /** Optional platform/test adapter. Browsers use the SDK capture implementation by default. */
  readonly createCaptureController?: TranscriptionCaptureFactory;
  readonly onBusyChange?: (busy: boolean) => void;
}

/** Shared recording, latest-draft insertion, submission blocking and cleanup. */
export function useComposerTranscription(options: ComposerTranscriptionOptions & {
  readonly conversationId: string;
  readonly composer: ConversationComposerResult;
  readonly disabled?: boolean;
}) {
  const latest = useRef(options.composer);
  latest.current = options.composer;
  const release = useRef<(() => void) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onBusyChange = useRef(options.onBusyChange);
  onBusyChange.current = options.onBusyChange;
  const capability = validateTranscriptionHttpCapability(options.capability ?? DEFAULT_TRANSCRIPTION_HTTP_CAPABILITY);
  const controls = useCapturedAudioTranscription({
    conversationId: options.conversationId,
    createCaptureController: options.createCaptureController ?? (({ onResult }) => createBrowserAudioCaptureController({
      formats: capability.formats, maxBytes: capability.maximumBytes,
      maxDurationSeconds: capability.maximumDurationSeconds, onResult,
    })),
    transcribeCapturedAudio: options.transcribe,
    applyTranscript: (text) => {
      const composer = latest.current;
      composer.setDraft([composer.draft.trimEnd(), text.trim()].filter(Boolean).join(" "));
    },
  });
  const active = controls.busy || controls.status === "recording";
  const blocked = Boolean(options.disabled || options.composer.isSending);
  useEffect(() => {
    if (!active) { release.current?.(); release.current = null; }
  }, [active, controls.status, attempt]);
  useEffect(() => {
    options.onBusyChange?.(active);
  }, [active, options.onBusyChange]);
  useEffect(() => () => {
    release.current?.(); release.current = null;
    onBusyChange.current?.(false);
  }, [options.conversationId]);
  useEffect(() => {
    if (blocked && active) void controls.cancel();
  }, [blocked, active, controls.cancel]);
  const start = async () => {
    if (blocked || release.current || !controls.canStart) return;
    release.current = options.composer.acquireSubmissionBlock();
    setAttempt((value) => value + 1);
    await controls.start();
  };
  const retry = async () => {
    if (blocked || release.current || !controls.canRetry) return;
    release.current = options.composer.acquireSubmissionBlock();
    setAttempt((value) => value + 1);
    await controls.retry();
  };
  return { ...controls, active, canStart: controls.canStart && !blocked,
    canRetry: controls.canRetry && !blocked, start, retry };
}
