import type { CreateHandrailAssistantOptions } from "@handrail/ai-assistant/server/assistant";
import type { AssistantContext } from "./identity.js";

/** Add only domain tools and enforce business authorization here. Approval
 * controls in the browser are preferences, never permission grants. */
export const domainTools: NonNullable<CreateHandrailAssistantOptions<AssistantContext>["tools"]> = [];
export const toolPolicy: NonNullable<CreateHandrailAssistantOptions<AssistantContext>["toolPolicy"]> = () => ({ outcome: "deny" });
