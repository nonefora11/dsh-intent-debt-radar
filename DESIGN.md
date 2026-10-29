# 意图债务雷达（Intent Debt Radar）— 设计草案 v0.2

DSH 插件。追踪的不是任务，而是**对话里未兑现的语义承诺**。

> 别人管 To-Do，我们管 **To-Be-Acknowledged**。
> 所有现有系统都在追踪"用户主动创建的任务"，**没人追踪"用户和 Agent 顺口放弃的那句话"**。

关联文档：[RESEARCH.md](./RESEARCH.md)（调研：别人想要什么、为什么现有方案错位）

---

## 0. 已锁定的决策（v0.2）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 抽取在哪跑 | **A：插件内独立调 `ctx.llm`**，不污染主对话 |
| 2 | 误报治理 | **不要人工确认队列**；改为「账本管理界面」+ 低置信折叠 |
| 2b | 提醒时间 | **每张卡片可设 `remindAt`**（卡片级，不是全局） |
| 2c | 启动提示 | **打开 DSH 时弹一次「当前待办状态」**，需节流（见 §4.2） |
| 3 | 通知主次 | **DSH 面板为主**；Windows 通知为辅，只推 P0 |
| 4 | Agent 承诺 | **纳入（D4）**，且为主要卖点 |
| 5 | 账本归属 | **单库 + `workspace` 字段**（见 §2.5 详解） |

---

## 1. 技术底座（已在本机 DSH 0.2.1-rc.3 核实）

### 1.1 插件形态

```js
export const name = 'dsh-intent-debt-radar'
export const inject = ['tools', 'storageDomain']   // 可选服务用 ctx.inject([...])
export function apply(ctx, config) { /* ... */ }
```

`package.json` 挂 bundle 层：

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

模板参考：`dsh-session-port`（host + client 双半边完整范例）、`dsh-everything`（最简工具插件）。

### 1.2 消息监听（核心入口）

```js
ctx.on('session/event', (session, event) => { /* ... */ })
ctx.on('session/created', (session) => { /* ... */ })
```

事件词汇表（`@deepseek-ai/dsh-session/known-event-types`）：

- `user/message` — `event.data` 即 message 本体
- `assistant/message` / `developer/message` / `system/message` — `event.data.message`
- `turn/start` / `turn/end` / `step/start` / `step/end` — 轮次边界，**闭环检测靠这个**
- `tool/call` / `tool/result` — 有没有真干活
- `todo/write` — 已转待办
- `schedule/change` — 已挂提醒 = 已闭环
- `goal/change` / `plan/mode` / `workspace/changes` — 决策落地信号

> 事件极密。廉价层必须纯正则 + 失败早退，同会话 200ms debounce 合批。

### 1.3 跨会话历史回填

```js
ctx.sessionQuery.listSessions(...) / filterSessions([...]) / readSession(...)
```

直接读 `.jsonl.zstd`，不用自己解压。装完扫最近 N 天 → **冷启动立刻有内容**。

### 1.4 跨会话持久化

```js
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
ctx.storageDomain.open(domain)
```

落 `~/.dsh/storages/`，schema 校验 + 原子写 + 迁移由框架兜。

### 1.5 提醒通道

1. **DSH 面板（主）** — 常驻 tab + 标题栏红点 + 启动摘要弹窗
2. **`ctx.schedule.create(sessionId, request, signal)`** — 到点把 prompt 推回会话
3. **系统通知（辅，仅 P0）** — client 半边 `new Notification()`；Win 走 toast，mac/linux 走各自实现；**不引入任何下载执行的 shell/PowerShell 脚本**（见 §7 安全扫描红线）

### 1.6 客户端 UI

```js
window.__ModuleLoader__.load({ id: 'dsh-intent-debt-radar', factory(require) { ... } })
```

挂载点：`sidebar.panellist` + `main` 面板（账本页）、`conversation.session.header.utilities`（本会话债务徽标）。主题只吃 `var(--dsw-alias-*)`，自动跟深浅色。

