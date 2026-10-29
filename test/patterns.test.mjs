import test from 'node:test';
import assert from 'node:assert/strict';

import { clausesOf, clip, isClosure, jaccard, scanText, shingles } from '../lib/patterns.js';

test('clausesOf keeps offsets into the original text', () => {
  const text = '第一句。第二句！ 第三句';
  const clauses = clausesOf(text);
  assert.equal(clauses.length, 3);
  assert.deepEqual(clauses.map((clause) => clause.text), ['第一句', '第二句', '第三句']);
  assert.equal(text.slice(clauses[1].start, clauses[1].end), '第二句');
  assert.equal(clauses[2].start, text.indexOf('第三句'));
});

test('clausesOf drops blank clauses and trims leading whitespace', () => {
  const clauses = clausesOf('  \n A；\n\n B \n');
  assert.deepEqual(clauses.map((clause) => clause.text), ['A', 'B']);
});

test('scanText catches an explicit deferral', () => {
  const found = scanText('这个先放着，回头再说', 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'defer');
  assert.equal(found[0].label, 'defer.shelve');
  assert.equal(found[0].quote, '这个先放着');
  // A two-character subject is not a debt: keep the clause, verb included.
  assert.equal(found[0].impliedPromise, '这个先放着');
  assert.equal(found[0].confidence, 0.9);
});

test('two tells for one intent inside one message stay one card', () => {
  // Regression: the comma split made this sentence produce two deferral cards
  // for the same shelved thing, and the weaker one ("回头再说") had no subject.
  const found = scanText('这个日志先放着，回头再说', 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].quote, '这个日志先放着');
  assert.equal(found[0].impliedPromise, '这个日志');
});

test('the phrase that started this: 先等会做吧', () => {
  // verbatim from the first real test run, where it fired nothing at all
  const found = scanText('这个日志先等会做吧，我现在有事', 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'defer');
  assert.equal(found[0].quote, '这个日志先等会做吧');
  assert.equal(found[0].impliedPromise, '这个日志');
});

test('immediate instructions are not deferrals', () => {
  for (const phrase of ['先跑一下测试吧', '等一下，我看下日志', '先看日志再改代码', '这里先加个判断']) {
    assert.deepEqual(scanText(phrase, 'user'), [], `false positive on ${phrase}`);
  }
});

test('scanText catches the shelving variants', () => {
  for (const phrase of ['先这样吧，别管它了', '等我有空再看', 'Next time we will look at it']) {
    const found = scanText(phrase, 'user');
    assert.ok(found.length >= 1, `expected a hit for ${phrase}`);
    assert.equal(found[0].kind, 'defer');
  }
});

test('scanText separates an open decision from a deferral in the same message', () => {
  const found = scanText('用 SQLite 还是 Postgres？你决定吧', 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'decision');
});

test('scanText reads assistant promises, not assistant narration', () => {
  const promise = scanText('下一步我来把测试补上。', 'assistant');
  assert.equal(promise.length, 1);
  assert.equal(promise[0].kind, 'agent-promise');
  assert.equal(scanText('先做 A 再做 B，然后跑一遍。', 'assistant').length, 0);
});

test('scanText never invents a card out of ordinary prose', () => {
  assert.deepEqual(scanText('今天天气不错，代码跑通了。', 'user'), []);
  assert.deepEqual(scanText('', 'user'), []);
  assert.deepEqual(scanText(undefined, 'user'), []);
});

test('quotes are the original clause, never a rewrite', () => {
  const text = '先放着吧，回头再说，我先把这条路走完。';
  for (const candidate of scanText(text, 'user')) {
    assert.ok(text.includes(candidate.quote), `quote should appear verbatim: ${candidate.quote}`);
  }
});

test('isClosure tells closure from debt', () => {
  assert.equal(isClosure('算了，不用了'), true);
  assert.equal(isClosure('搞定了，已经改好了'), true);
  assert.equal(isClosure('never mind, forget it'), true);
  assert.equal(isClosure('回头再说'), false);
  assert.equal(isClosure(''), false);
});

test('shingles and jaccard behave on near-duplicates', () => {
  const a = shingles('把这个接口的错误处理补上');
  const b = shingles('这个接口的错误处理还没补上');
  assert.ok(jaccard(a, b) > 0.4, 'similar sentences should overlap');
  assert.equal(jaccard(shingles('完全无关的一句话'), shingles('another sentence entirely')), 0);
  assert.equal(jaccard(new Set(), a), 0);
});

test('clip cuts by code point and leaves short text alone', () => {
  assert.equal(clip('短句', 10), '短句');
  assert.equal([...clip('一二三四五', 3)].length, 4, 'limit plus the ellipsis');
  assert.ok(clip('一二三四五', 3).endsWith('…'));
});

test('a short subject falls back to the clause instead of a stub', () => {
  const found = scanText('这个东西先等会做吧', 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].impliedPromise, '这个东西先等会做');
});

test('clip and scanText repair lone surrogates instead of storing them', () => {
  const broken = '这个东西先等会做' + String.fromCharCode(0xdca7);
  assert.equal(clip(broken, 40).isWellFormed(), true);
  const found = scanText(broken, 'user');
  assert.equal(found.length, 1);
  assert.equal(found[0].quote.isWellFormed(), true);
  assert.equal(found[0].impliedPromise.isWellFormed(), true);
});
