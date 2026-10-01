import { createRoot } from "react-dom/client";
import { createHandrailAiClient } from "../../dist/client/index.js";
import { createAttachmentUploader } from "../../dist/index.js";
import { HandrailChatWorkspace } from "../../dist/react-styled/index.js";

// Only the HTTP server is synthetic; use the production client/session/UI path.
void (async () => {
  const client = await createHandrailAiClient({ baseUrl: `${location.origin}/api`,
    synchronizationPollingMilliseconds: 150, idleSynchronizationPollingMilliseconds: 150,
    conversations: { mode: "multiple", clientId: "browser" as never, authorize: () => "allow" } });
  const workspace = client.workspace!;
  const session = () => workspace.getSnapshot().threads.find(thread =>
    thread.conversationId === workspace.getSnapshot().selectedConversationId)?.runtime.displaySession;
  Object.assign(globalThis, { fixture: { client, session,
    snapshot: () => session()?.window.getSnapshot(),
    select: (id: string) => workspace.open({ authorizationContext: {}, conversationId: id as never }),
    dispose: () => client.dispose(),
  } });
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("No uploads in this fixture"); } });
  createRoot(document.getElementById("root")!).render(<HandrailChatWorkspace workspace={workspace}
    title="Polling regression" layout="page" threads={false} historyLayout="sidebar"
    catalogOptions={{ catalog: client.catalog, authorizationContext: {} }} historyOptions={{ autoSelect: true }}
    composerForConversation={(_runtime, conversationId) => ({ uploader, conversationId, createRequest: () => ({}) })}
    attachmentsEnabled={false} approvals={false} transcription={false}/>);
})();
