import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Ledger } from '../lib/store.js';
import { Radar, hasToolCallBlock, identityOf, textOf } from '../lib/extract.js';

const NOW = 1_790_000_000_000;
const SESSION = { id: 's1', header: { cwd: 'C:/work' } };

async function radarWithLedger(settings = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-extract-'));
  const ledger = new Ledger({ directory });
  await ledger.open();
  const radar = new Radar({ ledger, now: () => NOW, settings });
  return { directory, ledger, radar };
}

/** A user message event. */
function userSaid(text, seq = 1, turn = 1) {
  return { type: 'user/message', seq, time: NOW, data: { content: [{ type: 'text', text }], turn } };
}

/** An assistant message event. */
function assistantSaid(text, seq = 2, turn = 1, extraBlocks = []) {
  return {
    type: 'assistant/message',
    seq,
    time: NOW,
    data: { message: { content: [{ type: 'text', text }, ...extraBlocks] }, turn, step: 1 },
  };
}

const turnEnd = (turn = 1) => ({ type: 'turn/end', seq: 9, time: NOW, data: { turn, reason: { kind: 'stop' } } });

test('textOf joins text blocks and ignores everything else', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call', name: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(textOf({}), '');
  assert.equal(textOf(null), '');
});

test('hasToolCallBlock spots a promise that arrived with action', () => {
  assert.equal(hasToolCallBlock({ content: [{ type: 'tool-call', name: 'bash' }] }), true);
  assert.equal(hasToolCallBlock({ content: [{ type: 'text', text: 'hi' }] }), false);
});

test('a deferral in a user message becomes a card', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, userSaid('这个先放着，回头再说'));
  assert.equal(ledger.all().length, 1);
  const [card] = ledger.all();
  assert.equal(card.kind, 'defer');
  assert.equal(card.sessionId, 's1');
  assert.equal(card.workspace, 'C:/work');
  assert.equal(card.status, 'open');
  assert.equal(card.anchorSeq, 1);
  assert.equal(card.hits, 1);
  await ledger.close();
});

test('the same sentence twice increments hits instead of duplicating', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, userSaid('这个先放着，回头再说', 1));
  radar.observe(SESSION, userSaid('这个先放着，回头再说', 7, 3));
  assert.equal(ledger.all().length, 1);
  assert.equal(ledger.all()[0].hits, 2);
  await ledger.close();
});

test('a low-confidence kind is filtered by settings', async () => {
  const { ledger, radar } = await radarWithLedger({ minConfidence: 0.7 });
  radar.observe(SESSION, userSaid('用 SQLite 还是 Postgres？你决定吧'));
  assert.equal(ledger.all().length, 0);
  await ledger.close();
});

test('an assistant promise with no tool call that turn becomes debt', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } });
  radar.observe(SESSION, assistantSaid('下一步我来把测试补上。'));
  radar.observe(SESSION, turnEnd(1));
  assert.equal(ledger.all().length, 0, 'held back until the turn is committed');

  const written = radar.commitPending('s1', { sessionId: 's1', workspace: 'C:/work', workspaceId: 'w', seq: 2, time: NOW, turn: 1 });
  assert.equal(written, 1);
  assert.equal(ledger.all()[0].kind, 'agent-promise');
  assert.equal(ledger.all()[0].speaker, 'assistant');
  await ledger.close();
});

test('an assistant promise followed by real work is not debt', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } });
  radar.observe(SESSION, assistantSaid('稍后我帮你改一下', 2, 1, [{ type: 'tool-call', name: 'bash' }]));
  radar.observe(SESSION, { type: 'tool/call', seq: 3, time: NOW, data: { name: 'bash' } });
  radar.observe(SESSION, turnEnd(1));
  assert.equal(radar.commitPending('s1', { sessionId: 's1', workspace: 'C:/work', workspaceId: 'w', seq: 3, time: NOW, turn: 1 }), 0);
  assert.equal(ledger.all().length, 0);
  await ledger.close();
});

test('an unanswered question turns into a loop card once the subject changes', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } });
  radar.observe(SESSION, assistantSaid('要不要我把数据库迁移脚本也一起写？'));
  radar.observe(SESSION, turnEnd(1));
  radar.observe(SESSION, userSaid('今天先聊聊前端配色吧', 5, 2));

  const loop = ledger.all().find((card) => card.kind === 'loop');
  assert.ok(loop !== undefined, 'expected a loop card');
  assert.equal(loop.status, 'open');
  assert.ok(loop.quote.includes('迁移脚本'));
  await ledger.close();
});

test('a question the user answers does not create a loop card', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, { type: 'turn/start', seq: 1, time: NOW, data: { turn: 1 } });
  radar.observe(SESSION, assistantSaid('要不要我把数据库迁移脚本也一起写？'));
  radar.observe(SESSION, turnEnd(1));
  radar.observe(SESSION, userSaid('要，数据库迁移脚本一起写', 5, 2));
  assert.equal(ledger.all().filter((card) => card.kind === 'loop').length, 0);
  await ledger.close();
});

test('a todo write converts the matching card', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, userSaid('日志分割这块先放着，回头再说', 1));
  assert.equal(ledger.all()[0].status, 'open');
  radar.observe(SESSION, { type: 'todo/write', seq: 4, time: NOW, data: { todos: [{ content: '日志分割' }] } });
  assert.equal(ledger.all()[0].status, 'converted');
  await ledger.close();
});

test('a closure phrase settles the card instead of creating one', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(SESSION, userSaid('日志分割这块先放着，回头再说', 1));
  radar.observe(SESSION, userSaid('日志分割搞定了', 5, 2));
  assert.equal(ledger.all()[0].status, 'closed');
  await ledger.close();
});

test('a malformed event never throws into the conversation', async () => {
  const { ledger, radar } = await radarWithLedger();
  radar.observe(null, null);
  radar.observe(SESSION, { type: 'user/message' });
  radar.observe(SESSION, { type: 'turn/end', data: {} });
  radar.observe({}, { type: 'user/message', data: null });
  assert.equal(ledger.all().length, 0);
  await ledger.close();
});

test('the per-session ceiling holds', async () => {
  const { ledger, radar } = await radarWithLedger({ maxCardsPerSession: 2 });
  radar.observe(SESSION, userSaid('先放着，回头再说', 1));
  radar.observe(SESSION, userSaid('这个先这样吧', 2));
  radar.observe(SESSION, userSaid('等我有空再看', 3));
  assert.ok(ledger.all().length <= 2);
  await ledger.close();
});

test('identity ignores punctuation and case', () => {
  assert.equal(identityOf('defer', '回头再说！'), identityOf('defer', ' 回头再说 '));
});
