import { createHash } from "node:crypto";
import { ConversationCatalogError, parseConversationCatalogTitle, type ConversationCatalog } from "../conversation/catalog.js";
import { ConversationTitleGenerationService, createConversationTitleGenerationContext,
  DEFAULT_CONVERSATION_TITLE, type ConversationTitleGenerationHostRequest } from "../conversation/title-generation.js";
import { replayConversation } from "../conversation/replay.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import { PostgresProviderOperationStore, type PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import type { ProviderUsage } from "../providers/index.js";
import { parseNormalizedUsageReceipt, projectProviderUsageToReceipt } from "../usage.js";
import type { HandrailAssistantAuthorizationContext } from "./assistant.js";

export interface AssistantTitleProviderRequest<TContext> extends ConversationTitleGenerationHostRequest {
  readonly authorizationContext: TContext;
  /** Report this invocation separately from the conversational answer. */
  readonly recordUsage: (usage: ProviderUsage | null, status: "completed" | "failed" | "cancelled") => Promise<void>;
}

export interface AssistantAutomaticTitleOptions {
  /** Existing catalog placeholder labels. A null title is always considered untitled. */
  readonly placeholderTitles?: readonly string[];
  /** Includes provider work and usage capture. Defaults to 30 seconds. */
  readonly timeoutMilliseconds?: number;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** The server owns generation, duplicate dispatch protection, and catalog persistence. */
export function createAssistantConversationTitles<TContext extends HandrailAssistantAuthorizationContext>(options: {
  readonly assistantId: string;
  readonly automatic?: false | AssistantAutomaticTitleOptions;
  readonly catalogFor: (context: TContext) => ConversationCatalog<TContext>;
  readonly bundleFor: (context: TContext) => PostgresAssistantPersistenceBundle<TContext>;
  readonly provider: {
    readonly metadata: { readonly provider_id: string; readonly model_id: string };
    readonly generateTitle?: (input: AssistantTitleProviderRequest<TContext>) => Promise<string>;
  };
  readonly diagnostics?: AiDiagnosticSink;
}) {
  const policy = options.automatic === false ? {} : options.automatic;
  const placeholders = new Set([DEFAULT_CONVERSATION_TITLE, ...(policy?.placeholderTitles ?? [])]);
  const timeoutMilliseconds = policy?.timeoutMilliseconds ?? 30_000;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300_000) {
    throw new TypeError("The automatic title timeout must be between 1 and 300000 milliseconds.");
  }
  const isUntitled = (title: string | null) => title === null || placeholders.has(title);
  const pending = new Map<string, Promise<string>>();
  const automatic = options.automatic !== false && options.provider.generateTitle !== undefined;

