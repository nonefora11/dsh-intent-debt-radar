/**
 * `dsh-intent-debt-radar` — the optional model layer.
 *
 * The regex extractor is free, instant, and explainable; it is also blind to
 * any phrasing nobody wrote a rule for. This module adds a second opinion from
 * the conversation's own model route, under one hard constraint: **a token
 * budget is a feature, not an accounting detail.** A radar that costs more than
 * the work it saves gets deleted, so every design decision here is about
 * spending as little as possible for the same cards.
 *
 * The thrift ladder, outermost first:
 *
 *   1. Gate. Rules already ran. Only clauses the rules cannot settle — they
 *      matched a weak cue, or sit next to a strong one — are worth a request.
 *   2. Batch. One request per turn, never one per message, and never per clause.
 *   3. Trim. Clause text, ±1 neighbour as context, clipped. No conversation
 *      transcript, no system prompt of the session, no tool history.
 *   4. Cap. `maxClausesPerCall`, `maxTokens` on the reply, a compact output
 *      grammar of one-letter kinds.
 *   5. Cache. The same clause set costs nothing the second time.
 *   6. Budget. Hour/day call and token ceilings; over budget the radar silently
 *      falls back to rules, which is the mode it ships with anyway.
 *
 * Failure is always the same failure: fall back to rules, record why, never
 * throw into the host.
 *
 * @module dsh-intent-debt-radar/lib/llm
 */

import { createHash } from 'node:crypto';

import { KINDS, clausesOf, clip } from './patterns.js';

/** User-facing extraction modes. `rules` is free; `api` adds the model layer. */
export const MODES = ['rules', 'api'];

/** When the model layer may run. `suspect` is the thrifty default. */
export const GATES = ['suspect', 'always'];

/** Version of the request/parse contract; stored with cache entries. */
export const PROMPT_VERSION = 1;

/** Kind letters the reply is allowed to use, mapped back to card kinds. */
const KIND_LETTERS = { d: 'defer', l: 'loop', c: 'decision', a: 'agent-promise' };

/**
 * The whole system prompt. It is short on purpose: this text is paid for on
 * every call, so it carries the output grammar and nothing else. Anything the
 * model could infer from the input is not written here.
 */
export const EXTRACT_POLICY = [
  '你是「意图债务」抽取器。判断每个编号子句是否留下了未兑现的语义承诺。',
  '四类债务：d=推后/以后再说 l=未闭环的问题 c=被搁置的决策 a=助手说要做却没做。',
  '只输出 JSON 数组，不要解释，不要 markdown，不要代码围栏。没有债务就输出 []。',
  '元素格式：{"i":编号,"k":"d|l|c|a","q":"子句原文片段，不改写，≤20字","p":"欠下的事，动词开头，≤24字","c":0.0-1.0}',
  '不算债务：闲聊、已经做完的事、已经写进待办的事、用户明确表示放弃的事。',
  '拿不准就不要输出，宁少不多。',
].join('\n');

/**
 * Weak cues: a clause carrying one of these *might* be a deferral, and is worth
 * asking about. Deliberately broader than the rule set — this is the funnel's
 * intake, not its judgement.
 */
const WEAK_CUES = [
  /以后|之后|回头|下次|下回|改天|改日|抽空|有空|待定|稍后|晚点|后面|再说|先[等缓搁放压记留别不]|等[一会下]|暂时|暂不|不急|不急这一会/,
  /记一下|记下来|记着|周末|过两天|这两天|这几天|往后再|再处理|再弄|再改|再聊|再补|再议/,
  /待|TODO|FIXME|后续|继续|接着|还没|没有(?:处理|确定|定|回答)|后面再/,
  /\b(?:later|afterwards|next time|revisit|hold off|for now|deferred|todo|follow[- ]?up|not yet|some other time)\b/i,
];

/** How much neighbour text rides along as context, in characters. */
const NEIGHBOUR_CHARS = 60;

/** Rough token estimate for mixed Chinese/English: ~0.7 tokens per character. */
export function estimateTokens(text) {
  const source = typeof text === 'string' ? text : '';
  if (source === '') return 0;
  return Math.ceil(source.length * 0.7);
}

/** Does this clause carry a weak cue? */
export function isSuspect(text) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return false;
  for (const cue of WEAK_CUES) if (cue.test(source)) return true;
  return false;
}

/**
 * Pick the clauses worth spending a request on.
 *
 * A clause qualifies when it carries a weak cue, or when it is the neighbour of
 * one (the subject often sits one clause away: `日志分割` / `先放着吧`). Each
 * pick keeps a small context window so the model can resolve pronouns, and the
 * whole list is capped — the cap is the single most effective cost control.
 *
 * @param {string} text - one message body.
 * @param {object} [options] - funnel shape.
 * @param {number} [options.maxClauses] - picks per message.
 * @param {number} [options.maxChars] - characters per pick.
 * @returns {Array<{text: string, context: string}>} suspect clauses.
 */
