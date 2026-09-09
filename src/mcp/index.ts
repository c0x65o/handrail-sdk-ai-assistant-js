import type { JsonObject, JsonSchemaObject, JsonValue } from "../protocol.js";
import type { ApplicationToolExecutor, ApplicationToolExecutorContext } from "../tools/executor.js";
import type { ToolDiscoveryAdapter, ToolRegistration } from "../tools/registry.js";
import { diagnoseAiOperation, type AiDiagnosticSink } from "../diagnostics.js";

export const MCP_CONNECTOR_ADAPTER_VERSION = "handrail.mcp-connector.v1" as const;

export interface McpListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
}

/** SDK-neutral MCP client subset. Keep a concrete MCP SDK in the companion/application layer. */
export interface McpConnectorClient {
  listTools(input: { readonly signal?: AbortSignal }): Promise<{ readonly tools: readonly McpListedTool[] }>;
  callTool(input: {
    readonly name: string;
    readonly arguments: JsonObject;
    /** Stable across retries; the connector must not weaken server-side idempotency. */
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<JsonValue>;
  close?(): void | Promise<void>;
}

export interface RequestScopedMcpConnectorOptions<TContext> {
  readonly connectorId: string;
  /** Creates a connection only after discovery authorization succeeds. */
  readonly connect: (context: TContext, signal: AbortSignal) => McpConnectorClient | Promise<McpConnectorClient>;
  readonly authorize: (request: McpAuthorizationRequest<TContext>) => "allow" | "deny" | Promise<"allow" | "deny">;
  readonly namespace?: string;
  readonly timeoutMilliseconds?: number;
  readonly diagnostics?: AiDiagnosticSink;
}

export interface RequestScopedMcpSession {
  readonly tools: readonly McpListedTool[];
  callTool(input: { readonly name: string; readonly arguments: JsonObject; readonly toolCallId: string;
    readonly signal?: AbortSignal }): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface McpAuthorizationRequest<TContext> {
  readonly operation: "discover" | "execute";
  readonly toolName?: string;
  readonly context: TContext;
  readonly arguments?: JsonObject;
  readonly toolCallId?: string;
}

export interface McpConnectorAdapterOptions<TContext, TAdapterContext = TContext> {
  readonly connectorId: string;
  readonly client: McpConnectorClient;
  readonly authorize: (request: McpAuthorizationRequest<TContext | TAdapterContext>) => "allow" | "deny" | Promise<"allow" | "deny">;
  /**
   * Synchronous, per-caller catalog policy. ToolRegistry discovery is
   * intentionally synchronous, so an install-time authorization decision must
   * never be reused as authority to disclose a tool to another actor.
   */
  readonly discover: (request: {
    readonly toolName: string;
    readonly context: TContext;
  }) => boolean;
  readonly executionContext: (context: ApplicationToolExecutorContext<TContext>) => TContext;
  readonly namespace?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly diagnostics?: AiDiagnosticSink;
}

function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

/**
 * Principal/session-dependent MCP lifecycle for per-message connector lists.
 * Authorization precedes both connection/disclosure and every execution;
 * close is idempotent and all remote work is time bounded.
 */
export async function createRequestScopedMcpSession<TContext>(
  options: RequestScopedMcpConnectorOptions<TContext>, context: TContext, signal?: AbortSignal,
): Promise<RequestScopedMcpSession> {
  signal?.throwIfAborted();
  const connectorId = identifier(options.connectorId, "connectorId");
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 300_000) {
    throw new TypeError("timeoutMilliseconds is invalid");
  }
  if (await options.authorize({ operation: "discover", context }) !== "allow") throw new TypeError("MCP discovery is not authorized");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("MCP operation timed out")), timeoutMilliseconds);
  let client: McpConnectorClient | null = null, closed = false;
  const close = async () => {
    if (closed) return; closed = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort();
    await client?.close?.();
  };
  try {
    client = await options.connect(context, controller.signal);
    const listed = await diagnoseAiOperation(options.diagnostics,
      { domain: "mcp", operation: "scoped_list_tools", requestId: connectorId },
      () => client!.listTools({ signal: controller.signal }));
    controller.signal.throwIfAborted();
    // Discovery's deadline does not expire the entire conversation session.
    // Each call gets its own deadline; the session signal still cancels all work.
    clearTimeout(timer);
    const namespace = options.namespace === undefined ? "" : `${identifier(options.namespace, "namespace")}.`;
    const remoteByPublic = new Map<string, string>();
    const tools = Object.freeze(listed.tools.map((tool) => {
      const remote = identifier(tool.name, "MCP tool name"), name = `${namespace}${remote}`;
      if (remoteByPublic.has(name)) throw new TypeError("MCP server returned duplicate tool names");
      remoteByPublic.set(name, remote); return Object.freeze({ ...tool, name });
    }));
    return Object.freeze({ tools,
      async callTool(input: { readonly name: string; readonly arguments: JsonObject; readonly toolCallId: string;
        readonly signal?: AbortSignal }) {
        if (closed) throw new TypeError("MCP session is closed");
        const remoteName = remoteByPublic.get(input.name); if (!remoteName) throw new TypeError("MCP tool is not disclosed");
        if (await options.authorize({ operation: "execute", toolName: remoteName, context,
          arguments: input.arguments, toolCallId: input.toolCallId }) !== "allow") throw new TypeError("MCP tool execution is not authorized");
        if (input.signal?.aborted) throw input.signal.reason;
        const callController = new AbortController();
        const abortFromSession = () => callController.abort(controller.signal.reason);
        const abortFromCall = () => callController.abort(input.signal?.reason);
        controller.signal.addEventListener("abort", abortFromSession, { once: true });
        input.signal?.addEventListener("abort", abortFromCall, { once: true });
        if (controller.signal.aborted) abortFromSession();
        const callTimer = setTimeout(() => callController.abort(new Error("MCP operation timed out")), timeoutMilliseconds);
        try {
          callController.signal.throwIfAborted();
          return await diagnoseAiOperation(options.diagnostics,
            { domain: "mcp", operation: "scoped_call_tool", toolName: remoteName,
              toolCallId: input.toolCallId, requestId: connectorId },
            () => client!.callTool({ name: remoteName, arguments: input.arguments,
              idempotencyKey: identifier(input.toolCallId, "toolCallId"), signal: callController.signal }));
        } finally {
          clearTimeout(callTimer);
          controller.signal.removeEventListener("abort", abortFromSession);
          input.signal?.removeEventListener("abort", abortFromCall);
        }
      }, close });
  } catch (error) { await close(); throw error; }
}

