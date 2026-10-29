/**
 * `dsh-intent-debt-radar` — turning one conversation's event stream into debts.
 *
 * The radar is a state machine per session, fed by `session/event`. It is
 * deliberately dumb: regex hits become cards, structural signals (did this turn
 * call a tool? did it write a todo?) retire them, and overlap arithmetic decides
 * whether the user's next sentence answered the previous question.
 *
 * Every semantic decision that would need a model is deferred to the optional
 * model layer. What lives here must be explainable in one sentence to a user
 * staring at a red card.
 *
 * @module dsh-intent-debt-radar/lib/extract
 */

import { KINDS, clip, isClosure, jaccard, scanText, shingles, withoutClosure } from './patterns.js';
import { idOf } from './store.js';

/** Text of one message, joining its text blocks. */
/**
 * The part of an assistant message that actually asks something.
 *
 * Comparing a whole reply against a whole answer drowns the question in prose:
 * every extra clause lowers the overlap, so a *correct* answer scored ~0.05 and
 * a false "you never answered me" card appeared. Only the interrogative clauses
 * are compared.
 * @param {string} text - an assistant message.
 * @returns {string} the questions it asked, joined.
 */
const SENTENCE_BREAK = /[\u3002\uff01\uff1b;\u000a]+/;

function questionCore(text) {
  const parts = String(text)
    .split(SENTENCE_BREAK)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const asking = parts.filter((part) => /[？?]|吗|呢|要不要|是否|怎么办|怎么做|如何|哪个|为什么|行不行|好不好/.test(part));
  const chosen = asking.length > 0 ? asking : parts.slice(-1);
  return chosen.join(' ').replace(/[？?]/g, ' ');
}

