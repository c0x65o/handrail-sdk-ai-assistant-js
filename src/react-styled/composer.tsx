import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ComposerApprovalMode } from "../composer-approval.js";
import type { ConversationComposerResult } from "../react/use-conversation-composer.js";
import { AttachmentList, Composer, ErrorList, FileInput, Form, Stop, Submit, Textarea } from "../react/primitives.js";

export function ComposerIcon({ name }: { readonly name: "plus" | "shield" | "microphone" | "send" | "stop" }) {
  return <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    {name === "plus" ? <path d="M12 4v16M4 12h16"/> : name === "send" ? <path d="M12 20V4m-7 7 7-7 7 7"/>
      : name === "shield" ? <><path d="m12 3 8 4v6c0 5-8 8-8 8s-8-3-8-8V7l8-4Z"/><path d="m9 9 2 3-2 3m5 0h2"/></>
        : name === "stop" ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>
          : <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3"/></>}
  </svg>;
}

export interface ComposerApprovalControlProps {
  readonly approvalMode?: ComposerApprovalMode;
  /** Omit to show a read-only badge. The host must connect the preference to its authorized execution path. */
  readonly onApprovalModeChange?: (mode: ComposerApprovalMode) => void;
  /** Presentation only: hiding the badge never changes the approval mode. */
  readonly showApprovalControl?: boolean;
}

export function ComposerApprovalControl({ approvalMode = "required", onApprovalModeChange, disabled = false }:
  ComposerApprovalControlProps & { readonly disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="hr-composer__approval" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); setOpen(false); root.current?.querySelector("button")?.focus(); }
  }}>
    <button className="hr-composer__icon hr-composer__shield" type="button" aria-label="Approval settings"
      title={approvalMode === "automatic" ? "Auto-approve changes is on" : "Approval required for changes"}
      aria-expanded={open} data-mode={approvalMode} onClick={() => setOpen(!open)}><ComposerIcon name="shield"/></button>
    {open && <div className="hr-composer__approval-panel" role="group" aria-label="Approval settings">
      <label><span>Auto-approve changes</span><input type="checkbox" role="switch" checked={approvalMode === "automatic"}
        disabled={disabled || !onApprovalModeChange} onChange={(event) => onApprovalModeChange?.(event.target.checked ? "automatic" : "required")}/></label>
      <p>{approvalMode === "automatic" ? "Add, edit, and delete without asking each time, within your account permissions."
        : "Review and approve additions, edits, and deletions before they run."}</p>
      <p>{onApprovalModeChange ? "Applies to your next message. Changes already running keep their original setting."
        : "Approval settings are managed by this application."}</p>
    </div>}
  </div>;
}

interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}
type RecognitionConstructor = new () => Recognition;
function recognitionConstructor(): RecognitionConstructor | undefined {
  const host = globalThis as typeof globalThis & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

/** Browser dictation fallback. Hosts can supply their authenticated transcription controls instead. */
export function BrowserDictationControl({ composer }: { readonly composer: ConversationComposerResult }) {
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState("");
  const latest = useRef(composer); latest.current = composer;
  const active = useRef<Recognition | null>(null);
  const release = useRef<(() => void) | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    const recognition = active.current; active.current = null;
    if (recognition) { recognition.onresult = null; recognition.onend = null; recognition.onerror = null; recognition.abort(); }
    if (timeout.current) clearTimeout(timeout.current);
    release.current?.(); release.current = null;
  }, []);
  const start = () => {
    if (active.current || composer.isSending) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) { setNotice("Voice input is unavailable in this browser. You can use keyboard dictation."); return; }
    const recognition = new Constructor();
    active.current = recognition;
    release.current = composer.acquireSubmissionBlock();
    recognition.lang = document.documentElement.lang || navigator.language;
    recognition.continuous = true; recognition.interimResults = false;
    recognition.onresult = (event) => {
      if (active.current !== recognition) return;
      const parts: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result?.isFinal) parts.push(result[0].transcript.trim());
      }
      if (parts.length) latest.current.setDraft([latest.current.draft.trimEnd(), ...parts].filter(Boolean).join(" "));
    };
    const finish = () => {
      if (active.current !== recognition) return;
      active.current = null; setRecording(false);
      if (timeout.current) clearTimeout(timeout.current);
      release.current?.(); release.current = null;
    };
    recognition.onend = finish;
    recognition.onerror = (event) => {
      if (active.current !== recognition) return;
      setNotice(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Microphone access was denied. Allow it in your browser settings to dictate."
        : "Voice input stopped. Your draft is saved; try dictating again.");
      finish(); recognition.abort();
    };
    setNotice(""); setRecording(true);
    try { recognition.start(); timeout.current = setTimeout(() => recognition.stop(), 60_000); }
    catch { finish(); setNotice("Voice input could not start. Check your microphone and try again."); }
  };
  return <>
    <button type="button" className="hr-composer__icon" aria-label={recording ? "Stop dictation" : "Dictate a message"}
      title={recording ? "Stop dictation" : "Dictate a message"} aria-pressed={recording} disabled={composer.isSending}
      onClick={() => recording ? active.current?.stop() : start()}><ComposerIcon name={recording ? "stop" : "microphone"}/></button>
    {recording && <span role="status">Listening…</span>}
    {notice && <span className="hr-composer__notice" role="status">{notice}</span>}
  </>;
}