---

## 2. 数据模型

```ts
type DebtCard = {
  id: string                 // ulid
  workspace: string          // 归属工作区路径哈希；账本是单库，靠这列区分
  sessionId: string
  anchorSeq: number          // 原话所在 seq → 点击跳回原处
  anchorTime: number
  quote: string              // 原话摘录 ≤200 字（只存摘录，不复制全文）
  speaker: 'user' | 'assistant'
  kind: 'defer' | 'loop' | 'decision' | 'agent-promise'
  subject: string            // 归一化主题，用于跨轮去重
  impliedPromise: string     // "要做什么"一句话
  dueHint?: string           // "周五" / "明天"
  remindAt?: number          // 用户设的提醒时间（卡片级）
  confidence: number
  score: number
  tier: 'P0' | 'P1' | 'P2'
  status: 'open' | 'closed' | 'snoozed' | 'converted' | 'stale'
  hits: number               // 被提及次数 = 计息次数
  lastSeenAt: number
  convertedTo?: { kind: 'todo' | 'schedule', id: string }
  snoozedUntil?: number
  scorerVersion: number
}
```

### 2.1 四类债务

| 代号 | 名字 | 判据 | 成本 |
|---|---|---|---|
| **D1** | 显式推迟（用户） | 「以后再说 / 下次补 / 先这样 / 回头再 / 后面有空 / 等 X 再说」 | 纯正则，precision 必须 ≈100% |
| **D2** | 未闭环问题 | assistant 抛问题 → `turn/end` 用户没答；或用户提需求 → 该轮无 `tool/call`、无 `todo/write` | 结构信号，零语义 |
| **D3** | 搁置决策 | 「A 还是 B / 你决定 / 都行」→ 后续 2 轮无落地 | 只做粗筛 |
| **D4** | **Agent 承诺**（核心） | assistant 说「我稍后帮你改 / 下轮加」→ 此后无对应 `tool/call` | 需跨轮追踪，价值最高 |

> D4 是产品支点。调研显示用户抱怨的主语是"**它**答应了我"，不是"**我**忘了一件事"。

### 2.2 优先级公式（可解释，无黑盒）

```
score = base(kind)                    // agent-promise 7 / defer 6 / loop 5 / decision 4
      + 3 * min(hits, 4)              // 反复提及 = 反复逃避
      + 悬置天数                      // 拖得越久利息越高（封顶 14）
      + (dueHint ? 3 : 0)
      - (已闭环 ? 100 : 0)
tier: ≥12 → P0 | 6–11 → P1 | <6 → P2
```

「拖得越久越急」落在`悬置天数`一项。不用 LLM 打分 —— 不可解释的分数以后没法调。

---

## 2.5 「账本」到底是什么（详解）

这个词容易含糊，摊开说。

### 它不是
- ❌ **不是 DSH 的会话日志**。会话日志是只追加的事件流，会被压缩（billion-context 就在干这事）、被清理、被删除。债务是我们的**派生数据**，必须独立存活。
- ❌ **不是 DSH 自带 todo**。Todo 是用户主动创建的，语义是"我要做"；债务是"我说过但没做"，语义是"我欠着"。
- ❌ **不是 schedule**。定时器只是一根弦，不是记录。
- ❌ **不是散落的 markdown 文件**。那样没法去重、没法算优先级、没法跨会话查。

### 它是

**一张有状态机的表，一行 = 一张欠条。** 落在 `~/.dsh/storages/` 下的一个独立 storage domain 里（两个文件：`intent-debt.json` + schema 版本）。

之所以叫"账本"而不是"列表"，是因为它必须满足会计的四条约束：

| 会计概念 | 我们的对应 |
|---|---|
| 借方（产生） | 一句承诺被抽取入库 → `status: open` |
| 贷方（抵消） | 一次落地（`tool/call` / `todo/write` / "搞定了"）→ `status: closed` |
| 计息 | `hits + 1`、悬置天数增长 → 分数上涨 |
| 展期 | `snoozedUntil` → 用户说"我知道，先放放" |
| 转出 | `convertedTo` → 转 todo / 挂 schedule，账本里留痕但不催了 |
| 审计 | `anchorSeq` + `quote` → 每条都能点回原话，不接受"模型编的债" |

