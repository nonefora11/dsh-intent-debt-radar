/**
 * The model layer's contract, tested without a provider.
 *
 * Every assertion here is about money or trust: how many clauses a turn is
 * allowed to spend a request on, whether a cache hit really skips the call,
 * whether a budget refusal degrades to rules instead of raising, and whether a
 * card can always be traced back to a clause the user actually typed.
 */

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ApiExtractor,
  Budget,
  EXTRACT_POLICY,
  ExtractionCache,
  GATES,
  MODES,
  PROMPT_VERSION,
  cacheKeyOf,
  collectSuspects,
  estimateTokens,
  isSuspect,
  parseExtraction,
  promptBody,
  routeOf,
  suspectClauses,
} from '../lib/llm.js';
import { Radar } from '../lib/extract.js';
import { Ledger } from '../lib/store.js';

/** A real ledger in a throwaway directory, so no test can touch `~/.dsh`. */
async function memoryLedger() {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-test-'));
  const ledger = new Ledger({ directory });
  await ledger.open();
  return ledger;
}

/** Collect the text of a chunk stream into the reply the extractor parses. */
function streamOf(text, { reason = 'stop' } = {}) {
  return (async function* generate() {
    // Real chunk shapes: reasoning first, then the answer. The collector must
    // keep only the `text-delta` run, or reasoning would corrupt the JSON.
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'the user is deferring ' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'the user is deferring ' } };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    yield { type: 'text-delta', index: 1, text };
    yield { type: 'block-end', index: 1, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: reason } };
  })();
}

/** An `llm` service that answers with a fixed body and counts calls. */
function fakeLlm(body, { reason = 'stop' } = {}) {
  const llm = {
    calls: 0,
    requests: [],
    stream(request) {
      llm.calls += 1;
      llm.requests.push(request);
      return streamOf(typeof body === 'function' ? body(request) : body, { reason });
    },
  };
  return llm;
}

/** Settings with the model layer on and generous ceilings unless overridden. */
function settingsOf(overrides = {}) {
  return {
    mode: 'api',
    minConfidence: 0.5,
    maxCardsPerSession: 80,
    maxClausesPerCall: 6,
    llmProvider: '',
    llmModel: '',
    ...overrides,
  };
}

/** A session whose own route is a deepseek model. */
const session = {
  id: 's1',
  header: { cwd: '/w' },
  requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
};

/** Card context as the host builds it. */
const context = { sessionId: 's1', workspace: '/w', workspaceId: 'w', seq: 3, time: 1_700_000_000_000, turn: 2 };

test('mode names are the two the panel offers', () => {
  assert.deepEqual(MODES, ['rules', 'api']);
  assert.deepEqual(GATES, ['suspect', 'always']);
  assert.equal(PROMPT_VERSION, 1);
});

test('token estimate rounds up and never returns NaN', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens('abc'), 3);
  assert.ok(estimateTokens('十'.repeat(100)) >= 70);
  assert.ok(estimateTokens(EXTRACT_POLICY) < 400, 'the policy must stay small; it is paid on every call');
});

test('weak cues are broader than the rule set but still discriminating', () => {
  assert.equal(isSuspect('这个先放着，回头再说'), true);
  assert.equal(isSuspect('记一下，周末再处理'), true);
  assert.equal(isSuspect("let's revisit this next time"), true);
  assert.equal(isSuspect('今天天气不错'), false);
  assert.equal(isSuspect('已经修好了'), false);
});

test('suspect clauses are clipped, deduped, and carry a neighbour as context', () => {
  const picks = suspectClauses('日志分割这部分，先放着吧，我现在有事要出门。');
  assert.equal(picks.length, 1);
  assert.ok(picks[0].text.includes('先放着'));
  assert.ok(picks[0].context.includes('⟪此处⟫'));
  assert.ok(picks[0].context.includes('日志分割'), 'the subject one clause back must ride along');
});

test('a message with no cue costs nothing', () => {
  assert.deepEqual(suspectClauses('构建通过了，测试也绿了。'), []);
  assert.deepEqual(suspectClauses(''), []);
});

test('one turn is capped, user first, no duplicates across speakers', () => {
  const batch = [
    { text: '这个改天再说，先放着。', speaker: 'assistant' },
    { text: '这个改天再说，先放着。', speaker: 'user' },
    { text: '另一个也回头再弄。', speaker: 'user' },
  ];
  const picks = collectSuspects(batch, { maxClauses: 2 });
  assert.equal(picks.length, 2, 'the cap is the main cost control and must hold');
  assert.equal(picks[0].speaker, 'user', 'user debt is the kind worth spending a request on');
  const capped = collectSuspects(batch, { maxClauses: 1 });
  assert.equal(capped.length, 1);
});

test('the prompt body numbers clauses and keeps context parenthetical', () => {
  const body = promptBody([
    { text: '先放着吧', context: '日志分割 ⟪此处⟫' },
    { text: '回头再说', context: '' },
  ]);
  assert.equal(body, '1. 先放着吧（上下文：日志分割 ⟪此处⟫）\n2. 回头再说');
});

