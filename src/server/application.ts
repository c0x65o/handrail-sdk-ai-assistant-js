export { runIndependentReadBatch, type IndependentReadCall, type IndependentReadResult } from "../tools/read-batch.js";
import type { ConversationRuntimeOptions } from "../runtime.js";
import { createConversationRuntime, type ConversationRuntime } from "../runtime.js";
import type { ToolDefinition } from "../protocol.js";
import {
  createApplicationGateway,
  type ApplicationGateway,
  type ApplicationGatewayAuthorizationContext,
  type ApplicationGatewayOptions,
} from "../transports/application-gateway.js";
import {
  createDeferredToolDiscoveryPlan,
  type DeferredToolDiscoveryPlan,
  type ToolNamespaceDefinition,
} from "../tools/deferred.js";
import {
  BoundedToolExecutor,
  type ApplicationToolExecutor,
  type ApplicationToolPolicyInput,
  type ApplicationToolPolicy,
  type ApplicationToolPolicyDecision,
  type BoundedToolExecutionOutcome,
  type BoundedToolExecutorLimits,
  type BoundedToolExecutionRequest,
  type ToolExecutionLedger,
} from "../tools/executor.js";
import type { ApprovalExecutionCoordinator } from "../tools/approval-execution.js";
import type { AiDiagnosticSink } from "../diagnostics.js";
import type { ToolRecoveryPolicy } from "../tools/recovery.js";
import type { ApplicationToolOutput } from "../tools/executor.js";
export * from "../tools/recovery.js";
export * from "./tool-incidents.js";
import {
  runToolLoop,
  type RunToolLoopOptions,
  type ToolLoopLimits,
  type ToolLoopResult,
} from "../tools/loop.js";
import type {
  ToolPlugin,
  ToolPluginApprovalMode,
  ToolPluginPresentation,
} from "../tools/plugin.js";
import {
  ToolRegistry,
  type ToolDiscoveryAdapter,
  type ToolDiscoveryQuery,
  type ToolRegistration,
} from "../tools/registry.js";

export {
  createApplicationTurnTransport,
  type ApplicationTurnExecutionContext,
  type ApplicationTurnTransportOptions,
} from "../transports/application-turn.js";
export type { DurableTurnExecutionIdentity, TurnExecutionContext } from "../transports/types.js";
export {
  createDurableApplicationTransport,
  InMemoryDurableApplicationTurnStore,
  type DurableApplicationTransport,
  type DurableApplicationTurnStore,
  type DurableApplicationTurnRequestCodec,
} from "../transports/durable.js";
export { createAttachmentStagingService, type AttachmentBlobStore,
  type AttachmentStagingMetadataStore } from "../attachments/staging.js";

export const AI_APPLICATION_ASSEMBLY_VERSION = "handrail.ai-application.v1" as const;

export interface AiApplicationPublicApproval {
  readonly toolName: string;
  readonly mode: ToolPluginApprovalMode;
  readonly rendererKey?: string;
}

export interface AiApplicationPublicPlugin {
  readonly pluginId: string;
  readonly version: string;
  readonly identity: string;
  readonly displayName: string;
  readonly description?: string;
  readonly tools: readonly ToolDefinition[];
  readonly approvals: readonly AiApplicationPublicApproval[];
  readonly presentations: readonly ToolPluginPresentation[];
}

export interface AiApplicationClientCatalog {
  readonly version: typeof AI_APPLICATION_ASSEMBLY_VERSION;
  readonly tools: readonly ToolDefinition[];
  readonly plugins: readonly AiApplicationPublicPlugin[];
}

export type ApplicationApprovalPolicyDecision =
  | "require_approval"
  | "allow_without_approval";

export interface ApplicationApprovalPolicyInput<TApplicationContext>
  extends ApplicationToolPolicyInput<TApplicationContext> {
  readonly pluginId: string;
  readonly configuredMode: "policy";
}

