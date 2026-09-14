import { HandrailAssistantLauncher } from "@handrail/ai-assistant/react/styled";
import { protectedAssistantRequest } from "./host/browser-auth.js";

/** Theme and labels are application branding; standard controls stay intact. */
export function AssistantLauncher() {
  return <HandrailAssistantLauncher endpoint="/api/assistant" protectedRequest={protectedAssistantRequest}
    title="Assistant" trigger="Ask assistant" theme={{ mode: "system" }} />;
}