  const generate = async (conversationId: string, context: TContext, requireCompleted = false): Promise<string> => {
    const catalog = options.catalogFor(context);
    // Authorize before consulting shared work or reading any transcript.
    const found = await catalog.get({ authorizationContext: context, conversationId: conversationId as never });
    if (!isUntitled(found.descriptor.title)) return found.descriptor.title!;
    if (found.descriptor.lifecycle !== "active" || !catalog.capabilities.rename.supported) {
      throw new ConversationCatalogError("unsupported", "rename");
    }
    const identity = hash(JSON.stringify([options.assistantId, context.tenantId, context.scopeId, conversationId]));
    const existing = pending.get(identity);
    if (existing) return existing;
    const work = (async () => {
      const bundle = options.bundleFor(context);
      const replay = await replayConversation({ conversationId: conversationId as never, eventStore: bundle.events });
      const state = replay.state;
      replay.store.destroy();
      if (state.replay_error !== null) throw new ConversationCatalogError("unavailable", "rename");
      const titleContext = createConversationTitleGenerationContext(state);
      if (titleContext.userTexts.length === 0) return found.descriptor.title ?? DEFAULT_CONVERSATION_TITLE;
      const completedTurn = [...state.turns].reverse().find((turn) => turn.status === "completed");
      if (requireCompleted && !completedTurn) return found.descriptor.title ?? DEFAULT_CONVERSATION_TITLE;
      const operationId = `title-${hash(JSON.stringify([identity, state.turns.at(-1)?.turn_id ?? "first-message"]))}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Conversation title generation timed out.")), timeoutMilliseconds);
      timeout.unref?.();
      try {
        const invoke = async (): Promise<string> => {
          let usageRecorded = false;
          const recordUsage: AssistantTitleProviderRequest<TContext>["recordUsage"] = async (usage, status) => {
            const receiptContext = {
              usage_receipt_id: `${operationId}:usage`, conversation_id: conversationId,
              turn_id: operationId, logical_request_id: operationId, trace_id: operationId,
              attempt: { id: `${operationId}:attempt`, index: 0 },
              continuation: { id: `${operationId}:continuation`, index: 0 },
              provider_id: options.provider.metadata.provider_id, model_id: options.provider.metadata.model_id,
              attribution: context.attribution, source: "provider" as const, terminal_status: status,
            };
            const unavailable = { status: "unavailable" as const };
            const receipt = usage ? projectProviderUsageToReceipt(usage, { ...receiptContext, quality: "reported" })
              : parseNormalizedUsageReceipt({ version: 1, ...receiptContext, tokens: {
                input_tokens: unavailable, cached_input_tokens: unavailable, output_tokens: unavailable,
                reasoning_tokens: unavailable, total_tokens: unavailable,
              }, provider_cost: unavailable });
            await bundle.usageReceiptSink?.capture(receipt);
            usageRecorded = true;
          };
          const service = new ConversationTitleGenerationService(async (request) => {
            if (!options.provider.generateTitle) return null;
            await bundle.usageAdmissions?.admit({ idempotency_key: `${operationId}:admission`,
              provider: options.provider.metadata.provider_id, model: options.provider.metadata.model_id,
              client_request_id: operationId, trace_id: operationId });
            try {
              const title = await options.provider.generateTitle({ ...request, authorizationContext: context, recordUsage });
              if (!usageRecorded) await recordUsage(null, "completed");
              return title;
            } catch (error) {
              if (!usageRecorded) await recordUsage(null, controller.signal.aborted ? "cancelled" : "failed");
              throw error;
            }
          });
          return service.generateTitle({ state, signal: controller.signal, idempotencyKey: operationId });
        };
        // Keep completed results across catalog-write failures and process restarts.
        // An uncertain external dispatch is never repeated under the same identity.
        const generated = options.provider.generateTitle
          ? await new PostgresProviderOperationStore(bundle.persistence, context.tenantId, context.scopeId).run({
            operationId, requestFingerprint: hash(JSON.stringify(titleContext)), execute: invoke,
            parseResult: (value) => parseConversationCatalogTitle(value, "rename"),
          }) : await invoke();
        const latest = await catalog.get({ authorizationContext: context, conversationId: conversationId as never });
        if (!isUntitled(latest.descriptor.title)) return latest.descriptor.title!;
        if (latest.descriptor.lifecycle !== "active") return latest.descriptor.title ?? DEFAULT_CONVERSATION_TITLE;
        // A concurrent manual rename/archive always wins the optimistic write.
        const renamed = await catalog.rename({ authorizationContext: context, conversationId: conversationId as never,
          expectedVersion: latest.descriptor.version, idempotencyKey: `${operationId}:rename` as never, title: generated });
        return renamed.descriptor.title ?? generated;
      } finally { clearTimeout(timeout); }
    })();
    pending.set(identity, work);
    try { return await work; }
    finally { if (pending.get(identity) === work) pending.delete(identity); }
  };

  return Object.freeze({ automatic, generate,
    async afterActivity(conversationId: string, context: TContext): Promise<void> {
      if (!automatic) return;
      try { await generate(conversationId, context); }
      catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "automatic_title",
        phase: "failed", conversationId, code: "title_generation_failed", retryable: true, cause }); }
    },
    async afterCompletion(conversationId: string, context: TContext): Promise<void> {
      if (!automatic) return;
      try { await generate(conversationId, context, true); }
      catch (cause) { emitAiDiagnostic(options.diagnostics, { domain: "gateway", operation: "automatic_title",
        phase: "failed", conversationId, code: "title_generation_failed", retryable: true, cause }); }
    },
  });
}
