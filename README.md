# 意图债务雷达 · Intent Debt Radar

[![test](https://github.com/nonefora11/dsh-intent-debt-radar/actions/workflows/test.yml/badge.svg)](https://github.com/nonefora11/dsh-intent-debt-radar/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.2%20%3C0.3.0-5b8def.svg)](package.json)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

**简体中文** · [English](README.en.md)

**你顺口放弃的那句话，不会因为对话滚过去了就不存在。**

每个聊天里都有这种句子：`这个先放着，回头再说`、`下次补上`、`让我先想一下`，还有助手那句
没人回应的 `要不要我继续把剩下的改完？`。它们不是任务——没有工具调用、没有写待办、没有
排日程，什么都没发生。它们是**意图债务**：已经许下、但从未兑现的语义承诺。放得越久，利息
越高。

这个插件替它们记账。

## 它追踪什么

| 类型 | 抓的是什么 | 例子 |
| --- | --- | --- |
| `defer` | 明确被搁置的事 | `这个先放着，回头再说` · `circle back later` |
| `loop` | 问了但没人回答的问题 | 助手提问，用户接着聊别的 |
| `decision` | 没做的决定 | `先不定，再看看` · `TBD` |
| `agent-promise` | 助手说了要做却没做 | 说了「下一步我补上测试」，那一轮一个工具都没调 |

抽取刻意做成**正则 + 结构信号**，不依赖模型：离线能跑、零成本，而且卡片上引用的永远是
原句，不是改写——所以每张卡都能被反驳。

## 债务怎么定价

```
score = base + 3·min(hits, 4) + min(ageDays, 14) + (有提醒 ? 3 : 0) − (被推迟 ? 6 : 0)
```

`base`：助手承诺 7、推后 6、未答 5、未决 4。`hits` 是同一件事反复出现的次数——反复绕开一个
话题是最强的信号。`ageDays` 是整套东西的立论：债务会生息，封顶 14 天，免得一条两年前的
旧笔记永远压着一条新鲜的毁约。

档位：**P0 ≥ 12**、**P1 ≥ 6**，其余 **P2**。

## 你能得到什么

- **侧边栏一行 + 实时角标**：未结债务数，一直在那儿。
- **账本页**：未结 / 已结清筛选；每张卡可以结清、重开、推迟一天、设提醒时间、转成待办
  （自动复制到剪贴板）；点 `跳到对话`（或引文本身）直接回到当初说那句话的会话。
- **启动摘要**：每次打开 DSH，先看最重的几笔，一次性，可关闭。
- **桌面提醒**：提醒时间到了用浏览器 `Notification` 弹出来——没有原生依赖，不碰 shell。
- **`intent_debt` 工具**：让 Agent 也能读自己欠的账——
  `list`、`stats`、`close`、`snooze`、`remind`、`convert`，还有 `mode`（不开面板也能切识别方式）。

## 安装

```bash
# 在你的 DSH profile 目录里
cd ~/.dsh/profiles/desktop

# 还没发到 npm 时，直接从仓库装：
npm install github:nonefora11/dsh-intent-debt-radar

# 已发布后：
npm install dsh-intent-debt-radar
```

然后把这个包加进该 profile `package.json` 的 `dsh.profile.bundles`：

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

重启 DSH，侧边栏全局面板里就会多出「意图债务」一行。

如果你的 DSH 装了插件市场，也可以直接从市场安装。

## 界面上该看哪里

- **每次打开 DSH** 弹一次摘要：欠了几件事、都是哪几句、最要紧的排在前面。关掉或重启才算看过；
  同一进程里不会反复打扰。
- **面板顶部**一行小字：`已观察 N 条消息 · 抓到 M 次迹象`，左边一个状态点。没消息时它直接说
  「还没收到任何会话事件——插件可能没被加载」，而不是装作一片安静。
- **识别方式**是两颗按钮，当前那颗高亮，点另一颗会当场答复切换结果。

## 两种识别模式

面板上有一个开关，也可以在配置里定死。默认是 `rules`。切到 `api` **不需要填任何 key**：
它复用你当前会话自己的模型路由（见下）。

| 模式 | 跑什么 | 花多少 | 适合 |
| --- | --- | --- | --- |
| `rules` | 纯正则 + 结构信号，本地状态机 | 零调用、零延迟、离线可用 | 日常默认，隐私敏感 |
| `api` | 规则先跑，只有拿不准的子句才问模型 | 有缓存与三重限额，见下 | 说法千奇百怪、想少漏 |

`api` 模式不是“每句话都发一遍模型”，那样成本随聊天量线性上涨，没人用得下去。它是**漏斗**：

1. **闸门**：规则已经处理的高置信命中不进模型；只有带弱信号（`以后/回头/改天/记一下/周末再/next time` …）
   或紧挨着弱信号的子句才算可疑。一整段 2400 字的材料里通常只有 1–3 个可疑子句。
2. **批量**：一个 turn 只发一次请求，不是一条消息一次、更不是一个子句一次。
3. **裁剪**：只发子句本身 + 前后各 60 字的上下文。不发会话记录、不发 system prompt、不发工具历史。
4. **封顶**：单次最多 `maxClausesPerCall`（默认 6）个子句，回复 `maxTokens: 320`，输出语法是单字母类型码。
5. **缓存**：同一组子句 + 同一个模型，第二次直接命中（LRU 256）。
6. **限额**：`maxCallsPerHour`（6）/ `maxCallsPerDay`（60）/ `maxTokensPerDay`（40000）。超了静默退回 `rules`，
   不报错、不打扰。

面板实时显示今天花了多少：`今日 2/60 次 · 1874 token · 缓存 3 · 跳过 9`。省钱这件事得能被看见，
否则只是插件的一面之词。

模型路由默认复用当前会话自己的 provider/model（不需要第二把 key）。想用更便宜的模型记账，
配置里写 `llmProvider` / `llmModel` 即可。

```yaml
- id: intent-debt-radar
  name: dsh-intent-debt-radar
  config:
    mode: api                    # rules | api
    maxClausesPerCall: 6         # 单次请求最多问几个子句
    maxCallsPerHour: 6
    maxCallsPerDay: 60
    maxTokensPerDay: 40000
    llmProvider: ''              # 留空 = 复用会话路由
    llmModel: ''
```

## 配置

可选，写在 profile 的 `cordis.patch.yml` 里本插件条目下：

```yaml
- id: intent-debt-radar
  name: dsh-intent-debt-radar
  config:
    enabled: true                # false = 什么都不加载，什么都不看
    minConfidence: 0.5           # 低于这个置信度的候选直接丢弃
    trackAssistantPromises: true # 是否也记 Agent 自己的毁约
    maxCardsPerSession: 80       # 单会话上限，防止一个长会话把账本刷爆
    retentionDays: 120           # 已结清的卡片超过这个天数会被清理
    retentionSweep: true         # 加载时执行上面的清理；false 表示一条都不删
    startupPopupGapHours: 0      # 0 = 每次启动都弹摘要
```

## 数据放在哪

一个文件：`$DSH_HOME/intent-debt-radar/ledger.json`（没有 `DSH_HOME` 就是 `~/.dsh/…`）。
写入走临时文件 + rename 原子替换，串行化单写链。卡片 id 由债务身份哈希得出而不是自增，所以
重启后同一句话再出现是 `hits + 1`，不会变成两条。文件损坏时保留为
`ledger.json.corrupt-<时间戳>`，绝不静默覆盖。

插件只读 `session/event`、只拥有这一个文件；不写会话日志、不写待办、不排日程。

**`rules` 模式下没有任何内容离开这台机器**——纯本地正则，一个网络请求都不发。`api` 模式下
外发的只有规则拿不准的那一个子句（上下文截到 60 字内），走当前会话自己的模型路由：不额外
要 API key，不连第三方端点，结果带缓存，同一句话不会付两次钱。

## 兼容性与实测环境

- DSH `>=0.2.0-rc.2 <0.3.0`，Node `>=22`，Web 客户端。
- 一个可选 peer 依赖 `@deepseek-ai/dsh-llm`，只在 `api` 模式下使用；`rules` 模式完全不需要它。

| 项目 | 实测值 |
| --- | --- |
| DSH 运行时 | `0.2.1-rc.5`（本机 `@deepseek-ai/dsh-base` 的版本号） |
| Node / 系统 | `v24.16.0` · Windows |
| 安装方式 | profile 内 `file:` 依赖，并写进该 profile `package.json` 的 `dsh.profile.bundles` |
| 自动化测试 | 107 项全绿（`npm test`）；CI 另在 Node 22/24 × Ubuntu/Windows 上跑 |
| 界面 | 侧边栏入口、启动摘要弹窗、账本面板：本机人工走查 |

只在这一个 DSH 版本上真机跑过，其他版本没有验证记录。撞到问题请开 issue，带上 `dsh` 版本、
`mode` 配置、以及面板顶部那行 `已观察 N 条消息 · 抓到 M 次迹象`——这三样基本能定位是没加载、
没收到事件、还是没命中。

## 开发

```bash
npm test        # 模式、评分、账本往返、抽取、模型层预算/缓存，
                # 外加一个用假 HTTP 驱动 apply() 的端到端冒烟测试
npm run check   # 测试 + npm pack --dry-run
```

## 许可证

MIT
---

[English](README.en.md) · [回到顶部](#意图债务雷达--intent-debt-radar)
