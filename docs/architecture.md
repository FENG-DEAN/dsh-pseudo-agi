# 架构：四条契约串成的闭环

## 1. 分层职责

| 层 | 插件 | 只做 | 不做 |
| --- | --- | --- | --- |
| 存储/召回 | `pseudo-agi-memory` | Markdown 落盘、预算召回、每步注入块、候选/提交两阶段 | 不决定做什么、不调用工具 |
| 手脚 | `pseudo-agi-tools` | 只读取证、受控写入、guard 边界 | 不记忆、不决定做什么 |
| 意识脚手架 | `pseudo-agi-scaffold` | 每轮首步注入一条纪律、发 `scaffold-step` 事件 | **不路由、不选工具、不改 loop 决策、不读用户文本做分类** |
| 治理 | `pseudo-agi-governance` | 只读观察、指标、JSONL、report 工具 | 不改变任何决策 |

**判断权归模型**。scaffold 必须 `await next()` 之后只追加、不否决；它没有关键词表，也不看 `ctx.tools.definitions()`。四层之间没有硬依赖，加载组合是自由的。

## 2. 事件契约

| 事件 | 模式 | 发出者 | 消费者 | 本工程用途 |
| --- | --- | --- | --- | --- |
| `agent/pre-step` | waterfall | Agent Loop | scaffold、memory、governance | 纪律注入 / 刷新注入块 / 记步 |
| `agent/turn-stopping` | serial | Agent Loop | memory、governance | 刷新 `working.md`（仅变化时）/ 记轮次 |
| `agent/error` | emit | Agent Loop | governance | 记错误 |
| `tools/pre-execute` | waterfall | 工具管线 | tools | 写操作按配置返回 `ask`（默认关闭） |
| `tools/result` | emit | 工具管线 | governance | 记工具三元组 |
| `pseudo-agi/memory-recall` | emit | memory | governance | 记忆命中率 |
| `pseudo-agi/scaffold-step` | emit | scaffold | governance | 纪律注入率 |

两个 `pseudo-agi/*` 事件由插件自己声明、自己发；`declare module '@deepseek-ai/cordis'` 扩展 `Events` 接口，类型检查覆盖 payload。

> **waterfall 的纪律**：观察者也必须 `return next()`。治理层在 `agent/pre-step` 上"先记录再 `next()`"，否则会 veto 掉每一个步。

## 3. 注册与释放清单

插件卸载、配置热重载、依赖服务消失时，下面每一项都由 Fiber 回收：

| 注册 | 归属 | 释放方式 |
| --- | --- | --- |
| `ctx.tools.register(...)` × 8（memory 4 + tools 3 + governance 1） | memory / tools / governance | 返回的 disposer，Fiber 持有 |
| `ctx.tools.guard(...)` | tools | 同上 |
| `ctx.on('tools/pre-execute')`、`ctx.on('agent/pre-step')` 等 12 个监听 | 各自插件 | `ctx.on` 内部 `fiber.effect` |
| `ctx.inject(['systemPrompt'], ...)` | memory | 注入的子 Fiber |
| `ctx.effect(() => async () => journal.flush())` | governance | 显式注册，卸载时 await |
| `WeakMap<Agent, ...>` 脚手架/注入状态 | scaffold / memory | 随 Agent 对象回收，无显式清理 |

没有任何 `setInterval` / `fs.watch` / socket / 全局单例。`working.md` 与 `governance/*.jsonl` 是**产物**，不是资源。

## 4. 磁盘布局

```
<workspace>/
├── .pseudo-agi/
│   ├── working.md                    # memory 的投影：树变化时刷新（可删）
│   ├── memory/
│   │   ├── working/   <id>.md        # 本任务用
│   │   ├── episodic/  <id>.md        # 发生过什么
│   │   ├── semantic/  <id>.md        # 稳定事实
│   │   ├── procedural/<id>.md        # 怎么做
│   │   └── candidates/<id>.md        # 未提交候选，召回/注入都看不到
│   └── governance/
│       └── <sessionId>.jsonl         # 决策-行动-结果三元组
└── docs/                              # kb_search / kb_read 的知识根
```

记录格式：Markdown + JSON 值 front matter（不用 YAML 依赖，round-trip 无损）：

```markdown
---
id: "mem-20260204-1a2b3c4d"
layer: "semantic"
title: "部署用 pnpm，不用 npm"
confidence: 0.9
tags: ["build"]
evidence: [{"kind":"file","ref":"docs/install.md"},{"kind":"tool","ref":"call_7f3"}]
createdAt: "2026-02-04T02:11:00.000Z"
updatedAt: "2026-02-04T02:11:00.000Z"
---

`pnpm build` 是唯一受支持的构建入口；`npm run build` 会跳过 workspace 顺序。
```

索引只是进程内 mtime 校验的解析缓存：删掉进程、删掉任何缓存都不会丢信息，召回永远从文件重建。

## 5. 闭环的两种走法

**取证路线**

1. `agent/pre-step` → scaffold 在本轮首步追加一条 `pseudo-agi-scaffold` 纪律消息："每个事实性断言带来源、检索为空就说没找到、写前说明意图"。它不判断"这一步是检索还是动手"。
2. 同一事件里 memory 重算注入块（语义/程序/情景，预算内、置信度下限以上）。
3. 模型自己决定调 `memory_recall` / `kb_search` → 工具返回 `hits[]`（带 `evidence` 或 `path:line`），或 `found: false` + note。
4. `tools/result` → governance 记工具三元组。
5. `agent/turn-stopping` → memory 刷新 `working.md`（仅变化时）；governance 记轮次。

**写入路线**

1. 模型决定写入 → `controlled_write`。
2. `tools/pre-execute` → 按 `writeRequiresApproval` 决定是否 `ask`；本工程配置为 `false`，直接进下一步。
3. `checkGuards()` → 路径越界/`.git`/`.exe` 之类在这里被**否决**（任何审批都不能翻案）。
4. 工具体再校验 writeRoots、大小、denied，写临时文件 → 检查 `exec.signal` → rename。
5. `tools/result` → governance 记结果（不记内容）。

## 6. 设计取舍

- **为什么脚手架在 `agent/pre-step` 改 `messages`，而不是 `agent.inject()`？** pre-step 的返回值就是"这一步收哪些消息"的决定，纪律因此在同一次决定里、排在请求之前、和步一起落日志。`agent.inject()` 投递到 next-step inbox，时序受驱动状态影响。
- **为什么纪律是 user 消息？** 模型的可见内容必须走已记录通道（`createUserMessage` + 自己的 `MessageSourceMap` kind + `form: 'notice'` + 摘要），这样它能被回放、被 UI 归类、被审计。
- **为什么脚手架不做路由？** 关键词分类会把"先取证还是先动手"从模型的判断里拿走，而这一步恰恰是唯一不能外包的部分。脚手架只注入纪律、只发事件。
- **为什么注入的记忆要关掉插值？** `systemPrompt.context` 默认会解析 `{{name}}`，而记忆正文是任意文本；`interpolate: false` 防止一条含 `{{` 的记忆让整次装配抛错。
- **为什么注入要每步重算？** 记忆会在同一轮里新增（本轮的 `memory_commit`），而装配发生在 pre-step 之后；重算一次的成本是几次 `readdir`。
- **为什么治理层不直接读 memory/tools 的运行时？** 事件让"关掉治理层"成为纯粹的减法，也让"关掉记忆层"时治理层仍能工作。