/**
 * Chooses whether a policy-controlled tool pauses for human confirmation.
 * Authorization remains exclusively owned by ApplicationToolPolicy.
 */
export type ApplicationApprovalPolicy<TApplicationContext> = (
  input: ApplicationApprovalPolicyInput<TApplicationContext>,
) => ApplicationApprovalPolicyDecision | Promise<ApplicationApprovalPolicyDecision>;

export interface CreateAiApplicationOptions<
  TApplicationContext,
  TDiscoveryContext,
  TInstallContext,
  TApprovalPermissionContext = unknown,
> {
  readonly plugins?: readonly ToolPlugin<
    ApplicationToolExecutor<TApplicationContext>,
    TDiscoveryContext,
    TInstallContext,
    TApplicationContext,
    unknown
  >[];
  /** MCP and other deferred sources use this same server-only discovery seam. */
  readonly connectors?: readonly ToolDiscoveryAdapter<
    ApplicationToolExecutor<TApplicationContext>,
    TDiscoveryContext,
    TInstallContext
  >[];
  readonly installContext: TInstallContext;
  readonly policy: ApplicationToolPolicy<TApplicationContext>;
  /** Project-aware confirmation policy for plugin tools whose approval mode is `policy`. */
  readonly approvalPolicy?: ApplicationApprovalPolicy<TApplicationContext>;
  readonly approvalCoordinator?: ApprovalExecutionCoordinator<TApprovalPermissionContext>;
  /** One host-only sink shared by bounded tool and approval execution. */
  readonly diagnostics?: AiDiagnosticSink;
  readonly executorLimits?: Partial<BoundedToolExecutorLimits>;
  readonly toolRecovery?: ToolRecoveryPolicy<TApplicationContext, ApplicationToolOutput>;
  /** Durable exactly-once ledger. Production constructors attach the scoped persistence ledger. */
  readonly toolExecutionLedger?: ToolExecutionLedger;
  readonly toolLoopLimits?: Partial<ToolLoopLimits>;
  /** Default durable usage sink automatically attached to runtimes created by this application. */
  readonly usageReceiptSink?: ConversationRuntimeOptions<unknown>["usageReceiptSink"];
}

export interface AiApplicationRunOptions<
  TApplicationContext,
  TDiscoveryContext,
  TApprovalPermissionContext,
> extends Omit<RunToolLoopOptions<TApplicationContext, TDiscoveryContext, TApprovalPermissionContext>,
  "executor" | "discoveredTools" | "limits"> {
  readonly discovery: ToolDiscoveryQuery<TDiscoveryContext>;
  readonly limits?: Partial<ToolLoopLimits>;
}

/**
 * Executes one provider-requested call through the exact discovery, policy,
 * approval, validation, diagnostics, and bounded-execution boundary owned by
 * this application. This is the migration seam for hosts that retain their
 * provider continuation loop while adopting Handrail's tool infrastructure.
 */
export interface AiApplicationToolExecutionOptions<
  TApplicationContext,
  TDiscoveryContext,
  TApprovalPermissionContext,
> extends Omit<BoundedToolExecutionRequest<TApplicationContext, TApprovalPermissionContext>, "discoveredTools"> {
  readonly discovery: ToolDiscoveryQuery<TDiscoveryContext>;
}

export interface AiApplication<
  TApplicationContext,
  TDiscoveryContext,
  TApprovalPermissionContext,
