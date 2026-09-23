import { useEffect, useRef, useState, type ReactNode } from "react";

export const ATTACHMENT_IMAGE_CSS = `
.hr-attachment-image{display:inline-flex;min-width:0;flex-shrink:0}
button.hr-attachment-image__open{padding:0;border:0;background:transparent;overflow:hidden;border-radius:8px;cursor:zoom-in}
.hr-attachment-image__open img{display:block;width:80px;height:64px;object-fit:cover}
dialog.hr-attachment-viewer{box-sizing:border-box;width:min(1100px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--hr-border,#ddd);border-radius:12px;background:var(--hr-bg,#fff);color:var(--hr-text,#202124);font:14px/1.5 var(--hr-font,system-ui);box-shadow:0 16px 64px #0006}
.hr-attachment-viewer::backdrop{background:#0009}
.hr-attachment-viewer__header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--hr-border,#ddd)}
.hr-attachment-viewer__header strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hr-attachment-viewer__header button,.hr-attachment-viewer__footer button{display:inline-flex;align-items:center;justify-content:center;min-width:36px;min-height:36px;padding:4px 8px;border:1px solid var(--hr-border,#ddd);border-radius:8px;background:var(--hr-panel,#f7f7f7);color:inherit;font:inherit;cursor:pointer}
.hr-attachment-viewer__footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--hr-border,#ddd);overflow-wrap:anywhere}
.hr-attachment-viewer__footer button{max-width:100%;white-space:normal}
.hr-attachment-viewer button:focus-visible,.hr-attachment-image__open:focus-visible{outline:3px solid var(--hr-accent,#5577cc);outline-offset:2px}
.hr-attachment-viewer__canvas{overflow:auto;height:min(75dvh,800px);background:#ededed}
.hr-attachment-viewer__stage{display:grid;place-items:center;min-width:100%;min-height:100%}
.hr-attachment-viewer .hr-attachment-viewer__stage img{display:block;width:100%;height:100%;max-width:none;max-height:none;object-fit:contain}
@media(pointer:coarse){.hr-attachment-viewer__header button,.hr-attachment-viewer__footer button{min-width:44px;min-height:44px}}
`;

/** Shared draft/saved image viewer. Native modal behavior supplies focus trapping and Escape. */
export function AttachmentImage({ url, name, onError, footer }: {
  readonly url: string;
  readonly name: string;
  readonly onError: () => void;
  readonly footer?: ReactNode;
}) {
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const open = openUrl === url;
  const close = () => {
    if (dialog.current?.open) dialog.current.close();
    setOpenUrl(null);
    trigger.current?.focus();
  };
  useEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    node.showModal();
    closeButton.current?.focus();
    // Host chat dialogs may trap Escape/Tab at document capture. The native
    // image modal owns these keys while focus is inside it.
    const keyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Node) || !node.contains(event.target)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== "Tab") return;
      event.stopPropagation();
      const buttons = node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => { window.removeEventListener("keydown", keyDown, true); if (node.open) node.close(); };
  }, [open, url]);
  return <span className="hr-attachment-image">
    <button ref={trigger} type="button" className="hr-attachment-image__open" aria-label={`Enlarge ${name}`}
      onClick={() => { setZoom(1); setOpenUrl(url); }}>
      <img alt={`${name} preview`} src={url} onError={onError}/>
    </button>
    {open && <dialog ref={dialog} className="hr-attachment-viewer" aria-label={`${name} image preview`}
      onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}
      onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <header className="hr-attachment-viewer__header"><strong>{name}</strong>
        <button type="button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - 0.5))}>−</button>
        <button type="button" aria-label="Reset image zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.5))}>+</button>
        <button ref={closeButton} type="button" aria-label="Close image preview" onClick={close}>×</button>
      </header>
      <div className="hr-attachment-viewer__canvas"><div className="hr-attachment-viewer__stage"
        style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
        <img src={url} alt={name} onError={() => { close(); onError(); }}/>
      </div></div>
      {footer && <footer className="hr-attachment-viewer__footer">{footer}</footer>}
    </dialog>}
  </span>;
}
