# 规范对照与已知风险

对照基线：DSH `0.2.2-rc.5` 的本地 checkout（`@deepseek-ai/**` 源码与类型）。

## 1. 三条硬约束

| 约束 | 落实位置 | 说明 |
| --- | --- | --- |
| 生命周期与 disposer | 全部 `src/index.ts` | 所有注册都返回 disposer 交给 Fiber；唯一非 Cordis 资源是治理层的写队列，用 `ctx.effect(() => async () => journal.flush())` 兜底。工程内**没有** `setInterval`、`fs.watch`、自定义 socket、全局单例 |
| 工具必须 `defineTool` | `memory/src/tools.ts`、`tools/src/tools.ts`、`governance/src/tools.ts` | 8 个工具全部来自 `@deepseek-ai/dsh-tools`；参数/输出用 DSH schema DSL；`object` 节点显式 `additionalProperties`；`execute` 返回值与 `output.schema` 对齐；长任务检查 `exec.signal` |
| 安全不是可选项 | `tools/src/policy.ts`、`tools/src/workspace.ts`、`tools/src/tools.ts` | guard（单调否决）与审批（`ask`）分离；写工具二次校验；不读凭据、不落盘密钥、审计不记参数 |

## 2. 方案里的 API 名称纠正（重要）

原始方案里有几处把"概念"写成了真实 API 名，按本工程的实际落地方式列在下面，避免照着写错：

| 方案原文 | 真实契约 | 本工程做法 |
| --- | --- | --- |
| "通过 `ctx.inject()` 把决策指令注入到当前 Agent 上下文" | `ctx.inject(deps, cb)` 是 **Cordis 的服务依赖注入**（等 `systemPrompt` 可用再回调），与消息无关。消息注入是 `agent.inject(UserMessage)`（投递到 next-step inbox）、`agent.steer()`（最近一步）、`agent.send/followup`，或在 `agent/pre-step` 里改写 `messages` | `agent/pre-step` 是 waterfall，直接返回 `{ kind: 'enter', messages: [...admitted, directive] }`。`ctx.inject(['systemPrompt'], ...)` 只用来挂可选的 prompt 注册 |
| "审批走 `ctx.approval`" | 工具管线里正确姿势是 `tools/pre-execute` 返回 `{ kind: 'ask', reason, displayReason }`，由 `ctx.approval.request()` 裁决；直接在工具体里调 `approval.request()` 会绕过管线契约 | **不在工具体里调 approval**，只在 pre-execute 返回 `ask`；无归属 agent 时 fail-closed 为 `deny` |
| "`ctx.tools.guard()` 单调否决" | 正确。签名 `(exec: Readonly<ToolExecution>) => string \| ToolGuardDenial \| undefined`，**同步**，跑在所有 pre-execute 之后、工具体之前 | guard 只做同步的路径字符串判定；符号链接/存在性在工具体内 async 复核 |
| "`agent/pre-step` 事件" | 存在，waterfall，payload = `{ agent, messages, turn, step, signal, modelSelection }`，返回 `PreStepDecision` | 脚手架先 `await next()` 再追加，绝不 veto 原生决策 |
| "工具用 `ctx.tools.register(defineTool(...))`" | 正确，但定义必须含 `output: { schema, render }`，且 `render` 返回 `ContentBlock[]` | 全部工具都声明了 `output` |
| "沙箱走 `ctx.sandbox`，默认 workspace-write，升权必须显式审批并携带新的 mode" | 沙箱是独立服务/策略插件（`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-fs-sandbox` 等）的领域，工具侧没有"静默提权 + 带新 mode 的审批"这一公开契约 | **本工程不调用 `ctx.sandbox`**，改用"路径围栏 + guard + 审批"的显式降级，并在下面第 4 节写明它不是沙箱 |
| "bundle = npm 包 + `cordis.patch.yml`，`package.json` 声明 `dsh.bundle.patch`" | 正确 | `packages/pseudo-agi-bundle/package.json` 的 `dsh.bundle.patch` 指向同目录 `cordis.patch.yml`，patch 行形态为 `- insert: [...]`，与 `dsh-cua-bundle` 一致 |
| "后层配置覆盖整份 config，不能假设深合并" | 正确 | patch 注释与 `docs/install.md` 都强调：重声明一行就要重述该行全部字段 |

## 3. 构建期修掉的真实缺陷

首次 `tsc` 到全绿的这一轮，修掉五处问题，其中两处是安全/正确性缺陷：

