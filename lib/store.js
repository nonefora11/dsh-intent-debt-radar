/**
 * `dsh-intent-debt-radar` — the ledger.
 *
 * One JSON file, one domain, one write chain. The ledger is the plugin's only
 * durable state and it is deliberately *not* the session log: logs get
 * compacted and pruned, and a debt that disappears when a conversation is
 * summarized was never a debt at all.
 *
 * Concurrency: writes are serialized through a single promise chain and the
 * file is replaced atomically (temp file + rename), so a crash mid-write leaves
 * the previous ledger intact instead of a truncated one.
 *
 * Location: `$DSH_HOME/intent-debt-radar/ledger.json`, falling back to
 * `~/.dsh/…` — the same resolution every out-of-tree DSH plugin uses, and the
 * reason this plugin works on somebody else's machine, not just the one it was
 * written on.
 *
 * @module dsh-intent-debt-radar/lib/store
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Stored schema version. A mismatch is handled by {@link Ledger.#migrate}. */
export const LEDGER_VERSION = 1;

/** Debounce window for coalescing bursts of card writes. */
const SAVE_DEBOUNCE_MS = 400;

/** Resolve the DSH home directory the way the harness itself does. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(homedir(), '.dsh');
}

/**
 * Stable 16-hex id for a debt identity. Deterministic on purpose: re-observing
 * the same sentence must land on the same card — across restarts included —
 * which is what makes `hits` a meaningful counter instead of a duplicate pile.
 * @param {string} key - identity string.
 * @returns {string} id.
 */
export function idOf(key) {
  return createHash('sha1').update(key, 'utf8').digest('hex').slice(0, 16);
}

/** Empty ledger document. */
function emptyLedger() {
  return { version: LEDGER_VERSION, cards: [], meta: { lastStartupShownAt: 0, lastScanAt: 0 } };
}

export class Ledger {
  /** @param {{directory?: string}} [options] - override the storage directory (tests). */
  constructor(options = {}) {
    this.directory = options.directory ?? path.join(resolveDshHome(), 'intent-debt-radar');
    this.file = path.join(this.directory, 'ledger.json');
    this.document = emptyLedger();
    this.cards = new Map();
    this.ready = null;
    this.chain = Promise.resolve();
    this.timer = null;
    this.disposed = false;
    // Writes that arrive before the load finishes stay in memory and are saved
    // after the merge. A flush in that window raced the readFile and truncated
    // the file to whatever had been written since boot.
    this.loaded = false;
    this.pendingWrite = false;
  }

  /**
   * Load once; every later call returns the same promise.
   *
   * A rejection is not memoized: a transient EACCES or a locked directory must
   * be retryable, otherwise one bad moment at boot leaves every later write
   * failing in silence.
   */
  async open() {
    if (this.ready !== null) return this.ready;
    this.ready = this.#load()
      .then(() => {
        this.loaded = true;
        if (this.pendingWrite) {
          this.pendingWrite = false;
          void this.flush().catch(() => {});
        }
      })
      .catch((error) => {
        this.ready = null;
        throw error;
      });
    return this.ready;
  }

