/**
 * `dsh-intent-debt-radar` — the trigger lexicon.
 *
 * The cheap layer of the pipeline: pure functions over one message's text. No
 * service, no I/O, no model call, so it can run on every `session/event` and
 * throw ~95% of them away before anything expensive happens.
 *
 * Vocabulary is bilingual because DSH conversations mix both freely. Every
 * pattern carries a `label` so a card can say *which* tell fired, and so the
 * precision harness can report per-pattern misses.
 *
 * Design rule that drives the whole file: a pattern only earns its place if it
 * fires on real deferral language and stays quiet on ordinary prose. Anything
 * ambiguous enough to need semantics belongs in the (later) model layer, not
 * here.
 *
 * @module dsh-intent-debt-radar/lib/patterns
 */

/**
 * Four debt kinds. The letter prefixes are stable identifiers used in stored
 * records, so renaming one is a schema migration.
 *
 *  D1 defer    — the user explicitly pushed something into the future.
 *  D2 loop     — a question or request the conversation never came back to.
 *  D3 decision — an open choice nobody closed.
 *  D4 promise  — the assistant said it would do something and did not.
 */
export const KINDS = ['defer', 'loop', 'decision', 'agent-promise'];

/**
 * Explicit shelving. Chinese first: these are the phrases that make the plugin
 * worth writing, and they are overwhelmingly literal.
 */
const DEFER_PATTERNS = [
  // 以后再说 / 回头再聊 / 下次补 …
  {
    label: 'defer.topic',
    re: /(?:以后|下次|改天|回头|之后|后面|往后|日后|晚点|待会|待会儿|等会|稍后|一会儿|明日|明天|下周|下回)(?:再|有空再|找时间再)(?:说|聊|看|谈|讲|处理|补|补上|补一下|做|搞|弄|提|讨论|商量|确认|对接|安排)/,
  },
  // 先这样 / 先放着 / 暂缓 / 先不管它 / 先等会儿
  {
    label: 'defer.shelve',
    re: /(?:先这样|先这么着|先放着|先搁着|先搁一搁|暂缓|暂时先不|先不管|先不做|先不动|先跳过|先掠过|暂时搁置|搁置一下|先(?:等|缓|搁|放|压|记|留|不|别|跳|略|这样|这么))/,
  },
  // 等忙完 / 等 X 再说 / 等会儿再说
  {
    label: 'defer.wait',
    re: /(?:等(?:我)?[^。！？!?\n]{0,8}再说|等(?:一?会(?:儿)?|下)(?:再|吧)|(?:以后|回头|改天)?有空(?:再|的时候)|等忙完|等有时间|等这阵子|等过了)/,
  },
  // 过两天 / 这两天再说 / 有空弄 —— a vaguer push, but still a push.
  {
    label: 'defer.push',
    re: /(?:过两?天|过几?天|过阵子|过段时间|这两天|这几天|这阵子|抽空|改天|回头)(?:再|的)?(?:说|聊|看|弄|做|处理|补|谈|搞)/,
  },
  // English
  {
    label: 'defer.en',
    re: /\b(?:later|next time|some other time|another time|not now|for now|not right now|we'?ll see|come back to (?:it|that|this)|revisit (?:it|that|this)|down the (?:road|line)|at some point|hold off on)\b/i,
  },
];

/** Open decisions: a fork that nobody resolved. */
const DECISION_PATTERNS = [
  {
    label: 'decision.choose',
    re: /(?:还是说|还是用|选哪个|选哪个好|用哪个|哪个更|你决定|你来定|你定吧|看你的|你看着办|都行|都可以|随便你|二选一|两套方案|两个方案|怎么定)/,
  },
  {
    label: 'decision.en',
    re: /\b(?:you decide|your call|up to you|either (?:one )?works|both work|which one|tbd|to be decided)\b/i,
  },
];

/**
 * Assistant-side promises. This is the product's edge: the user is not the one
 * who forgets here — the model is. Restricted to first-person/next-step
 * phrasings so ordinary narration ("先做 A 再做 B") does not fire.
 */
const PROMISE_PATTERNS = [
  // 稍后帮 / 这就给你改 / 待会儿补上
  {
    label: 'promise.soon',
    re: /(?:稍后|稍等片刻|等一下|等下|待会儿|待会|一会儿|马上|这就|立刻|我这就)[^。！？!?\n]{0,12}(?:帮|给|改|写|加|修|补|做|处理|生成|整理|跑|建|更新|替换|接上|补上)/,
  },
  // 下轮 / 下一步我来 / 接下来我会
  {
    label: 'promise.next',
    re: /(?:下一步|接下来|下一轮|下轮|下个回合|这轮之后|本轮之后)[^。！？!?\n]{0,14}(?:我|会|将|就|再)/,
  },
  // 后面我 / 之后我再
  {
    label: 'promise.followup',
    re: /(?:后面我|之后我|稍后我|待会我|等一下我|回头我|下轮我)[^。！？!?\n]{0,14}/,
  },
  // English
  {
    label: 'promise.en',
    re: /\b(?:i'?ll|i will|let me|we'?ll)\b[^.!?\n]{0,24}\b(?:later|next|afterwards|after that|in the next step|follow up|come back|do that|handle that|fix that|add that|get to that)\b/i,
  },
];

/** Phrases that mean *closure*, not debt. They retire cards instead of making them. */
const CLOSURE_PATTERNS = [
  {
    label: 'closure.done',
    re: /(?:搞定|已完成|完成了|做完了|改好了|修好了|解决了|弄好了|好了[，,。!！]|已经(?:改|修|做|加|补)|不用做了|不需要了|不用了|算了|取消|作废|作罢|不提了|跳过|忽略这条)/,
  },
  {
    label: 'closure.en',
    re: /\b(?:done|fixed|finished|already (?:done|fixed|handled)|never ?mind|forget (?:it|that)|scratch that|cancel(?:led)?|nvm)\b/i,
  },
];

export const DEFER = DEFER_PATTERNS;
export const DECISION = DECISION_PATTERNS;
export const PROMISE = PROMISE_PATTERNS;
export const CLOSURE = CLOSURE_PATTERNS;

/** Split text into sentence-ish clauses, keeping offsets into the original. */
export function clausesOf(text) {
  const source = typeof text === 'string' ? text : '';
  const out = [];
  const push = (from, to) => {
    const raw = source.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const start = from + lead;
    out.push({ text: trimmed, start, end: start + trimmed.length });
  };
  // Commas count as clause boundaries: `这个先放着，我现在有事` must yield the
  // deferral clause alone, not a quote with the excuse glued on.
  const delimiter = /[。！？!?；;\n，,]/g;
  let cursor = 0;
  let hit;
  while ((hit = delimiter.exec(source)) !== null) {
    push(cursor, hit.index);
    cursor = hit.index + 1;
  }
  push(cursor, source.length);
  return out;
}

/**
 * First match of `patterns` inside `text`, as
 * `{ label, index, length }` — `index` is into `text`, not the clause.
 * @param {string} text - clause text.
 * @param {ReadonlyArray<{label: string, re: RegExp}>} patterns - ordered patterns.
 * @returns {{label: string, index: number, length: number} | undefined} the match.
 */
function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.replace('g', ''));
    const found = re.exec(text);
    if (found !== null && found[0].length > 0) {
      return { label: pattern.label, index: found.index, length: found[0].length };
    }
  }
  return undefined;
}

