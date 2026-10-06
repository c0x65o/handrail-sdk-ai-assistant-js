import { createRoot } from "react-dom/client";
import { HandrailAssistantLauncher } from "../../dist/react-styled/index.js";
import { ApplicationConversationSession } from "../../dist/client/application-session.js";
import { useEffect, useMemo, useState } from "react";
import { IndexedDBApplicationConversationPendingStore } from "../../dist/browser/indexeddb-pending-store.js";
import type { ChatRequest } from "../../dist/protocol.js";
import { createAttachmentUploader } from "../../dist/index.js";

// Observe the real session error without replacing its admission/readiness logic.
const original = ApplicationConversationSession.prototype.sendMessage;
const fixture = { errors: [] as string[], session: null as ApplicationConversationSession<unknown> | null,
  setAccount: (account: string) => { void account; } };
Object.assign(window, { reopenFixture: fixture });
const initialize = ApplicationConversationSession.prototype.initialize;
ApplicationConversationSession.prototype.initialize = function() {
  fixture.session = this;
  return initialize.call(this);
};
ApplicationConversationSession.prototype.sendMessage = async function(input) {
  fixture.session = this;
  try { return await original.call(this, input); }
  catch (error) { fixture.errors.push(String((error as { code?: string }).code)); throw error; }
};
function Fixture() {
  const [account, setAccount] = useState("alice");
  const [visible, setVisible] = useState(false);
  const durable = new URLSearchParams(location.search).has("durable");
  const pendingStore = useMemo(() => durable ? new IndexedDBApplicationConversationPendingStore<ChatRequest>({
    scope: `${location.origin}:${account}`, databaseName: "denied-start-fixture",
  }) : undefined, [account, durable]);
  useEffect(() => () => pendingStore?.close(), [pendingStore]);
  const pageMode = new URLSearchParams(location.search).has("page");
  fixture.setAccount = setAccount;
  const protectedRequest = useMemo(() => (input: RequestInit) => {
    const headers = new Headers(input.headers); headers.set("x-fixture-account", account);
    return { ...input, headers };
  }, [account]);
  const assistant = <HandrailAssistantLauncher
    endpoint="/api/assistant" title="Race fixture" autoTitle={false} threads={false}
    clientId="reopen-browser" deviceId="reopen-device" attachmentsEnabled={false}
    protectedRequest={protectedRequest} {...(pendingStore ? { pendingStore } : {})}
    {...(pageMode ? { presentation: "page" as const, visible,
      // Mills supplies an inline factory. Visibility rerenders replace the
      // upload owner and reset local composer state, but retain the session.
      uploaderForConversation: () => createAttachmentUploader<Blob>({ upload: async () => { throw new Error("No file upload in this fixture"); } }),
    } : {})}
  />;
  return pageMode ? <><button onClick={() => setVisible(value => !value)}>Open chat</button>
    <aside hidden={!visible} inert={!visible} style={{ height: "100dvh" }}>{assistant}</aside></> : assistant;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
