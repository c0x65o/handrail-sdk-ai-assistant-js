import type {
  ApplicationToolExecutor,
  ApplicationToolOutput,
  ApplicationToolPolicy,
  JsonObject,
  JsonSchemaObject,
  JsonValue,
  ToolRegistration,
  ToolPlugin,
  ToolPluginPresentation,
} from "../src/index.js";
import { createToolPlugin } from "../src/index.js";

/** Structural shapes implemented by Spartan's existing AEGIS_TOOL_DEFINITIONS and AEGIS_ACTION_REGISTRY. */
export interface SpartanAegisFunctionDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}
export interface SpartanAegisActionRegistry<TActor, TExecutionContext> {
  catalogFunctions(actor: TActor): readonly SpartanAegisFunctionDefinition[];
  validate(name: string, args: unknown): Record<string, unknown>;
  summarizeForActor(actor: TActor, name: string, args: unknown): Promise<string>;
  execute(actor: TActor, context: TExecutionContext, name: string, args: unknown): Promise<unknown>;
}

export interface SpartanAegisAdapterOptions<TActor, TExecutionContext> {
  readonly actor: TActor;
  readonly readDefinitions: readonly SpartanAegisFunctionDefinition[];
  readonly runReadTool: (name: string, input: unknown) => Promise<unknown>;
  readonly actionRegistry: SpartanAegisActionRegistry<TActor, TExecutionContext>;
  readonly actionExecutionContext: TExecutionContext;
}

function jsonResult(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

/**
 * Checked migration seam for Spartan's current definitions and action registry.
 * Zod validation, actor filtering, summaries, confirmation, and side effects
 * remain in Spartan. Handrail only supplies discovery/execution plumbing.
 */
export function createSpartanAegisRegistrations<TActor, TExecutionContext>(
  options: SpartanAegisAdapterOptions<TActor, TExecutionContext>,
): {
  readonly registrations: readonly ToolRegistration<ApplicationToolExecutor<TActor>, TActor>[];
  readonly policy: ApplicationToolPolicy<TActor>;
} {
  const actionDefinitions = options.actionRegistry.catalogFunctions(options.actor);
  const actionNames = new Set(actionDefinitions.map((definition) => definition.name));
  const registrations = [...options.readDefinitions, ...actionDefinitions].map((definition) => {
    const action = actionNames.has(definition.name);
    const executor: ApplicationToolExecutor<TActor> = async (args) => jsonResult(action
      ? await options.actionRegistry.execute(options.actor, options.actionExecutionContext,
          definition.name, options.actionRegistry.validate(definition.name, args))
      : await options.runReadTool(definition.name, args));
    return {
      definition: {
        name: definition.name,
        description: definition.description,
        input_schema: definition.parameters,
      },
      executor,
      discover: (actor: TActor) => actor === options.actor,
      tags: [action ? "spartan-action" : "spartan-read"],
    } satisfies ToolRegistration<ApplicationToolExecutor<TActor>, TActor>;
  });
  const policy: ApplicationToolPolicy<TActor> = ({ definition, arguments: args }) => {
    if (!actionNames.has(definition.name)) return { outcome: "allow" };
    // Re-run Spartan's Zod boundary before a proposal is persisted. Execution
    // occurs only after ApprovalExecutionCoordinator supplies confirmed evidence.
    options.actionRegistry.validate(definition.name, args as JsonObject);
    return { outcome: "external_approval_required" };
  };
  return Object.freeze({ registrations: Object.freeze(registrations), policy });
}

export const SPARTAN_AEGIS_TOOL_LOOP_LIMITS = Object.freeze({
  maxIterations: 160,
  maxTotalToolCalls: 150,
  maxElapsedMs: 600_000,
  parallelism: 1,
});

export interface SpartanAegisProposalInput<TActor> {
  readonly actor: TActor;
  readonly name: string;
  readonly validatedArguments: Record<string, unknown>;
  readonly summary: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export interface SpartanAegisPluginOptions<TActor> {
  readonly actor: TActor;
  readonly readDefinitions: readonly SpartanAegisFunctionDefinition[];
  readonly runReadTool: (
    name: string,
    input: unknown,
    context: { readonly toolCallId: string; readonly signal: AbortSignal },
  ) => ApplicationToolOutput | Promise<ApplicationToolOutput>;
  readonly actionRegistry: Pick<SpartanAegisActionRegistry<TActor, never>,
    "catalogFunctions" | "validate" | "summarizeForActor">;
  /** Persist a proposal only. Confirmed side effects remain in Spartan. */
  readonly proposeAction: (
    input: SpartanAegisProposalInput<TActor>,
  ) => ApplicationToolOutput | Promise<ApplicationToolOutput>;
  readonly policy?: ApplicationToolPolicy<TActor>;
  readonly presentationFor?: (
    toolName: string,
    kind: "read" | "proposal",
  ) => Omit<ToolPluginPresentation, "toolName"> | undefined;
}

/**
 * Production migration seam: read tools execute normally, while action tools
 * can only create Spartan-owned proposals. The existing confirmation route and
 * action registry remain the sole path to a business side effect.
 */
export function createSpartanAegisPlugin<TActor>(
  options: SpartanAegisPluginOptions<TActor>,
): ToolPlugin<ApplicationToolExecutor<TActor>, TActor, undefined, TActor> {
  const actionDefinitions = options.actionRegistry.catalogFunctions(options.actor);
  const registrations = [
    ...options.readDefinitions.map((definition) => ({
      definition: { name: definition.name, description: definition.description,
        input_schema: definition.parameters },
      executor: (input: JsonObject, context: Parameters<ApplicationToolExecutor<TActor>>[1]) =>
        options.runReadTool(definition.name, input,
          { toolCallId: context.toolCallId, signal: context.signal }),
      discover: (actor: TActor) => actor === options.actor,
      tags: ["spartan-read"],
    })),
    ...actionDefinitions.map((definition) => ({
      definition: { name: definition.name, description: definition.description,
        input_schema: definition.parameters },
      executor: async (input: JsonObject, context: Parameters<ApplicationToolExecutor<TActor>>[1]) => {
        const validatedArguments = options.actionRegistry.validate(definition.name, input);
        const summary = await options.actionRegistry.summarizeForActor(
          options.actor, definition.name, validatedArguments,
        );
        return options.proposeAction({ actor: options.actor, name: definition.name,
          validatedArguments, summary, toolCallId: context.toolCallId, signal: context.signal });
      },
      discover: (actor: TActor) => actor === options.actor,
      tags: ["spartan-proposal"],
    })),
  ] satisfies readonly ToolRegistration<ApplicationToolExecutor<TActor>, TActor>[];
  const presentations = [
    ...options.readDefinitions.flatMap((definition) => {
      const presentation = options.presentationFor?.(definition.name, "read");
      return presentation ? [{ toolName: definition.name, ...presentation }] : [];
    }),
    ...actionDefinitions.flatMap((definition) => {
      const presentation = options.presentationFor?.(definition.name, "proposal");
      return presentation ? [{ toolName: definition.name, ...presentation }] : [];
    }),
  ];
  return createToolPlugin({
    pluginId: "spartan.aegis.erp",
    version: "1.0.0",
    displayName: "Spartan Aegis ERP",
    registrations,
    ...(options.policy ? { policy: options.policy } : {}),
    approvals: actionDefinitions.map((definition) => ({
      toolName: definition.name,
      mode: "never" as const,
      summarize: (input: JsonObject) => options.actionRegistry.summarizeForActor(
        options.actor, definition.name, options.actionRegistry.validate(definition.name, input),
      ),
    })),
    presentations,
  });
}
