import assert from 'node:assert/strict';
import { createHandrailAiClient } from '@handrail/ai-assistant/client';
import { createHandrailAssistant, openaiResponses } from '@handrail/ai-assistant/server/assistant';
import { postgres } from '@handrail/ai-assistant/persistence/postgres';
import { pg } from './fixtures/agent-cancellation/api.mjs';

const [baseUrl, conversationId, turnId, expected] = process.argv.slice(2);
const recovery = process.env.HANDRAIL_PROJECTION_RECOVERY;
let assistant, pool;
if (recovery) {
  assert.equal(process.env.HANDRAIL_TEST_POSTGRES_DISPOSABLE, '1');
  pool = new pg.Pool({ connectionString: process.env.HANDRAIL_TEST_POSTGRES_URL, max: 4 });
  const context = JSON.parse(recovery);
  assistant = await createHandrailAssistant({ id: 'agent-stop', authorize: () => context, persistence: postgres(pool),
    automaticTitles: false, provider: {
      metadata: openaiResponses({ model: 'fixture', request: () => { throw Error('Unexpected model'); } }).metadata,
      createTransport: () => ({
        capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
          attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
        startTurn: () => { throw Error('Read recovery must not start a provider'); },
        resumeTurn: () => { throw Error('Read recovery must not resume a provider'); },
      }),
    } });
}
const client = await createHandrailAiClient({ baseUrl, startActivityPolling: false, restoreActiveTurns: false,
  ...(assistant ? { fetch: (url, init) => assistant.handle(new globalThis.Request(url, init)) } : {}),
  conversations: { mode: 'multiple', clientId: 'fresh-process', authorize: () => 'allow' } });
try {
  const runtime = await client.registry.open({ conversationId, authorizationContext: null });
  await runtime.synchronize();
  const turn = runtime.getSnapshot().turns.find(turn => turn.turn_id === turnId);
  assert.equal(turn.status, expected);
  assert.equal(turn.remote_may_still_be_running, false);
  assert.equal(runtime.getSnapshot().active_turn_id, null);
  console.log(`Fresh JS process: ${expected}, remoteMayBeRunning=false`);
} finally { await client.dispose(); await assistant?.stopBackgroundWorkers(); await pool?.end(); }
