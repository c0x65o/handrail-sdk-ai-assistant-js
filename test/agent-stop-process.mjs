// Separate-process recovery proof. Input contains only disposable fixture data.
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers';
import { createHandrailAssistant, openaiResponses } from '@handrail/ai-assistant/server/assistant';
import { postgres } from '@handrail/ai-assistant/persistence/postgres';
import { createAgentConversationTransport, createAgentCheckpointReader, pg } from './fixtures/agent-cancellation/api.mjs';
import { services } from './fixtures/agent-cancellation/host.mjs';
const input = JSON.parse(process.env.HANDRAIL_STOP_FIXTURE);
const pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 4 });
const agent = await services(input.schema, input.key, { identity: input.identity });
let assistant;
try {
  assistant = await createHandrailAssistant({ id: 'agent-stop', authorize: () => input.context,
    persistence: postgres(pool), automaticTitles: false,
    provider: { metadata: openaiResponses({ model: 'fixture', request: () => { throw Error('No model during Stop'); } }).metadata,
      createTransport() {
        return createAgentConversationTransport({ runtime: agent.runtime, pollMs: 5,
          capabilities: { documentInput: { supported: false }, attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
          host: {
            async admit() { throw Error('Stop must never admit a job'); },
            async lookup(value) {
              assert.equal(value.conversationId, input.conversationId); assert.equal(value.turnId, input.turnId);
              const rows = await pool.query(`SELECT * FROM "${input.schema}".bindings WHERE conversation_id=$1 AND turn_id=$2`, [value.conversationId, value.turnId]);
              const row = rows.rows[0]; assert.deepEqual(row.identity, input.identity);
              return { identity: row.identity, turnId: row.turn_id, mutationId: row.mutation_id };
            },
            read: createAgentCheckpointReader({ runtime: agent.runtime, attribution: async () => input.context.attribution,
              pendingToolCallIds: async () => [input.effectRef] }),
            async cancel(binding) {
              const snapshot = (await agent.runtime.inspect(binding.identity)).value.snapshot;
              if (['cancelled', 'succeeded', 'failed'].includes(snapshot.state)) return 'already_terminal';
              const result = await agent.cancel.stop({ command: 'cancel', identity: binding.identity,
                expectedRevision: snapshot.revision, reason: 'explicit_stop' }, 'actor');
              assert.equal(result.ok, true); return 'cancellation_requested';
            },
          } });
      } },
  });
  assert.equal((await assistant.handle(new globalThis.Request('https://fixture.test/turns/cancel', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: input.conversationId,
      turnId: input.turnId, mutationId: 'stop', idempotencyKey: 'stop', reason: 'user' }) }))).status, 200);
  const deadline = Date.now() + 10000;
  while ((await agent.runtime.inspect(input.identity)).value.snapshot.state !== 'cancelled') {
    if (Date.now() > deadline) throw Error('Separate-process Stop did not converge');
    await new Promise(r => setTimeout(r, 25));
  }
  console.log('Fresh Node process: persisted native Stop reached the original PostgreSQL Agent job.');
} finally { await agent.close(); await assistant?.stopBackgroundWorkers(); await pool.end(); }
