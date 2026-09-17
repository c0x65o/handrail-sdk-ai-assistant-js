/** Local canonical-checkpoint/preparation benchmark, not a database, browser or
 * provider-network benchmark. Build first, then node --expose-gc this file.
 * The historical preparer is read from a real local Git commit; dependencies
 * use the same current build to isolate changes to preparation itself. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent,
  CONVERSATION_CHECKPOINT_SCHEMA_VERSION } from '../dist/index.js';
import { createSavedConversationRequestPreparer } from '../dist/server/saved-conversation-request.js';

if (!globalThis.gc) throw new Error('Run with --expose-gc');
const root = fileURLToPath(new URL('..', import.meta.url));
const baselineRevision = process.env.HANDRAIL_PREPARATION_BASELINE_REVISION ?? '81564f969be0ccc2c3a38c3362388476918a4521';
assert.match(baselineRevision, /^[a-f0-9]{40}$/u);
const measurementCase = process.env.HANDRAIL_PREPARATION_CASE;
if (!measurementCase) {
  const run = name => JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HANDRAIL_PREPARATION_CASE: name,
      HANDRAIL_PREPARATION_REPORT: '' }, maxBuffer: 1024 * 1024 }).trim());
  const rows = [];
  for (const events of [20_000, 100_000]) {
    const before = run(`before:${events}`), after = run(`after:${events}`);
    assert.equal(before.providerOutputSha256, after.providerOutputSha256);
    rows.push(before, after);
  }
  const concurrent = run('concurrent');
  const report = { source: 'Local synthetic complete canonical checkpoints, one fresh process per measurement case; no database/network/provider/browser timings.',
    baselineRevision, baselineDependencies: 'Same current compiled replay/protocol dependencies isolate preparer changes.',
    node: process.version, rows, concurrent,
    budgets: { providerBodyBytes: 32_768, retainedDuringContextBytes: 2 * 1024 * 1024,
      concurrentRetainedBytes: 12 * 1024 * 1024, unchangedCheckpointReads: 1, unchangedTailReads: 1 },
    limitations: ['Cold canonical checkpoint loading and prior-file catalogs still scale with retained canonical state.',
      'This is server model preparation, independent of bounded display pagination. Timing includes local JSON checkpoint decoding.',
      'Collected heap deltas include V8 warmup/collection noise; they are not total process memory or exact content size.',
      'Current provider text policy is 20 historical messages / 24000 characters plus admitted current input; no canonical truncation.'] };
  if (process.env.HANDRAIL_PREPARATION_REPORT) await writeFile(process.env.HANDRAIL_PREPARATION_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
const temporary = await mkdtemp(join(tmpdir(), 'handrail-preparation-'));
const source = execFileSync('git', ['show', `${baselineRevision}:src/server/saved-conversation-request.ts`], { cwd: root, encoding: 'utf8' });
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022 } }).outputText.replace(/from "(\.\.?\/[^"\n]+)"/gu,
  (_, path) => `from ${JSON.stringify(new URL(path, new URL('../dist/server/saved-conversation-request.js', import.meta.url)).href)}`);
const baselinePath = join(temporary, 'baseline.mjs');
await writeFile(baselinePath, javascript);
const baseline = (await import(pathToFileURL(baselinePath).href)).createSavedConversationRequestPreparer;
const round = value => Math.round(value * 1000) / 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));
const collect = async () => { await tick(); globalThis.gc(); await tick(); globalThis.gc(); };
const request = { protocol_version: 'handrail.ai-runtime.v1', continuation_of: null,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'untrusted history' }] }],
  tools: [], tool_results: [], generation: { max_output_tokens: 100, temperature: 0 }, correlation_hints: {} };

function fixture(events, owner) {
  const conversationId = 'same-conversation-id', turnId = 'active-turn';
  const event = (revision, payload) => parseConversationEvent({ version: 1, conversation_id: conversationId,
    event_id: `e${revision}`, revision, occurred_at: '2026-09-17T00:00:00Z',
    actor: { type: 'user' }, source: { type: 'runtime' }, payload });
  let state = reduceConversationEvent(createInitialConversationState(conversationId), event(1, {
    type: 'message.created', message_id: 'current', role: 'user', content: [{ type: 'text', text: `${owner}:current` }] }));
  state = reduceConversationEvent(state, event(2, { type: 'turn.started', turn_id: turnId, input_message_ids: ['current'] }));
  const messageCount = events / 100;
  const messages = Array.from({ length: messageCount }, (_, index) => ({ ...state.messages[0],
    message_id: `m${index}`, content: [{ type: 'text', text: `${owner}:${index}:` + 'x'.repeat(8000) }] }));
  const encoded = JSON.stringify({ schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION, conversationId,
    revision: events, state: { ...state, revision: events, last_event_id: `e${events}`,
      processed_event_ids: Array.from({ length: events }, (_, index) => `e${index + 1}`), messages: [...messages, ...state.messages] } });
  const reads = { checkpoint: 0, page: 0, head: 0, checkpointBytes: 0 };
  const eventStore = {
    checkpoints: { read: async () => { reads.checkpoint++; reads.checkpointBytes += Buffer.byteLength(encoded); return JSON.parse(encoded); },
      write: async () => { throw new Error('Preparation must not write checkpoints'); } },
    read: async input => { assert.equal(input.conversationId, conversationId); reads.page++;
      return { entries: [], nextCursor: null, latestRevision: events, hasMore: false }; },
    getLatestRevision: async id => { assert.equal(id, conversationId); reads.head++; return events; },
    append: async () => { throw new Error('Preparation must not alter canonical history'); },
  };
  return { events, messageCount, checkpointBytes: Buffer.byteLength(encoded), reads,
    prepare: (factory, context = async () => null) => factory({ eventStore, authorize: async () => {},
      resolveAttachment: async () => { throw new Error('Unexpected file'); }, applicationContext: context })({
      request, conversationId, turnId, mutationId: 'admitted', signal: new globalThis.AbortController().signal }),
    reset: () => { for (const key of Object.keys(reads)) reads[key] = 0; } };
}

try {
  const rows = [];
  for (const events of [20_000, 100_000].filter(count => measurementCase.endsWith(`:${count}`))) {
    const f = fixture(events, 'account');
    let expected;
    for (const [name, factory] of [['before', baseline], ['after', createSavedConversationRequestPreparer]]
      .filter(([name]) => measurementCase.startsWith(`${name}:`))) {
      await f.prepare(factory); f.reset();
      const durations = [];
      let output;
      for (let iteration = 0; iteration < 5; iteration++) {
        await collect(); const start = performance.now();
        output = await f.prepare(factory); durations.push(performance.now() - start);
      }
      if (expected) assert.deepEqual(output, expected); else expected = output;
      const reads = { ...f.reads }; f.reset();
      await collect(); const heapBefore = process.memoryUsage().heapUsed;
      let pausedHeap;
      await f.prepare(factory, async () => { await collect(); pausedHeap = process.memoryUsage().heapUsed; return null; });
      await collect();
      const row = { name, events, canonicalMessages: f.messageCount + 1, checkpointBytes: f.checkpointBytes,
        samples: durations.length, preparationP95Milliseconds: round([...durations].sort((a,b) => a-b).at(-1)),
        averageReads: Object.fromEntries(Object.entries(reads).map(([key, value]) => [key, value / durations.length])),
        providerMessages: output.request.messages.length, providerBodyBytes: Buffer.byteLength(JSON.stringify(output.request)),
        providerOutputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
        collectedHeapDuringContextDeltaBytes: pausedHeap - heapBefore,
        collectedHeapAfterDeltaBytes: process.memoryUsage().heapUsed - heapBefore };
      rows.push(row); console.log(JSON.stringify(row));
      assert.ok(row.providerBodyBytes < 32_768);
      if (name === 'after') {
        assert.equal(row.averageReads.checkpoint, 1); assert.equal(row.averageReads.page, 1);
        assert.ok(row.collectedHeapDuringContextDeltaBytes < 2 * 1024 * 1024, 'Preparation retained old canonical text across context callback');
      }
    }
  }
  if (measurementCase === 'concurrent') {
  const scopes = Array.from({ length: 30 }, (_, index) => fixture(20_000, `owner-${index}`));
  await collect(); const heapBefore = process.memoryUsage().heapUsed;
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered = 0, allEntered; const ready = new Promise(resolve => { allEntered = resolve; });
  const start = performance.now();
  const pending = scopes.map((f, index) => f.prepare(createSavedConversationRequestPreparer, async ({ request: prepared }) => {
    assert.equal(prepared.messages.at(-1).content[0].text, `owner-${index}:current`);
    if (++entered === scopes.length) allEntered(); await gate; return null;
  }));
  await ready; const admissionMilliseconds = performance.now() - start;
  await collect(); const pausedDelta = process.memoryUsage().heapUsed - heapBefore;
  release(); await Promise.all(pending);
  assert.ok(pausedDelta < 12 * 1024 * 1024, 'Concurrent preparations retained full transcripts');
  const concurrent = { scopes: 30, representedEventsPerScope: 20_000,
      sameConversationIds: true, ownerIsolation: true, admissionMilliseconds: round(admissionMilliseconds),
      collectedHeapDuringContextsDeltaBytes: pausedDelta };
  console.log(JSON.stringify(concurrent));
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