/**
 * Separately versioned MCP-to-ToolDiscoveryAdapter bridge. Authorization runs
 * before catalog disclosure and again immediately before execution. Tool-call
 * identity is forwarded as the idempotency boundary.
 */
export function createMcpConnectorAdapter<TContext, TAdapterContext = TContext>(
  options: McpConnectorAdapterOptions<TContext, TAdapterContext>,
): ToolDiscoveryAdapter<ApplicationToolExecutor<TContext>, TContext, TAdapterContext> & {
  readonly version: typeof MCP_CONNECTOR_ADAPTER_VERSION;
  readonly connectorId: string;
} {
  const connectorId = identifier(options.connectorId, "connectorId");
  const namespace = options.namespace === undefined ? "" : `${identifier(options.namespace, "namespace")}.`;
  return Object.freeze({
    version: MCP_CONNECTOR_ADAPTER_VERSION,
    connectorId,
    async registrations(context: TAdapterContext) {
      if (await options.authorize({ operation: "discover", context }) !== "allow") return [];
      const listed = await diagnoseAiOperation(options.diagnostics,
        { domain: "mcp", operation: "list_tools" }, () => options.client.listTools({}));
      const names = new Set<string>();
      return Object.freeze(listed.tools.map((tool): ToolRegistration<ApplicationToolExecutor<TContext>, TContext> => {
        const remoteName = identifier(tool.name, "MCP tool name");
        const name = `${namespace}${remoteName}`;
        if (names.has(name)) throw new TypeError("MCP server returned duplicate tool names");
        names.add(name);
        const executor: ApplicationToolExecutor<TContext> = async (arguments_, execution) => {
          const applicationContext = options.executionContext(execution);
          if (await options.authorize({ operation: "execute", toolName: remoteName, context: applicationContext, arguments: arguments_, toolCallId: execution.toolCallId }) !== "allow") {
            throw new TypeError("MCP tool execution is not authorized");
          }
          return diagnoseAiOperation(options.diagnostics,
            { domain: "mcp", operation: "call_tool", toolName: remoteName, toolCallId: execution.toolCallId },
            () => options.client.callTool({ name: remoteName, arguments: arguments_,
              idempotencyKey: execution.executionKey ?? execution.toolCallId, signal: execution.signal }));
        };
        return {
          definition: { name, description: tool.description?.trim() || `MCP tool ${remoteName}`, input_schema: tool.inputSchema },
          executor,
          discover: (applicationContext) => options.discover({
            toolName: remoteName,
            context: applicationContext,
          }),
          ...(options.tags ? { tags: options.tags } : {}),
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        };
      }));
    },
  });
}
