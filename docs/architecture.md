# 架构：四条契约串成的闭环

## 1. 分层职责

| 层 | 插件 | 只做 | 不做 |
| --- | --- | --- | --- |
| 存储/召回 | `pseudo-agi-memory` | Markdown 落盘、预算召回、每步注入块、候选/提交两阶段 | 不决定路由、不调用工具 |
| 手脚 | `pseudo-agi-tools` | 只读取证、受控写入、guard、审批请求 | 不记忆、不路由 |
| 意识 | `pseudo-agi-controller` | `agent/pre-step` 路由 + 注入一条指令 | 不替代 Agent Loop、不产出答案、不判定证据是否足够 |
| 治理 | `pseudo-agi-governance` | 只读观察、指标、JSONL、report 工具 | 不改变任何决策 |

控制器与治理层**没有硬依赖**：控制器只看 `ctx.tools.definitions(agent)` 这个公开视图来判断"本 agent 有没有检索/写工具"，治理层只认事件。所以四层的加载组合是自由的。

## 2. 事件契约

| 事件 | 模式 | 发出者 | 消费者 | 本工程用途 |
| --- | --- | --- | --- | --- |
| `agent/pre-step` | waterfall | Agent Loop | controller、memory、governance | 路由注入 / 刷新注入块 / 记步 |
| `agent/turn-stopping` | serial | Agent Loop | memory、controller、governance | 刷新 `working.md`（仅变化时）/ 可选反思 / 记轮次 |
| `agent/error` | emit | Agent Loop | governance | 记错误 |
| `tools/pre-execute` | waterfall | 工具管线 | tools | 写操作返回 `ask` |
| `tools/result` | emit | 工具管线 | controller、governance | 记"检索为空" / 记三元组 |
| `pseudo-agi/memory-recall` | emit | memory | governance | 命中率 |
| `pseudo-agi/controller-decision` | emit | controller | governance | 路由分布与注入率 |

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
| `WeakMap<Agent, ...>` 控制器/注入状态 | controller / memory | 随 Agent 对象回收，无显式清理 |

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

**命中路线（recall-first）**

1. `agent/pre-step` → controller 命中检索词、本 agent 有 `memory_recall`/`kb_search` → 追加一条 `pseudo-agi-controller` 消息："先取证，引用要带来源，没找到就说没找到"。
2. 同一事件里 memory 重算注入块（语义/程序/情景，预算内、置信度下限以上）。
3. 模型调用 `memory_recall` → 工具返回 `hits[]`（带 `evidence`）或 `found: false` + note。
4. `tools/result` → governance 记三元组；controller 若看到 `found: false` 置 `emptyRecall`。
5. `agent/turn-stopping` → memory 重写 `working.md`；controller（若开启 `reflectOnEmptyRecall`）`steer()` 一次"声明没找到"。

**写入路线（act-with-approval）**

1. controller 命中写操作词 → 注入"说明要改哪个文件、一次只改一件事、被拒就停"。
2. 模型调用 `controlled_write` → `tools/pre-execute` 返回 `ask` → `ctx.approval` 提示用户。
3. 批准后 `checkGuards()` → 路径越界/`.git`/`.exe` 之类在这里被**否决**（审批不能翻案）。
4. 工具体再校验 writeRoots、大小、denied，写临时文件 → 检查 `exec.signal` → rename。
5. `tools/result` → governance 记结果（不记内容）。

## 6. 设计取舍

- **为什么在 `agent/pre-step` 改 `messages`，而不是 `agent.inject()`？** pre-step 的返回值就是"这一步收哪些消息"的决定，指令因此在同一次决定里、排在请求之前、和步一起落日志。`agent.inject()` 投递到 next-step inbox，效果相近但时序受驱动状态影响；`steer()` 只留给轮末反思（它会把轮次重新打开，所以默认关闭）。
- **为什么策略指令是 user 消息？** 模型的可见内容必须走已记录通道（`createUserMessage` + 自己的 `MessageSourceMap` kind + `form: 'notice'` + 摘要），这样它能被回放、被 UI 归类、被审计。
- **为什么注入的记忆要关掉插值？** `systemPrompt.context` 默认会解析 `{{name}}`，而记忆正文是任意文本；`interpolate: false` 防止一条含 `{{` 的记忆让整次装配抛错。
- **为什么注入要每步重算？** 记忆会在同一轮里新增（本轮的 `memory_commit`），而装配发生在 pre-step 之后；重算一次的成本是几次 `readdir`。
- **为什么治理层不直接读 memory/tools 的运行时？** 事件让"关掉治理层"成为纯粹的减法，也让"关掉记忆层"时治理层仍能工作。
