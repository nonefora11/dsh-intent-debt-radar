# 调研：别人遇到这个问题吗？他们想让 AI 做到什么？

调研时间 2026-10-28。结论先说：**需求真实且被反复提出，但现有方案全部错位**。

---

## 一、学术侧：这个现象有正式名字

**前瞻记忆（prospective memory）** —— "记得在未来做某件事"。与"记得过去发生了什么"（回顾记忆）是两套机制。

关键数据：人类前瞻记忆失败率 **30–50%**，且**随上下文负载升高而恶化**（[Conner & Norman 相关研究索引](https://aclanthology.org/2024.clpsych-1.3.pdf)）。

这个数据对我们有两个直接含义：

1. 用户说"下次再说"然后忘掉，是**生理性**的，不是态度问题。所以"提醒"这个动作有真实价值，不是多管闲事。
2. **agent 也有前瞻记忆问题**。有研究者把这个结论直接推到 agent 身上：上下文负载越高，agent 越会"忘了自己刚才答应要做什么"（[arscontexta: auto-commit hooks eliminate prospective memory failures](https://github.com/agenticnotetaking/arscontexta/blob/2acfd5cc4473c4d06c46be63df748e77e00e2746/methodology/auto-commit%20hooks%20eliminate%20prospective%20memory%20failures%20by%20converting%20remember-to-act%20into%20guaranteed%20execution.md)）。

那份笔记的核心主张，几乎就是我们插件的设计纲领：

> 把「记得去做」（remember-to-act）转成「必然触发」（guaranteed execution）—— 用**事件触发**替代**自觉记忆**。

**这直接否决了"纯定时提醒"的方案。** 定时器问"到点了吗"，事件触发器问"条件满足了吗"。前者靠运气，后者靠结构。所以我们的账本挂在 `session/event` 上，不是挂在 cron 上。cron 只做"最后通牒"，不做主判定。

---

## 二、产品侧：一类失败，一类成功（但都跑偏了）

### 失败的：ChatGPT Tasks

OpenAI 上过"定时任务"，社区反馈两条主线：

- [ChatGPT Tasks been removed?](https://community.openai.com/t/chatgpt-tasks-been-removed/1304321/2)
- [ChatGPT Tasks (GPT-4o with Scheduled Tasks) Broken](https://community.openai.com/t/chatgpt-tasks-gpt-4o-with-scheduled-tasks-broken/1091150/22)
- [Why doesn't ChatGPT check back in as promised?](https://yomotherboard.com/question/why-doesnt-chatgpt-check-back-in-as-promised/)

用户的真实抱怨不是"没有定时器"，而是：

> "它答应了会回来跟我说，但它没回来。"

注意这句话的主语：**是 AI 没兑现承诺**，不是用户忘了任务。这说明用户把 AI 当成一个**会欠人情的对话对象**，而不是一个待办列表。这是整个产品的情绪支点 —— 我们卖的不是效率，是"这件事没掉地上"的确定感。

失败原因分析：定时任务与对话脱钩。到点弹一条"该做 X 了"，但用户早忘了 X 是在什么语境下说的，于是关掉通知，然后卸载。

### 成功的，但只服务销售：承诺追踪类产品

- [Bonfiyah Promise Tracker](https://bonfiyah.com/features/promise-tracker/) —— 追踪销售对客户许下的承诺
- [VocAI Commitments](http://vocai.net/commitments/#main) —— "Every promise, captured automatically"
- [Nynch Assist](https://www.nynch.com/assist) —— 面向商业关系的 AI 记忆层

**它们验证了"承诺追踪"是有人付钱的产品品类**，且全部聚焦**销售/客户关系**场景（因为那里一句承诺 = 一笔钱）。

没有一家做**开发者 ↔ AI Agent 的对话内承诺**。而这个场景的密度高得多：一次会话里能埋三到五条。

---

## 三、最接近的邻居：Cursor / Claude Code 用户的痛

- [How much of your prompt is re-explaining context the agent should already remember?](https://www.producthunt.com/p/vibecoding/how-much-of-your-prompt-is-re-explaining-context-the-agent-should-already-remember)
- [How are people handling context across different AI coding tools?](https://forum.cursor.com/t/how-are-people-handling-context-across-different-ai-coding-tools/159891/109)
- [Agents Window ignores sessionStart additional_context](https://forum.cursor.com/t/agents-window-ignores-sessionstart-additional-context-claude-code-project-hooks-no-longer-load-3-24-9/174143/8)

用户的原话大致是："这一轮我说了'先这样，回头再优化那个报错'，下一轮它完全不记得了，我得从头讲一遍。"

**痛点定位**：现有 AI 记忆产品（以及 DSH 生态里的 `dsh-engram`）都在解决"记住事实"（你是谁、项目用什么栈）。**没人解决"记住没做完的事"**。这是两个不同的记忆子系统，前者是知识，后者是义务。

---

## 四、DSH 生态内的近邻（已在插件市场 7,406 条里查过）

| 插件 | 做了什么 | 与我们的关系 |
|---|---|---|
| `dsh-loop-continue` | agent 叙述了下一步动作却没调工具 → 判定并续跑该轮 | **最接近**。但它只管 agent 单轮的行为断点，不管用户说的"下次再说"，也不留账 |
| `dsh-proactive` | 模型给自己设闹钟（单次/循环/cron + jitter） | 是"触发通道"，不是"债务识别"。可借鉴其唤醒机制 |
| `dsh-heartbeat` | 每 20 分钟自己醒，按兴趣搜东西推给你 | 主动打扰型，与我们"安静记账"哲学相反 |
| `dsh-engram` | 跨会话长期记忆，SQLite + FTS5 + 向量融合 | 记**知识**，不记**义务**。存储层可参考其 SQLite 做法 |
| `dph-taskboard` | 侧栏任务看板，把会话拖到四列 | 管**用户主动创建的任务**，不管顺口放弃的那句话 |
| `dsh-answer-reviewer` | 每轮回答用独立 LLM 打分，低于阈值回灌修正 | 证明"插件内独立调 LLM 做旁路判定"这条路在生态里是通的 |

**结论：这个位置是空的。** 差异化一句话：

> 所有现有系统都追踪"用户主动创建的任务"，没人追踪"用户和 Agent 顺口放弃的那句话"。

---

## 五、从调研直接改掉的三件事

1. **不做定时器驱动** → 主判定走事件（`turn/end` + 事件序列结构），定时器只做"睡够了没"的兜底。
2. **不弹"该做 X 了"** → 弹必须带**原话引文**。用户忘的不是任务，是语境。卡片上永远显示当时那句原话，这是可信度的全部来源。
3. **必须纳入 Agent 承诺（D4）** → 用户抱怨的主语是"它答应了我"，不是"我忘了一件事"。D4 才是真正的产品核心，D1（用户推迟）反而是次要的。