test('cache keys are stable and route-specific', () => {
  const picks = [{ text: '先放着吧' }];
  const a = cacheKeyOf(picks, { provider: 'deepseek', model: 'x' });
  const b = cacheKeyOf([{ text: '先放着吧' }], { provider: 'deepseek', model: 'x' });
  const c = cacheKeyOf(picks, { provider: 'deepseek', model: 'y' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('parsing keeps only traceable candidates', () => {
  const picks = [{ text: '这个先放着吧' }, { text: '回头再说日志' }];
  const raw = JSON.stringify([
    { i: 1, k: 'd', q: '这个先放着吧', p: '做日志分割', c: 0.8 },
    { i: 9, k: 'd', q: '不存在', p: 'x', c: 0.9 },
    { i: 2, k: 'z', q: '未知类型' },
    { i: 2, k: 'l', q: '', p: '回答这个问题', c: 0.4 },
  ]);
  const out = parseExtraction(raw, picks);
  assert.equal(out.length, 2, 'out-of-range index and unknown kind are dropped');
  assert.equal(out[0].kind, 'defer');
  assert.equal(out[0].impliedPromise, '做日志分割');
  assert.equal(out[1].kind, 'loop');
  assert.equal(out[1].quote, '回头再说日志', 'an empty quote falls back to the clause that was sent');
});

test('parsing tolerates fences, prose and full-width quotes', () => {
  const picks = [{ text: '先放着吧' }];
  const raw = '好的，结果如下：\n```json\n[{"i":1,"k":"d","q":"「先放着吧」","p":"处理日志","c":0.7}]\n```';
  const out = parseExtraction(raw, picks);
  assert.equal(out.length, 1);
  assert.equal(out[0].quote, '先放着吧');
});

test('parsing clamps confidence and dedupes the same debt', () => {
  const picks = [{ text: '先放着吧' }];
  const raw = JSON.stringify([
    { i: 1, k: 'd', q: '先放着吧', p: 'a', c: 4 },
    { i: 1, k: 'd', q: '先放着吧', p: 'b', c: 0 },
  ]);
  const out = parseExtraction(raw, picks);
  assert.equal(out.length, 1);
  assert.ok(out[0].confidence >= 0.4 && out[0].confidence <= 0.95);
});

test('a reply that is not JSON yields nothing instead of throwing', () => {
  const picks = [{ text: '先放着吧' }];
  assert.deepEqual(parseExtraction('我不确定。', picks), []);
  assert.deepEqual(parseExtraction('[not json', picks), []);
  assert.deepEqual(parseExtraction('{"i":1}', picks), []);
});

test('budget refuses by hour, day and tokens, each with a reason', () => {
  const hour = new Budget({ perHour: 1, perDay: 10, tokensPerDay: 10_000, now: () => 1_000 });
  assert.equal(hour.can(100).ok, true);
  hour.spend(100);
  assert.deepEqual(hour.can(100), { ok: false, reason: 'hour' });

  let clock = 1_000;
  const day = new Budget({ perHour: 100, perDay: 2, tokensPerDay: 10_000, now: () => clock });
  day.spend(10);
  clock += 2_000;
  day.spend(10);
  clock += 2_000;
  assert.deepEqual(day.can(10), { ok: false, reason: 'day' });

  const tokens = new Budget({ perHour: 100, perDay: 100, tokensPerDay: 500, now: () => clock });
  assert.equal(tokens.can(400).ok, true);
  assert.deepEqual(tokens.can(600), { ok: false, reason: 'tokens' });
});

test('budget rolls over at midnight and keeps an hour-long window', () => {
  let clock = Date.parse('2026-01-01T23:30:00Z');
  const budget = new Budget({ perHour: 5, perDay: 5, tokensPerDay: 1000, now: () => clock });
  budget.spend(10);
  clock = Date.parse('2026-01-02T00:10:00Z');
  assert.equal(budget.can(10).ok, true, 'a new day resets the daily counters');
  assert.equal(budget.snapshot().callsToday, 0);
  // The rolling hour still remembers the pre-midnight call: 40 minutes is inside it.
  assert.equal(budget.snapshot().callsLastHour, 1);
  clock = Date.parse('2026-01-02T01:40:00Z');
  assert.equal(budget.snapshot().callsLastHour, 0, 'and forgets it once the hour has passed');
});

test('zero limits mean unlimited, not zero', () => {
  const budget = new Budget({ perHour: 0, perDay: 0, tokensPerDay: 0, now: () => 1_000 });
  for (let index = 0; index < 50; index += 1) budget.spend(1_000);
  assert.equal(budget.can(10_000).ok, true);
});

test('cache is least-recently-used and counts its own hits', () => {
  const cache = new ExtractionCache(2);
  cache.set('a', [1]);
  cache.set('b', [2]);
  assert.deepEqual(cache.get('a'), [1]);
  cache.set('c', [3]);
  assert.equal(cache.get('b'), undefined, 'the entry least recently used is the one evicted');
  assert.equal(cache.hits, 1);
  assert.ok(cache.misses >= 1);
  assert.equal(cache.size, 2);
});

test('route prefers explicit config, then the session header', () => {
  assert.deepEqual(routeOf(session, { llmProvider: 'p', llmModel: 'm' }), { provider: 'p', model: 'm' });
  assert.deepEqual(routeOf(session, {}), { provider: 'deepseek', model: 'deepseek-chat' });
  assert.deepEqual(routeOf({}, {}), { provider: '', model: '' });
  const broken = {
    requestHeader() {
      throw new Error('no header');
    },
  };
  assert.deepEqual(routeOf(broken, {}), { provider: '', model: '' }, 'a broken header is a skip, not a crash');
});

test('one turn costs one request and produces cards', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm(JSON.stringify([{ i: 1, k: 'd', q: '这个先放着吧', p: '做日志分割', c: 0.8 }]));
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  const created = await extractor.run({
    session,
    batch: [{ text: '这个日志分割先放着吧，我现在有事。', speaker: 'user' }],
    context,
  });
  assert.equal(created, 1);
  assert.equal(llm.calls, 1, 'one turn must never mean more than one request');
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0].quote, '这个先放着吧');
  assert.equal(extractor.stats.calls, 1);
  assert.ok(extractor.stats.promptTokens > 0);
});

test('a repeated clause set is answered from cache', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm(JSON.stringify([{ i: 1, k: 'd', q: '先放着吧', p: '做事', c: 0.7 }]));
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  const batch = [{ text: '这个先放着吧。', speaker: 'user' }];
  await extractor.run({ session, batch, context });
  await extractor.run({ session, batch, context });
  assert.equal(llm.calls, 1, 'the second identical turn must not pay again');
  assert.equal(extractor.stats.cacheHits, 1);
});

