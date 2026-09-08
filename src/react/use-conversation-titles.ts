import { useEffect, useMemo } from "react";
import type { HandrailAiClient } from "../client/bootstrap.js";
import type { ConversationId } from "../conversation/events.js";
import { DEFAULT_CONVERSATION_TITLE } from "../conversation/title-generation.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { ChatRequest, StreamEvent } from "../protocol.js";
import { useConversationWorkspaceSnapshot } from "./workspace.js";

export interface UseConversationTitlesOptions {
  readonly client: HandrailAiClient<StreamEvent, ChatRequest, object>;
  readonly enabled?: boolean;
  readonly placeholderTitles?: readonly string[];
  readonly onTitle?: (conversationId: ConversationId, title: string) => void;
  readonly diagnostics?: AiDiagnosticSink;
}

const AUTHORIZATION_CONTEXT = Object.freeze({});

/** Shared by styled, headless, and native React clients; never tied to a send button. */
export function useConversationTitles({ client, enabled = true, placeholderTitles, onTitle, diagnostics }: UseConversationTitlesOptions): void {
  const snapshot = useConversationWorkspaceSnapshot(client.workspace ?? undefined);
  const owner = useMemo(() => ({ active: true, settled: new Set<ConversationId>(), pending: new Set<ConversationId>() }), [client]);
  useEffect(() => { owner.active = true; return () => { owner.active = false; }; }, [owner]);
  useEffect(() => {
    if (!enabled || !client.catalog.capabilities.rename.supported) return;
    const placeholders = new Set([DEFAULT_CONVERSATION_TITLE, ...(placeholderTitles ?? [])]);
    const isUntitled = (title: string | null) => title === null || placeholders.has(title);
    for (const thread of snapshot.threads) {
      const conversationId = thread.conversationId;
      if (thread.turnStatus !== "completed" || owner.settled.has(conversationId) || owner.pending.has(conversationId)) continue;
      owner.pending.add(conversationId);
      void (async () => {
        try {
          let descriptor = (await client.catalog.get({ authorizationContext: AUTHORIZATION_CONTEXT, conversationId })).descriptor;
          if (!owner.active || descriptor.lifecycle === "archived") return;
          if (isUntitled(descriptor.title)) {
            const token = String(conversationId).replaceAll(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 80);
            const generated = await client.resources.generateTitle({ conversationId, idempotencyKey: `assistant-title-v1-${token}` });
            if (!owner.active) return;
            // New servers persist titles; older endpoints only return generated text.
            // Re-read before the compatibility write to preserve concurrent renames.
            descriptor = (await client.catalog.get({ authorizationContext: AUTHORIZATION_CONTEXT, conversationId })).descriptor;
            if (!owner.active || descriptor.lifecycle === "archived") return;
            if (isUntitled(descriptor.title)) {
              descriptor = (await client.catalog.rename({ authorizationContext: AUTHORIZATION_CONTEXT, conversationId,
                expectedVersion: descriptor.version,
                idempotencyKey: `assistant-rename-v2-${token}-${descriptor.version}` as never, title: generated })).descriptor;
            }
          }
          if (owner.active && descriptor.title !== null) {
            owner.settled.add(conversationId);
            onTitle?.(conversationId, descriptor.title);
          }
        } catch (cause) {
          emitAiDiagnostic(diagnostics, { domain: "gateway", operation: "automatic_title",
            phase: "failed", retryable: true, conversationId, cause });
        } finally { owner.pending.delete(conversationId); }
      })();
    }
  }, [client, diagnostics, enabled, onTitle, owner, placeholderTitles, snapshot.threads]);
}