**一笔债只能被 closed 一次**，状态迁移有向：`open → {closed, snoozed, converted, stale}`，`snoozed → open`。不可逆的部分（converted）保留原始记录，不删行 —— 版本升级后 `scorerVersion` 让老卡片按新公式重算，而不是重抽。

### 归属：为什么是单库 + `workspace` 列（决策 5 的答案）

| 方案 | 好处 | 坏处 |
|---|---|---|
| **单库 + workspace 列**（采用） | 跨工作区聚合是一句 SQL；一个提醒通道看全局；并发由 storageDomain 串行化兜住 | 单文件随用量增长（十万级仍无压力） |
| 每工作区一库 | 删工作区时天然连带清理 | **跨会话/跨工作区提醒是核心卖点，多库要跨库 join**；用户设"全局提醒"就无处安放 |

**结论**：单库。工作区只作为一个可筛选的列，删工作区时把该 `workspace` 的行标 `stale`（不物理删，保留审计）。

---

## 3. 抽取管线

```
session/event
   ├─(1) 廉价触发层：正则词典 + 轮次结构   ← 本地，0 token，丢弃 ~95% 事件
   │       命中 → 切该 turn 片段（user + assistant 文本，≤1200 字）入队
   ├─(2) 抽取层：ctx.llm 异步、限流、可重试
   │       → 严格 JSON 数组 { kind, subject, impliedPromise, dueHint, confidence, quote_span }
   ├─(3) 合并去重：同 session 内 subject 3-gram Jaccard > 0.6 → 合并，hits+1
   └─(4) 闭环检测：todo/write / tool/call / schedule/change / 后续「好了、已修、不用了」
           → 相关卡片 closed（债务和任务的分水岭：它得会自己消失）
```

LLM 输出必须带 `quote_span` 且能对回原文。**卡片上显示的永远是原话，不是模型改写。** 这条决定可信度。

### 3.1 双模式落地（v0.2 已实现）

设计阶段的 (1)(2) 分层，落地成用户可见的一个开关 `mode: rules | api`：

| | `rules`（默认） | `api` |
| --- | --- | --- |
| 层 (1) 触发 | 全量跑正则 + 结构信号 | 同左，额外产出「可疑子句」清单 |
| 层 (2) 抽取 | 不跑，正则命中即建卡 | 只对可疑子句问模型，一次 turn 一次请求 |
| 成本 | 0 | 有缓存 + 三重限额（时/日调用数、日 token） |
| 失败模式 | 说法刁钻就漏 | 超预算/无路由 → 静默退回 rules |

**省 token 的六道闸**（顺序即成本顺序，前一道不过就不花后一道的钱）：

1. 结构闸：`tool/call > 0` 且无弱信号的 turn 直接跳过——真干了事，不需要问模型。
2. 子句闸：只在带弱信号（`以后/回头/改天/记一下/later/next time`…）的子句上开洞，一条 2400 字的消息通常漏出 1–3 句。
3. 裁剪闸：每句只带前后各 60 字上下文，不发会话记录、不发 system prompt、不发工具历史。
4. 批量闸：一个 turn 一次请求，单次 ≤6 子句，`maxTokens: 320`，输出用单字母类型码 `d/l/c/a`。
5. 缓存闸：sha1(PROMPT_VERSION | provider | model | 子句集) → LRU 256。
6. 预算闸：`maxCallsPerHour=6`、`maxCallsPerDay=60`、`maxTokensPerDay=40000`，超限静默降级。

模型路由复用 `session.requestHeader().config`，不额外要 key；也可以配 `llmProvider`/`llmModel` 指到便宜模型。
面板常显「今日 N/M 次 · X token · 缓存 K · 跳过 S」——省下的钱必须可见，否则只是插件的一面之词。

