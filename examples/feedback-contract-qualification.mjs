/**
 * Offline qualification ONLY: actual SDK ToolPlugin + MCP connector, injected
 * HTTP boundary. No model, network listener, environment configuration or intake.
 * See docs/feedback-integration.md before attempting a native dev composition.
 */
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// @ts-expect-error Pinned MCP 0.2.1 exports JavaScript without declarations; APIs verified in its source.
import { createConnectorServer, FEEDBACK_TOOL_NAMES } from "@handrail/mcp";
import { createToolPlugin, parseToolDefinition } from "../dist/index.js";
import { createAiApplication } from "../dist/server/application.js";
import { createRequestScopedMcpSession } from "../dist/mcp/index.js";

export { FEEDBACK_TOOL_NAMES };

/** @typedef {"bug" | "enhancement"} Kind */
/** @typedef {{ actor: string, scopeId: string }} Context */
/** @typedef {import('../dist/protocol.js').JsonObject} JsonObject */
/** @typedef {import('../dist/protocol.js').JsonValue} JsonValue */
/** @typedef {import('../dist/tools/executor.js').BoundedToolExecutionOutcome} Outcome */
/** @typedef {{ arguments?: JsonObject, context?: Context, signal?: AbortSignal }} InvokeOptions */
/** @typedef {{ app: import('../dist/server/application.js').AiApplication<Context, Context, unknown>, context: Context, invoke: (kind: Kind, options?: InvokeOptions) => Promise<Outcome>, session: import('../dist/mcp/index.js').RequestScopedMcpSession, diagnostics: import('../dist/diagnostics.js').AiDiagnosticEvent[] }} QualificationInput */
/** @param {unknown} body */
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

/** Source-derived HTTP projections, deliberately not a persistence emulator.
 * @param {Partial<{authorized: boolean, actor: string, remoteError: boolean, invalidReceipt: boolean}>} overrides
 */
export function qualificationFixture(overrides = {}) {
  const controls = { authorized: true, actor: "fixture-alice", remoteError: false, invalidReceipt: false, ...overrides };
  /** @type {{posts: JsonObject[], closed: number, sessions: (string | undefined)[]}} */
  const observations = { posts: [], closed: 0, sessions: [] };
  const request = {
    id: "fixture-enhancement", title: "DEV QA fixture enhancement",
    description: "Offline contract check", priority: "medium", status: "submitted",
    status_group: "in_progress", terminal: false, submission_kind: "enhancement",
  };
  /** @param {string} url @param {{headers: Record<string, string>, method?: string, body?: string}} init */
  const fetch = async (url, init) => {
    // Never fall back to global fetch. All values are synthetic fixture data.
    if (new URL(url).origin !== "https://feedback.invalid") throw new Error("Fixture origin required");
    observations.sessions.push(init.headers["x-handrail-application-session-token"]
      ?? init.headers["x-handrail-application-session"]);
    if (!controls.authorized) return json({ code: "not_authorized" }, 403);
    if (url.endsWith("/discovery")) return json({ contract_version: "v1",
      capability: { id: "fixture-capability", project_id: "fixture-project", service_env_id: "fixture-runtime" },
      principal: { authenticated: true, authentication_method: "known_users_direct_session" },
      enhancement_reporting: { enabled: true } });
    if (new URL(url).pathname.endsWith("/policy")) return json({ schema_version: 1,
      project_id: "fixture-project", environment: "dev", reporter: { identity_verified: true } });
    if (init.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      observations.posts.push(body);
      if (controls.remoteError) return json({ code: "remote_unavailable" }, 503);
      if (controls.invalidReceipt) return json({}, 201);
      return url.endsWith("/requests")
        ? json({ contract_version: "v1", request, replayed: false, assessment: null, assessment_warning: null }, 201)
        : json({ bug_id: "fixture-bug", event_id: body.event_id,
          reporter_identity: { verification_result: true } }, 201);
    }
    // Canonical API returns publicRequest directly, with no version envelope:
    // enhancement-reporting.js publicRequest + getEnhancementReportingRequest.
    if (url.endsWith("/requests/fixture-enhancement")) return json(request);
    throw new Error("Unexpected fixture request");
  };
  return { controls, observations, fetch };
}

/** Validate only demonstrated receipt fields; return a minimal model-safe view.
 * @param {JsonValue} result @param {Kind} kind @param {string} identity
 * @returns {{kind: Kind, reportId: string}}
 */
function receipt(result, kind, identity) {
  // Reparse the untrusted JSON boundary; validate every projected field below.
  const envelope = JSON.parse(JSON.stringify(result));
  if (envelope?.isError) throw new Error("Feedback request failed; reconcile before retry");
  const value = envelope?.structuredContent;
  if (kind === "bug" && value?.status === "submitted" && value.bugId === value.response?.bug_id
      && typeof value.bugId === "string" && value.bugId.length > 0
      && value.response.event_id === identity && value.response.reporter_identity?.verification_result === true) {
    return { kind, reportId: value.bugId };
  }
  if (kind === "enhancement" && value?.contract_version === "v1"
      && value.request?.submission_kind === "enhancement"
      && typeof value.request.id === "string" && value.request.id.length > 0
      && typeof value.replayed === "boolean") {
    return { kind, reportId: value.request.id };
  }
  throw new Error("Feedback receipt is unverified; reconcile before retry");
}

