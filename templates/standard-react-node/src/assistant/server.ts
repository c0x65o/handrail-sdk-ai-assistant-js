import { createHandrailAssistant, type CreateHandrailAssistantOptions, type HandrailAssistant } from "@handrail/ai-assistant/server/assistant";
import { usageFromEnvironment } from "@handrail/ai-assistant/server/usage-control";
import { authorizeAssistantRequest, type AssistantContext } from "./host/identity.js";
import { domainTools, toolPolicy } from "./host/tools.js";

type Options = Pick<CreateHandrailAssistantOptions<AssistantContext>, "persistence" | "provider"> &
  Partial<Pick<CreateHandrailAssistantOptions<AssistantContext>, "authorize" | "usage" | "diagnostics">>;

/** The SDK owns routes, catalog/history, files, approvals, send/retry/Stop and
 * usage. Hosts supply only their trusted domain, provider and storage seams. */
export function createApplicationAssistant(options: Options) {
  return createHandrailAssistant<AssistantContext>({
    id: "application-assistant",
    authorize: options.authorize ?? authorizeAssistantRequest,
    provider: options.provider,
    persistence: options.persistence,
    usage: options.usage ?? usageFromEnvironment(),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    recoverPendingOnContext: true,
    tools: domainTools, toolPolicy,
  });
}

export async function stopAssistant(assistant: HandrailAssistant): Promise<void> {
  try { await assistant.flushUsage(); } finally { assistant.stopUsageWorker(); }
}