---

## 4. 提醒设计

### 4.1 通道分工

| 场景 | 手段 | 频率控制 |
|---|---|---|
| 常驻 | 侧栏面板 tab + 未还债计数徽标 | 不打扰 |
| 会话内 | 标题栏徽标显示"本会话 3 条债" | 被动展示 |
| 轮次结束 | 可选一行「本次对话埋了 3 条债」（默认关） | 一轮一次 |
| 跨会话 | `ctx.schedule.create` 推到下次进入的会话 | P0 每天≤1 |
| 系统级 | 系统通知，**仅 P0** | 每天≤3，且尊重"免打扰" |
| 一键处理 | 「转 todo」复用 `todo_write`；「现在处理」把卡片作为 prompt 发回当前会话 | 用户主动 |

### 4.2 启动摘要弹窗（决策 2c 的落地）

进入 DSH 主界面时，client 半边调 host 路由 `/intent-debt/summary`：

- **弹的条件**：`P0 + P1 > 0` **且** 当日未弹过（`lastStartupShownAt` 落盘）
- **弹什么**：一句话总量 + 前三条原话引文 + 两个按钮（「看看」/「今天不问」）
- **绝不**：每次刷新都弹、空账本也弹、弹超过一个卡片

理由：任何"每次启动必弹"的插件都会在第三天被卸载。节流是功能的一部分，不是优化。

### 4.3 卡片级提醒时间（决策 2b）

账本管理页每行有「提醒我」→ 日期时间选择 → 写 `remindAt` → 同时挂一条 `ctx.schedule`。到点走 §4.1 的跨会话通道。

---

## 5. 里程碑

| 阶段 | 工作量 | 交付 | 验收 |
|---|---|---|---|
| **M0** | 0.5 天 | 骨架 + `session/event` 打点（只 log 不落盘） | 真实对话说「下次再说」，终端出现命中日志 |
| **M1** | 1 天 | D1/D2 规则债务 + 账本 + `intent_debt` 工具 + 面板列表 | 面板出现卡片，点击跳回原句 |
| **M2** | 1.5 天 | `ctx.llm` 抽取 D3/D4 + 合并去重 + 闭环 + 账本管理页（含 remindAt） | 20 条标注样本：召回≥0.7，误报≤2 条/会话 |
| **M3** | 1 天 | 启动摘要弹窗 + 跨会话 schedule + 系统通知（P0）+ 转 todo / 现在处理 | 关掉再打开，P0 债被推到眼前且只弹一次 |
| **M4** | 1 天 | 跨平台 + i18n + 图标 + README + 发布流程 + 安全扫描自检 | 在干净环境 `dsh plugin add github:...` 装成功 |

**范围红线**：M0–M4 期间不做云同步、不做图表 Dashboard、不做多语言超过中英。

---

## 6. 测试策略

- **单测**：正则触发层（正负样本各 50 条）、分数公式、状态机迁移合法性。
- **回放测试**：把历史会话 zstd 做成 fixture，跑回填 → 断言抽出的卡片集合。这是最有效的回归手段。
- **精度验收**：手工标注 20 条真实对话，统计 precision / recall，写进 README 的"已知局限"。
- **安全扫描自检**：提交前本地跑一遍官方 vet 规则（无硬编码密钥、无外传端点、无下载执行）。

---

## 7. 发布与分发适配（GitHub → 插件市场）

### 7.1 两个市场，都要覆盖

