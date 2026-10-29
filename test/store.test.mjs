import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LEDGER_VERSION, Ledger, idOf, isCardShape } from '../lib/store.js';

async function tempLedger() {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-store-'));
  const ledger = new Ledger({ directory });
  await ledger.open();
  return { directory, ledger };
}

function card(overrides = {}) {
  return {
    id: 'id-1',
    kind: 'defer',
    quote: '这个先放着，回头再说',
    impliedPromise: '回头再说',
    status: 'open',
    anchorTime: 1_790_000_000_000,
    lastSeenAt: 1_790_000_000_000,
    hits: 1,
    sessionId: 's1',
    scorerVersion: 1,
    ...overrides,
  };
}

test('a stored card survives a reopen', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.put(card());
  await ledger.flush();
  await ledger.close();

  const reopened = new Ledger({ directory });
  await reopened.open();
  assert.equal(reopened.all().length, 1);
  assert.equal(reopened.get('id-1').quote, '这个先放着，回头再说');
  await reopened.close();
});

test('flush writes a versioned document', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.put(card());
  await ledger.flush();
  const raw = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
  assert.equal(raw.version, LEDGER_VERSION);
  assert.equal(raw.cards.length, 1);
  assert.equal(typeof raw.meta.lastStartupShownAt, 'number');
  await ledger.close();
});

test('flush is atomic: no temp files are left behind', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.put(card());
  await ledger.flush();
  const entries = await readdir(directory);
  assert.deepEqual(entries.filter((name) => name.includes('.tmp-')), []);
  await ledger.close();
});

test('repeated flushes keep the last state', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.put(card({ hits: 1 }));
  await ledger.flush();
  ledger.put(card({ hits: 4 }));
  await ledger.flush();
  const raw = JSON.parse(await readFile(path.join(directory, 'ledger.json'), 'utf8'));
  assert.equal(raw.cards[0].hits, 4);
  await ledger.close();
});

test('a corrupt ledger is preserved, not silently replaced', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'intent-debt-corrupt-'));
  await writeFile(path.join(directory, 'ledger.json'), '{ not json', 'utf8');
  const ledger = new Ledger({ directory });
  await ledger.open();
  assert.deepEqual(ledger.all(), []);
  const entries = await readdir(directory);
  assert.ok(entries.some((name) => name.startsWith('ledger.json.corrupt-')));
  await ledger.close();
});

test('patch merges without letting the id change', async () => {
  const { ledger } = await tempLedger();
  ledger.put(card());
  const next = ledger.patch('id-1', { id: 'hijack', status: 'snoozed' });
  assert.equal(next.id, 'id-1');
  assert.equal(next.status, 'snoozed');
  assert.equal(ledger.patch('missing', { status: 'closed' }), undefined);
  await ledger.close();
});

test('malformed cards are refused at the boundary', async () => {
  const { ledger } = await tempLedger();
  assert.equal(isCardShape({ id: 'x' }), false);
  assert.throws(() => ledger.put({ id: '', kind: 'defer' }), /malformed/);
  await ledger.close();
});

test('prune drops settled cards past the retention window only', async () => {
  const now = 1_790_000_000_000;
  const old = now - 200 * 86_400_000;
  const { ledger } = await tempLedger();
  ledger.put(card({ id: 'old-closed', status: 'closed', lastSeenAt: old }));
  ledger.put(card({ id: 'old-open', status: 'open', lastSeenAt: old }));
  ledger.put(card({ id: 'new-closed', status: 'closed', lastSeenAt: now }));
  assert.equal(ledger.prune(120, now), 1);
  assert.deepEqual(
    ledger.all().map((entry) => entry.id).sort(),
    ['new-closed', 'old-open'],
  );
  await ledger.close();
});

test('meta round-trips through the file', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.setMeta({ lastStartupShownAt: 42 });
  await ledger.flush();
  await ledger.close();
  const reopened = new Ledger({ directory });
  await reopened.open();
  assert.equal(reopened.meta().lastStartupShownAt, 42);
  await reopened.close();
});

test('ids are content-derived, so the same debt is the same card', () => {
  assert.equal(idOf('defer|回头再说'), idOf('defer|回头再说'));
  assert.notEqual(idOf('defer|回头再说'), idOf('defer|下次补上'));
  assert.match(idOf('x'), /^[0-9a-f]{16}$/);
});

test('meta survives a reopen — a whitelist here reset the extractor mode', async () => {
  const { directory, ledger } = await tempLedger();
  ledger.setMeta({ mode: 'api', lastStartupShownAt: 42 });
  await ledger.flush();
  await ledger.close();

  const reopened = new Ledger({ directory });
  await reopened.open();
  assert.equal(reopened.meta().mode, 'api');
  assert.equal(reopened.meta().lastStartupShownAt, 42);
});

test('remove drops one card and leaves the rest', async () => {
  const { ledger } = await tempLedger();
  ledger.put(card({ id: 'a' }));
  ledger.put(card({ id: 'b' }));
  assert.equal(ledger.remove('a'), true);
  assert.equal(ledger.remove('a'), false);
  assert.deepEqual(ledger.all().map((entry) => entry.id), ['b']);
});

test('prune keeps live cards no matter how old they are', async () => {
  const { ledger } = await tempLedger();
  const stale = 1_790_000_000_000;
  ledger.put(card({ id: 'open-old', status: 'open', lastSeenAt: stale }));
  ledger.put(card({ id: 'closed-old', status: 'closed', lastSeenAt: stale }));
  ledger.put(card({ id: 'closed-new', status: 'closed', lastSeenAt: stale + 200 * 86_400_000 }));
  const removed = ledger.prune(120, stale + 200 * 86_400_000);
  assert.equal(removed, 1);
  assert.deepEqual(ledger.all().map((entry) => entry.id).sort(), ['closed-new', 'open-old']);
});
