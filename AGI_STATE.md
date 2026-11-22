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