| 市场 | 规模 | 入口 | 收录方式 |
|---|---|---|---|
| **dsh.so** | 22,717 条 | [提交页](https://www.dsh.so/zh/submit/) | 粘 GitHub/npm 地址 → 自动拉取 + 扫描 + 生成市场条目 |
| **awesome-dsh-plugin.com** | 7,406 条 | dshmarket 插件内置源 | 加 `dsh-plugin` GitHub topic 自动索引 |

### 7.2 收录硬性门槛（逐条对照，已抄自官方提交页）

| 要求 | 我们的对策 |
|---|---|
| DSH 兼容信号（`dsh` 字段 / manifest / `dsh-plugin` topic 至少一项） | `package.json` 有 `dsh.bundle.patch`；仓库加 `dsh-plugin` topic |
| README 带安装说明 | README 开头给 `dsh plugin --profile web add github:<owner>/dsh-intent-debt-radar` |
| SPDX 可识别开源许可证 | `LICENSE` = MIT |
| **插件 id 规范 `^[a-z0-9]+(-[a-z0-9]+)*$`** | 仓库名 + 包名固定 `dsh-intent-debt-radar`（无下划线、无大写） |
| 源码可扫描（含 JS/TS） | 纯 ESM JS，无构建产物混淆 |
| **安全扫描无阻断级发现** | 见 §7.3 红线 |
| 警告级需人工复核 | 提前消除：不 `eval`、不动态 `require` 外部路径 |

### 7.3 安全扫描红线（直接约束了我们的方案）

官方 vet 会对 **JS/TS 做 AST 分析，并扫描 shell/PowerShell 的"下载并执行"模式**。阻断项：硬编码密钥、数据外传端点、破坏性操作、挖矿特征。

三条直接影响：

1. **放弃 PowerShell toast 兜底**。任何 `iwr | iex`、`Invoke-WebRequest` + `Start-Process` 形状都会被判。改用渲染层 `new Notification()` + 平台原生命令（`notify-send` / `osascript`），且不下载任何东西。
2. **不内置遥测、不上传任何对话内容**。所有抽取结果只落本地。
3. **不 spawn 任意用户可控命令**。若必须起子进程，固定 argv、无 shell 层（`execFile` 而非 `exec`）。

### 7.4 可移植性（别按我这台机器写）

| 硬编码风险 | 对策 |
|---|---|
| `~/.dsh/profiles/desktop` | 一律用 `ctx` 给的服务，绝不自己拼 profile 路径 |
| Windows 通知 AUMID `com.deepseek.dsh` | 不写死；通知走渲染层 API，由宿主处理 |
| `C:\` 路径 / 盘符 | 全部 `path` API；storage 走 `storageDomain` |
| 只做中文 | `locale/zh.json` + `locale/en.json`，文案不内联在代码里 |
| 假设桌面端 | 面板在 web 端也必须可用；系统通知失败要静默降级，不能报错 |
| `engines.dsh` 缺失 | 声明 `"engines": { "dsh": ">=0.2.0-rc.2 <0.3.0" }` —— 市场用这个字段判兼容 |
| peerDeps 缺失 | `@deepseek-ai/*` 声明为 `peerDependencies`（市场兼容矩阵读这两个字段） |

### 7.5 发布清单

```
dsh-intent-debt-radar/
├── package.json          name/id 规范、dsh.bundle.patch、engines.dsh、peerDeps、icon
├── cordis.patch.yml      insert 一行，name 必须等于包名
├── index.js              host 半边（监听 + 抽取 + 账本 + 工具 + 路由）
├── client.js             client 半边（面板 + 启动弹窗 + 卡片交互）
├── locale/{zh,en}.json
├── icon.svg
├── LICENSE               MIT
├── README.md             中文主页：安装 / 用法 / 已知局限 / 隐私说明（不联网）
├── README.en.md          English mirror with a switcher at the top
└── test/                 正则样本、状态机、回放 fixture
```

---

## 8. 与现有能力的分工（不重复造）

- **schedule**：已有定时骨架，我们只决定「提醒什么」。
- **todo**：已是「闭环终点」，转 todo 即出口，不做第二套待办。
- **billion-context**：管上下文压缩；账本走独立 domain，**不进上下文**。
- **dsh-engram**：记**知识**（事实、偏好）；我们记**义务**（欠着的事）。两套记忆子系统。
- **dsh-loop-continue**：管 agent 单轮行为断点；我们管承诺的**存续与清偿**。
