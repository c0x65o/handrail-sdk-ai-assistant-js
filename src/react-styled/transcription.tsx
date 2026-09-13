import { useComposerTranscription, type ComposerTranscriptionOptions } from "../react/composer-transcription.js";
import { TranscriptionControlsStatus } from "../react/transcription.js";
import type { ConversationComposerResult } from "../react/use-conversation-composer.js";

export function ComposerTranscriptionControl(props: ComposerTranscriptionOptions & {
  readonly conversationId: string;
  readonly composer: ConversationComposerResult;
  readonly disabled?: boolean;
}) {
  const controls = useComposerTranscription(props);
  return <>
    {!controls.active && <button type="button" className="hr-composer__icon" disabled={!controls.canStart}
      aria-label="Start voice input" title="Start voice input" onClick={() => { void controls.start(); }}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
        <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>
      </svg>
    </button>}
    {controls.canStop && <button type="button" className="hr-composer__icon" aria-label="Stop voice recording" title="Stop voice recording"
      onClick={() => { void controls.stop(); }}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>
    </button>}
    {controls.canCancel && <button type="button" className="hr-composer__icon" aria-label="Cancel voice input" title="Cancel voice input"
      onClick={() => { void controls.cancel(); }}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m6 6 12 12M6 18 18 6"/></svg>
    </button>}
    {controls.canRetry && <button type="button" className="hr-composer__action" onClick={() => { void controls.retry(); }}>
      Retry transcription
    </button>}
    {controls.status !== "idle" && <TranscriptionControlsStatus className="hr-composer__notice" controller={controls}/>}
  </>;
}