> {
  readonly version: typeof AI_APPLICATION_ASSEMBLY_VERSION;
  discover(query: ToolDiscoveryQuery<TDiscoveryContext>): readonly ToolDefinition[];
  catalog(query: ToolDiscoveryQuery<TDiscoveryContext>): AiApplicationClientCatalog;
  deferredPlan(input: {
    readonly discovery: ToolDiscoveryQuery<TDiscoveryContext>;
    readonly namespaces?: readonly ToolNamespaceDefinition[];
    readonly maximumEagerTools?: number;
  }): DeferredToolDiscoveryPlan;
  executeTool(options: AiApplicationToolExecutionOptions<
    TApplicationContext,
    TDiscoveryContext,
    TApprovalPermissionContext
  >): Promise<BoundedToolExecutionOutcome>;
  run(options: AiApplicationRunOptions<TApplicationContext, TDiscoveryContext, TApprovalPermissionContext>): Promise<ToolLoopResult>;
  createRuntime<TRequest>(options: ConversationRuntimeOptions<TRequest>): Promise<ConversationRuntime<TRequest>>;
  createGateway<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext>(
    options: ApplicationGatewayOptions<TEvent, TRequest, TContext>,
  ): ApplicationGateway;
}

async function registrations<TExecutor, TDiscoveryContext, TInstallContext>(
  source: ToolDiscoveryAdapter<TExecutor, TDiscoveryContext, TInstallContext>,
  context: TInstallContext,
): Promise<readonly ToolRegistration<TExecutor, TDiscoveryContext>[]> {
  const values: ToolRegistration<TExecutor, TDiscoveryContext>[] = [];
  for await (const registration of await source.registrations(context)) values.push(registration);
  return values;
}

/**
 * Assemble the trusted application boundary once. Returned client catalogs are
 * data-only snapshots; the registry, executors, policies, approval functions,
 * connector clients, and install/application contexts remain in this closure.
 */
export async function createAiApplication<
  TApplicationContext,
  TDiscoveryContext,
  TInstallContext,
  TApprovalPermissionContext = unknown,