export function suspectClauses(text, { maxClauses = 4, maxChars = 120 } = {}) {
  const source = typeof text === 'string' ? text : '';
  if (source.trim() === '') return [];
  const clauses = clausesOf(source);
  const marked = clauses.map((clause) => isSuspect(clause.text));
  if (!marked.some(Boolean)) return [];
  const picks = [];
  const seen = new Set();
  for (let index = 0; index < clauses.length; index += 1) {
    if (!marked[index]) continue;
    const clause = clauses[index];
    const key = clause.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const before = clauses[index - 1]?.text ?? '';
    const after = clauses[index + 1]?.text ?? '';
    const context = [clip(before, NEIGHBOUR_CHARS), '⟪此处⟫', clip(after, NEIGHBOUR_CHARS)]
      .filter((part) => part !== '')
      .join(' ');
    picks.push({ text: clip(clause.text, maxChars), context });
    if (picks.length >= maxClauses) break;
  }
  return picks;
}

/**
 * Collect the suspect clauses of a whole turn.
 *
 * User text comes first: a debt is usually owed by the person who said "later",
 * and if the budget only allows one pick that should be the one.
 *
 * @param {Array<{text: string, speaker: string}>} batch - this turn's messages.
 * @param {object} [options] - funnel shape.
 * @returns {Array<{text: string, context: string, speaker: string}>} picks.
 */
export function collectSuspects(batch, { maxClauses = 6 } = {}) {
  const ordered = Array.isArray(batch) ? [...batch].filter((item) => item && typeof item.text === 'string') : [];
  ordered.sort((a, b) => (a.speaker === b.speaker ? 0 : a.speaker === 'user' ? -1 : 1));
  const picks = [];
  const seen = new Set();
  for (const item of ordered) {
    for (const pick of suspectClauses(item.text, { maxClauses: 4 })) {
      const key = pick.text.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ ...pick, speaker: item.speaker === 'assistant' ? 'assistant' : 'user' });
      if (picks.length >= maxClauses) return picks;
    }
  }
  return picks;
}

/** The numbered user turn sent to the model. Context rides in parentheses. */
export function promptBody(picks) {
  const lines = [];
  let index = 0;
  for (const pick of picks) {
    index += 1;
    const context = pick.context ? `（上下文：${pick.context}）` : '';
    lines.push(`${index}. ${pick.text}${context}`);
  }
  return lines.join('\n');
}

/** Stable cache key: same clauses on the same model cost nothing the second time. */
export function cacheKeyOf(picks, route) {
  const material = `${PROMPT_VERSION}|${route.provider}|${route.model}|${picks.map((pick) => pick.text).join('\u0001')}`;
  return createHash('sha1').update(material).digest('hex');
}

/**
 * Parse the model's reply into candidates.
 *
 * Tolerant by design — a fenced block, a stray sentence, a full-width quote —
 * but never creative: a candidate whose index is outside the sent list is
 * dropped, and `q` always resolves to a substring of the clause the model was
 * shown. A card the user cannot trace back to their own words is worse than no
 * card.
 *
 * @param {string} raw - assembled reply text.
 * @param {Array<{text: string, context?: string, speaker?: string}>} picks - what was sent.
 * @returns {Array<object>} candidates ready for `Radar.ingest`.
 */
