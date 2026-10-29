/**
 * `dsh-intent-debt-radar` — host half.
 *
 * Three responsibilities, in order of importance:
 *
 *   1. watch. Subscribe to `session/event`, feed the {@link Radar}, keep the
 *      ledger warm. Nothing here may throw into a conversation.
 *   2. serve. One small JSON surface over `webServer` so the panel can read and
 *      act without a second source of truth.
 *   3. offer. One tool, `intent_debt`, so the agent itself can look at the debt
 *      it owes instead of being told about it by a person.
 *
 * The panel is the product; notifications are a courtesy. That ordering is why
 * this file has no notification side effects beyond handing the client a list of
 * due cards.
 *
 * @module dsh-intent-debt-radar
 */

import { Ledger } from './lib/store.js';
import { Radar, textOf } from './lib/extract.js';
import { ApiExtractor, Budget, ExtractionCache, MODES } from './lib/llm.js';
import { canTransition, project, sortViews } from './lib/score.js';
import { STUB_SUBJECT, scanText } from './lib/patterns.js';

export const name = 'dsh-intent-debt-radar';

/** Services we would like, all resolved lazily so headless DSH still loads us. */
export const inject = ['tools'];

/** HTTP prefix for the panel's data surface. */
const ROUTE = '/intent-debt';

/** A turn's message bodies longer than this are cut before they reach a model. */
const BATCH_TEXT_CAP = 4000;

/** Resolved plugin settings with the defaults a new install gets. */
function settingsOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {};
  const number = (key, fallback) => (Number.isFinite(source[key]) ? source[key] : fallback);
  const text = (key, fallback) => (typeof source[key] === 'string' ? source[key] : fallback);
  return {
    enabled: source.enabled !== false,
    minConfidence: number('minConfidence', 0.5),
    trackAssistantPromises: source.trackAssistantPromises !== false,
    maxCardsPerSession: number('maxCardsPerSession', 80),
    retentionDays: number('retentionDays', 120),
    // The startup summary shows at most once per gap: dismissing it silences it
    // for the same window, so "知道了" means "not right now", not "forever".
    // 0 shows it on every page load.
    // The user asked for the summary on every launch, not once a day.
    startupPopupGapHours: number('startupPopupGapHours', 0),
    retentionSweep: source.retentionSweep !== false,
    // ---- extraction mode -----------------------------------------------------
    // 'rules' is the default: free, instant, explainable, offline. 'api' adds a
    // model pass over the clauses the rules cannot settle. The panel can switch
    // this at runtime; the switch survives restarts in the ledger's meta.
    mode: MODES.includes(text('mode', 'rules')) ? text('mode', 'rules') : 'rules',
    maxClausesPerCall: number('maxClausesPerCall', 6),
    maxCallsPerHour: number('maxCallsPerHour', 6),
    maxCallsPerDay: number('maxCallsPerDay', 60),
    maxTokensPerDay: number('maxTokensPerDay', 40_000),
    // Empty means "reuse the session's own route", which needs no configuration
    // and no second API key.
    llmProvider: text('llmProvider', ''),
    llmModel: text('llmModel', ''),
  };
}

