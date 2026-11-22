# AGI_STATE — 意识的当前工作台

> 由模型（意识）在开工/收工时维护：这是"我正在做什么"，不是事实记忆。
> 事实记忆在 `.pseudo-agi/memory/`，用 `memory_recall` 取；工具轨迹在 `.pseudo-agi/governance/*.jsonl`。
> 最近更新：2026-11-22（五层 + 管理面板真机验收后）

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
| 治理 | `@pseudo-agi/governance` | ✅ `governance_report` 可用；JSONL 已出现 `step`/`scaffold`/`tool`/`turn` 行 |
| 面板 | `@pseudo-agi/panel` | ✅ 侧栏「鲸鱼娘 AGI」入口真机出现（用户确认）；`GET /pseudo-agi/api/state` 200 |

伪AGI 自有工具共 8 个：`memory_recall`、`memory_candidate`、`memory_commit`、`memory_forget`、`kb_search`、`kb_read`、`controlled_write`、`governance_report`。

> 口径提醒：面板返回的 `toolCount`（真机 15）取的是**宿主全部**工具注册表 `ctx.get('tools').definitions().length`，不是上面这 8 个。两个数字都对，别拿它们互相校验。

## 下一步（按优先级）

1. **面板路由鉴权**：`GET /pseudo-agi/api/state` 无鉴权返回 200（含 `AGI_STATE.md` 全文与全部记忆标题），而 GUI 首页 `/` 返 401。先查清「prefix 路由不走 auth」是 DSH 既定契约还是缺口，再决定补鉴权还是记录为设计如此。
2. **补充文档**：把"写盘必须显式 workspaceRoot"这条教训写进 `docs/spec-compliance.md` 缺陷清单；把 `sidebar.panellist` slot 约定补进文档（`kb_search` 扫 7 个文件未找到）。
3. **跨会话连续性**：下次冷启动只靠本文件 + procedural 记忆能否恢复状态——已部分验证两次。
4. **评估 bundle 分发**：`pnpm pack` + `file:` 装一次，验证"npm 包 + cordis.patch.yml"这条分发路径（当前是 `link:` 五包）。
5. **沙箱**（见待决 2）：`ctx.sandbox` 仍未接。

已完成（移出队列）：四层架构记忆已落盘 `mem-20261122-d9b9a84f`；`turn` 类 JSONL 行已在真机 events 中见到。

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

### 2026-11-22 · 鲸鱼娘 AGI 管理面板（左侧栏入口）

- 新增 `packages/pseudo-agi-panel`：Host 侧只注册一个同源只读路由 `/pseudo-agi/api/state`；Client 侧 `window.__ModuleLoader__.load` + `ctx.slots.inject('sidebar.panellist' | 'main')`。
- 面板内容：分层计数、记忆列表（按更新时间倒序、带 confidence）、治理事件（step/scaffold/tool/memory/turn）、`AGI_STATE.md` 摘要、工具数。**只读**——不写文件、不调工具、不碰 loop。
- 与 `preset-editor` 同构：手写 ESM + 浏览器模块格式，**无构建步骤**。
- `scripts/panel-test.mjs`：真实 cordis + 假 webServer 驱动 `/state`，9/9 通过（含 404/405 与卸载撤销）。
- profile 已 link 第 5 个包并新增 patch 行，`profile-check` 12/12。
- 待验证（重启后）：侧栏出现鲸鱼图标，点击打开面板能看到实时数据。

### 2026-11-22 · 面板真机验收通过（重启后第一轮）

- **Client 侧**：用户确认左侧栏出现「鲸鱼娘 AGI」入口 —— 此前只有 `panel-test.mjs` 的 9/9 单测，这是首次真机渲染确认。
- **Host 侧**：`GET /pseudo-agi/api/state` → 200、`errors: []`；`events` 含本轮真实行：`turn:1 step:1 scaffold injected:true`、`tool kb_read callId=call_00_HSs5WEPSZcCnv95wME7Y5313 isError:false`、`turn:1`、`turn:2 step:1`（08:09–08:10）。数据是实时的，不是占位。
- **真机路由边界**：`POST /state` → 405；`GET /api/nope` → 404；`GET /api/state/`（尾斜杠）→ 404（`index.js:236-240` 只做精确等值 `state`）。与单测一致，尾斜杠 404 属已知边界而非缺陷。
- **`toolCount: 15` 的解释**：取自宿主 `ctx.get('tools').definitions().length`（`index.js:186-188`），是全部工具注册表，与伪AGI 自有的 8 个不是同一口径，两个数字都不算错。
- **profile 物证**：`cordis.patch.yml:37-84` 五层 insert 齐全；第 35-36 行「控制器与治理层先不启用」是过时注释，实际 scaffold 与 governance 都已启用并验证工作。
- **新发现（未决，已列入下一步 1）**：GUI 首页 `/` 返 401，而 `/pseudo-agi/api/state` 返 200 无鉴权，会把 `AGI_STATE.md` 全文和全部记忆标题吐给任何本机请求方。需查清是否为 DSH prefix 路由的既定契约。