export function parseExtraction(raw, picks) {
  const text = typeof raw === 'string' ? raw : '';
  const open = text.indexOf('[');
  const close = text.lastIndexOf(']');
  if (open < 0 || close <= open) return [];
  let parsed;
  try {
    parsed = JSON.parse(text.slice(open, close + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const position = Number(entry.i);
    if (!Number.isSafeInteger(position) || position < 1 || position > picks.length) continue;
    const pick = picks[position - 1];
    const letter = typeof entry.k === 'string' ? entry.k.trim().toLowerCase() : '';
    const kind = KIND_LETTERS[letter] ?? (KINDS.includes(letter) ? letter : '');
    if (kind === '') continue;
    const quote = clip(stripQuotes(entry.q) || pick.text, 200);
    const impliedPromise = clip(stripQuotes(entry.p), 160) || quote;
    const confidence = clamp(Number(entry.c), 0.4, 0.95);
    const identity = `${kind}|${quote}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    out.push({
      kind,
      label: `api.${kind}`,
      quote,
      impliedPromise,
      confidence,
      speaker: kind === 'agent-promise' ? 'assistant' : (pick.speaker ?? 'user'),
      source: 'api',
    });
  }
  return out;
}

/** Strip wrapping quotes the model likes to add, ASCII or full width. */
function stripQuotes(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^["'“”「『`]+/, '').replace(/["'“”」』`]+$/, '').trim();
}

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * Call ceilings. Three limits, because each one catches a different accident:
 * a burst during one long turn, an expensive day, and a misconfigured model.
 */
export class Budget {
  /**
   * @param {object} [limits] - ceilings.
   * @param {number} [limits.perHour] - calls allowed in any rolling hour.
   * @param {number} [limits.perDay] - calls allowed per calendar day.
   * @param {number} [limits.tokensPerDay] - prompt+completion tokens per day.
   * @param {() => number} [limits.now] - clock.
   */
  constructor({ perHour = 6, perDay = 60, tokensPerDay = 40_000, now = () => Date.now() } = {}) {
    this.perHour = Math.max(0, Math.floor(perHour));
    this.perDay = Math.max(0, Math.floor(perDay));
    this.tokensPerDay = Math.max(0, Math.floor(tokensPerDay));
    this.now = now;
    this.stamps = [];
    this.dayKey = '';
    this.dayCalls = 0;
    this.dayTokens = 0;
  }

  #roll() {
    const now = this.now();
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayCalls = 0;
      this.dayTokens = 0;
    }
    const horizon = now - 3_600_000;
    this.stamps = this.stamps.filter((stamp) => stamp > horizon);
  }

  /**
   * Ask before spending.
   * @param {number} estimate - projected prompt+completion tokens.
   * @returns {{ok: boolean, reason?: string}} whether the call may proceed.
   */
  can(estimate = 0) {
    this.#roll();
    if (this.perHour > 0 && this.stamps.length >= this.perHour) return { ok: false, reason: 'hour' };
    if (this.perDay > 0 && this.dayCalls >= this.perDay) return { ok: false, reason: 'day' };
    if (this.tokensPerDay > 0 && this.dayTokens + estimate > this.tokensPerDay) return { ok: false, reason: 'tokens' };
    return { ok: true };
  }

  /** Record one call and its measured (or estimated) cost. */
  spend(tokens = 0) {
    this.#roll();
    this.stamps.push(this.now());
    this.dayCalls += 1;
    this.dayTokens += Math.max(0, Math.round(tokens));
  }

  /** Read-only view for the panel. */
  snapshot() {
    this.#roll();
    return {
      callsLastHour: this.stamps.length,
      callsToday: this.dayCalls,
      tokensToday: this.dayTokens,
      limits: { perHour: this.perHour, perDay: this.perDay, tokensPerDay: this.tokensPerDay },
    };
  }
}

/** Small LRU for parsed results; a repeat costs nothing. */
export class ExtractionCache {
  constructor(limit = 256) {
    this.limit = Math.max(1, Math.floor(limit));
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }

  get size() {
    return this.map.size;
  }
}

/**
 * Resolve the model route for a session.
 *
 * An explicit `llmProvider`/`llmModel` in the plugin config wins, because a
 * user may want a cheap model for bookkeeping. Otherwise the session's own
 * request header is reused — that is the only route guaranteed to exist, and it
 * costs the user nothing extra to configure.
 *
 * @param {object} session - the live session.
 * @param {object} settings - plugin settings.
 * @returns {{provider: string, model: string}} the route, possibly empty.
 */
export function routeOf(session, settings = {}) {
  const configured = {
    provider: typeof settings.llmProvider === 'string' ? settings.llmProvider.trim() : '',
    model: typeof settings.llmModel === 'string' ? settings.llmModel.trim() : '',
  };
  if (configured.provider !== '' && configured.model !== '') return configured;
  let header;
  try {
    header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
  } catch {
    header = undefined;
  }
  const config = header?.config ?? null;
  return {
    provider: typeof config?.provider === 'string' ? config.provider : '',
    model: typeof config?.model === 'string' ? config.model : '',
  };
}

/**
 * The model layer itself.
 *
 * One instance per host process. `run()` is fire-and-forget from the host's
 * point of view: it swallows every failure into `stats` so a flaky provider can
 * never cost the user a conversation turn.
 */
export class ApiExtractor {
  /**
   * @param {object} options - wiring.
   * @param {object} options.llm - the `llm` service (`stream()`).
   * @param {import('./extract.js').Radar} options.radar - used to ingest cards.
   * @param {object} options.settings - resolved plugin settings.
   * @param {Budget} options.budget - call ceilings.
   * @param {ExtractionCache} options.cache - result cache.
   * @param {() => number} [options.now] - clock.
   */
  constructor({ llm, radar, settings, budget, cache, now = () => Date.now() }) {
    this.llm = llm;
    this.radar = radar;
    this.settings = settings;
    this.budget = budget;
    this.cache = cache;
    this.now = now;
    this.stats = {
      mode: settings.mode === 'api' ? 'api' : 'rules',
      calls: 0,
      skipped: 0,
      lastSkip: null,
      cacheHits: 0,
      failures: 0,
      promptTokens: 0,
      completionTokens: 0,
      clausesSent: 0,
      cardsFromApi: 0,
      lastCallAt: 0,
      lastError: null,
    };
  }

  /** Whether the model layer is on at all. */
  get enabled() {
    return this.settings.mode === 'api';
  }

  /** Snapshot for the panel: extraction mode plus the spend ledger. */
  snapshot() {
    return { ...this.stats, budget: this.budget.snapshot(), cacheSize: this.cache.size };
  }

  /**
   * Extract debts for one finished turn.
   * @param {object} input - turn payload.
   * @param {object} input.session - the session (for the model route).
   * @param {Array<{text: string, speaker: string}>} input.batch - this turn's message bodies.
   * @param {object} input.context - card context (`sessionId`, `workspace`, ...).
   * @returns {Promise<number>} how many cards the model layer produced.
   */
  async run({ session, batch, context }) {
    if (!this.enabled) return 0;
    try {
      return await this.#run({ session, batch, context });
    } catch (error) {
      this.stats.failures += 1;
      this.stats.lastError = error instanceof Error ? error.message : String(error);
      return 0;
    }
  }

  async #run({ session, batch, context }) {
    const picks = collectSuspects(batch, { maxClauses: this.settings.maxClausesPerCall });
    if (picks.length === 0) {
      this.stats.skipped += 1;
      this.stats.lastSkip = 'no-suspect';
      return 0;
    }
    if (this.llm === undefined || this.llm === null || typeof this.llm.stream !== 'function') {
      this.stats.skipped += 1;
      this.stats.lastSkip = 'no-llm-service';
      return 0;
    }
    const route = routeOf(session, this.settings);
    if (route.provider === '' || route.model === '') {
      this.stats.skipped += 1;
      this.stats.lastSkip = 'no-route';
      return 0;
    }

    const key = cacheKeyOf(picks, route);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cacheHits += 1;
      return this.#ingest(cached, context);
    }

    const body = promptBody(picks);
    const estimate = estimateTokens(EXTRACT_POLICY) + estimateTokens(body) + 320;
    const allowed = this.budget.can(estimate);
    if (!allowed.ok) {
      this.stats.skipped += 1;
      this.stats.lastSkip = `budget-${allowed.reason}`;
      return 0;
    }

    const request = {
      provider: route.provider,
      model: route.model,
      system: EXTRACT_POLICY,
      messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
      temperature: 0,
      maxTokens: 320,
    };

    this.stats.calls += 1;
    this.stats.clausesSent += picks.length;
    this.stats.lastCallAt = this.now();
    const raw = await this.#collect(this.llm.stream(request));
    const promptTokens = estimateTokens(EXTRACT_POLICY) + estimateTokens(body);
    const completionTokens = estimateTokens(raw);
    this.stats.promptTokens += promptTokens;
    this.stats.completionTokens += completionTokens;
    this.budget.spend(promptTokens + completionTokens);

    const candidates = parseExtraction(raw, picks);
    this.cache.set(key, candidates);
    return this.#ingest(candidates, context);
  }

  /** Drain a chunk stream into its final text block. */
  async #collect(stream) {
    const chunks = [];
    let reason = null;
    for await (const chunk of stream) {
      if (chunk?.type === 'finish') reason = chunk.reason?.kind ?? 'unknown';
      chunks.push(chunk);
    }
    if (reason === null) throw new Error('intent-debt: model stream ended without a finish chunk');
    if (reason !== 'stop') throw new Error(`intent-debt: model stream ended with ${reason}`);

    // The assembler is a host dependency. Prefer it — it understands every
    // chunk shape the runtime emits — and fall back to plain text concatenation
    // so this module stays importable and testable in a bare checkout. The
    // fallback must look at `text-delta` only: `reasoning-delta` carries a
    // `text` field too, and reasoning must never reach the JSON parser.
    let Assembler = null;
    try {
      ({ BlockAssembler: Assembler } = await import('@deepseek-ai/dsh-llm'));
    } catch {
      Assembler = null;
    }
    if (typeof Assembler === 'function') {
      const assembler = new Assembler();
      for (const chunk of chunks) assembler.push(chunk);
      return assembler
        .blocks()
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
    }
    return chunks
      .filter((chunk) => chunk?.type === 'text-delta' && typeof chunk.text === 'string')
      .map((chunk) => chunk.text)
      .join('');
  }

  #ingest(candidates, context) {
    if (!Array.isArray(candidates) || candidates.length === 0) return 0;
    const before = this.radar.created;
    this.radar.ingest(candidates, context);
    const created = this.radar.created - before;
    this.stats.cardsFromApi += created;
    return created;
  }
}