/**
 * All clause-level hits for one `speaker`, with the quote each card will carry.
 *
 * The quote is always the **original clause**, never a rewrite. That single
 * rule is what keeps the panel trustworthy: a card can be argued with.
 *
 * @param {string} text - message text.
 * @param {'user' | 'assistant'} speaker - who said it.
 * @returns {Array<{kind: string, label: string, quote: string, impliedPromise: string, offset: number, confidence: number}>} candidates.
 */
export function scanText(text, speaker) {
  const found = [];
  if (typeof text !== 'string' || text.trim() === '') return found;
  for (const clause of clausesOf(text)) {
    const body = clause.text;
    if (speaker === 'user') {
      const defer = firstMatch(body, DEFER_PATTERNS);
      if (defer !== undefined) {
        found.push(candidate('defer', defer, clause, body, 0.9));
        continue;
      }
      const decision = firstMatch(body, DECISION_PATTERNS);
      if (decision !== undefined) found.push(candidate('decision', decision, clause, body, 0.6));
      continue;
    }
    if (speaker === 'assistant') {
      const promise = firstMatch(body, PROMISE_PATTERNS);
      if (promise !== undefined) found.push(candidate('agent-promise', promise, clause, body, 0.7));
    }
  }
  return dedupeByKind(found);
}

/**
 * One intent, one card. `这个先放着，回头再说` is two clauses carrying two tells
 * for the *same* shelved thing; without this the panel would show it twice and
 * the second copy would outlive the first. The richest quote wins.
 * @param {Array<object>} found - raw candidates in clause order.
 * @returns {Array<object>} best candidate per kind.
 */
function dedupeByKind(found) {
  const best = new Map();
  for (const item of found) {
    const current = best.get(item.kind);
    if (current === undefined) {
      best.set(item.kind, item);
      continue;
    }
    const richer = item.quote.length > current.quote.length;
    const generic = current.impliedPromise === '这件事' || current.impliedPromise === '这个选择';
    if (richer || (item.quote.length === current.quote.length && generic)) best.set(item.kind, item);
  }
  return [...best.values()].sort((a, b) => a.offset - b.offset);
}

/**
 * Does this text read as *closing* something rather than opening it?
 * @param {string} text - message text.
 * @returns {boolean} true when a closure tell appears.
 */
export function isClosure(text) {
  return typeof text === 'string' && CLOSURE_PATTERNS.some((p) => p.re.test(text));
}