| # | 缺陷 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `estimateTokens` 用 `chars / 3` | 中文按 1 token/字，公式**低估约 4 倍**：`maxInjectTokens: 900` 实际可能注入 3000+ token | 改为 CJK 字符按 1 token、其余按 `ceil(chars / 4)`（[budget.ts](../packages/pseudo-agi-memory/src/budget.ts)） |
| 2 | `denyReason` 用 `resolve()` 比较扩展名 | `resolve('.ps1')` 会拼成 `<cwd>\.ps1`，**禁止扩展名规则永久失效**（`.exe`/`.ps1` 可被写入） | 引入不解析的 `fold()` 只做大小写折叠；路径仍用 `comparable()`（[workspace.ts](../packages/pseudo-agi-tools/src/workspace.ts)） |
| 3 | memory 用 `process.cwd()` 解析证据 | 会话 cwd 与宿主 cwd 不一致时，召回正常但**证据校验看错目录**，合法候选被误拒 | 新增 `workspaceRoot` 配置项，`root` 与 `file` 证据都相对它解析（[config.ts](../packages/pseudo-agi-memory/src/config.ts)） |
| 4 | Config 接口字段写成 `readonly string[]` | Schemastery 的 `required().default` 要求可变数组，四包全部编译失败 | 接口改为 `string[]`（属性仍 `readonly`，不鼓励就地改配置） |
| 5 | `candidates.records.sort()` / `asJson` 返回值过宽 | 只读数组不可 `sort`；`JsonValue` 不能赋给 `Record<string, JsonValue>` | 展开后排序；新增 `asJsonObject()` 收窄 |
| 6 | governance 用 `process.cwd()` 解析 journal 目录 | 宿主 cwd 不是工程目录且不可写，`mkdir`/`append` 失败被静默吞掉，**JSONL 永远为空**，而内存指标看起来正常 | 加 `workspaceRoot`，与 memory 完全一致 |

第 3 与第 6 条是同一个毛病犯了两次：**任何写盘插件都必须显式配置 `workspaceRoot`，绝不能用 `process.cwd()`**。宿主进程的 cwd 通常不是工程目录，且可能不可写；更糟的是失败往往被静默吞掉，症状是"功能缺失"而不是"报错"。

最初预判的三个风险**全部没有触发**：`z.union(MEMORY_LAYERS)` 形态可用、`ctx.inject(['systemPrompt'], cb)` 接受 `void` 回调、`declare module '@deepseek-ai/dsh-llm'` 的 `MessageSourceMap` 合并在包根有效。

## 4. 已验证 / 未验证

| 项 | 状态 |
| --- | --- |
| 五包 `tsc` 编译 | ✅ 通过 |
| 30 项纯逻辑（smoke：格式往返、召回、候选提交、预算、脚手架纪律、围栏、策略遵守、指标、JSONL） | ✅ 通过 |
| 14 项面板路由（panel-test：数据契约、404/405、签名 cookie 鉴权、卸载撤销） | ✅ 通过 |
| 真实 `SystemPrompt` + `ToolsService` 下加载五层、注册 8 个工具 | ✅ 通过 |
| `checkGuards()` 单调否决（越界/禁止段/禁止扩展名） | ✅ 通过 |
| `controlled_write` 遵守 `ctx.sandboxPolicy`（`read-only` 拒绝 / `danger-full-access` 放行） | ✅ 真机双向验证 |
| 工具体真实读写与记忆闭环 | ✅ 通过 |
| `agent/pre-step` 注入 → `assemble()` 结果含注入块 | ✅ 通过 |
| 卸载后工具/guard/prompt context 全部回收 | ✅ 通过 |
| 装进 profile 后 GUI 内实际可用（侧栏「鲸鱼娘 AGI」入口 + 面板数据） | ✅ 真机验证 |
| 真实 LLM 往返、审批 UI 交互、`approval policy = never` 下的拒绝 | ⛔ **有意未验证**：部署里 `writeRequiresApproval: false`，审批门这条代码路径不会触发。要验需临时改配置 + 重启 + 试写一次；为一条被主动关闭的能力单独跑一轮，收益低于成本。保留为**已知空白**，不假装验过 |

## 5. 安全与性能上的已知限制

- `estimateTokens` 是估算，不是分词器；注入预算应留 20% 余量。
- 召回是线性扫描 + 词袋打分，记录数上万时应换成倒排索引（当前设计刻意保持"无持久索引可丢"）。
- `kb_search` 每次调用都重新遍历知识根；大仓库下应加 `roots` 限定或缓存（缓存会引入失效问题，故未做）。
- 记忆写入没有冲突检测：同一 id 的并发提交是最后写入者胜。
- **记忆冲突靠显式取代，不做自动裁决**：`memory_candidate` 接受 `supersedes: [id...]`，`memory_commit` 时把被取代的记录标上 `supersededBy`——文件保留在磁盘上作为历史，但默认的召回、注入、摘要都会跳过它。判断"谁取代谁"是语义判断，归模型；装置只负责执行标记与过滤。
- **冲突检测已实现，裁决仍不做**：`memory_recall` 的返回里带 `conflicts`——对命中记录两两比对，满足三项即报出这对 id 并说明共享标签：**同一层**、**共享 ≥2 个标签**、**标题重叠 ≥2 个词**。它**只报告、不过滤、不重排**，因为"哪条仍然成立"只有读者能判断；模型看到提示后用 `supersedes` 去修正。
- 这套判定是**启发式，会误报**，实测记录如下：初版「共享 ≥1 标签」把两条只同带 `真机` 标签的不同事件报成冲突；放宽到「≥2 标签」后，又把一条设计原则与触发它的事件报成冲突（两者跨层，本不可能互相矛盾），因此加上「同层」约束。收紧后真实库里 5 组查询只剩 1 对误报（两个不同阶段的验收记录）。**不再继续收紧**：再严就会连真冲突一起漏掉，而误报的代价只是多看一眼。
- 仍未做：时间序自动裁决、置信度衰减。没有声明取代关系的两条记录会一起被召回，检测只是把它们并排放到眼前。
- 治理层的 JSONL 是追加写，没有轮转；长期运行需要外部清理。
- **知识库可以移出工作区**（`store.json` 指针 + `kb_store relocate`），因此"都文件在工作区内"这条旧假设不再成立：判定读权限的是「工作区或某个已声明知识根」，判定写权限的是 `writeRoots`。能读到搬出去的库，不等于能往里写。
- 位置变更在**插件加载时**生效：`relocate` 之后不重启，四层仍在旧根上读写（`kb_store status` 立刻能看到指针，但 `memory`/`governance` 不会）。这是有意的——不让一次调用中途改变正在使用的存储根。


