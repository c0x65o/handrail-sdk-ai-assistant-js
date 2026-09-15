import { createToolPlugin, type ApplicationToolExecutor, type JsonValue } from "@handrail/ai-assistant";
import { SPARTAN_AEGIS_TOOL_LOOP_LIMITS } from "@handrail/ai-assistant/adapters/spartan-aegis";
import { postgres, type PostgresPoolLike } from "@handrail/ai-assistant/persistence/postgres";
import { createHandrailAssistant, openaiResponses,
  type HandrailAssistantAuthorizationContext } from "@handrail/ai-assistant/server/assistant";
import { usageFromEnvironment } from "@handrail/ai-assistant/server/usage-control";

interface AegisActor { readonly userId: string; readonly companyId: string }
interface AegisContext extends HandrailAssistantAuthorizationContext { readonly actor: AegisActor }
interface AegisDefinition { readonly name: string; readonly description: string; readonly parameters: object;
  readonly mutates: boolean }
interface AegisDomain {
  definitions(actor: AegisActor): readonly AegisDefinition[];
  validate(name: string, input: unknown): unknown;
  execute(actor: AegisActor, name: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}

declare const app: { use(path: string, middleware: unknown): void };
declare const pool: PostgresPoolLike;
declare const aegis: AegisDomain;
declare const instructions: string;
declare function resolveAuthenticatedUser(request: Request): Promise<AegisContext>;
declare function listActiveAegisContexts(): AsyncIterable<AegisContext>;

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const mutatingTools = new Set<string>();
const erpTools = createToolPlugin<ApplicationToolExecutor<AegisContext>, AegisContext, AegisContext, AegisContext>({
  pluginId: "spartan.aegis.erp",
  version: "2.0.0",
  displayName: "Aegis ERP",
  registrations: (installedFor) => aegis.definitions(installedFor.actor).map((definition) => {
    if (definition.mutates) mutatingTools.add(definition.name);
    return ({
    definition: { name: definition.name, description: definition.description,
      input_schema: definition.parameters as never },
    discover: (request) => request.actor.companyId === installedFor.actor.companyId,
    executor: async (input, execution) => json(await aegis.execute(
      execution.applicationContext.actor,
      definition.name,
      aegis.validate(definition.name, input),
      execution.signal,
    )),
    tags: [definition.mutates ? "aegis-action" : "aegis-read"],
    });
  }),
});

const assistant = await createHandrailAssistant<AegisContext>({
  id: "aegis",
  instructions,
  authorize: (request) => resolveAuthenticatedUser(request),
  provider: openaiResponses({ model: process.env.OPENAI_MODEL ?? "gpt-5.1", maximumInputMessages: 30 }),
  persistence: postgres(pool),
  tools: [erpTools],
  toolPolicy: ({ definition }) => mutatingTools.has(definition.name)
    ? { outcome: "external_approval_required" }
    : { outcome: "allow" },
  usage: usageFromEnvironment(),
  recoveryContexts: listActiveAegisContexts,
  toolLoopLimits: SPARTAN_AEGIS_TOOL_LOOP_LIMITS,
});

// Authentication, SSE, retries, durable replay, cancellation, tool continuation,
// approvals, attachments, synchronization, and usage receipts are SDK-owned.
app.use("/api/assistant/aegis", assistant.express({ origin: "https://app.spartan.example" }));

// Legacy dual-write remains a rollout/rollback adapter outside this reusable integration.
void assistant.recoverPending();
void assistant.flushUsage();
