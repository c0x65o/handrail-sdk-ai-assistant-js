import type { AttachmentReference, JsonObject, JsonSchemaObject, ToolDefinition } from "../protocol.js";
import type { ProviderAdapterInvocation } from "./index.js";
import type { DeferredToolDiscoveryPlan } from "../tools/deferred.js";

export interface OpenAIResponsesFunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  readonly strict: boolean;
  readonly defer_loading?: true;
}

export interface OpenAIResponsesNamespaceTool {
  readonly type: "namespace";
  readonly name: string;
  readonly description: string;
  readonly tools: readonly OpenAIResponsesFunctionTool[];
}

export interface OpenAIResponsesWebSearchTool {
  readonly type: "web_search";
  readonly search_context_size?: "low" | "medium" | "high";
  readonly external_web_access?: boolean;
  readonly filters?: { readonly allowed_domains: readonly string[] };
}

export interface OpenAIResponsesToolSearchTool {
  readonly type: "tool_search";
  readonly execution: "server" | "client";
  readonly description?: string;
  readonly parameters?: JsonObject;
}

export type OpenAIResponsesProjectedTool =
  | OpenAIResponsesFunctionTool
  | OpenAIResponsesNamespaceTool
  | OpenAIResponsesWebSearchTool
  | OpenAIResponsesToolSearchTool;

export interface OpenAIResponsesHostedToolsOptions {
  readonly webSearch?: false | Omit<OpenAIResponsesWebSearchTool, "type">;
  readonly toolSearch?: false | Omit<OpenAIResponsesToolSearchTool, "type">;
}

export interface OpenAIResponsesRequest {
  readonly model: string;
  readonly input: readonly JsonObject[];
  readonly tools: readonly OpenAIResponsesProjectedTool[];
  readonly stream: true;
  readonly store: false;
  readonly parallel_tool_calls: false;
  readonly max_output_tokens: number;
  readonly instructions?: string;
  readonly tool_choice?: "auto" | "required";
  readonly include?: readonly ["reasoning.encrypted_content"];
  readonly reasoning?: { readonly effort: "minimal" | "low" | "medium" | "high" | "xhigh" };
}

export interface BuildOpenAIResponsesRequestOptions {
  readonly model: string;
  readonly invocation: ProviderAdapterInvocation;
  readonly plan: DeferredToolDiscoveryPlan;
  readonly supportsToolSearch: boolean;
  /** Keep schemas unchanged; disable provider strict mode for optional/open fields. Defaults true. */
  readonly functionStrict?: boolean;
  readonly hosted?: OpenAIResponsesHostedToolsOptions;
  readonly instructions?: string;
  readonly toolChoice?: "auto" | "required";
  readonly includeReasoningEncryptedContent?: boolean;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Trusted, bounded provider-native items retained for a store:false continuation. */
  readonly continuationItems?: readonly JsonObject[];
  /** Trusted host projection for opaque image/document references. */
  readonly resolveAttachment?: (reference: AttachmentReference) => JsonObject;
}

function projectFunction(tool: ToolDefinition, deferred = false, strict = true): OpenAIResponsesFunctionTool {
  return Object.freeze({
    type: "function", name: tool.name, description: tool.description,
    parameters: tool.input_schema, strict,
    ...(deferred ? { defer_loading: true as const } : {}),
  });
}

/**
 * Projects an already-authorized provider-neutral plan into the Responses API.
 * Hosted search receives namespace metadata and deferred definitions; models
 * without tool search get a bounded eager-only fallback.
 */
export function projectOpenAIResponsesTools(input: {
  readonly plan: DeferredToolDiscoveryPlan;
  readonly hosted?: OpenAIResponsesHostedToolsOptions;
  readonly supportsToolSearch: boolean;
  readonly functionStrict?: boolean;
}): readonly OpenAIResponsesProjectedTool[] {
  const tools: OpenAIResponsesProjectedTool[] = input.plan.eagerTools.map((tool) => projectFunction(tool, false, input.functionStrict));
  if (input.supportsToolSearch && input.hosted?.toolSearch !== false) {
    for (const namespace of input.plan.namespaces) {
      tools.push(Object.freeze({
        type: "namespace", name: namespace.name, description: namespace.description,
        tools: Object.freeze(namespace.tools.map((tool) => projectFunction(tool, namespace.deferred, input.functionStrict))),
      }));
    }
    tools.push(Object.freeze({ type: "tool_search", execution: input.hosted?.toolSearch?.execution ?? "server", ...input.hosted?.toolSearch }));
  } else {
    // The plan's eager bound is the fallback safety bound; deferred schemas are intentionally omitted.
    for (const namespace of input.plan.namespaces.filter((item) => !item.deferred)) {
      for (const tool of namespace.tools) if (!tools.some((item) => item.type === "function" && item.name === tool.name)) tools.push(projectFunction(tool, false, input.functionStrict));
    }
  }
  if (input.hosted?.webSearch) tools.push(Object.freeze({ type: "web_search", ...input.hosted.webSearch }));
  return Object.freeze(tools);
}

/** Build an SDK-independent `/v1/responses` request with stateless retention. */
export function buildOpenAIResponsesRequest(options: BuildOpenAIResponsesRequestOptions): OpenAIResponsesRequest {
  if (!options.model.trim()) throw new TypeError("model must not be empty");
  const input: JsonObject[] = options.invocation.messages.map((message) => ({
    role: message.role,
    // Assistant text is prior output, not an input_text content block. The
    // Responses easy-message string form preserves authored history verbatim.
    content: message.role === "assistant" && message.content.every(part => part.type === "text")
      ? message.content.map(part => part.type === "text" ? part.text : "").join("")
      : message.content.map((part): JsonObject => {
      if (part.type === "text") return { type: "input_text", text: part.text };
      if (!options.resolveAttachment) throw new TypeError("Responses attachments require trusted host resolution");
      return options.resolveAttachment(part.attachment);
    }),
  }));
  input.push(...(options.continuationItems ?? []));
  for (const result of options.invocation.tool_results) {
    const onlyText = result.content.length === 1 && result.content[0]?.type === "text"
      ? result.content[0].text
      : undefined;
    input.push({
      type: "function_call_output", call_id: result.tool_call_id,
      output: onlyText ?? JSON.stringify(result.content),
    });
  }
  return Object.freeze({
    model: options.model,
    input: Object.freeze(input),
    tools: projectOpenAIResponsesTools({ plan: options.plan, supportsToolSearch: options.supportsToolSearch,
      ...(options.functionStrict === undefined ? {} : { functionStrict: options.functionStrict }),
      ...(options.hosted ? { hosted: options.hosted } : {}) }),
    stream: true, store: false, parallel_tool_calls: false,
    max_output_tokens: options.invocation.generation.max_output_tokens,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    ...(options.includeReasoningEncryptedContent ? { include: ["reasoning.encrypted_content"] as const } : {}),
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
  });
}
