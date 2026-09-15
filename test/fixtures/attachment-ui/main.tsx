import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { createAttachmentUploader, createConversationStore, type ConversationRuntime } from "../../../src/index.js";
import { intakeFileInputImages } from "../../../src/browser/index.js";
import { HandrailChat, handrailChatPresetCss, MessageAttachmentPreview } from "../../../src/react-styled/index.js";

declare global {
  interface Window {
    attachmentQA: { maximumBytes: number; uploads: { size: number; type: string; name: string; width: number; height: number }[];
      oldRejections: string[]; paste(file: File): void };
  }
}
const maximumBytes = 8 * 1024 * 1024;
window.attachmentQA = { maximumBytes, uploads: [], oldRejections: [], paste(file) {
  const result = intakeFileInputImages([file], { maxFileBytes: maximumBytes, maxSelectionCount: 4,
    acceptedMediaTypes: ["image/png", "image/jpeg"] });
  window.attachmentQA.oldRejections = result.rejections.map(rejection => rejection.reason);
  const transfer = new DataTransfer(); transfer.items.add(file);
  document.querySelector("textarea")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
} };
function Fixture() {
  const runtime = useMemo(() => {
    const store = createConversationStore("attachment-qa" as never);
    return { store, getSnapshot: store.getSnapshot, observe: (callback: () => void) => store.subscribe(callback),
      sendMessage: async () => ({ status: "completed", turnId: "turn-qa" }) } as unknown as ConversationRuntime<undefined>;
  }, []);
  const uploader = useMemo(() => createAttachmentUploader<Blob>({ async upload({ source, metadata }) {
    const decoded = await createImageBitmap(source);
    window.attachmentQA.uploads.push({ size: source.size, type: source.type, name: metadata.filename ?? "", width: decoded.width, height: decoded.height });
    decoded.close();
    return { attachment_id: `att_${window.attachmentQA.uploads.length}`, content_ref: `ref_${window.attachmentQA.uploads.length}`,
      media_type: metadata.mediaType, byte_size: source.size, filename: metadata.filename ?? "image" };
  } }), []);
  const saved = useMemo(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 1200, 800);
    ctx.fillStyle = "#202020"; ctx.font = "48px sans-serif"; ctx.fillText("Saved floor plan · 24 ft × 18 ft", 60, 200);
    const bytes = Uint8Array.from(atob(canvas.toDataURL().split(",")[1]!), character => character.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  }, []);
  return <><style>{handrailChatPresetCss}{`body{margin:0;background:#eee;padding:12px;box-sizing:border-box}#root{max-width:980px;margin:auto} .saved{padding:10px;background:#fff;box-sizing:border-box}.hr-chat{width:100%;height:450px}`}</style>
    <HandrailChat runtime={runtime} composer={{ uploader, initialDraft: "Check these measurements", attachmentIntake: {
      acceptedMediaTypes: ["image/png", "image/jpeg"], maxFileBytes: { image: maximumBytes },
    } }} title="Attachment QA" voiceControls={null}/>
    <div className="saved hr-chat"><MessageAttachmentPreview attachment={{ attachment_id: "att_saved" as never, filename: "floor-plan.png", media_type: "image/png" }}
      url={saved}/></div>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
