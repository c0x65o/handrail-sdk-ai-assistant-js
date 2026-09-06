import type {
  ApplicationToolExecutor,
  ApplicationToolOutput,
  ApplicationToolPolicy,
} from "../tools/executor.js";
import { createToolPlugin, type ToolPlugin, type ToolPluginPresentation } from "../tools/plugin.js";
import type { JsonObject, JsonSchemaObject } from "../protocol.js";
import type { ToolRegistration } from "../tools/registry.js";

export const SPARTAN_AEGIS_ADAPTER_VERSION = "handrail.spartan-aegis.v1" as const;

export interface SpartanAegisFunctionDefinition {
  readonly name: string;
  readonly description?: string | null;
  /** Spartan's Zod/OpenAI boundary types generated JSON Schema as unknown. */
  readonly parameters?: unknown;
}

export interface SpartanAegisActionCatalog<TActor> {
  catalogFunctions(actor: TActor): readonly SpartanAegisFunctionDefinition[];
  validate(name: string, args: unknown): Record<string, unknown>;
  summarizeForActor(actor: TActor, name: string, args: unknown): Promise<string>;
}

export interface SpartanAegisProposalInput<TActor> {
  readonly actor: TActor;
  readonly name: string;
  readonly validatedArguments: Record<string, unknown>;
  readonly summary: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export interface SpartanAegisPluginOptions<TActor> {
  /** This adapter is request/actor scoped; no actor identity is serialized. */
  readonly actor: TActor;
  readonly readDefinitions: readonly SpartanAegisFunctionDefinition[];
  readonly runReadTool: (
    name: string,
    input: unknown,
    context: { readonly toolCallId: string; readonly signal: AbortSignal },
  ) => ApplicationToolOutput | Promise<ApplicationToolOutput>;
  readonly actionRegistry: SpartanAegisActionCatalog<TActor>;
  /** Persists a proposal only. Confirmed business execution remains Spartan-owned. */
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
 * Supported adapter for Spartan's existing Aegis read definitions and action
 * registry. Action executors can only persist proposals; this module has no
 * reference to Spartan's confirmed side-effect executor.
 */
export function createSpartanAegisPlugin<TActor>(
  options: SpartanAegisPluginOptions<TActor>,
): ToolPlugin<ApplicationToolExecutor<TActor>, TActor, undefined, TActor> & {
  readonly adapterVersion: typeof SPARTAN_AEGIS_ADAPTER_VERSION;
} {
  const actionDefinitions = options.actionRegistry.catalogFunctions(options.actor);
  const names = new Set<string>();
  const registration = (
    definition: SpartanAegisFunctionDefinition,
    kind: "read" | "proposal",
  ): ToolRegistration<ApplicationToolExecutor<TActor>, TActor> => {
    if (names.has(definition.name)) throw new TypeError(`Duplicate Spartan Aegis tool "${definition.name}"`);
    names.add(definition.name);
    const executor: ApplicationToolExecutor<TActor> = kind === "read"
      ? (input, context) => options.runReadTool(definition.name, input,
        { toolCallId: context.toolCallId, signal: context.signal })
      : async (input, context) => {
          const validatedArguments = options.actionRegistry.validate(definition.name, input);
          const summary = await options.actionRegistry.summarizeForActor(
            options.actor, definition.name, validatedArguments,
          );
          return options.proposeAction({ actor: options.actor, name: definition.name,
            validatedArguments, summary, toolCallId: context.toolCallId, signal: context.signal });
        };
    return {
      definition: { name: definition.name,
        description: definition.description ?? `${definition.name} operation`,
        input_schema: jsonSchemaObject(definition.parameters) },
      executor,
      discover: (actor) => actor === options.actor,
      tags: [kind === "read" ? "spartan-read" : "spartan-proposal"],
    };
  };
  const registrations = [
    ...options.readDefinitions.map((definition) => registration(definition, "read")),
    ...actionDefinitions.map((definition) => registration(definition, "proposal")),
  ];
  const presentation = (definition: SpartanAegisFunctionDefinition, kind: "read" | "proposal") => {
    const value = options.presentationFor?.(definition.name, kind);
    return value ? [{ toolName: definition.name, ...value }] : [];
  };
  const plugin = createToolPlugin({
    pluginId: "spartan.aegis.erp", version: "1.0.0", displayName: "Spartan Aegis ERP",
    registrations,
    ...(options.policy ? { policy: options.policy } : {}),
    approvals: actionDefinitions.map((definition) => ({
      toolName: definition.name,
      // The tool itself creates the externally reviewed Spartan proposal.
      mode: "never" as const,
      summarize: (input: JsonObject) => options.actionRegistry.summarizeForActor(
        options.actor, definition.name, options.actionRegistry.validate(definition.name, input),
      ),
    })),
    presentations: [
      ...options.readDefinitions.flatMap((definition) => presentation(definition, "read")),
      ...actionDefinitions.flatMap((definition) => presentation(definition, "proposal")),
    ],
  });
  return Object.freeze({ ...plugin, adapterVersion: SPARTAN_AEGIS_ADAPTER_VERSION });
}

export const SPARTAN_AEGIS_TOOL_LOOP_LIMITS = Object.freeze({
  maxIterations: 160,
  maxTotalToolCalls: 150,
  maxElapsedMs: 600_000,
  parallelism: 1,
});

export const SPARTAN_AEGIS_MAXIMUM_INPUT_MESSAGES = 30;

function jsonSchemaObject(value: unknown): JsonSchemaObject {
  if (value === undefined) return { type: "object", properties: {}, additionalProperties: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Spartan Aegis tool parameters must be a JSON Schema object");
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonSchemaObject;
  } catch {
    throw new TypeError("Spartan Aegis tool parameters must be JSON serializable");
  }
}
