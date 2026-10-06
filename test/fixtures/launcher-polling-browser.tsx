import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { HandrailAssistantLauncher, type HandrailAssistantLauncherProps } from "../../dist/react-styled/index.js";
import { ApplicationConversationSession } from "../../dist/client/application-session.js";
import { pollingGateway } from "./polling-gateway.js";

const gateway = pollingGateway();
const observation = { session: null as ApplicationConversationSession<unknown> | null };
const initialize = ApplicationConversationSession.prototype.initialize;
ApplicationConversationSession.prototype.initialize = function() { observation.session = this; return initialize.call(this); };
const root = createRoot(document.getElementById("root")!);
let settings: Partial<HandrailAssistantLauncherProps> = {};
function configure(next: Partial<HandrailAssistantLauncherProps>) {
  settings = { ...settings, ...next };
  flushSync(() => root.render(<HandrailAssistantLauncher endpoint="/fixture/assistant" fetch={gateway.fetch}
    presentation="page" includeStyles={false} autoTitle={false} approvals={null} {...settings}/>));
}
Object.assign(globalThis, { pollingFixture: { gateway, configure, snapshot: () => observation.session?.getSnapshot(),
  async uncertainSend() {
    try { await observation.session!.sendMessage({ content: "Keep original identity", request: { text: "Original request" } }); }
    catch { /* Synthetic uncertain response deliberately retains the journal. */ }
  },
  async retry() { try { await observation.session!.retryPending(); } catch { /* Same uncertain response. */ } },
  dispose: () => root.unmount(),
} });
configure({});