test('a turn with nothing suspicious never calls the model', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm('[]');
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  await extractor.run({ session, batch: [{ text: '构建通过了。', speaker: 'user' }], context });
  assert.equal(llm.calls, 0);
  assert.equal(extractor.stats.lastSkip, 'no-suspect');
});

test('an exhausted budget degrades to rules instead of calling', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm('[]');
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ perHour: 0, perDay: 0, tokensPerDay: 1, now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  await extractor.run({ session, batch: [{ text: '这个先放着吧。', speaker: 'user' }], context });
  assert.equal(llm.calls, 0);
  assert.equal(extractor.stats.lastSkip, 'budget-tokens');
});

test('rules mode is inert even with a live model service', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf({ mode: 'rules' });
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm('[]');
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  await extractor.run({ session, batch: [{ text: '这个先放着吧。', speaker: 'user' }], context });
  assert.equal(llm.calls, 0);
  assert.equal(extractor.enabled, false);
});

test('a provider failure is recorded, not thrown, and never creates a card', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm('{"i":1}', { reason: 'error' });
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  const created = await extractor.run({ session, batch: [{ text: '这个先放着吧。', speaker: 'user' }], context });
  assert.equal(created, 0);
  assert.equal(extractor.stats.failures, 1);
  assert.match(extractor.stats.lastError, /error/);
});

test('a missing route or missing service is a skip with a reason', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const extractor = new ApiExtractor({
    llm: fakeLlm('[]'),
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  await extractor.run({ session: {}, batch: [{ text: '这个先放着吧。', speaker: 'user' }], context });
  assert.equal(extractor.stats.lastSkip, 'no-route');

  const orphan = new ApiExtractor({
    llm: null,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  await orphan.run({ session, batch: [{ text: '这个先放着吧。', speaker: 'user' }], context });
  assert.equal(orphan.stats.lastSkip, 'no-llm-service');
});

test('the request itself stays small — this is the whole point', async () => {
  const ledger = await memoryLedger();
  const settings = settingsOf();
  const radar = new Radar({ ledger, settings });
  const llm = fakeLlm('[]');
  const extractor = new ApiExtractor({
    llm,
    radar,
    settings,
    budget: new Budget({ now: () => 1_000 }),
    cache: new ExtractionCache(8),
    now: () => 1_000,
  });
  const long = `${'背景材料。'.repeat(400)}这个日志分割先放着吧，我现在有事。${'更多上下文。'.repeat(400)}`;
  await extractor.run({ session, batch: [{ text: long, speaker: 'user' }], context });
  const request = llm.requests[0];
  assert.equal(request.provider, 'deepseek');
  assert.equal(request.temperature, 0);
  assert.equal(request.maxTokens, 320);
  const body = request.messages[0].content[0].text;
  assert.ok(body.length < 600, `a 2400-character message must not become a 2400-character request, got ${body.length}`);
  assert.ok(!body.includes('背景材料。背景材料。背景材料。背景材料。'), 'the bulk of the message is not sent');
});