export function textOf(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Does this assistant message already carry a tool call? */
export function hasToolCallBlock(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return false;
  return message.content.some((block) => block !== null && typeof block === 'object' && block.type === 'tool-call');
}

/** Identity string for one debt: kind + normalized quote. */
export function identityOf(kind, quote) {
  const normalized = String(quote ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 60);
  return `${kind}|${normalized}`;
}

/** Shared shingles over the smaller set — containment, not Jaccard. */
function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * One session's observation state. Cheap: a handful of scalars plus the last
 * assistant message, dropped when the session goes away.
 */
class SessionState {
  constructor() {
    this.toolCalls = 0;
    this.todoWrites = 0;
    this.lastAssistant = null;
    this.pendingQuestion = null;
    this.lastSeenAt = 0;
  }
}

/**
 * The radar: one instance per plugin, one entry in {@link sessions} per live
 * session.
 */
export class Radar {
  /**
   * @param {object} options - wiring.
   * @param {import('./store.js').Ledger} options.ledger - the ledger to write into.
   * @param {() => number} [options.now] - clock (tests inject one).
   * @param {object} [options.settings] - resolved plugin settings.
   */
  constructor({ ledger, now = () => Date.now(), settings = {} }) {
    this.ledger = ledger;
    this.now = now;
    this.settings = {
      minConfidence: typeof settings.minConfidence === 'number' ? settings.minConfidence : 0.5,
      trackAssistantPromises: settings.trackAssistantPromises !== false,
      maxCardsPerSession: Number.isSafeInteger(settings.maxCardsPerSession) ? settings.maxCardsPerSession : 80,
      retentionDays: Number.isSafeInteger(settings.retentionDays) ? settings.retentionDays : 120,
    };
    this.sessions = new Map();
    this.created = 0;
    /**
     * In-memory counters for the panel footer. They answer the only question a
     * silent plugin can raise — "are you even awake?" — without a disk write per
     * message. `messages === 0` while the user is typing means the wiring is
     * wrong, not the patterns.
     */
    this.stats = { messages: 0, hits: 0, cards: 0, lastEventType: null, lastAt: 0, lastError: null };
  }

  /** State for one session id. */
  stateOf(sessionId) {
    let state = this.sessions.get(sessionId);
    if (state === undefined) {
      state = new SessionState();
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Forget a session (it was deleted, or the radar is being torn down). */
  forget(sessionId) {
    this.sessions.delete(sessionId);
  }

  /**
   * Feed one event. Never throws: a radar that can break a conversation is
   * worse than a radar that misses a debt.
   * @param {object} session - the session the event belongs to.
   * @param {object} event - one `session/event` payload.
   */
  observe(session, event) {
    try {
      const type = typeof event?.type === 'string' ? event.type : null;
      if (type !== null) {
        this.stats.lastEventType = type;
        this.stats.lastAt = this.now();
      }
      this.#observe(session, event);
    } catch (error) {
      // Diagnostics only; see the module header on why this is swallowed.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.stats.lastError = this.lastError;
    }
  }

  #observe(session, event) {
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    if (sessionId === '' || event === null || typeof event !== 'object') return;
    const type = String(event.type ?? '');
    const state = this.stateOf(sessionId);
    const now = this.now();
    state.lastSeenAt = now;
    const context = this.#contextOf(session, event, now);

    switch (type) {
      case 'turn/start': {
        state.toolCalls = 0;
        state.todoWrites = 0;
        return;
      }
      case 'tool/call': {
        state.toolCalls += 1;
        return;
      }
      case 'todo/write': {
        state.todoWrites += 1;
        this.#settleFromTodos(event?.data?.todos, sessionId, context);
        return;
      }
      case 'user/message': {
        this.#onUserMessage(event, state, sessionId, context);
        return;
      }
      case 'assistant/message': {
        this.#onAssistantMessage(event, state, sessionId, context);
        return;
      }
      case 'turn/end': {
        this.#onTurnEnd(state);
        return;
      }
      default:
        return;
    }
  }

  /** Identity of the conversation slot a card belongs to. */
  #contextOf(session, event, now) {
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : '';
    return {
      sessionId: typeof session?.id === 'string' ? session.id : '',
      workspace: cwd,
      workspaceId: cwd === '' ? 'unknown' : idOf(cwd),
      seq: Number.isFinite(event?.seq) ? event.seq : 0,
      time: Number.isFinite(event?.time) ? event.time : now,
      turn: Number.isFinite(event?.data?.turn) ? event.data.turn : 0,
    };
  }

  #onUserMessage(event, state, sessionId, context) {
    const message = event?.data;
    // Runtime context is injected by the harness, not typed by anyone: it is a
    // wall of environment prose that no user ever promised anything in, and it
    // would be the single biggest thing we could ever pay to send to a model.
    if (message?.source?.kind === 'runtime-context') return;
    const text = textOf(message);
    if (text.trim() === '') return;

    // Closure first: "算了 / 不用了 / 搞定了" retires cards instead of creating one.
    if (isClosure(text)) this.#settleFromProse(text, sessionId, context.workspaceId);

    // Did this sentence answer the question the last turn left hanging?
    const question = state.pendingQuestion;
    if (question !== null) {
      // Answered if the reply covers the question's own words, not if it merely
      // shares vocabulary with the paragraph around them.
      const asked = shingles(question.core ?? question.text);
      const reply = shingles(text);
      let shared = 0;
      for (const token of asked) if (reply.has(token)) shared += 1;
      // Two shared shingles is the honest bar: a correct short answer to a long
      // question shares that much, and unrelated prose shares none.
      const answered = asked.size > 0 ? shared >= 2 || containment(asked, reply) >= 0.34 : jaccard(question.shingles, reply) >= 0.18;
      state.pendingQuestion = null;
      if (!answered && question.text.trim() !== '') {
        this.#upsert({
          kind: 'loop',
          label: 'loop.unanswered',
          quote: question.text,
          impliedPromise: question.text,
          confidence: 0.55,
          context: { ...question.context, seq: question.seq ?? context.seq, time: question.time ?? context.time },
          why: '上一轮的问题没有得到回应',
        });
      }
    }

    this.#absorb(text, 'user', context);
  }

  #onAssistantMessage(event, state, sessionId, context) {
    const message = event?.data?.message;
    const text = textOf(message);
    if (text.trim() === '') return;
    state.lastAssistant = {
      text,
      context,
      seq: context.seq,
      time: context.time,
      turn: context.turn,
      hasToolCall: hasToolCallBlock(message),
      promises: this.settings.trackAssistantPromises ? scanText(text, 'assistant') : [],
      asksQuestion: /[?？]\s*$/.test(text.trim()),
    };
    // A promise is only a debt if the same turn did not act on it. That decision
    // needs the whole turn, so it waits for turn/end.
  }

  #onTurnEnd(state) {
    const last = state.lastAssistant;
    state.lastAssistant = null;
    if (last === null) return;
    const acted = last.hasToolCall || state.toolCalls > 0 || state.todoWrites > 0;
    if (last.promises.length > 0 && !acted) {
      state.pendingPromises = last.promises;
      state.pendingPromiseContext = last.context;
    }
    // An unanswered question is debt only once the user moves on; remember it.
    if (last.asksQuestion && !acted) {
      state.pendingQuestion = {
        text: last.text,
        core: questionCore(last.text),
        shingles: shingles(last.text),
        seq: last.seq,
        time: last.time,
        context: last.context,
      };
    } else {
      state.pendingQuestion = null;
    }
  }

  /** Turn assistant candidates into cards. Called from turn/end with the turn context. */
  #absorb(text, speaker, context) {
    this.stats.messages += 1;
    for (const candidate of scanText(text, speaker)) {
      if (candidate.confidence < this.settings.minConfidence) continue;
      this.stats.hits += 1;
      this.#upsert({ ...candidate, context, why: candidate.label });
    }
  }

  /**
   * Accept candidates from the model layer.
   *
   * Same funnel as a regex hit — confidence floor, per-session cap, dedupe by
   * identity — so the two extractors cannot fight over one debt: whichever sees
   * it first creates the card and the other just raises its `hits`.
   *
   * @param {Array<object>} candidates - parsed model output.
   * @param {object} context - card context (`sessionId`, `workspace`, ...).
   * @returns {number} cards created (not refreshed).
   */
  ingest(candidates, context) {
    const before = this.created;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const quote = typeof candidate.quote === 'string' ? candidate.quote.trim() : '';
      if (quote === '') continue;
      const kind = KINDS.includes(candidate.kind) ? candidate.kind : 'defer';
      const confidence = Number.isFinite(candidate.confidence) ? candidate.confidence : 0.6;
      if (confidence < this.settings.minConfidence) continue;
      this.stats.hits += 1;
      this.#upsert({
        ...candidate,
        kind,
        quote,
        confidence,
        context,
        why: candidate.why ?? candidate.label ?? 'model',
      });
    }
    return this.created - before;
  }

  /**
   * Insert or refresh one debt.
   * @param {object} input - candidate + context.
   */
  #upsert(input) {
    const { kind, label, quote, impliedPromise, confidence, context, why } = input;
    const identity = identityOf(kind, quote);
    const id = idOf(identity);
    const now = this.now();
    const existing = this.ledger.get(id);
    if (existing !== undefined) {
      if (existing.status === 'converted') return existing;
      const reopened = existing.status === 'closed' || existing.status === 'stale';
      return this.ledger.patch(id, {
        hits: (Number.isFinite(existing.hits) ? existing.hits : 1) + 1,
        lastSeenAt: now,
        status: existing.status === 'snoozed' ? 'snoozed' : 'open',
        ...(reopened ? { reopenedAt: now } : {}),
      });
    }
    if (this.#sessionCardCount(context.sessionId) >= this.settings.maxCardsPerSession) return undefined;
    const card = {
      id,
      identity,
      workspace: context.workspace,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      anchorSeq: context.seq,
      anchorTime: context.time > 0 ? context.time : now,
      turn: context.turn,
      quote: clip(quote, 200),
      impliedPromise: clip(impliedPromise, 160),
      speaker: kind === 'agent-promise' ? 'assistant' : 'user',
      kind,
      label,
      why: why ?? label,
      confidence,
      hits: 1,
      status: 'open',
      createdAt: now,
      lastSeenAt: now,
      scorerVersion: 1,
    };
    this.created += 1;
    return this.ledger.put(card);
  }

  #sessionCardCount(sessionId) {
    let count = 0;
    for (const card of this.ledger.all()) {
      if (card.sessionId !== sessionId) continue;
      // Settled cards do not occupy the cap: counting them meant a long session
      // silently stopped learning after 80 debts, with no symptom to notice.
      if (card.status === 'closed' || card.status === 'converted') continue;
      count += 1;
    }
    return count;
  }

  /** A todo write means the user turned a debt into real work: retire matching cards. */
  #settleFromTodos(todos, sessionId, context) {
    if (!Array.isArray(todos)) return;
    for (const todo of todos) {
      const text = typeof todo === 'string' ? todo : String(todo?.content ?? todo?.text ?? '');
      if (text.trim() === '') continue;
      this.#settle(text, sessionId, 'converted', { todoText: clip(text, 120), workspaceId: context?.workspaceId });
    }
  }

  /** Prose closure ("算了 / 搞定了") retires matching cards in this session. */
  #settleFromProse(text, sessionId, workspaceId) {
    // Compare the subject, not the closure phrase: "日志分割搞定了" is about
    // 日志分割, and the words that say it is over must not dilute the overlap.
    const subject = withoutClosure(text);
    this.#settle(subject === '' ? text : subject, sessionId, 'closed', { closedBy: 'closure-phrase', workspaceId });
  }

  /** Retire every live card whose subject the given text covers. */
  #settle(text, sessionId, status, extra) {
    const target = shingles(text);
    const workspaceId = typeof extra?.workspaceId === 'string' ? extra.workspaceId : '';
    const now = this.now();
    for (const card of this.ledger.all()) {
      // Identity is global, so a debt first seen in another session of the same
      // workspace is the same debt: its closure has to be able to retire it,
      // otherwise the card can only be closed from the session that created it.
      const sameSession = card.sessionId === sessionId;
      const sameWorkspace = workspaceId !== '' && workspaceId !== 'unknown' && card.workspaceId === workspaceId;
      if (sameSession === false && sameWorkspace === false) continue;
      if (card.status === 'closed' || card.status === 'converted' || card.status === 'stale') continue;
      const subject = shingles(`${card.impliedPromise} ${card.quote}`);
      if (containment(subject, target) < 0.5) continue;
      this.ledger.patch(card.id, {
        status,
        settledAt: now,
        lastSeenAt: now,
        ...(status === 'converted' ? { convertedTo: { kind: 'todo', id: card.id, text: extra?.todoText ?? '' } } : {}),
        ...(status === 'closed' ? { closedBy: extra?.closedBy ?? 'user' } : {}),
      });
    }
  }

  /** Fold the assistant's held-back promises into cards; called by the host at turn/end. */
  commitPending(sessionId, context) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return 0;
    const promises = state.pendingPromises;
    if (!Array.isArray(promises) || promises.length === 0) return 0;
    state.pendingPromises = null;
    const stamp = state.pendingPromiseContext;
    state.pendingPromiseContext = null;
    let written = 0;
    for (const promise of promises) {
      if (promise.confidence < this.settings.minConfidence) continue;
      this.#upsert({
        ...promise,
        context: { ...context, seq: stamp?.seq ?? context.seq, time: stamp?.time ?? context.time, turn: stamp?.turn ?? context.turn },
        why: '这一轮说了要做，但没有动',
      });
      written += 1;
    }
    return written;
  }
}