export const HANDRAIL_CHAT_COMPOSER_CSS = `
.hr-composer{padding:8px;min-width:0;color:var(--hr-text,#202124);background:var(--hr-bg,#fff)}
.hr-composer .hr-composer__form{position:relative;display:flex;flex-direction:column;gap:4px;border:1px solid var(--hr-border,#e9e9e9);border-radius:18px;padding:10px;background:var(--hr-bg,#fff);box-shadow:0 4px 18px #00000006}
.hr-composer .hr-composer__draft{box-sizing:border-box;display:block;inline-size:100%;min-inline-size:0;min-block-size:26px;max-block-size:120px;resize:none;border:0;border-radius:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:15px;line-height:1.4;padding:2px 2px;margin:0}
.hr-composer .hr-composer__draft:focus-visible{outline:none}.hr-composer .hr-composer__form:focus-within{border-color:var(--hr-muted,#999)}
.hr-composer__toolbar{display:flex;align-items:center;gap:4px;min-width:0}.hr-composer__spacer{flex:1}.hr-composer__voice{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;min-width:0}
.hr-composer button.hr-composer__icon,.hr-composer .hr-composer__voice>button{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:32px;height:32px;min-height:32px;border:0;border-radius:50%;padding:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.hr-composer .hr-composer__voice>button:not(:has(svg)){width:auto;border-radius:12px;font-size:13px}
.hr-composer button.hr-composer__send{width:34px;height:34px;color:#fff;background:var(--hr-composer-send,#55b653)}
.hr-composer button:disabled{opacity:.45;cursor:not-allowed}.hr-composer button:focus-visible,.hr-composer input:focus-visible{outline:3px solid var(--hr-accent,#55b653);outline-offset:2px}
.hr-composer button.hr-composer__shield{color:var(--hr-muted,#999)}.hr-composer button.hr-composer__shield[data-mode=automatic]{color:var(--hr-text,#202124);background:var(--hr-panel,#f1f3f2)}
.hr-composer__approval{position:relative}.hr-composer__approval-panel{position:absolute;z-index:20;bottom:42px;left:-36px;width:min(300px,calc(100vw - 64px));box-sizing:border-box;border:1px solid var(--hr-border,#e9e9e9);border-radius:16px;padding:16px;background:var(--hr-bg,#fff);box-shadow:0 8px 30px #0002;font-size:14px}
.hr-composer__approval-panel label{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:600}.hr-composer__approval-panel input{accent-color:var(--hr-composer-send,#55b653);width:20px;height:20px}.hr-composer__approval-panel p{margin:10px 0 0;line-height:1.45;color:var(--hr-muted,#666)}
.hr-composer__attachments{display:flex;flex-wrap:wrap;gap:8px;padding:0;margin:0;list-style:none}.hr-composer__attachments:empty,.hr-composer__errors:empty{display:none}.hr-composer__attachments li{max-width:100%;overflow-wrap:anywhere}.hr-composer__errors{margin:0;padding-left:20px;color:var(--hr-danger,#b42318);font-size:13px}.hr-composer__notice{font-size:12px;max-width:220px}
.hr-composer .hr-composer__toolbar svg{width:18px;height:18px}
@media(pointer:coarse){.hr-composer button.hr-composer__icon,.hr-composer .hr-composer__voice>button{width:40px;height:40px;min-height:40px}}
@media(max-width:520px){.hr-composer{padding:8px}.hr-composer .hr-composer__form{padding:8px;border-radius:16px}.hr-composer__toolbar{gap:4px}}
`;

export interface StandardChatComposerProps extends ComposerApprovalControlProps {
  readonly composer?: ConversationComposerResult;
  readonly canStop?: boolean;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly voiceControls?: ReactNode;
  readonly attachmentsEnabled?: boolean;
  readonly actions?: ReactNode;
  readonly labels?: Partial<{ attach: string; send: string; stop: string }>;
}

/** The shared two-row composer used by every styled preset and custom host surfaces. */
export function StandardChatComposer(props: StandardChatComposerProps) {
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = textarea.current;
    if (node) { node.style.height = "auto"; node.style.height = `${Math.min(Math.max(26, node.scrollHeight), 120)}px`; }
  }, [props.composer?.draft]);
  return <Composer {...(props.composer ? { composer: props.composer } : {})} className="hr-composer">
    <style>{HANDRAIL_CHAT_COMPOSER_CSS}</style>
    <Form className="hr-composer__form">
      <AttachmentList showRetry={false} className="hr-composer__attachments"/>
      <Textarea ref={textarea} className="hr-composer__draft" rows={1} maxLength={props.maxLength} placeholder={props.placeholder ?? "Message…"}/>
      <div className="hr-composer__toolbar">
        {props.attachmentsEnabled !== false && <><FileInput ref={input} hidden/>
          <button className="hr-composer__icon" type="button" aria-label={props.labels?.attach ?? "Add files and images"}
            title={props.labels?.attach ?? "Add files and images"} disabled={props.composer?.isSending} onClick={() => input.current?.click()}><ComposerIcon name="plus"/></button></>}
        {props.showApprovalControl !== false && <ComposerApprovalControl {...props} disabled={Boolean(props.composer?.isSending || props.canStop)}/>}
        <div className="hr-composer__spacer"/>
        <div className="hr-composer__voice">{props.voiceControls === undefined && props.composer ? <BrowserDictationControl composer={props.composer}/> : props.voiceControls}</div>
        {props.canStop ? <Stop className="hr-composer__icon hr-composer__send" aria-label={!props.labels?.stop || props.labels.stop === "Stop" ? "Stop response" : props.labels.stop}><ComposerIcon name="stop"/></Stop>
          : <Submit className="hr-composer__icon hr-composer__send" aria-label={!props.labels?.send || props.labels.send === "Send" ? "Send message" : props.labels.send}><ComposerIcon name="send"/></Submit>}
      </div>
      {props.actions}
      <ErrorList className="hr-composer__errors"/>
    </Form>
  </Composer>;
}