export function apply(ctx, config) {
  // One mutable copy of the settings: the panel can flip `mode` at runtime and
  // both the radar and the extractor read it through the same object.
  const settings = settingsOf(config);
  const logger = ctx.logger?.('intent-debt-radar') ?? null;
  const ledger = new Ledger();
  const radar = new Radar({ ledger, settings });
  const budget = new Budget({
    perHour: settings.maxCallsPerHour,
    perDay: settings.maxCallsPerDay,
    tokensPerDay: settings.maxTokensPerDay,
  });
  const cache = new ExtractionCache(256);
  /** The model layer, once the `llm` service exists. Null keeps rules-only. */
  let extractor = null;
  // A ledger that cannot be opened must not take the host down with it; every
  // read path treats `undefined` as "empty for now".
  const ready = ledger.open().then(() => {
    const saved = ledger.meta().mode;
    if (MODES.includes(saved)) settings.mode = saved;
    repairSubjects(ledger);
    // The retention setting was documented but never applied: a ledger only ever
    // grew. Prune on load, which is the only moment the age of a card is settled
    // and nobody is mid-click.
    if (settings.retentionSweep) ledger.prune(settings.retentionDays, Date.now());
  }).catch((error) => {
    logger?.warn?.(`ledger open failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!settings.enabled) {
    logger?.info?.('disabled by configuration');
    return;
  }

  // The model layer is optional by construction: without the service the plugin
  // is exactly what it was before this file had a second extractor.
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.get('llm');
    if (llm === undefined) return;
    extractor = new ApiExtractor({ llm, radar, settings, budget, cache });
  });

  // ---- watch ---------------------------------------------------------------

  /** Per-session message bodies of the turn in progress, for the model layer. */
  const batches = new Map();

  // The listener can fire before `ready` resolves — a host that boots with a
  // turn in flight will do exactly that. Events are held, not dropped, and
  // replayed in order once the ledger is warm.
  const buffered = [];
  let loaded = false;

  /** The real watcher; also the replay target for buffered events. */
  function observe(session, event) {
    radar.observe(session, event);
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '') return;
    const type = String(event?.type ?? '');

    if (type === 'user/message' || type === 'assistant/message') {
      if (settings.mode !== 'api') return;
      const message = type === 'user/message' ? event?.data : event?.data?.message;
      if (message?.source?.kind === 'runtime-context') return;
      const text = textOf(message);
      if (text.trim() === '') return;
      let batch = batches.get(sessionId);
      if (batch === undefined) {
        batch = [];
        batches.set(sessionId, batch);
      }
      batch.push({ text: text.slice(0, BATCH_TEXT_CAP), speaker: type === 'user/message' ? 'user' : 'assistant' });
      return;
    }

    if (type === 'turn/end') {
      const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
      const context = {
        sessionId,
        workspace: cwd,
        workspaceId: cwd === '' ? 'unknown' : cwd,
        seq: Number.isFinite(event?.seq) ? event.seq : 0,
        time: Number.isFinite(event?.time) ? event.time : Date.now(),
        turn: Number.isFinite(event?.data?.turn) ? event.data.turn : 0,
      };
      radar.commitPending(sessionId, context);
      const batch = batches.get(sessionId) ?? [];
      batches.delete(sessionId);
      // Fire-and-forget: the model pass outlives the turn but never blocks it.
      if (extractor !== null && settings.mode === 'api' && batch.length > 0) {
        void extractor.run({ session, batch, context });
      }
      return;
    }

  }

  void ready.then(() => {
    loaded = true;
    for (const entry of buffered.splice(0)) observe(entry.session, entry.event);
  });

  const disposeWatch = ctx.on('session/event', (session, event) => {
    if (!settings.enabled) return;
    if (loaded === false) {
      // Bounded tap: a pathological boot must not queue a whole day of traffic.
      if (buffered.length < 500) buffered.push({ session, event });
      return;
    }
    observe(session, event);
  });

  // `session/delete` and `session/close` are not event types DSH emits — the
  // hook that actually fires is `session/disposed`. Without it, every session's
  // last message stayed pinned in memory for the life of the process.
  const disposeDisposed = ctx.on('session/disposed', (session) => {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '') return;
    radar.forget(sessionId);
    batches.delete(sessionId);
  });

  ctx.effect(() => () => {
    try {
      disposeDisposed?.();
    } catch {
      /* already gone */
    }
    try {
      disposeWatch?.();
    } catch {
      /* already gone */
    }
    void ledger.close();
  }, 'intent-debt:lifecycle');

  /** One flag per process: the summary is offered once, on the first look. */
  const startupRuntime = { shownThisBoot: false };

  // Timers here would duplicate the client's poll; `GET /due` is the contract.

  // ---- serve ---------------------------------------------------------------

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    const connection = webCtx.get('connection');
    if (webServer === undefined || connection === undefined) return;
    webCtx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) => {
            const rejection = connection.requestRejection?.(req);
            if (typeof rejection === 'number' && rejection > 0) {
              res.statusCode = rejection;
              res.end();
              return;
            }
            handleRoute(req, res, { ledger, settings, ready, radar, startupRuntime, apiOf: () => extractor }).catch((error) => {
              logger?.warn?.(`route failed: ${error instanceof Error ? error.message : String(error)}`);
              if (!res.headersSent) json(res, 500, { error: 'internal' });
              else res.end();
            });
          },
        }),
      'intent-debt:routes',
    );
  });

  // ---- offer ---------------------------------------------------------------

  ctx.inject(['tools'], (toolCtx) => {
    const tools = toolCtx.get('tools');
    if (tools === undefined) return;
    toolCtx.effect(() => {
      const dispose = tools.register(toolRegistration({ ledger, ready, radar, settings, apiOf: () => extractor }));
      return () => {
        try {
          dispose?.();
        } catch {
          /* already gone */
        }
      };
    }, 'intent-debt:tool');
  });
}

/* -------------------------------------------------------------------------- */
/* HTTP surface                                                                */
/* -------------------------------------------------------------------------- */

/** Write a JSON response. */
function json(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.statusCode = status;
  res.setHeader?.('content-type', 'application/json; charset=utf-8');
  res.setHeader?.('cache-control', 'no-store');
  res.end(body);
}

/** Read a request body as JSON, tolerating empty and malformed bodies. */
function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve) => {
    if (req === null || typeof req !== 'object' || typeof req.on !== 'function') {
      resolve({});
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // Answer first, then stop reading: destroying the socket before the
        // reply produced a 404 on a dead connection.
        resolve(TOO_LARGE);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** Snapshot the panel renders. */
function stateOf(ledger, settings, extra = {}, runtime = { shownThisBoot: true }) {
  const now = Date.now();
  const views = sortViews(ledger.all().map((card) => project(card, now)));
  const live = views.filter((view) => view.live);
  const counts = { P0: 0, P1: 0, P2: 0 };
  for (const view of live) counts[view.tier] += 1;
  const meta = ledger.meta();
  const gapMs = Math.max(0, settings.startupPopupGapHours) * 3_600_000;
  // "Every launch" is the promise, not "every hour": the summary shows once
  // per process, and the gap only exists for hosts that keep the client alive
  // across days.
  const shownThisBoot = runtime.shownThisBoot === true;
  return {
    now,
    mode: settings.mode,
    cards: views,
    live,
    stats: {
      total: views.length,
      live: live.length,
      tiers: counts,
      open: live.filter((v) => v.status === 'open').length,
      // Counted over every view: a snoozed card is not "live", so counting the
      // live list reported 0 forever.
      snoozed: views.filter((v) => v.status === 'snoozed').length,
    },
    startup: {
      show: live.length > 0 && shownThisBoot === false && now - (meta.lastStartupShownAt ?? 0) >= gapMs,
      lastShownAt: meta.lastStartupShownAt ?? 0,
      top: live.slice(0, 5).map(compact),
    },
    ...extra,
  };
}

/**
 * Cards written by an older scorer can carry a subject that says nothing
 * (`这个东西`). The quote is still there, so the tells are re-read from it and the
 * subject follows. Idempotent: a card whose subject already has content is left
 * alone, so this costs nothing after the first pass.
 * @param {object} ledger - the ledger to repair in place.
 * @returns {void}
 */
function repairSubjects(ledger) {
  for (const card of ledger.all()) {
    if (typeof card.quote !== 'string' || card.quote === '') continue;
    if (!STUB_SUBJECT.test(card.impliedPromise ?? '')) continue;
    const again = scanText(card.quote, card.speaker === 'assistant' ? 'assistant' : 'user');
    const first = again[0];
    if (first === undefined || first.impliedPromise === card.impliedPromise) continue;
    ledger.patch(card.id, { impliedPromise: first.impliedPromise, why: first.label });
  }
}

/** Small view for popups and badges. */
function compact(view) {
  return {
    id: view.id,
    kind: view.kind,
    tier: view.tier,
    score: view.score,
    quote: view.quote,
    impliedPromise: view.impliedPromise,
    ageDays: view.ageDays,
    sessionId: view.sessionId,
    workspace: view.workspace,
    remindAt: view.remindAt ?? null,
  };
}

/** The actions that address one card. */
const CARD_ACTIONS = ['close', 'reopen', 'snooze', 'remind', 'convert', 'notified', 'delete'];

/** Sentinel for a request body over the size limit. */
const TOO_LARGE = Symbol('too-large');

/**
 * Coerce a requested reminder time into something `Date` can represent.
 * @param {unknown} value - caller supplied epoch milliseconds.
 * @param {number} now - current time, the default.
 * @returns {number|null} a safe timestamp, or null when the value is unusable.
 */
function clampTime(value, now) {
  if (!Number.isFinite(value)) return now + 3_600_000;
  // Beyond this, toISOString throws and the panel would show "Invalid Date".
  if (value < 0 || value > 8_640_000_000_000_000) return null;
  return value;
}

/** Which status each state-changing action asks for. */
const STATUS_FOR = {
  close: 'closed',
  reopen: 'open',
  snooze: 'snoozed',
  convert: 'converted',
};

/** Route table. Kept flat on purpose: one GET, one POST. */
async function handleRoute(req, res, context) {
  const { ledger, settings, ready, radar } = context;
  await ready;
  const api = context.apiOf?.() ?? null;
  // Every reply carries the radar's own counters: a plugin that answers "nothing
  // to report" must still prove it saw the conversation. The startup flag lives
  // on the route context, because it is per process, not per request.
  const snap = (extra = {}) =>
    stateOf(ledger, settings, { scan: radar?.stats ?? null, api: api?.snapshot() ?? null, ...extra }, context.startupRuntime);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const endpoint = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname;

  if (req.method === 'GET') {
    if (endpoint === '/' || endpoint === '/state') {
      json(res, 200, snap());
      return;
    }
    if (endpoint === '/due') {
      const now = Date.now();
      const due = ledger
        .all()
        .map((card) => project(card, now))
        .filter((view) => view.live && typeof view.remindAt === 'number' && view.remindAt <= now)
        .filter((view) => !(typeof view.notifiedAt === 'number' && view.notifiedAt >= view.remindAt))
        .slice(0, 10)
        .map(compact);
      json(res, 200, { now, due });
      return;
    }
    json(res, 404, { error: 'not-found' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader?.('allow', 'GET, POST');
    json(res, 405, { error: 'method-not-allowed' });
    return;
  }

  const body = await readJson(req);
  if (body === TOO_LARGE) {
    json(res, 413, { error: 'payload-too-large' });
    return;
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const id = typeof body.id === 'string' ? body.id : '';

  if (action === 'dismiss-startup' || action === 'startup-shown') {
    // Both mean "the summary had its moment": one the user closed it, the other
    // the client rendered it. Either way the next one waits for the gap.
    context.startupRuntime.shownThisBoot = true;
    ledger.setMeta({ lastStartupShownAt: Date.now() });
    await ledger.flush().catch(() => {});
    json(res, 200, snap());
    return;
  }

  if (action === 'mode') {
    // Switching the extractor is a user-facing choice, not config-file surgery:
    // the panel writes it here and the ledger remembers it across restarts.
    const next = MODES.includes(body.mode) ? body.mode : '';
    if (next === '') {
      json(res, 400, { error: 'unknown-mode' });
      return;
    }
    settings.mode = next;
    ledger.setMeta({ mode: next });
    await ledger.flush().catch(() => {});
    json(res, 200, snap());
    return;
  }

  if (!CARD_ACTIONS.includes(action)) {
    json(res, 400, { error: 'unknown-action', action });
    return;
  }

  if (id === '' || ledger.get(id) === undefined) {
    json(res, 404, { error: 'unknown-card' });
    return;
  }

  const now = Date.now();
  // Illegal transitions are refused rather than written: a closed card that can
  // be "closed" again, or a settled one that can be snoozed back to life, is how
  // a ledger stops being trustworthy.
  const target = STATUS_FOR[action];
  if (target !== undefined) {
    const current = ledger.get(id)?.status ?? 'open';
    if (canTransition(current, target) === false) {
      json(res, 409, { error: 'illegal-transition', from: current, to: target });
      return;
    }
  }
  switch (action) {
    case 'close': {
      ledger.patch(id, { status: 'closed', settledAt: now, lastSeenAt: now, closedBy: 'panel' });
      break;
    }
    case 'reopen': {
      ledger.patch(id, {
        status: 'open',
        reopenedAt: now,
        lastSeenAt: now,
        hits: (ledger.get(id)?.hits ?? 1) + 1,
        // A reopened debt is live again: the settlement traces would still be
        // rendered by the panel and would skew scoring.
        settledAt: undefined,
        closedBy: undefined,
        convertedTo: undefined,
      });
      break;
    }
    case 'snooze': {
      const hours = Number.isFinite(body.hours) ? Math.min(24 * 90, Math.max(1, body.hours)) : 24;
      ledger.patch(id, { status: 'snoozed', snoozedUntil: now + hours * 3_600_000, lastSeenAt: now });
      break;
    }
    case 'remind': {
      const at = clampTime(body.remindAt, now);
      if (at === null) {
        json(res, 400, { error: 'bad-remind-at' });
        return;
      }
      ledger.patch(id, {
        remindAt: at,
        dueHint: new Date(at).toISOString().slice(0, 16).replace('T', ' '),
        notifiedAt: undefined,
        lastSeenAt: now,
      });
      break;
    }
    case 'convert': {
      const card = ledger.get(id);
      const line = `[意图债务] ${card.impliedPromise || card.quote}`;
      ledger.patch(id, { status: 'converted', settledAt: now, lastSeenAt: now, convertedTo: { kind: 'todo', text: line } });
      await ledger.flush().catch(() => {});
      json(res, 200, snap({ converted: { id, text: line } }));
      return;
    }
    case 'notified': {
      // Keeping the hint after firing left a permanent +3 due bonus and a line
      // that claimed the card was due when it was not.
      ledger.patch(id, { notifiedAt: now, remindAt: undefined, dueHint: undefined });
      break;
    }
    case 'delete': {
      ledger.remove(id);
      break;
    }
    default: {
      json(res, 400, { error: 'unknown-action' });
      return;
    }
  }
  await ledger.flush().catch(() => {});
  json(res, 200, snap());
}

/* -------------------------------------------------------------------------- */
/* Tool                                                                        */
/* -------------------------------------------------------------------------- */

/** `intent_debt` — the ledger, as the agent sees it. */
function toolRegistration({ ledger, ready, settings, apiOf }) {
  return {
    name: 'intent_debt',
    description:
      'Read and settle the intent-debt ledger: promises, deferrals and unanswered questions extracted from conversations, scored by how long they have been avoided. Use `list` to see open debt, `convert` to turn one into a todo line, `close` when it is genuinely done, `mode` to switch between the free rule extractor and the model-assisted one.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'stats', 'close', 'snooze', 'remind', 'convert', 'mode'],
          description: 'list: show open debt; stats: counts by tier; close/snooze/remind/convert: act on one id; mode: read or switch the extractor.',
        },
        id: { type: 'string', description: 'Card id, as printed by `list`.' },
        hours: { type: 'number', description: 'Snooze length in hours (default 24).' },
        remindAt: { type: 'number', description: 'Epoch ms for a reminder; defaults to one hour from now.' },
        limit: { type: 'number', description: 'How many cards `list` prints (default 10).' },
        value: { type: 'string', enum: MODES, description: 'For action=mode: `rules` (free, offline) or `api` (model-assisted, budgeted).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      await ready;
      const now = Date.now();
      const action = typeof args?.action === 'string' ? args.action : 'list';
      const views = sortViews(ledger.all().map((card) => project(card, now)));
      const live = views.filter((view) => view.live);

      if (action === 'mode') {
        const next = MODES.includes(args?.value) ? args.value : '';
        if (next === '') return `当前模式：${settings.mode}。可选 rules（免费、离线）或 api（调用模型，有预算上限）。`;
        settings.mode = next;
        ledger.setMeta({ mode: next });
        await ledger.flush().catch(() => {});
        return `已切换到 ${next} 模式${next === 'api' ? '：只有规则拿不准的子句才会调用模型，按小时/按天/按 token 三重限额。' : '：不再产生任何模型调用。'}`;
      }

      if (action === 'list') {
        if (live.length === 0) return '意图债务为空：没有检测到被搁置的承诺或未闭环的问题。';
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(50, args.limit) : 10;
        return live
          .slice(0, limit)
          .map((view, index) => {
            const age = view.ageDays >= 1 ? `${view.ageDays} 天` : '今天';
            return `${index + 1}. [${view.tier} ${view.score}] ${view.kind} · ${age} · ${view.speaker === 'assistant' ? '我说过' : '你说过'}\n   「${view.quote}」\n   → 欠的是：${view.impliedPromise}\n   id=${view.id}`;
          })
          .join('\n\n');
      }

      if (action === 'stats') {
        const counts = { P0: 0, P1: 0, P2: 0 };
        for (const view of live) counts[view.tier] += 1;
        const settled = views.length - live.length;
        const base = `意图债务：${live.length} 条未结（P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}），已结清 ${settled} 条。最久的一条已经拖了 ${live.length > 0 ? Math.max(...live.map((v) => v.ageDays)) : 0} 天。`;
        const api = apiOf?.() ?? null;
        if (api === null) return `${base}\n抽取模式：${settings.mode}（模型层未加载）。`;
        const spend = api.snapshot();
        return `${base}\n抽取模式：${settings.mode} · 今日调用 ${spend.budget.callsToday}/${spend.budget.limits.perDay} 次 · 已用 ${spend.budget.tokensToday} token · 缓存命中 ${spend.cacheHits} · 跳过 ${spend.skipped}`;
      }

      const id = typeof args?.id === 'string' ? args.id : '';
      const card = ledger.get(id);
      if (card === undefined) return `没有找到 id=${id || '(空)'} 的债务。先用 action=list 看有哪些。`;

      const target = STATUS_FOR[action];
      if (target !== undefined && canTransition(card.status, target) === false) {
        return `这条现在是 ${card.status}，不能直接变成 ${target}。先用 action=list 看看它还需要处理吗。`;
      }

      if (action === 'close') {
        ledger.patch(id, { status: 'closed', settledAt: now, lastSeenAt: now, closedBy: 'agent' });
        await ledger.flush().catch(() => {});
        return `已结清：「${card.quote}」`;
      }
      if (action === 'snooze') {
        const hours = Number.isFinite(args?.hours) ? Math.min(24 * 90, Math.max(1, args.hours)) : 24;
        ledger.patch(id, { status: 'snoozed', snoozedUntil: now + hours * 3_600_000, lastSeenAt: now });
        await ledger.flush().catch(() => {});
        return `已推迟 ${hours} 小时：「${card.quote}」`;
      }
      if (action === 'remind') {
        const at = Number.isFinite(args?.remindAt) ? args.remindAt : now + 3_600_000;
        ledger.patch(id, {
          remindAt: at,
          dueHint: new Date(at).toISOString().slice(0, 16).replace('T', ' '),
          notifiedAt: undefined,
          lastSeenAt: now,
        });
        await ledger.flush().catch(() => {});
        return `提醒已设为 ${new Date(at).toLocaleString()}：「${card.quote}」`;
      }
      if (action === 'convert') {
        const line = `[意图债务] ${card.impliedPromise || card.quote}`;
        ledger.patch(id, { status: 'converted', settledAt: now, lastSeenAt: now, convertedTo: { kind: 'todo', text: line } });
        await ledger.flush().catch(() => {});
        return `已转成待办：${line}`;
      }
      return `未知操作：${action}`;
    },
  };
}
