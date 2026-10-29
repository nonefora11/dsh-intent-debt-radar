import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, inject, name } from '../index.js';

/**
 * A stand-in for the host context: enough of Cordis to run `apply`, register
 * routes and the tool, and replay events. The point is to catch wiring mistakes
 * (a route that never registers, a tool whose schema the host would reject)
 * without booting DSH.
 */
async function boot() {
  const home = await mkdtemp(path.join(tmpdir(), 'intent-debt-smoke-'));
  process.env.DSH_HOME = home;

  const handlers = [];
  const disposers = [];
  const routes = [];
  const tools = new Map();

  const toolService = {
    register(spec) {
      tools.set(spec.name, spec);
      return () => tools.delete(spec.name);
    },
  };
  const webServer = {
    register(spec) {
      routes.push(spec);
      return () => {};
    },
  };
  const connection = { requestRejection: () => undefined };

  const services = new Map([
    ['tools', toolService],
    ['webServer', webServer],
    ['connection', connection],
  ]);

  const ctx = {
    on(type, fn) {
      handlers.push([type, fn]);
      return () => {};
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    inject(_names, fn) {
      fn(ctx);
    },
    get(service) {
      return services.get(service);
    },
    logger: () => ({ info() {}, warn() {}, debug() {} }),
  };

  apply(ctx, {});
  await new Promise((resolve) => setTimeout(resolve, 30));

  const emit = (type, session, event) => {
    for (const [kind, fn] of handlers) if (kind === type) fn(session, event);
  };

  const respond = (method, url, body) =>
    new Promise((resolve) => {
      const route = routes[0];
      assert.ok(route !== undefined, 'no route registered');
      let status = 0;
      let payload = '';
      const req = {
        method,
        url,
        on(event, fn) {
          if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
          if (event === 'end') fn();
        },
      };
      const res = {
        set statusCode(value) {
          status = value;
        },
        get statusCode() {
          return status;
        },
        setHeader() {},
        end(chunk) {
          payload = chunk ?? '';
          resolve({ status, json: payload === '' ? null : JSON.parse(payload) });
        },
      };
      route.handler(req, res);
    });

  return { home, emit, respond, tools, ctx, disposers };
}

const SESSION = { id: 's-smoke', header: { cwd: 'C:/work' } };
const NOW = Date.now();
const userSaid = (text, seq = 1) => ({ type: 'user/message', seq, time: NOW, data: { content: [{ type: 'text', text }], turn: 1 } });

/** The write is queued, not synchronous: wait for it the way a process restart would. */
async function readLedger(file, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`ledger never appeared at ${file}`);
}

test('the host half exports the shape the loader expects', () => {
  assert.equal(name, 'dsh-intent-debt-radar');
  assert.deepEqual(inject, ['tools']);
});

test('a conversation event reaches the ledger and the route reports it', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));

  const state = await host.respond('GET', '/intent-debt/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.cards.length, 1);
  assert.equal(state.json.cards[0].kind, 'defer');
  assert.equal(state.json.stats.live, 1);
  assert.equal(state.json.startup.show, true);
  assert.equal(state.json.startup.top.length, 1);
  // The counters are what tell a silent install apart from a broken one.
  assert.equal(state.json.scan.messages, 1);
  assert.equal(state.json.scan.hits, 1);
  assert.equal(state.json.scan.lastEventType, 'user/message');

  const raw = await readLedger(path.join(host.home, 'intent-debt-radar', 'ledger.json'));
  assert.equal(raw.cards.length, 1);
});

test('the action route settles a card and persists it', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));
  const state = await host.respond('GET', '/intent-debt/state');
  const id = state.json.cards[0].id;

  const closed = await host.respond('POST', '/intent-debt/action', { action: 'close', id });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.cards[0].status, 'closed');
  assert.equal(closed.json.stats.live, 0);

  const raw = await readLedger(path.join(host.home, 'intent-debt-radar', 'ledger.json'));
  assert.equal(raw.cards[0].status, 'closed');
});

test('converting returns a todo line the panel can hand off', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('日志分割这块先放着，回头再说'));
  const id = (await host.respond('GET', '/intent-debt/state')).json.cards[0].id;
  const converted = await host.respond('POST', '/intent-debt/action', { action: 'convert', id });
  assert.equal(converted.json.converted.id, id);
  assert.match(converted.json.converted.text, /^\[意图债务\] /);
});

test('reminding a card makes it due, and marking it notified silences it', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));
  const id = (await host.respond('GET', '/intent-debt/state')).json.cards[0].id;

  const reminded = await host.respond('POST', '/intent-debt/action', { action: 'remind', id, remindAt: Date.now() - 1000 });
  assert.equal(reminded.json.cards[0].status, 'open');

  const due = await host.respond('GET', '/intent-debt/due');
  assert.equal(due.json.due.length, 1);

  await host.respond('POST', '/intent-debt/action', { action: 'notified', id });
  const after = await host.respond('GET', '/intent-debt/due');
  assert.equal(after.json.due.length, 0);
});

test('dismissing the startup summary is remembered', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));
  assert.equal((await host.respond('GET', '/intent-debt/state')).json.startup.show, true);
  await host.respond('POST', '/intent-debt/action', { action: 'dismiss-startup' });
  assert.equal((await host.respond('GET', '/intent-debt/state')).json.startup.show, false);
});

test('unknown routes and unknown cards answer instead of hanging', async () => {
  const host = await boot();
  assert.equal((await host.respond('GET', '/intent-debt/nope')).status, 404);
  assert.equal((await host.respond('POST', '/intent-debt/action', { action: 'close', id: 'missing' })).status, 404);
  assert.equal((await host.respond('POST', '/intent-debt/action', { action: 'bogus', id: 'missing' })).status, 400);
});

test('the intent_debt tool lists, stats and settles', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));
  const tool = host.tools.get('intent_debt');
  assert.ok(tool !== undefined, 'tool not registered');
  assert.equal(tool.parameters.properties.action.enum.includes('convert'), true);

  const listing = await tool.execute({ action: 'list' });
  assert.match(listing, /意图债务|defer/);
  const id = /id=([0-9a-f]{16})/.exec(listing)?.[1];
  assert.ok(id !== undefined, `no id in listing: ${listing}`);

  assert.match(await tool.execute({ action: 'stats' }), /未结/);
  assert.match(await tool.execute({ action: 'close', id }), /已结清/);
  assert.match(await tool.execute({ action: 'list' }), /为空/);
  assert.match(await tool.execute({ action: 'close', id: 'nope' }), /没有找到/);
});

test('dispose closes the ledger without throwing', async () => {
  const host = await boot();
  host.emit('session/event', SESSION, userSaid('这个先放着，回头再说'));
  for (const dispose of host.disposers) dispose();
});
