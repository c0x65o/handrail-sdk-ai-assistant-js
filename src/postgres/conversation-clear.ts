import { randomUUID } from "node:crypto";
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient } from "./index.js";
import { assertPostgresConversationIdle, assertPostgresConversationWritable } from "./conversation-deletion.js";
import { parseConversationEvent, type ConversationId } from "../conversation/events.js";

/** Called inside an authorized catalog-clear transaction. A monotonic reset
 * event clears projected context across clients without deleting audit history,
 * resetting revisions, releasing old execution receipts or sealing the ID. */
export async function clearPostgresConversation(input: {
  readonly client: PostgresSqlClient;
  readonly tenantId: string;
  readonly conversationId: ConversationId;
  readonly relatedTenantIds?: readonly string[];
}) {
  for (const tenant of [...new Set([input.tenantId, ...(input.relatedTenantIds ?? [])])].sort()) {
    await assertPostgresConversationWritable(input.client, tenant, input.conversationId);
    await assertPostgresConversationIdle(input.client, tenant, input.conversationId);
  }
  // Hide only calls admitted before this reset. Keep their authority, effects
  // and receipts intact, including for direct authorized audit reads.
  for (const tenant of new Set([input.tenantId, ...(input.relatedTenantIds ?? [])])) {
    await input.client.query(`INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload)
      SELECT tenant_id,'checkpoint',$2,'cleared-call:' || record_id,1,'{}'::jsonb
      FROM handrail_ai_documents WHERE tenant_id=$1 AND kind='realtime_call' AND payload->>'conversationId'=$2
      ON CONFLICT (tenant_id,kind,scope_id,record_id) DO NOTHING`, [tenant, input.conversationId]);
  }
  // Reuse the enclosing transaction; never commit the event separately from
  // the catalog version/audit/idempotency receipt.
  const client: PostgresSqlClient = { query: input.client.query.bind(input.client),
    transaction: async operation => operation(client) };
  const events = new PostgresConversationEventStore(new PostgresAiPersistence(client), input.tenantId);
  const revision = await events.getLatestRevision(input.conversationId);
  await events.append({ conversationId: input.conversationId, expectedRevision: revision,
    events: [parseConversationEvent({ version: 1, event_id: `clear-${randomUUID()}`,
      conversation_id: input.conversationId, revision: (revision ?? 0) + 1,
      occurred_at: new Date().toISOString(), actor: { type: "system" }, source: { type: "runtime" },
      payload: { type: "conversation.cleared" } })] });
}
