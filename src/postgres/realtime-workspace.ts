import type { PostgresRealtimeCallStore } from "./realtime-calls.js";
import { PostgresRealtimeToolActivityStore } from "./realtime-tool-activity.js";

export interface RealtimeWorkspaceCursor {
  readonly conversationId: string;
  readonly callId: string;
}
export interface AuthorizedRealtimeConversation {
  readonly conversationId: string;
  /** The host must authorize this exact tenant/owner/conversation scope first. */
  readonly calls: PostgresRealtimeCallStore;
}

/** A separate voice feed: it never writes text activity or acknowledges results.
 * Each request is limited to 100 explicitly authorized conversations and 50 calls.
 * Call evidence reads use at most four concurrent operations, independent of how
 * many threads the owner has opened. Hosts retain domain ownership checks.
 */
export class PostgresRealtimeWorkspaceActivityStore {
  readonly #scopes: readonly AuthorizedRealtimeConversation[];
  constructor(scopes: readonly AuthorizedRealtimeConversation[]) {
    if (scopes.length > 100) throw new TypeError("Too many realtime workspace conversations.");
    const conversations = new Set<string>(), scopeIds = new Set<string>();
    const first = scopes[0]?.calls;
    for (const scope of scopes) {
      if (typeof scope.conversationId !== "string" || !scope.conversationId || scope.conversationId.length > 512 ||
          conversations.has(scope.conversationId) || scopeIds.has(scope.calls.scopeId) ||
          scope.calls.persistence !== first?.persistence || scope.calls.tenantId !== first?.tenantId) {
        throw new TypeError("Realtime workspace conversation scopes are invalid.");
      }
      conversations.add(scope.conversationId); scopeIds.add(scope.calls.scopeId);
    }
    this.#scopes = Object.freeze(scopes.map((scope) => Object.freeze({ ...scope })));
  }

  async list(input: { readonly after?: RealtimeWorkspaceCursor; readonly limit?: number } = {}) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError("Realtime workspace page size is invalid.");
    const after = input.after;
    if (after && (!this.#scopes.some((scope) => scope.conversationId === after.conversationId) ||
        typeof after.callId !== "string" || !after.callId || after.callId.length > 512)) {
      throw new TypeError("Realtime workspace cursor is invalid.");
    }
    const first = this.#scopes[0]?.calls;
    if (!first) return Object.freeze({ calls: Object.freeze([]), next: null });
    const scopes = new Map(this.#scopes.map((scope) => [scope.conversationId, scope.calls]));
    const result = await first.persistence.client.query<{ conversation_id: string; call_id: string }>(
      `SELECT d.payload->>'conversationId' AS conversation_id, d.record_id AS call_id
       FROM handrail_ai_documents d
       JOIN unnest($2::text[], $3::text[]) AS authorized(scope_id, conversation_id)
         ON d.scope_id=authorized.scope_id AND d.payload->>'conversationId'=authorized.conversation_id
       WHERE d.tenant_id=$1 AND d.kind='realtime_call'
         AND NOT EXISTS (SELECT 1 FROM handrail_ai_documents cleared WHERE cleared.tenant_id=d.tenant_id
           AND cleared.kind='checkpoint' AND cleared.scope_id=d.payload->>'conversationId'
           AND cleared.record_id='cleared-call:' || d.record_id)
         AND ($4::text IS NULL OR (d.payload->>'conversationId',d.record_id)>($4,$5))
       ORDER BY d.payload->>'conversationId',d.record_id LIMIT $6`,
      [first.tenantId, this.#scopes.map((scope) => scope.calls.scopeId), this.#scopes.map((scope) => scope.conversationId),
        after?.conversationId ?? null, after?.callId ?? null, limit + 1]);
    const read = async (row: { conversation_id: string; call_id: string }) => {
      const calls = scopes.get(row.conversation_id);
      if (!calls) throw new TypeError("Realtime workspace returned a foreign conversation.");
      const state = await new PostgresRealtimeToolActivityStore(calls, row.call_id).readState();
      if (state.call.conversationId !== row.conversation_id) throw new TypeError("Realtime workspace call identity changed.");
      // Explicit public projection: no provider reference, worker ID, fingerprint,
      // owner scope, read token, tool arguments or business result leaves the store.
      return Object.freeze({ conversationId: row.conversation_id, callId: row.call_id,
        status: state.call.status, counts: state.counts, unread: state.unread });
    };
    const rows = result.rows.slice(0, limit);
    const calls: Awaited<ReturnType<typeof read>>[] = [];
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = await Promise.allSettled(rows.slice(offset, offset + 4).map(read));
      for (const result of batch) {
        if (result.status === "rejected") throw result.reason;
        calls.push(result.value);
      }
    }
    const last = calls.at(-1);
    return Object.freeze({ calls: Object.freeze(calls), next: result.rows.length > limit && last
      ? Object.freeze({ conversationId: last.conversationId, callId: last.callId }) : null });
  }
}
