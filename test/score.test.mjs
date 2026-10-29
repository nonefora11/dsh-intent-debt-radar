import test from 'node:test';
import assert from 'node:assert/strict';

import { AGE_CAP_DAYS, SCORER_VERSION, canTransition, isLive, project, scoreOf, sortViews, tierOf } from '../lib/score.js';

const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

/** Minimal stored card. */
function card(overrides = {}) {
  return {
    id: 'abc',
    kind: 'defer',
    quote: '这个先放着，回头再说',
    impliedPromise: '回头再说',
    status: 'open',
    hits: 1,
    anchorTime: NOW,
    scorerVersion: SCORER_VERSION,
    ...overrides,
  };
}

test('a fresh deferral scores base + one hit', () => {
  assert.equal(scoreOf(card(), NOW), 9);
});

test('age raises the score and stops at the cap', () => {
  assert.equal(scoreOf(card({ anchorTime: NOW - 3 * DAY }), NOW), 12);
  const floorAtCap = scoreOf(card({ anchorTime: NOW - 40 * DAY }), NOW);
  assert.equal(floorAtCap, 9 + AGE_CAP_DAYS);
});

test('hits dominate but are capped at four', () => {
  assert.equal(scoreOf(card({ hits: 3 }), NOW), 6 + 9);
  assert.equal(scoreOf(card({ hits: 9 }), NOW), scoreOf(card({ hits: 4 }), NOW));
});

test('an agent promise outranks a deferral of the same age', () => {
  const promise = scoreOf(card({ kind: 'agent-promise' }), NOW);
  const defer = scoreOf(card({ kind: 'defer' }), NOW);
  assert.ok(promise > defer);
});

test('settled cards accrue nothing', () => {
  for (const status of ['closed', 'converted']) {
    assert.equal(scoreOf(card({ status, anchorTime: NOW - 30 * DAY, hits: 9 }), NOW), 0);
  }
});

test('snoozing subtracts, and an expired snooze subtracts nothing', () => {
  assert.equal(scoreOf(card({ status: 'snoozed', snoozedUntil: NOW + DAY }), NOW), 3);
  assert.equal(scoreOf(card({ status: 'snoozed', snoozedUntil: NOW - DAY }), NOW), 9);
});

test('a due hint adds three', () => {
  assert.equal(scoreOf(card({ dueHint: '2026-10-28 09:00' }), NOW), 12);
});

test('tiers follow the thresholds', () => {
  assert.equal(tierOf(12), 'P0');
  assert.equal(tierOf(11.99), 'P1');
  assert.equal(tierOf(6), 'P1');
  assert.equal(tierOf(5.99), 'P2');
  assert.equal(tierOf(0), 'P2');
});

test('the state machine allows only the listed moves', () => {
  assert.equal(canTransition('open', 'closed'), true);
  assert.equal(canTransition('closed', 'open'), true);
  assert.equal(canTransition('converted', 'snoozed'), false);
  assert.equal(canTransition('open', 'open'), false);
  assert.equal(canTransition('nonsense', 'open'), false);
});

test('an expired snooze reads as live again, without a scheduler', () => {
  assert.equal(isLive(card({ status: 'snoozed', snoozedUntil: NOW - 1 }), NOW), true);
  assert.equal(isLive(card({ status: 'snoozed', snoozedUntil: NOW + DAY }), NOW), false);
  assert.equal(isLive(card({ status: 'closed' }), NOW), false);
});

test('projection never mutates the stored card and normalizes an expired snooze', () => {
  const stored = card({ status: 'snoozed', snoozedUntil: NOW - 1 });
  const view = project(stored, NOW);
  assert.equal(view.status, 'open');
  assert.equal(view.live, true);
  assert.equal(stored.status, 'snoozed', 'the stored record is untouched');
  assert.ok(view.score > 0);
  assert.equal(typeof view.ageDays, 'number');
});

test('sorting puts live first, then the heaviest, then the oldest', () => {
  const views = [
    { id: 'old-light', live: true, score: 5, anchorTime: NOW - 10 * DAY },
    { id: 'settled', live: false, score: 0, anchorTime: NOW },
    { id: 'heavy', live: true, score: 18, anchorTime: NOW - DAY },
    { id: 'old-heavy', live: true, score: 18, anchorTime: NOW - 20 * DAY },
  ];
  assert.deepEqual(
    sortViews(views).map((view) => view.id),
    ['old-heavy', 'heavy', 'old-light', 'settled'],
  );
});