/** @param {ReturnType<typeof qualificationFixture>} fixture
 * @param {(input: QualificationInput) => Promise<unknown>} run
 */
export async function withQualificationAssistant(fixture, run, { bug = true, enhancement = true } = {}) {
  const context = Object.freeze({ actor: fixture.controls.actor, scopeId: fixture.controls.actor });
  const authorized = () => fixture.controls.authorized && fixture.controls.actor === context.actor;
  /** @type {import('../dist/diagnostics.js').AiDiagnosticEvent[]} */
  const diagnostics = [];
  const session = await createRequestScopedMcpSession({ connectorId: "feedback-qualification",
    authorize: () => authorized() ? "allow" : "deny",
    diagnostics: event => diagnostics.push(event),
    connect: async () => {
      const { server } = await createConnectorServer({ config: { enabled: false }, env: {},
        feedbackConfig: { sessionToken: `synthetic-session-${context.actor}`, fetch: fixture.fetch,
          bug: { enabled: bug, apiBaseUrl: "https://feedback.invalid/api", projectId: "fixture-project",
            environment: "dev", serviceEnvId: "fixture-runtime", reportToken: "synthetic-bug-token", transport: "server" },
          enhancement: { enabled: enhancement, apiUrl: "https://feedback.invalid/api/enhancement-reporting/v1",
            projectId: "fixture-project", capabilityId: "fixture-capability", serviceEnvId: "fixture-runtime",
            token: "synthetic-enhancement-token", contractVersion: "v1" },
        } });
      const client = new Client({ name: "feedback-qualification", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const close = async () => {
        fixture.observations.closed++;
        await Promise.all([client.close(), server.close()]);
      };
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        return { listTools: async () => ({ tools: (await client.listTools()).tools.map(tool => {
          const definition = parseToolDefinition({ name: tool.name, description: tool.description ?? tool.name,
            input_schema: tool.inputSchema });
          return { name: definition.name, description: definition.description, inputSchema: definition.input_schema };
        }) }),
          callTool: async ({ name, arguments: args, signal }) => JSON.parse(JSON.stringify(
            await client.callTool({ name, arguments: args }, undefined, { signal }))),
          close };
      } catch { await close(); throw new Error("Fixture connection failed"); }
    },
  }, context);
  try {
    /** @type {Map<string, Kind>} */
    const submitNames = new Map([[FEEDBACK_TOOL_NAMES.bugSubmit, "bug"], [FEEDBACK_TOOL_NAMES.enhancementSubmit, "enhancement"]]);
    // The fixture uses one durable-intent stand-in per explicit request. Provider
    // call IDs never determine this identity. Production needs host durability.
    /** @param {Kind} kind */
    const identity = kind => createHash("sha256").update(JSON.stringify([
      "fixture-project", "dev", context.actor, "fixture-conversation", "fixture-message", kind,
    ])).digest("hex");
    const plugin = createToolPlugin({ pluginId: "feedback.qualification", version: "1.0.0",
      displayName: "Offline feedback qualification",
      registrations: session.tools.filter(tool => submitNames.has(tool.name)).map(tool => {
        const kind = submitNames.get(tool.name);
        if (!kind) throw new Error("Unsupported fixture tool");
        return { definition: { name: tool.name, description: tool.description ?? tool.name, input_schema: tool.inputSchema },
          /** @param {Context} caller */
          discover: caller => caller.actor === context.actor && authorized(),
          /** @type {import('../dist/tools/executor.js').ApplicationToolExecutor<Context>} */
          executor: async (args, execution) => receipt(await session.callTool({ name: tool.name,
            arguments: args, toolCallId: identity(kind), signal: execution.signal }), kind, identity(kind)) };
      }),
    });
    const app = await createAiApplication({ plugins: [plugin], installContext: context,
      policy: () => ({ outcome: "allow" }),
      toolAdmission: ({ applicationContext }) => ({ outcome: authorized() && applicationContext.actor === context.actor ? "allow" : "deny" }),
      diagnostics: event => diagnostics.push(event),
    });
    /** @param {Kind} kind @param {InvokeOptions} options */
    const invoke = (kind, options = {}) => {
      const name = kind === "bug" ? FEEDBACK_TOOL_NAMES.bugSubmit : FEEDBACK_TOOL_NAMES.enhancementSubmit;
      const args = { title: `DEV QA fixture ${kind}`, description: "Offline contract check",
        ...(kind === "bug" ? { event_id: identity(kind) }
          : { idempotency_key: identity(kind), external_conversation_id: "fixture-conversation" }), ...options.arguments };
      return app.executeTool({ discovery: { context }, applicationContext: options.context ?? context,
        call: { name, tool_call_id: identity(kind), arguments: args }, executionKey: identity(kind),
        ...(options.signal ? { signal: options.signal } : {}) });
    };
    return await run({ app, context, invoke, session, diagnostics });
  } finally { await session.close(); }
}