## 6. 围栏 + 统一策略，但都不是内核沙箱

本工程的写工具做两层检查：

- **自有围栏**：只写 UTF-8 文本，拒绝 `.exe/.dll/.bat/.ps1` 等扩展名，限制单次字节数；拒绝 `.git`、`node_modules`、`.ssh`、`.env` 等路径段；落在 `writeRoots` 之外一律拒绝（默认就是工作区根，写绝对路径才能把搬出去的知识库也设为可写），包含判定统一走 `path.relative`（Windows/macOS 大小写不敏感）。
- **DSH 统一文件策略**：`controlled_write` 与 `kb_store` 都经 `ctx.inject(['sandboxPolicy'])` 取得策略服务，用 `resolve({ session: exec.agent.session })` 解析当前会话模式，`read-only` 直接拒绝。**注意 `exec.agent` 是 `Agent` 不是 `Session`**，会话要从 `agent.session` 取——传错对象会让 resolver 抛异常，若被兜底 `catch` 吞掉，症状会伪装成"没有策略可用"。

这样一来，它与 DSH 自带的 `write`/`edit`（走 `ctx.fs`）和 `pwsh`（走 `ctx.shell`）共用一个策略归属，不再是绕过策略的后门。

但两者都**只是策略检查，不是内核边界**：检查发生在可信代码里，信任的是"模型控制的只有路径"这一前提；进程被攻破、TOCTOU、网络访问都不在覆盖范围内。真正的内核级隔离由 `ctx.sandbox` 的进程后端负责（Windows 上是 ACL 受限令牌），那是 `pwsh` 消费的，不是本工程的写工具。

## 7. 威胁 → 缓解

| 威胁 | 缓解 | 残留风险 |
| --- | --- | --- |
| 错误记忆被每轮重复注入 | 候选 → 证据校验 → 提交三阶段；置信度下限；`working.md` 可见 | 证据本身可能是错的（引用了一个错误文件）；需要人工抽查 |
| 模型用训练知识补全"没找到" | 召回/检索返回 `found: false` + 明确 note；脚手架注入"不得补全"；注入块首句写明"证据不足必须声明" | 模型仍可能违反指令，只能靠治理指标发现（记忆命中率/工具失败率） |
| 写操作越权 | `writeRoots` + denied 段/扩展名 + 同步 guard + 审批 + 工具体复核 | 审批被点"同意"时仍会写；用户是最后一环 |
| 用 `kb_store` 把知识库搬到任意位置 | `status` 之外的 action 受会话文件策略约束（`read-only` 拒绝、`workspace-write` 禁止搬出工作区）；目标不能包含/被包含于当前库；目标非空需显式 `overwrite`；复制先校验再写指针 | `danger-full-access` 下可搬到任意可写目录（这是该策略的定义） |
| 指针文件被改坏导致读错目录 | 损坏/缺字段时回退配置默认位置并给 `warning`，绝不因为一个坏 JSON 让插件加载失败 | 回退到旧根后可能读到过期数据，直到有人看 `kb_store status` |
| 审批被 guard 翻案 | guard 是单调否决，审批只作用于"这一次调用" | 无 |
| 工具卸载后残留能力 | 工具、guard、监听全部随 Fiber 回收 | 已写出的文件不回收（本来就是产物） |
| 审计日志泄密 | 只记工具名/调用 id/是否失败，不记参数与内容 | 记忆事件记录了 query 前 200 字符，可能含敏感信息；需要时把 `journal` 关掉 |

## 8. 明确的能力边界

- 不会在模型参数之外"学习"：记忆是检索增强，不是权重更新。
- 没有自主目标：脚手架只注入纪律，不产生任务；做什么仍由模型判断。
- 不能绕过 guard：没有提权通道。
- 不能自证正确：治理层只统计，不判定事实真伪。
