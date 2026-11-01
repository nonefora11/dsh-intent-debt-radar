# Intent Debt Radar

[![test](https://github.com/nonefora11/dsh-intent-debt-radar/actions/workflows/test.yml/badge.svg)](https://github.com/nonefora11/dsh-intent-debt-radar/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2%20%3C0.3.0-5b8def.svg)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

[简体中文](README.md) · **English**

**A promise you quietly dropped does not stop existing just because the conversation scrolled.**

Every chat has them: `让我先想一下`, `这个回头再说`, `下次补上`, and the assistant's
`要不要我继续把剩下的改完？` that nobody answered. They are not tasks — no tool was
called, no todo was written, nothing was scheduled. They are *intent debt*: semantic
commitments that were made and never honoured, and they get more expensive the longer
they sit there.

This plugin keeps a ledger of them.

## What it tracks

| Kind | What it catches | Example |
| --- | --- | --- |
| `defer` | Something explicitly set aside | `这个先放着，回头再说` · `circle back later` |
| `loop` | A question that never got an answer | assistant asks, user changes the subject |
| `decision` | A fork left open | `先不定，再看看` · `TBD` |
| `agent-promise` | The assistant said it would, then didn't | "I'll add the tests next" with no tool call that turn |

Extraction is deliberately **regex + structure**, not a model call. It runs offline,
it costs nothing, and every card can be argued with because the quote on the card is
the original sentence, never a paraphrase.

## How debt is priced

```
score = base + 3·min(hits, 4) + min(ageDays, 14) + (hasDue ? 3 : 0) − (snoozing ? 6 : 0)
```

`base` is 7 for an agent promise, 6 for a deferral, 5 for an unanswered question, 4 for
an undecided fork. `hits` counts how many times the same thing came back — repeatedly
avoiding a topic is the strongest signal there is. `ageDays` is the whole thesis: debt
accrues interest. It is capped at 14 days so a two-year-old note cannot outrank a live
broken promise forever.

Tiers: **P0 ≥ 12**, **P1 ≥ 6**, everything else **P2**.

## What you get

- **Sidebar row with a live badge** — the number of open debts, always visible.
- **The ledger page** — open / settled filters, and per card: settle, reopen, snooze a
  day, pick a reminder time, or convert to a todo (copied to your clipboard); `Open
  chat` (or the quote itself) jumps straight back to the conversation it came from.
- **Startup summary** — on launch, the top debts, dismissible; each dismissed summary
  stays quiet for `startupPopupGapHours` (default 0 = show it again on the next load).
- **Desktop reminders** — the browser `Notification` API when a reminder comes due, no
  native dependency and no shell.
- **An `intent_debt` tool** — so the agent can read the debt it owes:
  `list`, `stats`, `close`, `snooze`, `remind`, `convert`, plus `mode` to flip the
  extractor without opening the panel.

## Install

```bash
# inside your DSH profile directory
cd ~/.dsh/profiles/desktop

# before it is on npm, install straight from the repository:
npm install github:nonefora11/dsh-intent-debt-radar

# once published:
npm install dsh-intent-debt-radar
```

Then add it to `dsh.profile.bundles` in that profile's `package.json`:

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "…",
      "dsh-intent-debt-radar"
    ]
  }
}
```

Restart DSH. The 意图债务 row appears in the sidebar's global panel list.

Or install it from a plugin market if your DSH build has one.

## Where to look

The ledger page, roughly (`P0`/`P1` are tiers, the number is today's score):

```
Intent Debt                                 live 3 · settled 12
What a conversation shelved, a question nobody answered, a decision not taken.

1284 messages seen · 37 tells caught     ●      extractor  [rules] [model]
                                         today 2/60 calls · 1874 tokens · cache 3 · skipped 9

  P0 score 15   deferred · you said it · open 2 days · said 3 times
  "let's park the log for now, I'm busy"
  [Open chat] [Settle] [Snooze a day] [Remind] [To a todo]

  P1 score 9    unanswered · I said it · open 1 day
  "shall I finish the rest?"
  [Open chat] [Settle] [Snooze a day] [Remind] [To a todo]