>(options: CreateAiApplicationOptions<
  TApplicationContext,
  TDiscoveryContext,
  TInstallContext,
  TApprovalPermissionContext
>): Promise<AiApplication<TApplicationContext, TDiscoveryContext, TApprovalPermissionContext>> {
  const registry = new ToolRegistry<ApplicationToolExecutor<TApplicationContext>, TDiscoveryContext>();
  const plugins = [...(options.plugins ?? [])];
  const ownerByTool = new Map<string, typeof plugins[number]>();
  const toolsByPlugin = new Map<string, readonly string[]>();

  for (const plugin of plugins) {
    if (toolsByPlugin.has(plugin.pluginId)) throw new TypeError(`Duplicate plugin "${plugin.pluginId}"`);
    const installed = await registrations(plugin, options.installContext);
    const names: string[] = [];
    for (const registration of installed) {
      registry.register(registration);
      names.push(registration.definition.name);
      ownerByTool.set(registration.definition.name, plugin);
    }
    const installedNames = new Set(names);
    for (const metadata of [...plugin.approvals, ...plugin.presentations]) {
      if (!installedNames.has(metadata.toolName)) throw new TypeError(`Plugin "${plugin.pluginId}" metadata references an unregistered tool`);
    }
    toolsByPlugin.set(plugin.pluginId, Object.freeze(names));
  }
  for (const connector of options.connectors ?? []) {
    await registry.registerAdapter(connector, options.installContext);
  }

  const policy: ApplicationToolPolicy<TApplicationContext> = async (input) => {
    const host = await options.policy(input);
    if (host.outcome !== "allow") return host;
    const plugin = ownerByTool.get(input.definition.name);
    const pluginDecision = plugin?.policy
      ? await plugin.policy(input)
      : ({ outcome: "allow" } satisfies ApplicationToolPolicyDecision);
    if (pluginDecision.outcome !== "allow") return pluginDecision;
    if (plugin === undefined) return { outcome: "allow" };
    const approval = plugin.approvals.find((item) => item.toolName === input.definition.name);
    if (approval === undefined || approval.mode === "never") return { outcome: "allow" };
    if (approval.mode === "always") return { outcome: "external_approval_required" };
    const decision = await options.approvalPolicy?.({
      ...input,
      pluginId: plugin.pluginId,
      configuredMode: "policy",
    }) ?? "allow_without_approval";
    if (decision !== "require_approval" && decision !== "allow_without_approval") {
      throw new TypeError("Application approval policy returned an invalid decision");
    }
    return decision === "require_approval"
      ? { outcome: "external_approval_required" }
      : { outcome: "allow" };
  };
  const executor = new BoundedToolExecutor({
    registry,
    policy,
    ...(options.approvalCoordinator ? { approvalCoordinator: options.approvalCoordinator } : {}),
    ...(options.toolExecutionLedger ? { ledger: options.toolExecutionLedger } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.executorLimits ? { limits: options.executorLimits } : {}),
    ...(options.toolRecovery ? { recovery: options.toolRecovery } : {}),
  });
  const discover = (query: ToolDiscoveryQuery<TDiscoveryContext>) => registry.discover(query);

  return Object.freeze({
    version: AI_APPLICATION_ASSEMBLY_VERSION,
    discover,
    catalog(query: ToolDiscoveryQuery<TDiscoveryContext>) {
      const tools = discover(query);
      const visible = new Set(tools.map((tool) => tool.name));
      return Object.freeze({
        version: AI_APPLICATION_ASSEMBLY_VERSION,
        tools,
        plugins: Object.freeze(plugins.map((plugin) => Object.freeze({
          pluginId: plugin.pluginId,
          version: plugin.version,
          identity: plugin.identity,
          displayName: plugin.displayName,
          ...(plugin.description ? { description: plugin.description } : {}),
          tools: Object.freeze(tools.filter((tool) => toolsByPlugin.get(plugin.pluginId)?.includes(tool.name))),
          approvals: Object.freeze(plugin.approvals.filter((item) => visible.has(item.toolName)).map((item) => Object.freeze({
            toolName: item.toolName,
            mode: item.mode,
            ...(item.rendererKey ? { rendererKey: item.rendererKey } : {}),
          }))),
          presentations: Object.freeze(plugin.presentations.filter((item) => visible.has(item.toolName))),
        }))),
      });
    },
    deferredPlan(input: {
      readonly discovery: ToolDiscoveryQuery<TDiscoveryContext>;
      readonly namespaces?: readonly ToolNamespaceDefinition[];
      readonly maximumEagerTools?: number;
    }) {
      return createDeferredToolDiscoveryPlan({
        tools: discover(input.discovery),
        namespaces: input.namespaces ?? [],
        ...(input.maximumEagerTools === undefined ? {} : { maximumEagerTools: input.maximumEagerTools }),
      });
    },
    executeTool(input: AiApplicationToolExecutionOptions<
      TApplicationContext,
      TDiscoveryContext,
      TApprovalPermissionContext
    >) {
      const { discovery, ...request } = input;
      return executor.executeDetailed({
        ...request,
        discoveredTools: discover(discovery),
      });
    },
    run(input: AiApplicationRunOptions<TApplicationContext, TDiscoveryContext, TApprovalPermissionContext>) {
      const { discovery, limits, ...run } = input;
      return runToolLoop({
        ...run,
        discoveredTools: discover(discovery),
        executor,
        limits: { ...options.toolLoopLimits, ...limits },
      });
    },
    createRuntime<TRequest>(runtimeOptions: ConversationRuntimeOptions<TRequest>) {
      return createConversationRuntime({
        ...runtimeOptions,
        ...(runtimeOptions.usageReceiptSink || !options.usageReceiptSink
          ? {}
          : { usageReceiptSink: options.usageReceiptSink }),
      });
    },
    createGateway<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext>(
      gatewayOptions: ApplicationGatewayOptions<TEvent, TRequest, TContext>,
    ) {
      const diagnostics = gatewayOptions.diagnostics ?? options.diagnostics;
      return createApplicationGateway({
        ...gatewayOptions,
        ...(diagnostics ? { diagnostics } : {}),
      });
    },
  });
}
