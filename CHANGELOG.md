# Changelog

Notable changes to `dsh-intent-debt-radar`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/).

## [0.2.4] — 2026-11-01

### Added

- **CI.** `.github/workflows/test.yml` runs `npm test` and `npm pack --dry-run` on
  Node 22 and 24, on both Ubuntu and Windows, for every push and pull request. No
  install step on purpose: the suite has to be green on a bare checkout, and that is
  also the check that `rules` mode really needs nothing from `@deepseek-ai/dsh-llm`.
- **A verified-environment table** in both READMEs, and status badges at the top.
  Only DSH `0.2.1-rc.5` on Windows has actually been run, and the table says so
  instead of implying a support matrix that was never exercised.
- **Text layout sketches** of the ledger page and the launch summary in both READMEs,
  drawn with the exact UI labels. No screenshots: a picture of a panel rots silently
  the first time a button gets renamed, while a text sketch can be diffed in review.

## [0.2.3] — 2026-10-29

### Added

- **A debt now leads back to the words that created it.** Every card carries a
  `跳到对话` / `Open chat` action (and the quote itself is clickable, plus each row of
  the startup summary) that hands the card's `sessionId` to the layout service's
  `openSession`, so the conversation reopens where the promise was made. The lookup is
  lazy — it runs at click time, because `uiWorkspace` can register after this plugin —
  and a missing service, a deleted session or a thrown navigation error all fall back
  to an inline `找不到这个会话了` message instead of breaking the page.

## [0.2.2] — 2026-10-29

A full audit pass before publishing: two data-integrity blockers, four majors, and a
list of smaller holes. Everything below was reproduced before it was fixed.

### Fixed

- **The first debt of a boot could vanish.** The watcher sees events before
  `ledger.open()` resolves, and the load then cleared the in-memory map before merging
  the file. A card written in that window disappeared; worse, a flush in the same
  window could rename a one-card snapshot over the whole ledger. Writes now stay in
  memory until the load completes, and the load merges instead of clearing.
- **A failed save could kill the host.** The debounce timer called `flush()` without a
  handler, so an unwritable `$DSH_HOME` surfaced as an unhandled rejection. Both the
  timer and the new-card path now swallow-and-report.
- **A reminder could be burned without ever being shown.** The pump marked every due
  card as notified even when notifications were denied or the constructor threw, and
  the host filters `notifiedAt >= remindAt` forever. Only a notification that was
  actually constructed marks the card.
- **The startup summary returned on every reload.** The client now posts
  `startup-shown`, so `startupPopupGapHours` means something.
- **The popup was not a modal.** It now carries `role="dialog"`/`aria-modal`, takes
  focus, and closes on Escape — DSH keys shortcut suppression and `closeTopModal` off
  exactly that markup, so the composer behind it was still live.
- **"Settled" counted snoozed cards.** A card postponed for a day fell into the
  settled tab while still showing its action buttons.
- **The mode button could lie.** `act()` returns `null` on failure instead of throwing,
  so the failure branch was dead code; it now reads the return value.
- **False "copied to clipboard".** `navigator.clipboard?.` short-circuits to
  `undefined`, which read as success; the text is now shown when the API is absent.
- **Per-session bookkeeping never ran.** `forget()` was wired to
  `session/delete`/`session/close`, which DSH never emits; it now listens to
  `session/disposed`.
- **The per-session cap counted settled cards**, so a long session stopped learning.
  Only live cards count now.
- **A answered multi-clause question still became debt.** Overlap was measured against
  the whole assistant message; it is now measured against the question's own clauses.
- Requests to the host time out after 10 s, the notification pump cannot overlap
  itself, and it stays quiet while the window is hidden.
- Reminders cannot be set in the past, `生僻` CJK brackets are gone from the English UI,
  and action failures are now visible instead of silently swallowed.

### Added

- `test/client.test.mjs`: the browser half loads through the module loader, registers
  its three surfaces, keeps both dictionary copies in sync with `locale/*.json`, and
  resolves every literal `tr()` key.

## [0.2.1] — 2026-10-28

Three things the first real user could not find. All three were the plugin's fault,
not the user's.

### Fixed

- **Raw keys in the startup summary.** When the host handed the overlay a translator
  bound to another namespace, it returned the key itself and the popup read
  `startup.title` / `startup.note`. `translatorOf` now compares the result against the
  key and falls back to the bundled dictionary, so a missing namespace degrades to
  plain Chinese instead of machine words.
- **The mode switch looked like a label.** It was a segmented control on a line of
  grey text. It is now two explicit buttons with the active one accented, plus a
  one-line confirmation after a flip and a visible failure message.