```

And once per launch, a summary with only the heaviest few:

```
┌ Before you start: 3 intent debts ──────────────────────────────┐
│ Promises from earlier conversations that were never kept.      │
│ They live in interest, not in your memory.                     │
│   P0  "let's park the log for now, I'm busy"        open 2 days│
│   P1  "shall I finish the rest?"                    open 1 day │
│   P2  "leave the login page for later"              open 1 day │
│                                  [Open the sidebar] [Got it]  │
└────────────────────────────────────────────────────────────────┘
```

Details:

- **The summary** appears once per DSH launch, most avoided first. Closing it or
  restarting counts as seen; it does not nag twice in one process.
- **The counter line** at the top is live — `N messages seen · M tells caught` — next
  to a status dot. With nothing observed it says so outright instead of looking like a
  calm, empty ledger.
- **The extractor** is two buttons, the active one accented, and flipping it reports
  back on the spot; switch to `model` and the line on the right immediately starts
  saying `today 2/60 calls · 1874 tokens`, so the cost is never a matter of trust.
- **The quote itself is clickable too**, same as `Open chat`: back to the conversation
  where the promise was made.

## Two extraction modes

There is a switch in the panel, and the same setting in config. Default is `rules`.

| Mode | What runs | What it costs | When |
| --- | --- | --- | --- |
| `rules` | Regex plus structural signals, a local state machine | Zero calls, zero latency, works offline | The default, and the privacy-safe choice |
| `api` | Rules first, then a model only for the clauses rules were unsure about | Cached and triple-capped, see below | Unusual phrasing, fewer misses |

`api` is not "send every sentence to a model". That would make cost grow linearly with
chat volume, and nobody would keep it on. It is a **funnel**:

1. **Gate.** Hits rules already resolve confidently never reach the model. Only clauses
   carrying a weak cue (`later`, `next time`, `revisit`, `for now`, `hold off`, or a
   Chinese equivalent like `以后` / `回头` / `改天` / `记一下`) are suspect. A 2400-character
   wall of text usually contains one to three of them.
2. **Batch.** One request per turn — not one per message, and definitely not one per clause.
3. **Trim.** The request carries the clause plus 60 characters of context on each side.
   No transcript, no system prompt, no tool history.
4. **Cap.** At most `maxClausesPerCall` (default 6) clauses per request, `maxTokens: 320`
   on the reply, and an output grammar of single-letter type codes.
5. **Cache.** The same clause set against the same model hits an LRU of 256 and costs nothing.
6. **Budget.** `maxCallsPerHour` (6), `maxCallsPerDay` (60), `maxTokensPerDay` (40000).
   Past any of them the plugin falls back to `rules` silently — no error, no popup.

The panel shows the running total: `today 2/60 calls · 1874 tokens · 3 cached · 9 skipped`.
Saving money has to be visible, otherwise it is just the plugin's own claim.

Model routing reuses the current session's provider and model, so no second API key is
needed. To bill extraction to a cheaper model, set `llmProvider` / `llmModel`.

```yaml
- id: intent-debt-radar
  name: dsh-intent-debt-radar
  config:
    mode: api              # rules | api
    maxClausesPerCall: 6
    maxCallsPerHour: 6
    maxCallsPerDay: 60
    maxTokensPerDay: 40000
    llmProvider: ''        # empty = reuse the session route
    llmModel: ''
```

## Configuration

Optional, in the profile's `cordis.patch.yml` under this plugin's entry:

```yaml
- id: intent-debt-radar
  name: dsh-intent-debt-radar
  config:
    enabled: true               # false = load nothing, watch nothing
    minConfidence: 0.5          # below this, a candidate is ignored
    trackAssistantPromises: true # catch the agent's own dropped promises
    maxCardsPerSession: 80      # per-session ceiling, keeps one chat from flooding the ledger
    retentionDays: 120          # settled cards older than this are pruned
    retentionSweep: true        # do that pruning on load; false keeps everything
    startupPopupGapHours: 0     # 0 = show the startup summary on every launch
```

## Data

One file: `$DSH_HOME/intent-debt-radar/ledger.json` (or `~/.dsh/…`). Written atomically
via a temp file plus rename, serialized through a single write chain. Card ids are
derived from the debt's identity, not a counter, so re-observing the same sentence after
a restart increments `hits` instead of creating a duplicate. A corrupt file is preserved
as `ledger.json.corrupt-<timestamp>` rather than silently overwritten.

The plugin reads `session/event` and owns that one file. It never writes to the session
log, the todo list, or the schedule service.

**Nothing leaves your machine in `rules` mode** — it is pure local regex, no network call
of any kind. In `api` mode the only thing sent is the clause the rules could not settle
(capped at 60 characters of context around it), through the session's own model route;
no API key of its own, no third-party endpoint, and the answer is cached so the same
sentence is never paid for twice.

## Compatibility and what was actually tested

- DSH `>=0.2.0-rc.2 <0.3.0`, Node `>=22`, web client.
- One optional peer, `@deepseek-ai/dsh-llm`, used only by `api` mode; `rules` mode runs without it.

| Item | Measured |
| --- | --- |
| DSH runtime | `0.2.1-rc.5` (the version reported by `@deepseek-ai/dsh-base`) |
| Node / OS | `v24.16.0` · Windows |
| Install | `file:` dependency inside a profile, plus an entry in that profile's `dsh.profile.bundles` |
| Tests | 107 passing (`npm test`); CI additionally runs Node 22/24 × Ubuntu/Windows |
| UI | sidebar entry, startup summary, ledger panel — walked through by hand |

Only that one DSH version has been run for real; nothing else is verified. If something breaks, open an
issue with your `dsh` version, the `mode` setting, and the counter line at the top of the panel
(`observed N messages · caught M signals`) — those three distinguish "not loaded" from "no events" from
"nothing matched".

## Development

```bash
npm test        # patterns, scoring, ledger round-trip, extraction, llm budget/cache,
                # plus an end-to-end smoke test that drives apply() over fake HTTP
npm run check   # tests + npm pack --dry-run
```

## License

MIT
---

[简体中文](README.md) · [Back to top](#intent-debt-radar)
