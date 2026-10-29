/**
 * `dsh-intent-debt-radar` — client half.
 *
 * One hand-written CommonJS factory registered into the browser module loader,
 * the same shape every out-of-tree DSH plugin uses: no bundler, no JSX, no
 * TypeScript; the only runtime imports are `react`.
 *
 * Surfaces:
 *  - `sidebar.panellist` + `main` — the ledger page. One seat: the sidebar row
 *    carries the live count as a badge, and the page behind it is the working
 *    surface (settle, snooze, remind, convert).
 *  - `shell.overlay` — two overlays: the startup summary the user asked for, and
 *    the desktop-notification pump that fires when a reminder comes due.
 *
 * All data comes from the authenticated `/intent-debt/*` routes of the host
 * half, so the panel and the agent tool can never disagree about the ledger.
 *
 * @module dsh-intent-debt-radar/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-intent-debt-radar',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'intent-debt-radar';
    /** Host route prefix owned by the host half. */
    const ROUTE_PREFIX = '/intent-debt';
    /** Main-panel id; the sidebar row reuses it as its list id. */
    const PANEL_ID = 'intent-debt-radar';

    // #region dictionaries
    const zh = {
      'title': '意图债务',
      'subtitle': '对话里被搁置的承诺、跑偏的问题、没做的决定。拖得越久，利息越高。',
      'stat.live': '未结',
      'stat.settled': '已结清',
      'scan.observed': '已观察 {n} 条消息',
      'scan.hits': '抓到 {n} 次迹象',
      'scan.silent': '还没收到任何会话事件——插件可能没被加载',
      'mode.label': '识别方式',
      'mode.rules': '规则',
      'mode.api': '模型',
      'mode.hint.rules': '只跑本地规则：零调用、零延迟、离线可用。',
      'api.off': '模型层未加载，当前只有规则可用。',
      'api.stats': '今日 {calls}/{day} 次 · {tokens} token · 缓存 {cache} · 跳过 {skipped}',
      'api.waiting': '模型层已就绪，还没有可疑子句值得一问。',
      'mode.failed': '切换失败，请重试。',
      'mode.on': '已切到模型识别：先跑规则，只有拿不准的子句才问模型。',
      'mode.off': '已切回规则识别：零调用、零延迟。',
      'filter.live': '未结',
      'filter.all': '全部',
      'filter.settled': '已结清',
      'kind.defer': '推后',
      'kind.loop': '没有回答',
      'kind.decision': '搁置的决定',
      'kind.agent-promise': '我说过要做',
      'speaker.user': '你说过',
      'speaker.assistant': '我说过',
      'meta.age': '拖了 {days} 天',
      'meta.hits': '重复出现 {n} 次',
      'meta.session': '会话 {id}',
      'action.convert': '转待办',
      'action.snooze': '推迟一天',
      'action.remind': '设提醒',
      'action.close': '结清',
      'action.reopen': '重开',
      'remind.hint': '选择提醒时间',
      'empty.live': '没有未结的意图债务。这句话很少被说出口，值得珍惜。',
      'empty.all': '账本还是空的。聊几轮天，它就开始记账了。',
      'empty.settled': '还没有结清过任何债务。',
      'loading': '读取账本…',
      'error.network': '连不上 DSH 主机，稍后自动重试。',
      'error.action': '操作失败，请重试。',
      'converted': '已转成待办：{text}',
      'converted.copied': '已复制到剪贴板，粘到待办里即可。',
      'refresh': '刷新',
      'notify.enable': '开启桌面提醒',
      'notify.enabled': '桌面提醒已开启',
      'notify.blocked': '浏览器拒绝了通知权限，提醒只在面板里显示。',
      'notify.title': '意图债务提醒',
      'startup.title': '开工前先看一眼：你有 {n} 笔意图债务',
      'startup.note': '这些是之前的对话里没有兑现的承诺。它们在利息里，不在你的记忆里。',
      'startup.dismiss': '知道了',
      'startup.open': '去侧边栏处理',
      'startup.scan': '已观察 {n} 条消息',
      'startup.switch': '切到模型识别',
      'badge.title': '意图债务',
      'tier.score': '评分 {score}',
      'remind.past': '请选择将来的时间',
      'quote.open': '「',
      'quote.close': '」',
      'quote.arrow': '　→　',
      'action.jump': '跳到对话',
      'jump.failed': '找不到这个会话了，可能已被删除。',
      'jump.hint': '回到这句话所在的会话',
    };
    const en = {
      'title': 'Intent Debt',
      'subtitle': 'Promises set aside, questions left hanging, decisions postponed. The longer they sit, the more they cost.',
      'stat.live': 'open',
      'stat.settled': 'settled',
      'scan.observed': '{n} messages seen',
      'scan.hits': '{n} tells caught',
      'scan.silent': 'No session event has arrived yet — the plugin may not be loaded',
      'mode.label': 'extractor',
      'mode.rules': 'rules',
      'mode.api': 'model',
      'mode.hint.rules': 'Local rules only: no calls, no latency, works offline.',
      'api.off': 'Model layer not loaded; rules only.',
      'api.stats': '{calls}/{day} today · {tokens} tokens · {cache} cached · {skipped} skipped',
      'api.waiting': 'Model layer ready, nothing suspicious to ask about yet.',
      'mode.failed': 'Switch failed, try again.',
      'mode.on': 'Model extraction is on: rules first, the model only for the clauses they cannot settle.',
      'mode.off': 'Back to rules only: no calls, no latency.',
      'filter.live': 'Open',
      'filter.all': 'All',
      'filter.settled': 'Settled',
      'kind.defer': 'Deferred',
      'kind.loop': 'Unanswered',
      'kind.decision': 'Undecided',
      'kind.agent-promise': 'I said I would',
      'speaker.user': 'you said',
      'speaker.assistant': 'I said',
      'meta.age': '{days}d old',
      'meta.hits': 'raised {n}×',
      'meta.session': 'session {id}',
      'action.convert': 'To todo',
      'action.snooze': 'Snooze a day',
      'action.remind': 'Remind',
      'action.close': 'Settle',
      'action.reopen': 'Reopen',
      'remind.hint': 'Pick a time',
      'empty.live': 'No open intent debt. That sentence is rarely spoken — worth keeping.',
      'empty.all': 'The ledger is empty. A few conversations and it starts keeping books.',
      'empty.settled': 'Nothing settled yet.',
      'loading': 'Reading the ledger…',
      'error.network': 'Cannot reach the DSH host; retrying shortly.',
      'error.action': 'That action failed. Try again.',
      'converted': 'Turned into a todo: {text}',
      'converted.copied': 'Copied. Paste it into your todo list.',
      'refresh': 'Refresh',
      'notify.enable': 'Enable desktop reminders',
      'notify.enabled': 'Desktop reminders on',
      'notify.blocked': 'The browser refused notification permission; reminders stay in the panel.',
      'notify.title': 'Intent debt reminder',
      'startup.title': '{n} intent debts are waiting',
      'startup.note': 'Promises from earlier conversations that were never kept. They accrue interest; they do not accrue memory.',
      'startup.dismiss': 'Got it',
      'startup.open': 'Open in sidebar',
      'startup.scan': '{n} messages seen',
      'startup.switch': 'Switch to the model',
      'badge.title': 'Intent debt',
      'tier.score': 'score {score}',
      'remind.past': 'Pick a time in the future',
      'quote.open': '"',
      'quote.close': '"',
      'quote.arrow': ' → ',
      'action.jump': 'Open chat',
      'jump.failed': 'That session is gone — it may have been deleted.',
      'jump.hint': 'Back to the chat this came from',
    };
    // #endregion

    // #region theme tokens
    // Only host theme tokens, so the panel follows light/dark without literals.
    const T = {
      labelPrimary: 'var(--dsw-alias-label-primary)',
      labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      bgBase: 'var(--dsw-alias-bg-base, Canvas)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1, Canvas)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, Canvas)',
      border: 'var(--dsw-alias-border-l2)',
      borderL1: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2))',
      brand: 'var(--dsw-alias-brand-primary, var(--dsw-alias-state-business-primary))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12))',
      error: 'var(--dsw-alias-state-error-primary, #d33)',
      success: 'var(--dsw-alias-state-success-primary, #2a2)',
      warn: 'var(--dsw-alias-state-warn-primary, #c80)',
      radiusSm: 'var(--dsw-alias-radius-sm, 6px)',
      radiusLg: 'var(--dsw-alias-radius-lg, 10px)',
      shadow: 'var(--dsw-alias-shadow-md, 0 8px 28px rgba(0,0,0,0.18))',
      mono: 'var(--dsw-alias-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    };
    // #endregion

    // #region shared helpers

    /** Absolute URL for one of this plugin's host routes. */
    function hostUrl(path) {
      return new URL(`${ROUTE_PREFIX}${path}`, window.location.href).toString();
    }

    /** A translator that never throws and never shows a raw key. */
    function translatorOf(t) {
      const local = (key) => zh[key] ?? en[key] ?? key;
      if (typeof t !== 'function') return local;
      // A host translator without this namespace returns the key itself, which
      // is how `startup.title` ended up on screen. Compare against the key and
      // fall back to the dictionary bundled right here.
      return (key) => {
        let value = '';
        try {
          value = t(key);
        } catch {
          value = '';
        }
        if (typeof value === 'string' && value !== '' && value !== key) return value;
        return local(key);
      };
    }

    /** `datetime-local` speaks local wall clock; toISOString() would drift by the zone offset. */
    function localInputValue(date) {
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** Fill `{name}` slots without depending on a formatter. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_match, key) => (values?.[key] === undefined ? `{${key}}` : String(values[key])));
    }

    /** One JSON call against the host routes. */
    async function callHost(path, body) {
      const options = body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
      // A host that never answers must not wedge the store for the rest of the
      // session: without a deadline `inflight` stays non-null and every later
      // refresh returns the same dead promise.
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        options.signal = AbortSignal.timeout(10_000);
      }
      const response = await fetch(hostUrl(path), options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    }
    // #endregion

    // #region ledger store
    // Module-level: the sidebar badge and the panel are two registrations but one
    // view of the same list. One fetch loop feeds both.
    const store = {
      snapshot: null,
      error: '',
      listeners: new Set(),
      timer: null,
      refs: 0,
      inflight: null,
    };

    function notify() {
      for (const listener of [...store.listeners]) {
        try {
          listener(store.snapshot);
        } catch {
          // a broken subscriber must not break the others
        }
      }
    }

    function subscribe(listener) {
      store.listeners.add(listener);
      return () => {
        store.listeners.delete(listener);
      };
    }

    /** Pull the ledger; concurrent callers share one request. */
    async function refresh() {
      if (store.inflight !== null) return store.inflight;
      store.inflight = (async () => {
        try {
          store.snapshot = await callHost('/state');
          store.error = '';
        } catch {
          store.error = 'network';
        } finally {
          store.inflight = null;
          notify();
        }
      })();
      return store.inflight;
    }

    /** Translate one registered key; bound in apply(), so the sidebar icon obeys the locale. */
    let labelOf = (key) => key;

    /**
     * Jump back to the chat a debt came from.
     *
     * Resolved at click time, not at registration time: `uiWorkspace` may be
     * registered after this plugin, and a captured reference would go stale the
     * first time the layout service is rebuilt.
     */
    let resolveWorkspace = () => undefined;
    function jumpToSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      try {
        const workspace = resolveWorkspace();
        const open = workspace?.openSession;
        if (typeof open !== 'function') return false;
        open.call(workspace, sessionId);
        return true;
      } catch {
        return false;
      }
    }

    /** Where the sidebar keeps the ledger page; bound to the layout service in apply(). */
    let openLedgerPage = () => {};

    /** Flip the extractor from any surface — popup, panel, or agent tool. */
    async function switchMode(next) {
      return await act({ action: 'mode', mode: next });
    }

    /** POST one action and adopt the returned snapshot. */
    async function act(body) {
      try {
        const next = await callHost('/action', body);
        if (next !== null && typeof next === 'object' && Array.isArray(next.cards)) {
          store.snapshot = next;
          store.error = '';
          notify();
        }
        return next;
      } catch {
        store.error = 'action';
        notify();
        return null;
      }
    }

    /**
     * Keep the snapshot fresh while *any* surface is mounted.
     *
     * Ref-counted on purpose: the sidebar row, the panel and the overlay all
     * subscribe, and a bare "first caller starts it, first cleanup stops it"
     * left a still-mounted panel refreshing nothing after the sidebar row
     * unmounted.
     */
    function retainPolling() {
      store.refs += 1;
      if (store.refs === 1) {
        store.timer = setInterval(() => void refresh(), 15_000);
        void refresh();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        store.refs -= 1;
        if (store.refs > 0 || store.timer === null) return;
        clearInterval(store.timer);
        store.timer = null;
      };
    }

    /** Subscribe a component to the shared snapshot. */
    function useSnapshot() {
      const [, force] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => subscribe(force), []);
      React.useEffect(() => retainPolling(), []);
      return store.snapshot;
    }
    // #endregion

    // #region atoms

    /** 16×16 line icon: a hook pulling a weight — the visual for "debt hanging". */
    function Icon({ size = 16 }) {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h(
          'g',
          { fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M8 1.8v4.4' }),
          h('path', { d: 'M4.6 6.2h6.8' }),
          h('path', { d: 'M6.2 6.2v3.1a1.8 1.8 0 0 0 3.6 0V6.2' }),
          h('circle', { cx: 8, cy: 12.4, r: 1.5 }),
        ),
      );
    }

    /** Tier chip. P0 is the only one that gets colour: crying wolf costs more than silence. */
    function TierBadge({ tier, score }) {
      const colour = tier === 'P0' ? T.error : tier === 'P1' ? T.warn : T.labelTertiary;
      return h(
        'span',
        {
          style: {
            flex: 'none',
            fontFamily: T.mono,
            fontSize: 10.5,
            lineHeight: '16px',
            padding: '0 5px',
            borderRadius: T.radiusSm,
            border: `1px solid ${colour}`,
            color: colour,
            letterSpacing: '0.02em',
          },
          title: fill(labelOf('tier.score'), { score: Math.round(score) }),
        },
        `${tier} ${Math.round(score)}`,
      );
    }

    /** A button that reads as text until hovered. */
    function FlatButton({ label, onClick, tone, disabled, title }) {
      const [hover, setHover] = React.useState(false);
      const colour = tone === 'danger' ? T.error : tone === 'accent' ? T.brand : T.labelSecondary;
      return h(
        'button',
        {
          type: 'button',
          title: title ?? label,
          disabled: disabled === true,
          onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            appearance: 'none',
            border: `1px solid ${hover && !disabled ? colour : T.borderL1}`,
            background: hover && !disabled ? (tone === 'danger' ? 'rgba(221,51,51,0.10)' : T.hover) : 'transparent',
            color: disabled === true ? T.labelTertiary : colour,
            borderRadius: T.radiusSm,
            padding: '3px 8px',
            fontSize: 11.5,
            cursor: disabled === true ? 'default' : 'pointer',
            opacity: disabled === true ? 0.6 : 1,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    /** Segmented filter. */
    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { style: { display: 'inline-flex', gap: 2, padding: 2, background: T.bgLayer2, borderRadius: T.radiusSm } },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              onClick: () => onChange(option.value),
              style: {
                appearance: 'none',
                border: 'none',
                background: value === option.value ? T.bgBase : 'transparent',
                color: value === option.value ? T.labelPrimary : T.labelSecondary,
                borderRadius: T.radiusSm,
                padding: '3px 10px',
                fontSize: 11.5,
                cursor: 'pointer',
              },
            },
            option.label,
          ),
        ),
      );
    }
    // #endregion

    // #region card row

    function CardRow({ view, tr }) {
      const [remindOpen, setRemindOpen] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const settled = view.status === 'closed' || view.status === 'converted' || view.status === 'stale';
      const kindLabel = tr(`kind.${view.kind}`) || view.kind;

      async function run(body) {
        const next = await act(body);
        if (next === null) {
          setMessage(tr('error.action'));
          return;
        }
        if (body.action === 'convert') {
          const text = next.converted?.text ?? '';
          // `navigator.clipboard?.` short-circuits to undefined when the API is
          // missing, which used to report an empty clipboard as a success.
          const writer = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
          if (typeof writer?.writeText === 'function') {
            try {
              await writer.writeText(text);
              setMessage(tr('converted.copied'));
              return;
            } catch {
              // fall through to showing the text
            }
          }
          setMessage(fill(tr('converted'), { text }));
        }
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            border: `1px solid ${T.borderL1}`,
            borderRadius: T.radiusLg,
            background: T.bgLayer1,
            opacity: settled ? 0.62 : 1,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(TierBadge, { tier: view.tier, score: view.score }),
          h('span', { style: { fontSize: 11.5, color: T.labelTertiary } }, `${kindLabel} · ${tr(`speaker.${view.speaker}`)}`),
          h('span', { style: { flex: 1 } }),
          h(
            'span',
            { style: { fontSize: 11, color: T.labelTertiary, fontFamily: T.mono } },
            [
              view.ageDays >= 1 ? fill(tr('meta.age'), { days: view.ageDays }) : '',
              view.hits > 1 ? fill(tr('meta.hits'), { n: view.hits }) : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ),
        h(
          'div',
          {
            title: tr('jump.hint'),
            onClick: () => {
              if (!jumpToSession(view.sessionId)) setMessage(tr('jump.failed'));
            },
            style: {
              fontSize: 13,
              lineHeight: 1.5,
              color: T.labelPrimary,
              wordBreak: 'break-word',
              cursor: 'pointer',
            },
          },
          `${tr('quote.open')}${view.quote}${tr('quote.close')}`,
        ),
        h('div', { style: { fontSize: 12, lineHeight: 1.5, color: T.labelSecondary, wordBreak: 'break-word' } }, `${tr('quote.arrow')}${view.impliedPromise}`),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 } },
          h(FlatButton, {
            key: 'jump',
            label: tr('action.jump'),
            onClick: () => {
              if (!jumpToSession(view.sessionId)) setMessage(tr('jump.failed'));
            },
          }),
          settled
            ? h(FlatButton, { key: 'reopen', label: tr('action.reopen'), onClick: () => void run({ action: 'reopen', id: view.id }) })
            : [
                h(FlatButton, { key: 'convert', label: tr('action.convert'), tone: 'accent', onClick: () => void run({ action: 'convert', id: view.id }) }),
                h(FlatButton, { key: 'snooze', label: tr('action.snooze'), onClick: () => void run({ action: 'snooze', id: view.id, hours: 24 }) }),
                h(FlatButton, { key: 'remind', label: tr('action.remind'), onClick: () => setRemindOpen((open) => !open) }),
                h(FlatButton, { key: 'close', label: tr('action.close'), onClick: () => void run({ action: 'close', id: view.id }) }),
              ],
          h('span', { style: { flex: 1 } }),
          h('span', { style: { fontSize: 10.5, color: T.labelTertiary, fontFamily: T.mono } }, fill(tr('meta.session'), { id: String(view.sessionId ?? '').slice(0, 8) })),
        ),
        remindOpen
          ? h('input', {
              type: 'datetime-local',
              'aria-label': tr('remind.hint'),
              onChange: (event) => {
                const value = event.target.value;
                if (value === '') return;
                const at = Date.parse(value);
                // A past time is due on arrival: the pump would fire once and
                // consume it, which reads as "the reminder never worked".
                if (!Number.isFinite(at) || at <= Date.now()) {
                  setMessage(tr('remind.past'));
                  return;
                }
                setRemindOpen(false);
                void run({ action: 'remind', id: view.id, remindAt: at });
              },
              min: localInputValue(new Date(Date.now() + 60_000)),
              style: {
                alignSelf: 'flex-start',
                background: T.bgBase,
                color: T.labelPrimary,
                border: `1px solid ${T.borderL1}`,
                borderRadius: T.radiusSm,
                padding: '3px 6px',
                fontSize: 12,
              },
            })
          : null,
        message === '' ? null : h('div', { style: { fontSize: 11.5, color: T.labelSecondary } }, message),
      );
    }
    // #endregion

    // #region panel

    function LedgerPanel({ t }) {
      const tr = translatorOf(t);
      const snapshot = useSnapshot();
      const [filter, setFilter] = React.useState('live');
      const [notifyState, setNotifyState] = React.useState(typeof Notification === 'undefined' ? 'blocked' : Notification.permission);
      const [notice, setNotice] = React.useState('');

      const cards = snapshot?.cards ?? [];
      const live = snapshot?.live ?? [];
      // A snoozed card is not live, but it is not settled either: counting it as
      // settled hid it in the 已结清 tab while its action buttons said otherwise.
      const isSettled = (view) => view.live !== true && view.status !== 'snoozed';
      const settledCount = cards.filter(isSettled).length;
      const shown = filter === 'live' ? live : filter === 'settled' ? cards.filter(isSettled) : cards;

      const mode = snapshot?.mode === 'api' ? 'api' : 'rules';
      const api = snapshot?.api ?? null;
      // Spend is shown, never hidden: "cheap" is a claim the panel has to keep
      // provable, otherwise the user has to take the plugin's word for it.
      const apiText =
        api === null
          ? tr('api.off')
          : api.calls === 0 && api.skipped === 0
            ? tr('api.waiting')
            : fill(tr('api.stats'), {
                calls: api.budget?.callsToday ?? 0,
                day: api.budget?.limits?.perDay ?? 0,
                tokens: api.budget?.tokensToday ?? 0,
                cache: api.cacheHits ?? 0,
                skipped: api.skipped ?? 0,
              });

      // The honest line: "nothing to report" and "not running" look identical
      // in every other plugin, and that is a bad way to lose a user's trust. It
      // sits at the very top because it is also the answer to "is this thing on".
      const scan = snapshot?.scan ?? null;
      const scanLine =
        scan === null || scan.messages === 0
          ? tr('scan.silent')
          : `${fill(tr('scan.observed'), { n: scan.messages })} · ${fill(tr('scan.hits'), { n: scan.hits })}`;

      /** Flip the extractor; the host persists the choice in the ledger's meta. */
      async function setMode(next) {
        if (next === mode) return;
        const result = await switchMode(next);
        if (result === null) {
          setNotice(tr('mode.failed'));
          return;
        }
        setNotice(next === 'api' ? tr('mode.on') : tr('mode.off'));
      }

      async function enableNotifications() {
        if (typeof Notification === 'undefined') {
          setNotifyState('blocked');
          return;
        }
        const result = await Notification.requestPermission();
        setNotifyState(result);
      }

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            padding: '18px 20px',
            height: '100%',
            // DSH ships no global border-box reset: without this the padding is
            // added on top of 100% and the last row is clipped by the column.
            boxSizing: 'border-box',
            overflow: 'auto',
            color: T.labelPrimary,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10 } },
          h('div', { style: { flex: 1, minWidth: 0 } }, [
            h('div', { key: 'title', style: { fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' } }, tr('title')),
            h('div', { key: 'sub', style: { fontSize: 12, color: T.labelSecondary, marginTop: 4, lineHeight: 1.6 } }, tr('subtitle')),
          ]),
          h(FlatButton, { label: tr('refresh'), onClick: () => void refresh() }),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' } },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: 3,
              background: scan !== null && scan.messages > 0 ? T.success : T.labelTertiary,
              flex: 'none',
            },
          }),
          h('span', { style: { fontSize: 11.5, color: T.labelSecondary } }, scanLine),
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 12, color: T.labelSecondary } }, `${tr('stat.live')} ${live.length}`),
          h('span', { style: { fontSize: 12, color: T.error } }, `P0 ${snapshot?.stats?.tiers?.P0 ?? 0}`),
          h('span', { style: { fontSize: 12, color: T.warn } }, `P1 ${snapshot?.stats?.tiers?.P1 ?? 0}`),
          h('span', { style: { fontSize: 12, color: T.labelTertiary } }, `P2 ${snapshot?.stats?.tiers?.P2 ?? 0}`),
          h('span', { style: { fontSize: 12, color: T.labelTertiary } }, `${tr('stat.settled')} ${settledCount}`),
          h('span', { style: { flex: 1 } }),
          notifyState === 'granted'
            ? h('span', { style: { fontSize: 11.5, color: T.success } }, tr('notify.enabled'))
            : notifyState === 'denied' || notifyState === 'blocked'
              ? h('span', { style: { fontSize: 11.5, color: T.labelTertiary } }, tr('notify.blocked'))
              : h(FlatButton, { label: tr('notify.enable'), onClick: () => void enableNotifications() }),
        ),
        h(Segmented, {
          value: filter,
          onChange: setFilter,
          options: [
            { value: 'live', label: tr('filter.live') },
            { value: 'all', label: tr('filter.all') },
            { value: 'settled', label: tr('filter.settled') },
          ],
        }),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 11.5, color: T.labelTertiary } }, tr('mode.label')),
          h(FlatButton, { label: tr('mode.rules'), tone: mode === 'rules' ? 'accent' : undefined, onClick: () => void setMode('rules') }),
          h(FlatButton, { label: tr('mode.api'), tone: mode === 'api' ? 'accent' : undefined, onClick: () => void setMode('api') }),
          h('span', { style: { flex: 1 } }),
        ),
        h('div', { style: { fontSize: 11.5, color: T.labelTertiary, lineHeight: 1.6, marginTop: -6 } }, mode === 'api' ? apiText : tr('mode.hint.rules')),
        notice === '' ? null : h('div', { style: { fontSize: 11.5, color: T.labelSecondary, marginTop: -6 } }, notice),
        store.error === ''
          ? null
          : h('div', { style: { fontSize: 12, color: T.warn } }, tr(store.error === 'network' ? 'error.network' : 'error.action')),
        snapshot === null
          ? h('div', { style: { fontSize: 12.5, color: T.labelTertiary } }, tr('loading'))
          : shown.length === 0
            ? h(
                'div',
                {
                  style: {
                    padding: '28px 20px',
                    border: `1px dashed ${T.borderL1}`,
                    borderRadius: T.radiusLg,
                    fontSize: 12.5,
                    color: T.labelTertiary,
                    textAlign: 'center',
                    lineHeight: 1.7,
                  },
                },
                tr(filter === 'live' ? 'empty.live' : filter === 'settled' ? 'empty.settled' : 'empty.all'),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                shown
                  .slice()
                  .sort((a, b) => (a.live === b.live ? b.score - a.score : a.live ? -1 : 1))
                  .map((view) => h(CardRow, { key: view.id, view, tr })),
              ),
      );
    }
    // #endregion

    // #region overlays

    /** Fire one desktop notification per due card, once. */
    function NotificationPump({ t }) {
      const tr = translatorOf(t);
      React.useEffect(() => {
        let stopped = false;
        // One tick at a time: overlapping ticks both saw the same due card and
        // posted `notified` twice, which double-toasts and double-consumes.
        let busy = false;
        async function tick() {
          if (stopped || busy) return;
          if (typeof document !== 'undefined' && document.hidden === true) return;
          busy = true;
          try {
            const { due } = await callHost('/due');
            if (!Array.isArray(due) || due.length === 0) return;
            const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'granted';
            const fallbackTitle = tr('notify.title');
            for (const card of due) {
              let shown = false;
              if (canNotify) {
                try {
                  const notification = new Notification(card.quote.slice(0, 60) || fallbackTitle, {
                    body: card.impliedPromise || undefined,
                    tag: `intent-debt-${card.id}`,
                    silent: false,
                  });
                  shown = true;
                  notification.onclick = () => {
                    try {
                      window.focus();
                    } catch {
                      // focus is best-effort
                    }
                    try {
                      openLedgerPage();
                    } catch {
                      // the layout service may be absent in a headless host
                    }
                  };
                } catch {
                  // a blocked constructor is not an error worth surfacing
                }
              }
              // Only a reminder the user actually saw may be marked as sent: the
              // host filters `notifiedAt >= remindAt` forever, so a silent mark
              // burns the card for good.
              if (shown) await act({ action: 'notified', id: card.id });
            }
            void refresh();
          } catch {
            // host asleep; the next tick retries
          } finally {
            busy = false;
          }
        }
        const timer = setInterval(() => void tick(), 30_000);
        void tick();
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, []);
      return null;
    }

    /** The startup summary: what was left hanging, before the day starts. */
    function StartupOverlay({ t }) {
      const tr = translatorOf(t);
      const snapshot = useSnapshot();
      const [dismissed, setDismissed] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const startup = snapshot?.startup;
      const mode = snapshot?.mode === 'api' ? 'api' : 'rules';
      const scan = snapshot?.scan ?? null;
      const reported = React.useRef(false);
      const boxRef = React.useRef(null);
      const open =
        dismissed === false &&
        startup !== undefined &&
        startup !== null &&
        startup.show === true &&
        (startup.top?.length ?? 0) > 0;

      // Tell the host we put the summary in front of the user. Without this the
      // popup came back on every reload, `startupPopupGapHours` or not.
      React.useEffect(() => {
        if (!open || reported.current) return;
        reported.current = true;
        void act({ action: 'startup-shown' });
      }, [open]);

      React.useEffect(() => {
        if (!open) return;
        try {
          boxRef.current?.focus?.();
        } catch {
          // focus is best-effort
        }
      }, [open]);

      if (!open) return null;

      const dismiss = () => {
        setDismissed(true);
        void act({ action: 'dismiss-startup' });
      };

      /** Leave the summary and land on the page that can actually settle things. */
      const openPanel = () => {
        dismiss();
        try {
          openLedgerPage();
        } catch {
          // the layout service may be absent in a headless host
        }
      };

      const flip = async () => {
        setBusy(true);
        try {
          await switchMode(mode === 'api' ? 'rules' : 'api');
        } finally {
          setBusy(false);
        }
      };

      return h(
        'div',
        {
          // DSH decides "is a modal open" from exactly this pair, and it keys
          // global shortcut suppression and Escape off it too.
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': fill(tr('startup.title'), { n: startup.top.length }),
          tabIndex: -1,
          ref: boxRef,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.34)',
            outline: 'none',
          },
          onClick: dismiss,
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              dismiss();
            }
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              width: 'min(560px, calc(100vw - 48px))',
              background: T.bgLayer1,
              border: `1px solid ${T.border}`,
              borderRadius: T.radiusLg,
              boxShadow: T.shadow,
              padding: '18px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              color: T.labelPrimary,
            },
          },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, fill(tr('startup.title'), { n: startup.top.length })),
          h('div', { style: { fontSize: 12, color: T.labelSecondary, lineHeight: 1.65 } }, tr('startup.note')),
          h(
            'div',
            { style: { fontSize: 11.5, color: T.labelTertiary } },
            scan === null || scan.messages === 0
              ? tr('scan.silent')
              : `${fill(tr('scan.observed'), { n: scan.messages })} · ${fill(tr('scan.hits'), { n: scan.hits })}`,
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8, margin: '4px 0' } },
            startup.top.map((card) =>
              h(
                'div',
                {
                  key: card.id,
                  title: tr('jump.hint'),
                  onClick: () => {
                    dismiss();
                    jumpToSession(card.sessionId);
                  },
                  style: {
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    cursor: 'pointer',
                  },
                },
                h(TierBadge, { tier: card.tier, score: card.score }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 0 } },
                  h('div', { style: { wordBreak: 'break-word' } }, `${tr('quote.open')}${card.quote}${tr('quote.close')}`),
                  h(
                    'div',
                    { style: { fontSize: 11.5, color: T.labelTertiary, marginTop: 1 } },
                    [
                      h('span', { key: 'kind' }, `${tr(`kind.${card.kind}`)}`),
                      card.impliedPromise !== undefined && card.impliedPromise !== '' && card.impliedPromise !== card.quote
                        ? h('span', { key: 'subj' }, `${tr('quote.arrow')}${card.impliedPromise}`)
                        : null,
                    ],
                  ),
                ),
              ),
            ),
          ),
          // Same honesty rule as the panel: say what the extractor is, and how
          // much it has actually seen, without needing another click.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5, color: T.labelTertiary } },
            h('span', null, tr('mode.label')),
            h('span', { style: { color: mode === 'api' ? T.brand : T.labelSecondary, fontWeight: 600 } }, mode === 'api' ? tr('mode.api') : tr('mode.rules')),
            h('span', null, '·'),
            h('span', null, scan !== null && scan !== undefined && scan.messages > 0 ? fill(tr('startup.scan'), { n: scan.messages }) : tr('scan.silent')),
            h(FlatButton, { label: busy ? '…' : mode === 'api' ? tr('mode.rules') : tr('startup.switch'), onClick: () => void flip() }),
          ),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 } },
            h(FlatButton, { label: tr('startup.open'), onClick: openPanel }),
            h(FlatButton, { label: tr('startup.dismiss'), tone: 'accent', onClick: dismiss }),
          ),
        ),
      );
    }

    function Overlays({ t }) {
      return h(React.Fragment, null, h(StartupOverlay, { t }), h(NotificationPump, { t }));
    }
    // #endregion

    // #region registrations

    /** Sidebar row icon, carrying the live count as a badge. */
    function SidebarIcon({ size }) {
      const snapshot = useSnapshot();
      const live = snapshot?.live?.length ?? 0;
      const box = size ?? 16;
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }, title: labelOf('badge.title') },
        h(Icon, { size: box }),
        live > 0
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  top: -4,
                  right: -6,
                  minWidth: 13,
                  height: 13,
                  padding: '0 3px',
                  borderRadius: 7,
                  background: T.error,
                  color: '#fff',
                  fontSize: 9,
                  lineHeight: '13px',
                  textAlign: 'center',
                  fontWeight: 600,
                },
              },
              live > 99 ? '99+' : String(live),
            )
          : null,
      );
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      // The popup's "open the panel" button has to reach the same page the
      // sidebar row does, so bind it to the layout service once, here.
      resolveWorkspace = () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
        } catch {
          return undefined;
        }
      };

      try {
        const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined;
        const selectPanel = layout?.selectPanel;
        if (typeof selectPanel === 'function') {
          openLedgerPage = () => selectPanel.call(layout, PANEL_ID);
        }
      } catch {
        // no layout service: the popup still works, it just cannot navigate
      }

      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'intent-debt: dictionaries');
      } catch (error) {
        console.warn('intent-debt: dictionary registration failed:', error);
      }

      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: PANEL_ID, locale: NS },
            LedgerPanel,
          ),
        );
      } catch (error) {
        console.warn('intent-debt: panel registration failed:', error);
      }

      try {
        const t = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : (key) => zh[key] ?? key;
        labelOf = translatorOf(t);
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 6, locale: NS, label: () => t('badge.title') },
            SidebarIcon,
          ),
        );
      } catch (error) {
        console.warn('intent-debt: sidebar row registration failed:', error);
      }

      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'intent-debt-radar-overlays', order: 60, locale: NS }, Overlays),
        );
      } catch (error) {
        console.warn('intent-debt: overlay registration failed:', error);
      }
    }
    // #endregion

    // Exposed for the loader-based tests in test/client.test.mjs: the render path
    // is otherwise unreachable without a DOM, and it is where typos hide.
    const internals = { CardRow, TierBadge, LedgerPanel, StartupOverlay, SidebarIcon, jumpToSession };

    return { inject, apply, name: NS, internals };
  },
});