- **"Is it even running?"** The scan counter moved from the bottom of the panel to the
  top, next to a status dot, and the startup summary now carries the same line. Zero
  observed messages is stated outright instead of looking like an empty ledger.

### Added

- `mode.on` / `mode.off` confirmations, and a per-card kind label in the summary so
  the first line of each debt says what kind of debt it is.
- `wellFormed()` in `lib/patterns.js`: lone surrogates are repaired on the way into
  the ledger, so a truncated character cannot become a black diamond in the panel.
- `STUB_SUBJECT`: a subject made only of demonstratives (`这个东西`) no longer becomes
  the card's promise; the clause keeps its verb and the card stays readable.

## [0.2.0] — 2026-10-28

Two ways to read a conversation, and the cheap one is still the default.

### Added

- **`api` extraction mode.** Rules stay in front; only the clauses they were unsure
  about go to a model through `ctx.llm.stream()`. One request per turn, at most six
  clauses, 320 output tokens, 60 characters of context per side, an LRU of 256, and a
  three-way budget (calls per hour, calls per day, tokens per day). Past the budget it
  degrades to `rules` silently instead of failing.
- **`mode` switch** in the panel and in config, persisted in the ledger meta so it
  survives a restart. The tool grew `action: "mode"` for the agent to read or flip it.
- **Spend readout** in the panel: calls, tokens, cache hits, skips, today's ceilings.
- **Weak-cue funnel** (`suspectClauses`, `collectSuspects`): clause-level gating that
  keeps the request body under ~600 characters even for a 2400-character message.
- 37 new unit tests (`test/llm.test.mjs`) covering the funnel, the response parser,
  the budget rollover, the cache, route resolution, and a full extractor run against a
  scripted stream.

### Changed

- `runtime-context` messages are skipped entirely: they are injected environment text,
  not something a person said.
- `@deepseek-ai/dsh-llm` is declared as an optional peer dependency.

## [0.1.0] — 2026-10-28

First release. The whole point is small: a promise that was quietly dropped
should not be able to disappear just because the conversation scrolled.

### Added

- **Debt extraction from conversation events.** The host half subscribes to
  `session/event` and keeps three kinds of debt:
  - `defer` — the user set something aside (`以后再说`, `下次补`, `先这样`, `later`,
    `circle back`).
  - `loop` — a question that was asked and never answered, detected by overlap
    between the question and the user's next message.
  - `decision` — a fork in the road that was left open (`再想想`, `先不定`,
    `TBD`).
  - `agent-promise` — the assistant said it would do something and the turn
    ended without a single tool call.
- **Interest-bearing scores.** `base + 3·min(hits,4) + min(ageDays,14) + due −
  snooze`, capped so an old note cannot outrank a live broken promise forever.
  Tiers: P0 ≥ 12, P1 ≥ 6, P2 below.
- **One ledger, many conversations.** `$DSH_HOME/intent-debt-radar/ledger.json`,
  written atomically (temp file + rename) through a single serialized write
  chain. Ids are content-derived, so the same sentence re-observed after a
  restart lands on the same card and increments `hits` instead of duplicating.
- **Panel** (`sidebar.panellist` + `main`): open/settled filters, per-card
  settle, reopen, snooze a day, set a reminder, and convert to a todo line
  (copied to the clipboard).
- **Startup summary** (`shell.overlay`): the top debts, once per launch,
  dismissible, with the dismissal timestamp stored in the ledger so it does not
  nag on every reload.
- **Desktop reminders** through the browser `Notification` API, pumped by a 30 s
  poll of `GET /intent-debt/due`; each card is marked `notifiedAt` so a reminder
  fires once. No shell, no PowerShell, no native dependency.
- **`intent_debt` tool** so the agent can read its own debt and settle it:
  `list`, `stats`, `close`, `snooze`, `remind`, `convert`.
- **Bilingual UI** (zh-CN / en) and host theme tokens only — no hard-coded
  colours, so light and dark both work.

### Notes

- Extraction is regex- and structure-based on purpose. A model is optional and
  never required: the plugin works on a machine with no network.
- Nothing in the plugin writes to the session log, the todo list, or the
  schedule service. It reads events and owns exactly one file.

[0.1.0]: https://github.com/nonefora11/dsh-intent-debt-radar/releases/tag/v0.1.0
[0.2.0]: https://github.com/nonefora11/dsh-intent-debt-radar/releases/tag/v0.2.0
[0.2.1]: https://github.com/nonefora11/dsh-intent-debt-radar/releases/tag/v0.2.1
[0.2.2]: https://github.com/nonefora11/dsh-intent-debt-radar/releases/tag/v0.2.2
[0.2.3]: https://github.com/nonefora11/dsh-intent-debt-radar/releases/tag/v0.2.3
