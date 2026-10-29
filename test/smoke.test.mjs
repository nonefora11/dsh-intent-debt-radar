/**
 * End-to-end smoke test: the parts that unit tests cannot reach.
 *
 * `apply()` is the only place where the ledger, the radar, the HTTP routes and
 * the tool all meet the host. Every bug that ever reached the user lived in that
 * seam — a route that never registered, an event name that never fires, a card
 * that never reached disk. So this file builds a minimal fake host and drives it
 * exactly like DSH does: emit `session/event`, then call the HTTP surface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = await mkdtemp(path.join(tmpdir(), 'intent-debt-smoke-'));
process.env.DSH_HOME = home;

const { apply } = await import('../index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake host: enough of cordis and of node:http to exercise `apply()`. */
function fakeHost() {
  const handlers = new Map();
  const effects = [];
  const tools = [];
  let routeHandler = null;

  const ctx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') effects.push(disposer);
      return disposer;
    },
    inject(names, callback) {
      callback(ctx);
    },
    get(service) {
      if (service === 'tools') {
        return {
          register(definition) {
            tools.push(definition);
            return () => {
              const index = tools.indexOf(definition);
              if (index >= 0) tools.splice(index, 1);
            };
          },
        };
      }
      if (service === 'webServer') {
        return {
          register(route) {
            routeHandler = route.handler;
            return () => {
              routeHandler = null;
            };
          },
        };
      }
      if (service === 'connection') return { requestRejection: () => undefined };
      return undefined;
    },
  };

  return {
    ctx,
    tools,
    emit(type, session, event) {
      const handler = handlers.get(type);
      if (handler === undefined) throw new Error(`no handler for ${type}`);
      handler(session, event);
    },
    get route() {
      if (routeHandler === null) throw new Error('route was never registered');
      return routeHandler;
    },
    disposeAll() {
      for (const disposer of effects.splice(0)) disposer();
      for (const handler of handlers.values()) handler;
    },
  };
}

/** Drive one request through the registered route handler. */
async function request(handler, { method = 'GET', url, body }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {};
  req.destroy = () => {};
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      this.headersSent = true;
      if (chunk !== undefined) this.chunks.push(Buffer.from(String(chunk)));
    },
  };
  const done = new Promise((resolve) => {
    const original = res.end.bind(res);
    res.end = (chunk) => {
      original(chunk);
      resolve();
    };
  });
  handler(req, res);
  if (method === 'POST') {
    // The handler suspends on `await ready` before it attaches its body
    // listeners, so the body has to arrive on a later macrotask — exactly like a
    // real socket.
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  await done;
  const text = Buffer.concat(res.chunks).toString('utf8');
  return { status: res.statusCode, body: text === '' ? null : JSON.parse(text) };
}

function userMessage(seq, text, time = Date.now()) {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content: [{ type: 'text', text }] },
  };
}

function turnEnd(seq, time = Date.now()) {
  return { type: 'turn/end', seq, time, data: { turn: 1, reason: { kind: 'done' } } };
}

const session = { id: 'smoke-session', header: { cwd: '/tmp/smoke-workspace' } };

test('one deferred sentence becomes one card, visible over HTTP and on disk', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  await sleep(50);

  host.emit('session/event', session, userMessage(1, '这个日志先等会做吧，我现在有事'));
  host.emit('session/event', session, turnEnd(2));
  await sleep(250);

  const state = await request(host.route, { url: '/intent-debt/state' });
  assert.equal(state.status, 200);
  assert.equal(state.body.cards.length, 1);
  assert.equal(state.body.live.length, 1);
  assert.match(state.body.cards[0].quote, /先等会做/);
  assert.equal(state.body.mode, 'rules');
  assert.equal(state.body.startup.show, true);
  assert.equal(state.body.scan.messages >= 1, true);

  await sleep(500);
  const onDisk = JSON.parse(await readFile(path.join(home, 'intent-debt-radar', 'ledger.json'), 'utf8'));
  assert.equal(onDisk.cards.length, 1);
  assert.equal(onDisk.version, 1);
});

test('the mode switch survives a restart', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  await sleep(50);

  const switched = await request(host.route, { method: 'POST', url: '/intent-debt/action', body: { action: 'mode', mode: 'api' } });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.mode, 'api');
  await sleep(500);

  const second = fakeHost();
  apply(second.ctx, {});
  await sleep(120);
  const state = await request(second.route, { url: '/intent-debt/state' });
  assert.equal(state.body.mode, 'api', 'the panel promised the choice persists');
});

test('a card can be closed once and not a second time', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  await sleep(50);

  host.emit('session/event', session, userMessage(10, '这个先放着，回头再说'));
  await sleep(250);
  const state = await request(host.route, { url: '/intent-debt/state' });
  const id = state.body.cards[0].id;

  const first = await request(host.route, { method: 'POST', url: '/intent-debt/action', body: { action: 'close', id } });
  assert.equal(first.status, 200);
  const again = await request(host.route, { method: 'POST', url: '/intent-debt/action', body: { action: 'close', id } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'illegal-transition');
});

test('the tool answers without a browser', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  await sleep(50);
  host.emit('session/event', session, userMessage(20, '这个先放着，回头再说'));
  await sleep(250);

  const tool = host.tools.find((entry) => entry.name === 'intent_debt');
  assert.ok(tool, 'the tool must be registered');
  const stats = await tool.execute({ action: 'stats' }, {});
  assert.match(stats, /意图债务/);
  const list = await tool.execute({ action: 'list' }, {});
  assert.match(list, /欠的是/);
});

test('unknown routes and methods answer with JSON, never a hang', async () => {
  const host = fakeHost();
  apply(host.ctx, {});
  await sleep(50);

  const missing = await request(host.route, { url: '/intent-debt/nope' });
  assert.equal(missing.status, 404);
  const wrongPath = await request(host.route, { url: '/intent-debt/nope', method: 'DELETE' });
  assert.equal(wrongPath.status, 405);
  const badAction = await request(host.route, { method: 'POST', url: '/intent-debt/state', body: {} });
  assert.equal(badAction.status, 400);
  assert.equal(badAction.body.error, 'unknown-action');
  const unknownCard = await request(host.route, { method: 'POST', url: '/intent-debt/action', body: { action: 'close', id: 'deadbeef' } });
  assert.equal(unknownCard.status, 404);
});
