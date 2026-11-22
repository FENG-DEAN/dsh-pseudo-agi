# 架构：四条契约串成的闭环

## 1. 分层职责

| 层 | 插件 | 只做 | 不做 |
| --- | --- | --- | --- |
| 存储/召回 | `pseudo-agi-memory` | Markdown 落盘、预算召回、每步注入块、候选/提交两阶段 | 不决定做什么、不调用工具 |
| 手脚 | `pseudo-agi-tools` | 只读取证、受控写入、guard 边界 | 不记忆、不决定做什么 |
| 意识脚手架 | `pseudo-agi-scaffold` | 每轮首步注入一条纪律、发 `scaffold-step` 事件 | **不路由、不选工具、不改 loop 决策、不读用户文本做分类** |
| 治理 | `pseudo-agi-governance` | 只读观察、指标、JSONL、report 工具 | 不改变任何决策 |
| 面板 | `pseudo-agi-panel` | 左侧栏入口 + 视图（知识库位置/分层/记忆/事件/工作台）；`GET /state` 只读，`POST /store` 是唯一的写路径（迁移或回滚知识库，复用 `@pseudo-agi/store` 原语，受 `dsh-auth` cookie 与 read-only 策略约束） | **除显式迁移外不写文件、不调工具、不碰 loop** |

另有一个**不是插件**的横切库 `@pseudo-agi/store`：解析知识库活动根、统计、迁移与回滚。memory / tools / governance / panel 都是它的消费者，它本身不注册任何 `ctx.*`（详见 §4.1）。

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
| `ctx.inject(['credentials'], ...)` / `ctx.inject(['sandboxPolicy'], ...)` | panel / tools | 注入的子 Fiber |
| `ctx.webServer.register({ kind: 'prefix', ... })` | panel | 返回的 `off()`，经 `ctx.effect` 持有 |
| `ctx.slots.register(...)`（客户端半侧） | panel | 随客户端模块卸载 |
| `ctx.effect(() => async () => journal.flush())` | governance | 显式注册，卸载时 await |
| `WeakMap<Agent, ...>` 脚手架/注入状态 | scaffold / memory | 随 Agent 对象回收，无显式清理 |

没有任何 `setInterval` / `fs.watch` / socket / 全局单例。`working.md` 与 `governance/*.jsonl` 是**产物**，不是资源。

## 4. 磁盘布局

`<workspace>` 默认是 `<用户主目录>/dsh-pseudo-agi`（`workspaceRoot` 留空时），**不是**宿主进程 cwd——见 §4.2。

```
<workspace>/
├── .pseudo-agi/
│   ├── store.json                    # 知识库指针：活动根在哪（见 §4.1）
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

### 4.2 工作区默认位置

`workspaceRoot` 留空 ⇒ `<home>/dsh-pseudo-agi`；显式值按原样解析（相对值按 cwd，故推荐绝对路径）。这个默认值是有意的：

- 宿主进程的 cwd 是安装目录，每台机器不同，还可能不可写；
- 用户主目录稳定且可写，未做任何配置的安装也能"装上就有地方存"；
- 想让它检索某个工程的 `docs/`，再覆盖成该工程的绝对路径。

实现只有一处（`@pseudo-agi/store` 的 `resolveWorkspaceRoot`），四层共用。

### 4.1 知识库活动根（可换位置）

上面那棵树落在 `<workspace>/.pseudo-agi` 只是**默认值**。真正的位置由指针文件决定：

```json
// <workspace>/.pseudo-agi/store.json
{ "version": 1, "root": "D:/AGI-KB/pseudo-agi", "movedAt": "…", "movedFrom": "…" }
```

解析优先级：**指针 → 配置 `storeRoot` → `<workspace>/.pseudo-agi`**。四层（memory / tools / governance / panel）都从这一个文件解析，实现只有一份：`@pseudo-agi/store`（纯库、无构建步骤、无宿主依赖）。

配置里以 `.pseudo-agi` 开头的路径（`memory.root`、`governance.root`、`tools.knowledgeRoots`）按**活动根**解析，所以搬家后不需要改任何一行的 `root`——这正是把位置放进数据而不是放进四个配置的原因。以绝对路径写死的条目则原样保留，作为"我不在乎指针"的逃生口。

`kb_store` 是唯一写入口（`status` / `relocate` / `rollback`），顺序是**复制 → 校验文件数与字节 → 最后写指针**：复制失败时活动位置原地不动；源默认保留（`move: true` 才删）；目标非空要显式 `overwrite`。`rollback` 只重新指向、不动数据，因此误搬不会丢记录。看板上「知识库位置」一行就是 `status` 的同一份数据。

`AGI_STATE.md` 与 `docs/` 留在工作区：前者是"意识正在做什么"的工程状态，后者是工程文档，都不是知识库的搬家单位。

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

## 7. 浏览器面板：客户端插件的接线约定

面板是唯一一个"两半"的层：Host 半侧跑在 DSH 进程里，Client 半侧跑在浏览器里。

**Host 半侧**只注册一条同源路由：

```js
ctx.webServer.register({ kind: 'prefix', path: '/pseudo-agi/api', handler })
```

它把所有数据（分层计数、记忆列表、治理事件、`AGI_STATE.md` 摘要）算好，用 `GET /pseudo-agi/api/state` 一次返回；只有 `GET` 存在，其余方法 405、其余路径 404。

**Client 半侧**由 `package.json` 的 `dsh.client` 声明（`platform: 'web'`、`immediately: true`、注入 `dsh-client-locale` / `ui-renderer` / `ui-layout` / `ui-sidebar`），入口是 `exports['./client']`，代码必须包在 `window.__ModuleLoader__.load({ id, factory })` 里，靠 `require('react')` 取共享依赖。

**两个 slot**（`client.js:239,244`）：

| slot | 作用 |
| --- | --- |
| `sidebar.panellist` | 左侧栏的入口行：「鲸鱼娘 AGI」 |
| `main` | 打开后占据主区域的面板主体 |

两者都用 `ctx.slots.inject(name, () => ctx.slots.register({ ... }))` 注册，随模块卸载自动回收。面板的中英文案走 `ctx.locale.register(NS, STRINGS)`，配色全部用 `--dsw-alias-*` 主题变量，不写死颜色。

**鉴权是面板自己的责任，不是宿主给的。** 插件 prefix 路由不在 Host Connection 的鉴权覆盖内（`dsh-host-webserver` 的 `register()` 签名里没有任何 auth 参数），所以面板必须自验浏览器会话 cookie：从 `ctx.inject(['credentials'])` 拿 `client-connection/browser-session` 的 secret，按 `dsh-auth-<sha256(authority)>` 验 HMAC-SHA256 签名，并校验 cookie 绑定的 authority 与请求 `host` 一致、未过期。拿不到 secret（最小宿主）时放行并只告警一次，避免把面板锁死。

> 同类的 `@local/dsh-preset-editor` 也注册了 prefix 路由却**不做任何鉴权**（`index.js:261-266`）——这是 DSH 插件生态的常态，不是本工程的疏漏。本工程选择多做一层，是因为面板会把 `AGI_STATE.md` 全文和全部记忆标题吐出去。
