/**
 * `dsh-intent-debt-radar` — scoring, tiers, and the card state machine.
 *
 * Deliberately arithmetic, not a model call. A score nobody can explain is a
 * score nobody can tune, and the whole product claim is "this debt is heavier
 * because it has been sitting there longer" — which has to be auditable when a
 * user asks why a card is red.
 *
 * @module dsh-intent-debt-radar/lib/score
 */

/** Bump when the formula changes; stored cards re-score, they are not re-extracted. */
export const SCORER_VERSION = 1;

/** Base weight per debt kind. An agent's broken promise outranks the user's own deferral. */
export const BASE = {
  'agent-promise': 7,
  defer: 6,
  loop: 5,
  decision: 4,
};

/** How long a card may sit before the age term stops growing. */
export const AGE_CAP_DAYS = 14;

/** Tier thresholds, inclusive lower bounds. */
export const TIERS = [
  { tier: 'P0', min: 12 },
  { tier: 'P1', min: 6 },
  { tier: 'P2', min: 0 },
];

/** Statuses that stop the clock: a settled card accrues nothing. */
const SETTLED = new Set(['closed', 'converted']);

/** Legal state transitions. Anything not listed is a bug, not an edge case. */
const TRANSITIONS = {
  open: ['closed', 'converted', 'snoozed', 'stale'],
  snoozed: ['open', 'closed', 'converted', 'stale'],
  closed: ['open'],
  converted: ['open'],
  stale: ['open', 'closed'],
};

/**
 * Score one card.
 *
 *   base + 3·min(hits, 4) + min(ageDays, 14) + (dueHint ? 3 : 0) − (snoozed ? 6 : 0)
 *
 * `hits` is how many times the same debt surfaced again: repeatedly avoiding a
 * topic is the strongest signal there is. `ageDays` is the product thesis —
 * debt accrues interest — capped so a two-year-old note cannot outrank a live
 * broken promise forever.
 *
 * @param {object} card - stored card.
 * @param {number} now - epoch ms.
 * @returns {number} score; 0 for settled cards.
 */
export function scoreOf(card, now) {
  if (card === null || typeof card !== 'object') return 0;
  if (SETTLED.has(card.status)) return 0;
  const base = BASE[card.kind] ?? 3;
  const hits = Math.max(1, Number.isFinite(card.hits) ? card.hits : 1);
  const ageMs = Math.max(0, now - (Number.isFinite(card.anchorTime) ? card.anchorTime : now));
  const ageDays = Math.min(AGE_CAP_DAYS, ageMs / 86_400_000);
  const due = typeof card.dueHint === 'string' && card.dueHint !== '' ? 3 : 0;
  const snoozed = Number.isFinite(card.snoozedUntil) && card.snoozedUntil > now ? 6 : 0;
  return base + 3 * Math.min(hits, 4) + ageDays + due - snoozed;
}

/**
 * Tier for one score.
 * @param {number} score - from {@link scoreOf}.
 * @returns {'P0' | 'P1' | 'P2'} tier.
 */
export function tierOf(score) {
  for (const { tier, min } of TIERS) if (score >= min) return tier;
  return 'P2';
}

/** Does `from → to` respect the state machine? */
export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * May this card be woken up right now? `snoozed` cards re-open on their own
 * once the snooze expires — no scheduler needed, reads are cheap.
 * @param {object} card - stored card.
 * @param {number} now - epoch ms.
 * @returns {boolean} true when the card reads as live.
 */
export function isLive(card, now) {
  if (card === null || typeof card !== 'object') return false;
  if (card.status === 'open') return true;
  if (card.status === 'snoozed') return !(Number.isFinite(card.snoozedUntil) && card.snoozedUntil > now);
  return false;
}

/**
 * Project a stored card into what the panel renders: live score, tier, age.
 * Never mutates the stored record — the stored `score` is only a cache.
 * @param {object} card - stored card.
 * @param {number} now - epoch ms.
 * @returns {object} view.
 */
export function project(card, now) {
  const live = isLive(card, now);
  const score = live ? scoreOf(card, now) : 0;
  return {
    ...card,
    status: live && card.status === 'snoozed' ? 'open' : card.status,
    score: round2(score),
    tier: live ? tierOf(score) : 'P2',
    ageDays: Number.isFinite(card.anchorTime)
      ? Math.max(0, Math.round(((now - card.anchorTime) / 86_400_000) * 10) / 10)
      : 0,
    live,
  };
}

/** Two decimals is plenty for a UI badge and keeps snapshots diffable. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Sort for display: live first, then heaviest, then oldest.
 * @param {Array<object>} views - projected cards.
 * @returns {Array<object>} sorted copy.
 */
export function sortViews(views) {
  return [...views].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.anchorTime - b.anchorTime;
  });
}
