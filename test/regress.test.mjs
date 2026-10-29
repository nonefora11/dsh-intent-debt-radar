/**
 * Regressions for the audit findings of 0.2.1.
 *
 * Each test here fails on the shipped 0.2.1 build and pins one of the four
 * holes that were reproduced against it: a wiped ledger at boot, a session cap
 * that counted settled cards, a false "you never answered me" card, and a
 * session that never left memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Ledger } from '../lib/store.js';
import { Radar } from '../lib/extract.js';

const NOW = 1_790_000_000_000;
const SESSION = { id: 's1', header: { cwd: 'C:/work' } };

async function radarWithLedger(settings = {}, session = SESSION) {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-regress-'));
  const ledger = new Ledger({ directory });
  await ledger.open();
  const radar = new Radar({ ledger, now: () => NOW, settings });
  return { directory, ledger, radar, session };
}

const userSaid = (text, seq = 1, turn = 1) => ({ type: 'user/message', seq, time: NOW, data: { content: [{ type: 'text', text }], turn } });
const assistantSaid = (text, seq = 2, turn = 1) => ({ type: 'assistant/message', seq, time: NOW, data: { message: { content: [{ type: 'text', text }] }, turn, step: 1 } });
const turnEnd = (turn = 1) => ({ type: 'turn/end', seq: 9, time: NOW, data: { turn, reason: { kind: 'stop' } } });

function card(overrides = {}) {
  return {
    id: 'x1',
    kind: 'defer',
    quote: '这个先放着，回头再说',
    impliedPromise: '回头再说',
    status: 'open',
    anchorTime: NOW,
    lastSeenAt: NOW,
    hits: 1,
    sessionId: 's1',
    scorerVersion: 1,
    ...overrides,
  };
}

test('a card written before open() resolves is not wiped by the load', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-race-'));

  // A first run leaves a ledger on disk.
  const first = new Ledger({ directory });
  await first.open();
  first.put(card({ id: 'old' }));
  await first.flush();
  await first.close();

  // The second instance is written to before its own load finishes — exactly
  // what happens when a turn is already in flight at boot.
  const second = new Ledger({ directory });
  const opening = second.open();
  second.put(card({ id: 'fresh' }));
  await opening;

  const ids = second.all().map((entry) => entry.id).sort();
  assert.deepEqual(ids, ['fresh', 'old'], 'the card created during boot must survive the load');
});

test('the per-session cap counts live debt, not everything ever seen', async () => {
  const { ledger, radar } = await radarWithLedger({ maxCardsPerSession: 2 });

  radar.observe(SESSION, userSaid('这个先放着，回头再说'));
  radar.observe(SESSION, userSaid('那个下周再弄，先这样'));
  assert.equal(ledger.all().length, 2);

  // Settle both, then a third deferral must still be recorded.
  for (const entry of ledger.all()) ledger.patch(entry.id, { status: 'closed' });
  radar.observe(SESSION, userSaid('文档回头补一下'));
  assert.equal(ledger.all().length, 3, 'settled cards must not occupy the cap');
});

test('an answered multi-clause question is not recorded as debt', async () => {
  const { ledger, radar } = await radarWithLedger();

  radar.observe(
    SESSION,
    assistantSaid(
      '我建议按小时切分日志，顺便说下背景：现在的文件已经很大了，读取会变慢，磁盘也快满了，所以这一步要先做。你看是按天切还是按小时切？保留多少天？归档要不要压缩？',
      1,
      1,
    ),
  );
  radar.observe(SESSION, turnEnd(1));

  radar.observe(SESSION, userSaid('按天切吧，保留 90 天，归档要压缩', 2, 2));

  const loops = ledger.all().filter((entry) => entry.kind === 'loop');
  assert.equal(loops.length, 0, 'the reply answered the question');
});

test('a truly unanswered question is still recorded', async () => {
  const { ledger, radar } = await radarWithLedger();

  radar.observe(SESSION, assistantSaid('日志要按天还是按小时切？保留多少天？', 1, 1));
  radar.observe(SESSION, turnEnd(1));
  radar.observe(SESSION, userSaid('那我们先看看别的吧，颜色我想改成深色', 2, 2));

  const loops = ledger.all().filter((entry) => entry.kind === 'loop');
  assert.equal(loops.length, 1);
});

test('forget() releases a session', async () => {
  const { radar } = await radarWithLedger();
  radar.observe(SESSION, userSaid('这个先放着，回头再说'));
  assert.equal(radar.sessions.size, 1);
  radar.forget(SESSION.id);
  assert.equal(radar.sessions.size, 0);
});

test('a card with an unknown status is refused on load instead of living forever', async () => {
  const { isCardShape } = await import('../lib/store.js');
  assert.equal(isCardShape(card({ status: 'open' })), true);
  assert.equal(isCardShape(card({ status: 'zombie' })), false);
  assert.equal(isCardShape(card({ status: undefined })), false);
});