  async #load() {
    await mkdir(this.directory, { recursive: true });
    let raw;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt ledger is preserved, never silently overwritten: the user may
      // want to look at it, and an empty ledger is a safe stand-in meanwhile.
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {});
      return;
    }
    this.document = this.#migrate(parsed);
    const merged = new Map();
    for (const card of this.document.cards) {
      if (isCardShape(card)) merged.set(card.id, card);
    }
    // Cards created while the read was in flight win the tie: they are newer
    // than the file, and clearing here dropped the first debt of the boot.
    for (const [id, card] of this.cards) merged.set(id, card);
    this.cards = merged;
  }

  /**
   * Accept an older document when its shape is compatible, otherwise start clean.
   *
   * Every meta key is carried over, not a hand-picked list: `mode` lives in this
   * bag, and a whitelist here silently reset the user's extractor choice on every
   * restart — the panel said it remembered, and the file said otherwise.
   */
  #migrate(parsed) {
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.cards)) return emptyLedger();
    const meta = parsed?.meta !== null && typeof parsed?.meta === 'object' ? parsed.meta : {};
    return {
      version: LEDGER_VERSION,
      cards: parsed.cards,
      meta: {
        ...meta,
        lastStartupShownAt: Number(meta.lastStartupShownAt) || 0,
        lastScanAt: Number(meta.lastScanAt) || 0,
      },
    };
  }

  /** Every stored card, in insertion order. */
  all() {
    return [...this.cards.values()];
  }

  /** One card by id, or undefined. */
  get(id) {
    return this.cards.get(id);
  }

  /**
   * Insert or replace one card. A brand-new card is written straight through:
   * a debt that only exists in memory until the next debounce tick is a debt
   * that disappears when the host is killed. Repeats stay debounced.
   */
  put(card) {
    if (!isCardShape(card)) throw new Error(`intent-debt: refusing to store a malformed card (${String(card?.id)})`);
    const isNew = this.cards.has(card.id) === false;
    this.cards.set(card.id, card);
    if (isNew) void this.flush().catch(() => {});
    else this.#touch();
    return card;
  }

  /** Merge a partial change into an existing card. Returns the updated card, or undefined. */
  patch(id, changes) {
    const current = this.cards.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...changes, id: current.id };
    if (!isCardShape(next)) throw new Error(`intent-debt: patch produced a malformed card (${id})`);
    this.cards.set(id, next);
    this.#touch();
    return next;
  }

  /**
   * Drop one card. Deleting through `cards` + `put()` would re-flush per card,
   * because every re-inserted card looks new to `put()`.
   * @param {string} id - card id.
   * @returns {boolean} whether anything was removed.
   */
  remove(id) {
    const removed = this.cards.delete(id);
    if (removed) this.#touch();
    return removed;
  }

  /** Remove settled cards past the retention window, so the file cannot grow forever. */
  prune(retentionDays, now) {
    const horizon = now - retentionDays * 86_400_000;
    let removed = 0;
    for (const [id, card] of this.cards) {
      const settled = card.status === 'closed' || card.status === 'converted' || card.status === 'stale';
      if (settled && card.lastSeenAt < horizon) {
        this.cards.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) this.#touch();
    return removed;
  }

  /** Read the meta bag (startup-popup suppression lives here). */
  meta() {
    return { ...this.document.meta };
  }

  /** Merge into the meta bag. */
  setMeta(changes) {
    this.document.meta = { ...this.document.meta, ...changes };
    this.#touch();
  }

  #touch() {
    if (this.disposed) return;
    if (this.loaded === false) {
      this.pendingWrite = true;
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
    // Never hold the process open for a pending save.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Force a save and wait for it. Serialized; a rejected write does not poison the chain. */
  async flush() {
    this.pendingWrite = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = {
      version: LEDGER_VERSION,
      cards: this.all(),
      meta: { ...this.document.meta },
    };
    const run = async () => {
      const temp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      await mkdir(this.directory, { recursive: true });
      await writeFile(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    };
    this.chain = this.chain.then(run, run);
    await this.chain;
  }

  /** Flush pending state and stop accepting writes. */
  async close() {
    await this.flush().catch(() => {});
    this.disposed = true;
  }
}

/** Minimal structural check: enough to keep a corrupt line from poisoning reads. */
/** The statuses the state machine and the pruner both understand. */
const KNOWN_STATUSES = new Set(['open', 'closed', 'converted', 'snoozed']);

export function isCardShape(card) {
  return (
    card !== null &&
    typeof card === 'object' &&
    typeof card.id === 'string' &&
    card.id.length > 0 &&
    typeof card.kind === 'string' &&
    typeof card.quote === 'string' &&
    typeof card.anchorTime === 'number' &&
    Number.isFinite(card.anchorTime) &&
    // An unknown status would load as a card that is neither live nor settled:
    // invisible in every filter and immune to pruning, forever.
    KNOWN_STATUSES.has(card.status)
  );
}