/**
 * Remove every closure tell from a text, so what remains is the *subject* of the
 * sentence rather than the act of closing it. `日志分割搞定了` should be compared
 * as `日志分割`, otherwise the phrase "搞定了" dilutes the overlap that decides
 * which card just got settled.
 * @param {string} text - message text.
 * @returns {string} text with closure phrases blanked out.
 */
export function withoutClosure(text) {
  let out = typeof text === 'string' ? text : '';
  for (const pattern of CLOSURE_PATTERNS) {
    out = out.replace(new RegExp(pattern.re.source, pattern.re.flags.replace('g', '') + 'g'), ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Build one candidate record from a pattern hit. */
function candidate(kind, hit, clause, body, confidence) {
  return {
    kind,
    label: hit.label,
    quote: clip(clause.text, 160),
    impliedPromise: clip(subjectOf(body, hit, kind), 120),
    offset: clause.start,
    confidence,
  };
}

/**
 * The *subject* of a deferral: the clause minus the deferral tell, minus the
 * modal/particle debris around it. `这个日志先等会做吧` should become `这个日志`,
 * not `这个日志 会做吧` — the card is read at a glance, and the verb the user
 * avoided is exactly the part that carries no information.
 */
/**
 * A subject made only of demonstratives and filler: it names nothing.
 * `这个`, `那个东西`, `它`, `这件事` all pass a length check and all fail the only
 * check that matters — could the user tell what they owe from it?
 */
export const STUB_SUBJECT = /^[\s这那它他们个东西样事情件点些一了的吧呢啊嘛哈呀哦呗]+$/u;

function subjectOf(body, hit, kind) {
  const rest = `${body.slice(0, hit.index)} ${body.slice(hit.index + hit.length)}`;
  let out = rest.replace(/\s+/g, ' ');
  // Peel trailing filler in passes: particles, then the generic verb the
  // deferral was attached to, then the particle the verb dragged in.
  const tail = /(?:[\s，,、:：]|吧|呢|啊|嘛|哈|呀|哦|呗|了|的|着|过|它|它们|这件事|事情|一下|一点|一会儿|会|要|得|先|再|就|把|给|弄|做|搞|处理|看|说|补|改|写|聊|谈|讨论|商量|确认|对接|安排|整理|管|缓|等|跳|过)+$/;
  for (let i = 0; i < 6; i += 1) {
    const next = out.replace(tail, '').trim();
    if (next === out) break;
    out = next;
  }
  out = out.replace(/^[\s，,、:：\-—]+|[\s，,、。.!！?？~]+$/g, '').trim();
  // 「这个东西」 carries a demonstrative and no content. It is long enough to
  // pass a length test, so the test has to be about substance, not size.
  if (STUB_SUBJECT.test(out)) {
    // The clause minus its trailing particles keeps the verb, which is the part
    // worth reading back to the user.
    const clause = body.replace(/[\s，,、。.!！?？~吧呢啊嘛哈呀哦呗了]{1,4}$/u, '').trim();
    if (Array.from(clause).length >= 2) return clause;
    return kind === 'decision' ? '这个选择' : '这件事';
  }
  return out;
}

/** Truncate with an ellipsis, by code point, never mid-surrogate. */
export function clip(text, limit) {
  const source = wellFormed(typeof text === 'string' ? text : String(text ?? ''));
  const points = Array.from(source);
  return points.length <= limit ? source : `${points.slice(0, limit).join('')}…`;
}

/**
 * Repair unpaired surrogates.
 *
 * A truncated UTF-8 boundary somewhere upstream can leave half a code point in
 * a string. Those halves survive `JSON.stringify` as escape sequences and turn
 * into a black diamond in the panel, so they are repaired once, on the way in,
 * rather than displayed forever.
 *
 * @param {string} text - any string, possibly carrying lone surrogates.
 * @returns {string} the same text, well formed.
 */
export function wellFormed(text) {
  if (typeof text !== 'string') return '';
  if (text === '') return '';
  if (typeof text.toWellFormed === 'function') return text.toWellFormed();
  const replacement = String.fromCharCode(0xfffd);
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[index] + text[index + 1];
        index += 1;
        continue;
      }
      out += replacement;
      continue;
    }
    out += code >= 0xdc00 && code <= 0xdfff ? replacement : text[index];
  }
  return out;
}

/**
 * Character-shingle set of a text, used for cheap fuzzy overlap. Three is the
 * smallest window that survives word-order noise in Chinese without matching
 * everything.
 * @param {string} text - any text.
 * @returns {Set<string>} shingles.
 */
export function shingles(text) {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const points = Array.from(clean);
  const out = new Set();
  if (points.length <= 3) {
    if (points.length > 0) out.add(points.join(''));
    return out;
  }
  for (let i = 0; i + 3 <= points.length; i += 1) out.add(points.slice(i, i + 3).join(''));
  return out;
}

/**
 * Jaccard similarity of two shingle sets, 0…1.
 * @param {Set<string>} a - first set.
 * @param {Set<string>} b - second set.
 * @returns {number} overlap.
 */
export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

