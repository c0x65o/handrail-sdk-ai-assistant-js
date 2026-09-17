import { createRoot } from "react-dom/client";
import { createHandrailAiClient } from "../../dist/client/index.js";
import { createAttachmentUploader } from "../../dist/index.js";
import { HandrailChatWorkspace } from "../../dist/react-styled/index.js";

// Production public SDK bundle; the local HTTP server supplies synthetic pages.
void (async () => {
  const params = new URLSearchParams(location.search);
  const messages = Number(params.get("messages") ?? 200);
  const single = params.get("single") === "true";
  const pending = params.get("pending") === "true";
  const client = await createHandrailAiClient({ baseUrl: `${location.origin}/api/${messages}${single ? "/single" : ""}${pending ? "/pending" : ""}`,
    synchronizationPollingMilliseconds: 300000, idleSynchronizationPollingMilliseconds: 300000,
    conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  const context = { account: "synthetic" };
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("Fixture has no uploads"); } });
  Object.assign(globalThis, { fixture: { client,
    async select(index: number) { return client.workspace!.open({ authorizationContext: context, conversationId: `chat-${messages}-${index}` as never }); },
    async dispose() { await client.dispose(); },
    snapshot() { const workspace = client.workspace!.getSnapshot();
      const runtime = workspace.threads.find(thread => thread.conversationId === workspace.selectedConversationId)?.runtime;
      return { selected: workspace.selectedConversationId, threads: workspace.threads.length,
        loadedThreads: workspace.threads.filter(thread => thread.runtime.getSnapshot().messages.length > 0).length,
        records: runtime?.displaySession?.getSnapshot().window.records.length ?? 0,
        bytes: runtime?.displaySession?.getSnapshot().window.retainedBytes ?? 0,
        relatedBytes: new TextEncoder().encode(JSON.stringify(runtime?.displaySession?.getSnapshot().related ?? [])).byteLength,
        state: runtime?.getSnapshot() }; }
  } });
  createRoot(document.getElementById("root")!).render(<HandrailChatWorkspace
    workspace={client.workspace!} title="Assistant" layout="page" threads={!single}
    catalogOptions={{ catalog: client.catalog, authorizationContext: context, pageSize: 5 }}
    historyOptions={{ autoSelect: true }} historyLayout="sidebar"
    composerForConversation={(_runtime, conversationId) => ({ uploader, conversationId, createRequest: () => ({}) })}
    attachmentsEnabled={false} approvals={false} transcription={false}/>);
})();
