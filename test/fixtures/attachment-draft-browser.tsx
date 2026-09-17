import { createRoot } from "react-dom/client";
import { createHandrailAiClient, ConversationDraftController, APPLICATION_GATEWAY_PROTOCOL_VERSION } from "../../dist/client/index.js";
import { IndexedDBApplicationConversationPendingStore } from "../../dist/browser/index.js";
import { HandrailAssistantWorkspace } from "../../dist/react-styled/index.js";
import type { ChatRequest, StreamEvent } from "../../dist/index.js";

// Real public client/bootstrap, React workspace and IndexedDB, with only local
// synthetic catalog/upload HTTP routes supplied by the qualification script.
void (async () => {
  const account = new URLSearchParams(location.search).get("account") ?? "a";
  const storage = new IndexedDBApplicationConversationPendingStore<ChatRequest>({ scope: `${account}:fixture-api` });
  let failTextWrites = false;
  const writeDraft = storage.writeDraft.bind(storage);
  storage.writeDraft = (...args) => failTextWrites ? Promise.reject(new Error("Synthetic draft storage failure")) : writeDraft(...args);
  const client = await createHandrailAiClient<StreamEvent, ChatRequest, object>({ baseUrl: `${location.origin}/api`, pendingStore: storage,
    capabilities: { protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION, authoritativeCancellation: false,
      attachments: { maximumFiles: 4, maximumBytesPerFile: 10 * 1024 * 1024, acceptedMediaTypes: ["image/png", "application/pdf"], uploadUrl: "upload" },
      presence: false, activity: false, synchronization: false,
      displayHistory: { version: 1, maximumPageSize: 50, maximumPageBytes: 262144, control: true },
      resources: { conversations: true, approvals: false, titleGeneration: false } },
    conversations: { mode: "multiple", clientId: `browser-${account}` as never,
      authorize: () => "allow" },
    buildRequest: ({ content, attachments }) => ({ protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: content }, ...attachments.map(attachment => ({
        type: "image" as const, attachment: attachment as never,
      }))] }], tools: [], tool_results: [], generation: { max_output_tokens: 64, temperature: 0 }, correlation_hints: {} }),
  });
  const context = {};
  await client.workspace!.open({ authorizationContext: context, conversationId: "first" as never });
  const heldDrafts: ConversationDraftController[] = [];
  let releaseText: (() => void) | undefined;
  const root = createRoot(document.getElementById("root")!);
  root.render(<HandrailAssistantWorkspace client={client} authorizationContext={context} autoTitle={false} transcription={false}
    voiceControls={null} title="Attachment qualification" historyOptions={{ autoCreate: false }}/>);
  Object.assign(globalThis, { attachmentFixture: {
    failTextWrites(value: boolean) { failTextWrites = value; },
    textState() {
      const state = client.workspace!.getSnapshot().threads.find(thread => thread.conversationId === "first")?.runtime.displaySession?.draft?.getSnapshot();
      return state && { textLength: state.text.length, edit: state.edit, status: state.status, error: state.error, inputError: state.inputError };
    },
    async holdTextBudget() {
      for (let index = 0; index < 7; index++) {
        const draft = new ConversationDraftController(`held-${index}`, storage);
        heldDrafts.push(draft); await draft.flush();
        if (!draft.setText(String(index).repeat(65536))) throw new Error("Fixture draft capacity unexpectedly exhausted");
        await draft.flush();
      }
    },
    captureAcceptedText() {
      const draft = client.workspace!.getSnapshot().threads.find(thread => thread.conversationId === "first")?.runtime.displaySession?.draft;
      if (!draft) throw new Error("Missing selected draft");
      releaseText = draft.retainText(draft.getSnapshot().text);
      draft.accepted(draft.getSnapshot().edit);
    },
    releaseCapturedText() { releaseText?.(); releaseText = undefined; },
    async clearTextBudget() {
      releaseText?.(); releaseText = undefined;
      for (const draft of heldDrafts.splice(0)) { draft.setText(""); await draft.dispose(); }
    },
    async select(id: string) { await client.workspace!.open({ authorizationContext: context, conversationId: id as never }); },
    async saved(id = "first") {
      const record = await storage.readAttachmentDraft(id);
      return record ? { count: record.files.length, bytes: [...new Uint8Array(await record.files[0]!.selection.source.arrayBuffer())],
        key: record.files[0]!.selection.idempotencyKey, reference: !!record.files[0]!.reference } : null;
    },
    async flush() { await client.attachmentDrafts.forConversation("first").flush(); },
    async flushText() { await client.workspace!.getSnapshot().threads.find(thread => thread.conversationId === "first")?.runtime.displaySession?.draft?.flush(); },
    async draft() { return storage.readDraft("first"); },
    async pending() { const saved = await storage.load("first"); return saved ? { messageId: saved.messageId, localDraft: saved.localDraft } : null; },
    async files() { return (await storage.readAttachmentDraft("first"))?.files.map(file => ({ id: file.id,
      filename: file.selection.filename, ready: !!file.reference })) ?? []; },
    failNextFileCleanup() {
      const original = storage.discardAcceptedFiles.bind(storage);
      storage.discardAcceptedFiles = async (...args) => {
        storage.discardAcceptedFiles = original;
        throw new Error(`Synthetic device cleanup interruption (${args[1].length} selections)`);
      };
    },
    async dispose() { root.unmount(); releaseText?.(); await Promise.all(heldDrafts.splice(0).map(draft => draft.dispose())); await client.dispose(); storage.close(); },
    retainedThreads() { return client.workspace!.getSnapshot().threads.length; },
  } });
})();
