# AGI_STATE — 意识的当前工作台

> 由模型（意识）在开工/收工时维护：这是"我正在做什么"，不是事实记忆。
> 事实记忆在 `.pseudo-agi/memory/`，用 `memory_recall` 取。
> 最近更新：2026-11-22（真机装载后首版）

## 当前目标

在 DSH 的插件契约内，跑通一个**意识=模型 / 记忆=知识库 / 手脚=工具**的伪AGI，并让它在真机上持续工作、跨会话不失忆。

## 架构共识（已定，不再反复讨论）

1. **意识就是模型本身**。不做 `pseudo-agi-controller`——把"先检索还是先动手"编码成关键词 if-else 是对判断力的降级，不是意识层。
2. **记忆 = 知识库 Markdown**。文件是真源，检索与注入是投影；删索引不丢信息。
3. **手脚 = 工具**。路径边界由 `guard`（单调否决）保证，`approval` 不做人工闸门。
4. **可回滚性由 git 提供**，替代同步审批。写坏了用 `git diff` / `git checkout`，而不是每次点确认。
5. **两种记忆分离**：事实记忆（`.pseudo-agi/memory/`）回答"我知道什么"，本文件回答"我正在做什么"。

## 已完成

- 四包工程（memory / tools / controller / governance）+ bundle；`pnpm verify` 全绿（smoke 27/27、load-test 18/18）。
- 真机装载 memory + tools 两层：7 个工具可用，每步注入块出现在上下文。
- 记忆闭环真机通过：`memory_candidate` → `memory_commit` → 落盘 → `memory_recall` 命中 → 每步注入。
- 路径围栏真机生效：`kb_read({path:"../escape.md"})` 返回"路径越界"。
- 写入改为无感（`writeRequiresApproval: false`），边界交给 guard。
- git 基线 `82dfb5f`，正式记忆文件入库。

## 下一步（按优先级）

1. **验证无感写入**：本文件由 `controlled_write` 创建成功即通过；再用一次越界写入确认 guard 仍在。
2. **每轮收工 commit**：把记忆与文档变更落成 git 提交，形成可追溯的意识轨迹。
3. **沉淀知识库**：把 DSH 插件契约的关键结论写进 `docs/`，让"查得到"替代"记得住"。
4. **跨会话连续性验证**：新会话冷启动时，只靠本文件 + `memory_recall` 能否恢复状态。
5. **评估 governance**：只读指标（工具失败率、记忆命中率）是否有用；它不干预决策。

## 阻塞 / 待决

- 无阻塞。
- 待决 1：`controller` 是否永久放弃 —— 当前判断：放弃。若将来真需要"强制先取证"，用一条常驻 `systemPrompt` 约束，而不是写插件。
- 待决 2：`governance` 是否启用 —— 需要一次重启，收益是可观测性。

## 运行环境

- profile：`C:\Users\FDA\.dsh\profiles\desktop`（只挂 memory + tools）
- 工程：`D:\Doc\AIDoc\Dsh_dev\dsh_agi_dev`
- 记忆根：`.pseudo-agi/memory`（git 跟踪，`working.md` 与 `candidates/` 不入库）
- 知识根：`docs/` + `.pseudo-agi/memory/`
- 审批策略：会话级 `never`；写工具已不 `ask`，因此不受其影响

## 验证记录

### 2026-11-22 · 无感写入与围栏共存

- `controlled_write({ path: "AGI_STATE.md" })` → 无审批直接成功，3013 bytes，新建。
- `controlled_write({ path: "../escape.md" })` → `Error: 路径越界："../escape.md" 不在工作区 D:\Doc\AIDoc\Dsh_dev\dsh_agi_dev 内`。
- 结论：审批已退出管线（`writeRequiresApproval: false`），拦截来自 `guard`；**无感写入与强制边界可以同时成立**。
- 下一步 1 完成，代办列表前进到"每轮收工 commit"。

## 启动协议（每轮固定动作）

1. **开工**：`kb_read({ path: "AGI_STATE.md" })` 读本文件的目标 / 下一步 / 阻塞；再用 `memory_recall` 取相关事实记忆（procedural 层已存这条协议，冷启动会自动带出来）。
2. **干活**：检索用 `kb_search`（结果必须带 `path:line`，没有就回答"没找到"）；写入用 `controlled_write`（无感，`guard` 兜底路径边界）。
3. **收工**：追加"验证记录"，改写"下一步"，然后 `git add -A && git commit`。
4. **不做**：不用关键词控制器替我决定路由；不把未确认的推断写进 `semantic` 层（先 `memory_candidate`，想清楚再 `memory_commit`）。

### 2026-11-22 · 控制器改造为脚手架，四层齐装

- `pseudo-agi-controller` → **`pseudo-agi-scaffold`**：`router.ts` 整体删除（关键词表、`decideRoute`、`lastUserText` 全部移除）。现在只做两件事：每轮首步注入一条纪律（`agent/pre-step`，先 `await next()` 再追加）、发 `pseudo-agi/scaffold-step` 事件。
- 判定写进代码注释与文档：**"这一步做什么"属于模型的判断，插件不许碰**。脚手架不读用户文本、不看工具列表。
- 事件与指标改名：`pseudo-agi/controller-decision` → `pseudo-agi/scaffold-step`；governance 的 `controllerSteps/Injections` → `scaffoldSteps/Injections`，无意义 `routes` 字段删除。
- profile 装配升级：memory + tools + scaffold + governance **四层全部 link 并写入 patch**，`pnpm profile-check` 11/11 通过。
- 本地验证：smoke 25/25、load-test 18/18，其中新增断言「脚手架的注入文本里不含 `路由=`」。
- 待真机验证（重启后）：纪律是否每轮首步出现一次、`governance_report` 是否可用、`.pseudo-agi/governance/*.jsonl` 是否真的被事件串起来。
