/** Runnable composition factory: import in an existing authenticated Node host.
 * No listener, environment defaults, migration, credential source or live call is created here.
 * The integration test runs this exact factory with PGlite and HTTP/provider boundary fixtures.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// @ts-expect-error Pinned MCP ships JS without declarations; source inspected at eb879d767d05c7c2e15748f6fe7838294b980d82.
import { createConnectorServer } from "@handrail/mcp";
import { createHandrailAssistant } from "../dist/server/assistant.js";
import { createFeedbackTools } from "../dist/server/application.js";
import { createRequestScopedMcpSession } from "../dist/mcp/index.js";
import { parseToolDefinition } from "../dist/index.js";

/** @typedef {import('../dist/server/assistant.js').HandrailAssistantAuthorizationContext} Context */
/** @typedef {import('../dist/server/assistant.js').CreateHandrailAssistantOptions<Context>} AssistantOptions */
/** @typedef {import('../dist/server/application.js').FeedbackToolsOptions<Context>} FeedbackOptions */
/** @typedef {{principalId: string, tenantId: string, scopeId: string, sessionToken: string, feedbackConfig: Record<string, unknown>}} CurrentSession */

/** Uses actual pinned MCP; raw sessions exist only inside a short-lived connection.
 * resolveCurrent must use the host's trusted server session store and check revocation.
 * Configuration must use strict boolean enables and the exact declared runtime tuples.
 * @param {{resolveCurrent: (context: Context, signal: AbortSignal) => Promise<CurrentSession | null>}} host
 * @param {Context} context @param {AbortSignal} signal
 */
export async function openFeedbackSession(host, context, signal) {
  const current = await host.resolveCurrent(context, signal);
  signal.throwIfAborted();
  if (!current || current.principalId !== context.principalId || current.tenantId !== context.tenantId
    || current.scopeId !== context.scopeId || !current.sessionToken) throw new Error("Feedback authentication required");
  const bug = current.feedbackConfig.bug && typeof current.feedbackConfig.bug === "object" ? current.feedbackConfig.bug : {};
  const enhancement = current.feedbackConfig.enhancement && typeof current.feedbackConfig.enhancement === "object" ? current.feedbackConfig.enhancement : {};
  return createRequestScopedMcpSession({ connectorId: "handrail-feedback",
    authorize: () => "allow", // SDK admission + current server lookup above; never a client-supplied session.
    connect: async () => {
      const { server } = await createConnectorServer({ config: { enabled: false }, env: {},
        feedbackConfig: { ...current.feedbackConfig, sessionToken: current.sessionToken,
          bug: { ...bug, enabled: "enabled" in bug && bug.enabled === true },
          enhancement: { ...enhancement, enabled: "enabled" in enhancement && enhancement.enabled === true } } });
      const client = new Client({ name: "handrail-feedback-host", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      let closed = false;
      const close = async () => {
        if (closed) return; closed = true;
        await Promise.allSettled([client.close(), server.close()]);
      };
      try {
        await server.connect(serverTransport); await client.connect(clientTransport);
        return { listTools: async () => ({ tools: (await client.listTools()).tools.map(tool => {
          const definition = parseToolDefinition({ name: tool.name, description: tool.description ?? tool.name, input_schema: tool.inputSchema });
          return { name: definition.name, description: definition.description, inputSchema: definition.input_schema };
        }) }),
          callTool: async ({ name, arguments: args, signal }) => JSON.parse(JSON.stringify(
            await client.callTool({ name, arguments: args }, undefined, { signal }))), close };
      } catch { await close(); throw new Error("Feedback connection unavailable"); }
    },
  }, context, signal);
}

/** Mount assistant.handle / assistant.express behind existing auth, origin/CSRF,
 * rate and size limits. Supply the normal provider wrapper and migrated persistence.
 * Stop background workers on host shutdown. Keep automatic titles off for a bounded proof.
 * @param {{assistant: Omit<AssistantOptions, 'tools' | 'toolAdmission' | 'toolPolicy' | 'recordFiles'>,
 * feedback: Omit<FeedbackOptions, 'persistence' | 'openSession'>,
 * resolveCurrent: (context: Context, signal: AbortSignal) => Promise<CurrentSession | null>}} host
 */
export async function createFeedbackGateway(host) {
  const feedback = createFeedbackTools({ ...host.feedback, persistence: host.assistant.persistence.persistence,
    openSession: (context, signal) => openFeedbackSession(host, context, signal) });
  const assistant = await createHandrailAssistant({ ...host.assistant,
    // Deliberately project the trusted context. Never cache arbitrary session objects.
    authorize: async (request, action) => {
      const context = await host.assistant.authorize(request, action);
      return { principalId: context.principalId, tenantId: context.tenantId, scopeId: context.scopeId,
        attribution: context.attribution };
    },
    tools: [feedback.plugin], toolAdmission: feedback.admission,
  });
  return assistant;
}
