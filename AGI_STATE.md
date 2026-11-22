# AGI_STATE — 意识的当前工作台

> 由模型（意识）在开工/收工时维护：这是"我正在做什么"，不是事实记忆。
> 事实记忆在 `.pseudo-agi/memory/`，用 `memory_recall` 取；工具轨迹在 `.pseudo-agi/governance/*.jsonl`。
> 最近更新：2026-11-22（四层真机闭环验证后）

## 当前目标

在 DSH 的插件契约内，跑通一个**意识=模型 / 记忆=知识库 / 手脚=工具**的伪AGI，并让它在真机上持续工作、跨会话不失忆。

## 架构共识（已定，不再反复讨论）

1. **意识就是模型本身。** 曾经有过一个做关键词路由的 `pseudo-agi-controller`，已改造成 `pseudo-agi-scaffold` 并删掉全部路由逻辑——"这一步做什么"属于模型的判断，插件不许碰。
2. **记忆 = 知识库 Markdown。** 文件是真源，检索与注入是投影；删索引不丢信息。
3. **手脚 = 工具。** 路径边界由 `guard`（单调否决）保证，`approval` 不当人工闸门。
4. **可回滚性由 git 提供**，替代同步审批。写坏了用 `git diff` / `git checkout`。
5. **两种记忆分离**：事实记忆（`.pseudo-agi/memory/`）回答"我知道什么"，本文件回答"我正在做什么"。
6. **任何写盘插件都必须显式配置 `workspaceRoot`**，绝不能用 `process.cwd()`——宿主进程的 cwd 通常不是工程目录，且可能不可写。这类缺陷已出现两次。

## 当前状态（2026-11-22，真机）

| 层 | 插件 | 真机状态 |
| --- | --- | --- |
| 记忆 | `@pseudo-agi/memory` | ✅ 4 个工具；候选→提交→落盘→召回→每步注入 |
| 手脚 | `@pseudo-agi/tools` | ✅ 3 个工具；`writeRequiresApproval: false`（无感），guard 围栏真机生效 |
| 脚手架 | `@pseudo-agi/scaffold` | ✅ 每轮首步注入一次纪律；`inject: []`，与工具层解耦 |
| 治理 | `@pseudo-agi/governance` | ✅ `governance_report` 可用；JSONL 已出现 `step`/`scaffold`/`tool` 行 |

工具面板共 8 个：`memory_recall`、`memory_candidate`、`memory_commit`、`memory_forget`、`kb_search`、`kb_read`、`controlled_write`、`governance_report`。

## 下一步（按优先级）

1. **沉淀四层架构结论为记忆**：本轮 `memory_recall("四层 闭环 脚手架 治理")` 返回"未找到（扫描 3 条）"——三条记忆只覆盖 guard、两层验证、启动协议，没有一条讲清整体架构。知识库有缺口，先补。
2. **验证 `turn` / `memory` 类 JSONL 行**：前者在轮末写，后者本轮已触发（未命中也会记录）。
3. **跨会话连续性**：下次冷启动只靠本文件 + procedural 记忆能否恢复状态——本轮已算部分验证（开工先读本文件成功）。
4. **补充文档**：把"写盘必须显式 workspaceRoot"这条教训写进 `docs/spec-compliance.md` 的缺陷清单。
5. **评估 bundle 分发**：`pnpm pack` + `file:` 装一次，验证"npm 包 + cordis.patch.yml"这条分发路径（当前是 `link:` 四包）。

## 阻塞 / 待决

- 无阻塞。
- 待决 1：`bundle` 分发路径未验证（`workspace:^` 依赖在 profile 里解析不了，所以现在装的是四个独立包）。
- 待决 2：沙箱（`ctx.sandbox`）仍未接；当前只有字符串层面的路径围栏。原方案要求"高危操作强制沙箱"，这是唯一完全没动的部分。

## 运行环境

- profile：`C:\Users\FDA\.dsh\profiles\desktop`（四层全挂，`link:` 到本工程）
- 工程：`D:\Doc\AIDoc\Dsh_dev\dsh_agi_dev`
- 记忆根：`.pseudo-agi/memory`（git 跟踪；`working.md`、`candidates/`、`governance/` 不入库）
- 知识根：`docs/` + `.pseudo-agi/memory/`
- 审批策略：会话级 `never`；写工具已不 `ask`，因此不受其影响

## 启动协议（每轮固定动作）

1. **开工**：`kb_read({ path: "AGI_STATE.md" })` 读本文件；再用 `memory_recall` 取相关事实记忆（procedural 层存着这条协议，冷启动会自动带出来）。
2. **干活**：检索用 `kb_search`（结果必须带 `path:line`，没有就回答"没找到"）；写入用 `controlled_write`（无感，`guard` 兜底）。
3. **收工**：追加"验证记录"，改写"下一步"，然后 `git add -A && git commit`。
4. **不做**：不做关键词路由（那是模型的活）；不把未确认的推断写进 `semantic` 层（先 `memory_candidate`，想清楚再 `memory_commit`）。

## 验证记录

### 2026-11-22 · 无感写入与围栏共存

- `controlled_write({ path: "AGI_STATE.md" })` → 无审批直接成功，3013 bytes，新建。
- `controlled_write({ path: "../escape.md" })` → `Error: 路径越界："../escape.md" 不在工作区 D:\Doc\AIDoc\Dsh_dev\dsh_agi_dev 内`。
- 结论：审批已退出管线（`writeRequiresApproval: false`），拦截来自 `guard`；无感写入与强制边界可以同时成立。

### 2026-11-22 · 控制器改造为脚手架，四层齐装

- `pseudo-agi-controller` → `pseudo-agi-scaffold`：`router.ts` 整体删除（关键词表、`decideRoute`、`lastUserText`）。
- 事件与指标改名：`pseudo-agi/controller-decision` → `pseudo-agi/scaffold-step`；`controllerSteps/Injections` → `scaffoldSteps/Injections`，`routes` 字段删除。
- 本地验证：smoke 25/25、load-test 18/18，含断言「脚手架注入文本里不含 `路由=`」。

### 2026-11-22 · 发现并修复 governance 的 cwd 依赖

- 内存指标正常但 JSONL 为空：`process.cwd()` 解析 `root`，宿主 cwd 不是工程目录且不可写，`mkdir`/`append` 失败被静默吞掉。
- 修法：加 `workspaceRoot`（与 memory 一致），patch 显式指向工程目录。

### 2026-11-22 · 四层闭环真机验证（本轮）

- 纪律注入：本轮开头出现 `[伪AGI·脚手架] 本轮纪律`，四条纪律 + "不是用户提出的新需求"。
- 治理工具：`governance_report` 出现在工具面板（8 个），返回「步 1；脚手架注入 1/1」。
- **事件串联物证**：`.pseudo-agi/governance/session-<id>.jsonl` 已含三类行——
  `{"kind":"step","detail":{"turn":21,"step":1,"messages":1}}`、
  `{"kind":"scaffold","detail":{"turn":21,"step":1,"injected":true}}`、
  `{"kind":"tool","detail":{"name":"kb_read","callId":"...","isError":false}}`。
- 覆盖缺口：`memory_recall("四层 闭环 脚手架 治理")` → 未找到（扫描 3 条），三条记忆里没有一条讲整体架构。
