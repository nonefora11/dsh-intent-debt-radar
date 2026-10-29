/**
 * The browser half has no DOM here, but it still has a contract worth pinning:
 * it must load through the module loader, register the three surfaces it
 * promises, and ship dictionaries that agree with the JSON files the host
 * translator serves.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Minimal React stand-in: the client only needs these symbols to define itself. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial ?? null }),
};

/** Load client.js the way the browser does and return its module object. */
async function loadClient() {
  let spec = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(candidate) {
        spec = candidate;
      },
    },
  };
  // A fresh query string defeats the ESM cache between tests in one file.
  await import(`${new URL('../client.js', import.meta.url).href}?t=${Math.random()}`);
  assert.ok(spec !== null, 'client.js must register itself with the module loader');
  const module = spec.factory((name) => {
    assert.equal(name, 'react', 'the client may only require react');
    return reactStub;
  });
  delete globalThis.window;
  return { spec, module };
}

test('the client registers under the plugin id and injects slots + locale', async () => {
  const { spec, module } = await loadClient();
  assert.equal(spec.id, 'dsh-intent-debt-radar');
  assert.equal(module.name, 'intent-debt-radar');
  assert.deepEqual([...module.inject], ['slots', 'locale']);
  assert.equal(typeof module.apply, 'function');
});

test('apply() claims the sidebar row, the main page and the overlay', async () => {
  const { module } = await loadClient();
  const registered = [];
  const dictionaries = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    locale: {
      register: (namespace, dict) => dictionaries.push({ namespace, dict }),
      bind: (namespace) => (key) => dictOf(dictionaries, namespace)[key] ?? key,
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (descriptor, component) => {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
  };

  module.apply(ctx);

  const names = registered.map((entry) => entry.descriptor.name);
  assert.deepEqual(names.sort(), ['main', 'shell.overlay', 'sidebar.panellist']);
  for (const entry of registered) {
    assert.equal(typeof entry.component, 'function', `${entry.descriptor.name} needs a component`);
    if (entry.descriptor.name === 'main') assert.equal(entry.descriptor.key, 'intent-debt-radar');
    if (entry.descriptor.name === 'sidebar.panellist') assert.equal(entry.descriptor.id, 'intent-debt-radar');
  }
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].namespace, 'intent-debt-radar');
});

function dictOf(dictionaries, namespace) {
  const found = dictionaries.find((entry) => entry.namespace === namespace);
  return { zh: found?.dict?.zh ?? {}, en: found?.dict?.en ?? {} };
}

test('the shipped JSON dictionaries and the inline ones agree', async () => {
  const { module } = await loadClient();
  const registered = [];
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: (namespace, dict) => registered.push(dict), bind: () => (key) => key },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  });
  const inline = registered[0];

  for (const locale of ['zh', 'en']) {
    const json = JSON.parse(await readFile(join(ROOT, 'locale', `${locale}.json`), 'utf8'));
    assert.deepEqual(
      Object.keys(inline[locale]).sort(),
      Object.keys(json).sort(),
      `${locale}: inline and JSON dictionaries must carry the same keys`,
    );
    for (const [key, value] of Object.entries(json)) {
      assert.equal(inline[locale][key], value, `${locale}.${key} drifted between the two copies`);
    }
  }
});

test('every literal tr() key exists in both dictionaries', async () => {
  const { module } = await loadClient();
  const registered = [];
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: (_namespace, dict) => registered.push(dict), bind: () => (key) => key },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  });
  const source = await readFile(join(ROOT, 'client.js'), 'utf8');
  const literal = new Set([...source.matchAll(/\btr\('([^']+)'\)/g)].map((match) => match[1]));
  assert.ok(literal.size > 20, 'the panel is expected to translate a fair number of strings');
  for (const key of literal) {
    assert.ok(key in registered[0].zh, `zh is missing ${key}`);
    assert.ok(key in registered[0].en, `en is missing ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Render smoke: no DOM, but the components can still be executed. This catches
// the class of typo that only a real render would otherwise reveal.
// ---------------------------------------------------------------------------

/**
 * Execute one component body.
 *
 * The stub React from loadClient() returns inert hooks, so this exercises the
 * render path (property access, translation calls, element construction) without
 * a DOM or an effect loop. Effects are covered by the host-side tests.
 */
function renderBody(component, props) {
  return component(props);
}

test('every registered surface renders without throwing', async () => {
  const { module } = await loadClient();
  const registered = [];
  module.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => fn(),
      register: (descriptor, component) => {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
  });
  const props = { t: (key) => key };
  for (const { descriptor, component } of registered) {
    assert.doesNotThrow(
      () => renderBody(() => component(descriptor.name === 'sidebar.panellist' ? { size: 16 } : props)),
      `${descriptor.name} threw while rendering`,
    );
  }
});

test('a card row renders live and settled cards with the same shape', async () => {
  const { module } = await loadClient();
  const tr = (key) => `[${key}]`;
  const base = {
    id: 'abc',
    kind: 'defer',
    speaker: 'user',
    tier: 'P1',
    score: 9,
    ageDays: 2,
    hits: 3,
    quote: '这个先放着',
    impliedPromise: '这个回头做',
    sessionId: 'session-1',
    status: 'open',
    live: true,
  };
  assert.doesNotThrow(() => module.internals.CardRow({ view: base, tr }));
  assert.doesNotThrow(() => module.internals.CardRow({ view: { ...base, status: 'snoozed', live: false }, tr }));
  assert.doesNotThrow(() => module.internals.CardRow({ view: { ...base, status: 'closed', live: false }, tr }));
  assert.doesNotThrow(() => module.internals.TierBadge({ tier: 'P0', score: 22 }));
});

test('jumpToSession hands the session id to the layout service, and degrades quietly', async () => {
  const { module } = await loadClient();
  const opened = [];
  let workspace = { openSession: (id) => opened.push(id) };
  const ctx = {
    get: (name) => (name === 'uiWorkspace' ? workspace : undefined),
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (key) => key },
    slots: { inject: (_name, fn) => fn(), register: () => () => {} },
  };

  module.apply(ctx);

  assert.equal(module.internals.jumpToSession('session-1'), true);
  assert.deepEqual(opened, ['session-1']);

  // A panel mounted before the layout service exists must not throw when clicked.
  workspace = undefined;
  assert.equal(module.internals.jumpToSession('session-2'), false);

  // A malformed view (no session id on very old cards) is a no-op, not a crash.
  assert.equal(module.internals.jumpToSession(undefined), false);
  assert.equal(module.internals.jumpToSession(''), false);

  // A thrown navigation error is swallowed: the click must never break the panel.
  workspace = {
    openSession() {
      throw new Error('layout exploded');
    },
  };
  assert.equal(module.internals.jumpToSession('session-3'), false);
});
