# AGI_STATE — 意识的当前工作台

> 由模型（意识）在开工/收工时维护：这是"我正在做什么"，不是事实记忆。
> 事实记忆在 `.pseudo-agi/memory/`，用 `memory_recall` 取；工具轨迹在 `.pseudo-agi/governance/*.jsonl`。
> 最近更新：2026-11-22（面板鉴权真机生效；浏览器 UI 待确认）

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

1. **确认浏览器面板在新鉴权下仍可用**（待用户确认）：真机 401 已成立；`client.js` 的 fetch 默认 `same-origin` 会带 cookie，逻辑上不受影响，但 UI 未亲眼确认。若面板空白，`git revert c9be26b` 即回滚。
2. **真机验证 `controlled_write` 的 read-only 拒绝**（未验证）：单测已覆盖，但当前会话策略是 `danger-full-access`，行为差异不可见。要验证需把会话策略切到 `read-only` 后试写；注意切换会影响该会话全部受限能力（含 `pwsh`），验证完须切回。
2. **补充文档**：把"写盘必须显式 workspaceRoot"这条教训写进 `docs/spec-compliance.md` 缺陷清单；把 `sidebar.panellist` slot 约定补进文档（`kb_search` 扫 7 个文件未找到）；把"插件 prefix 路由不走 Host 鉴权"写进架构文档。
3. **跨会话连续性**：下次冷启动只靠本文件 + procedural 记忆能否恢复状态——已部分验证两次。
4. **评估 bundle 分发**：`pnpm pack` + `file:` 装一次，验证"npm 包 + cordis.patch.yml"这条分发路径（当前是 `link:` 五包）。
5. **沙箱**（见待决 2）：`ctx.sandbox` 仍未接。

已完成（移出队列）：四层架构记忆已落盘 `mem-20261122-d9b9a84f`；`turn` 类 JSONL 行已在真机 events 中见到；面板路由鉴权已实现（`pseudo-agi-panel` 验 Host Connection 的签名 cookie）。

## 阻塞 / 待决

- 无阻塞。
- 待决 1：`bundle` 分发路径未验证（`workspace:^` 依赖在 profile 里解析不了，所以现在装的是四个独立包）。
- 待决 2（**已修，待真机确认**）：沙箱机制本来就在——`dsh-sandbox` / `dsh-sandbox-policy` 由 `dsh-web-app` bundle 加载，会话策略当前是 `danger-full-access`（系统提示原话："The DSH file sandbox does not restrict file modifications"）。真正的缺口不是"没接沙箱"，而是 **`controlled_write` 绕过了统一策略**：DSH 的 `write`/`edit`（走 `ctx.fs`）与 `pwsh`（走 `ctx.shell`）都受策略约束，只有我们自己实现的写工具不受。修法见验证记录。

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

### 2026-11-22 · 面板路由鉴权修复（单测过，真机待重启验证）

**根因（源码级，不是推断）**——从 `app.asar` 解出源码后确认：
- `dsh-host-webserver` 的 `register()` 只登记路由，签名里**没有任何 auth 参数**（`src/index.ts:445`），所以插件 prefix 路由天然不在 Host 鉴权覆盖范围内。
- 全宿主唯一的 401 文案来自 `dsh-client-connection/src/browser-auth.ts:385`（`writeUnauthorized`），它只挂在 Host Connection 自己的 index / connect / API 载体上。
- 鉴权模型：`dsh web` 打印的 URL 带一次性 `?token=`；访问 `/` 时 `authorizeIndex` 校验 launch token 并铸签名 cookie `dsh-auth-<base64url(sha256(authority))>`，值为 `v<ver>.<body>.<HMAC-SHA256(secret)>`、`HttpOnly; SameSite=Strict`；secret 存在 credentials，key 为 `client-connection/browser-session`（`browser-auth.ts:14,244-305`）。
- 顺带排除：`ctx.authorization` 与 HTTP 鉴权无关，它是"需要人类交互拿凭据"的 OAuth 流接缝。

**修法**：panel 自己验 cookie，不改 DSH、不复制其内部类。
- `ctx.get('credentials').readRecord('client-connection/browser-session')` 取同一 secret（该 key 运行时形态就是 `<scope>/<id>` 字符串，故无需 import 内部包）。
- `createHmac` + `timingSafeEqual` 验签名，并校验 `authority === req.headers.host`、`issuedAt <= now < expiresAt`。
- 拿不到 secret（最小宿主、单测环境）时放行且只 warn 一次——否则会把面板锁死。

**验证**：`node scripts/panel-test.mjs` → **14/14**（新增 5 例：有效 cookie→200、无 cookie→401、伪造签名→401、过期→401、authority 不符→401）；`smoke.mjs` 25/25；`profile-check.mjs` 12/12。

**未验证**：真机行为要重启后才知道——改的是 `link:` 包源码，宿主进程此刻仍持有旧模块，`/state` 现在应仍返回 200。

### 2026-11-22 · 鉴权修复真机第一次未生效（已定位，待二次重启）

- **现象**：重启后（GUI 端口 `58891` → `51628`，新进程），`GET /` 仍 401，但 `GET /pseudo-agi/api/state` 仍 **200**，带伪造 cookie 也 200 → 鉴权分支根本没进入，不是验签失败。
- **已排除**：① 代码没落盘——磁盘 `index.js` mtime 16:19:03，含 `authorize`/`secretReady`；② 进程是旧的——7 个进程 StartTime 16:20:45，晚于文件；③ 链接断了——profile 的 `@pseudo-agi/panel` 是 Junction 指向工程；④ 副本缓存——`.pnpm` 与深层扫描均无第二份 `index.js`；⑤ 记录缺失——`.credentials.yaml` 里有 `client-connection/browser-session`，`kind: grant`、`payload.version: 1`、secret 43 字符 base64url（≈32 字节）；⑥ 时序——本地复现「credentials 先于 / 后于 panel」两种顺序**都返回 401**。
- **结论（推断，待证）**：真机上 `browserSessionSecret()` 返回 `undefined`，走 `unverifiable` 放行。最可能是 `ctx.get('credentials', false)` 在插件自身 ctx 上看不到由兄弟插件提供的服务。
- **二次修法**：改用 `ctx.inject(['credentials'], cb)` 在依赖作用域内读 secret；并把 `data.auth = { enforced, reason }` 放进响应，`reason` ∈ `credentials-service-absent` / `secret-unavailable` / `secret-read-failed` / `ready`，重启后可直接判定。
- **单测**：panel-test 14/14、smoke 25/25 仍通过（无 credentials 的最小宿主仍放行，符合设计）。
- **教训**：单测全绿不等于真机生效——测试里 credentials 是同 app 直供，真机是跨插件服务，可见性条件不同。

### 2026-11-22 · 鉴权修复真机第二次生效

- **真机物证**（GUI 端口 `59213`）：`GET /` → 401（`dsh web authentication required; reopen the URL printed by dsh web.`）；`GET /pseudo-agi/api/state` 无 cookie → **401**；带伪造 cookie → **401**。这是鉴权首次在真机成立——`denied` 只可能在 secret 已加载时发生，否则会走 `unverifiable` 放行。
- **第一次失败的真正原因**（修正上一节的推断）：不是加载时序，而是**插件自身的 ctx 看不到由兄弟插件提供的服务**。本地实验"credentials 先/后于 panel"都返回 401，恰恰说明顺序无关；换成 `ctx.inject(['credentials'], cb)` 在依赖作用域里读之后才成功。
- **浏览器端**：`packages/pseudo-agi-panel/client.js:104` 的 `fetch(url, { headers: { accept } })` 未设 `credentials`，默认 `same-origin` 会带 cookie，故面板逻辑上不受影响（**UI 仍待用户确认**）。
- **参照插件对照**：`@local/dsh-preset-editor`（Junction → `D:\Doc\AIDoc\Dsh_dev\preset-editor`）同样用 `webServer.register({ kind: 'prefix' })` 且**不做任何鉴权**（`index.js:261-266`）；它的 `inject = ['agentPresets','webServer']` 只是必需依赖声明。结论：插件 prefix 路由无鉴权是生态常态，本 panel 的自验 cookie 比参考插件更严格。

### 2026-11-22 · 按三元设想收口（方案 A）

起因：用户指出上一轮偏离了目标——把「内驱 / 定时任务」当成三元（意识/记忆/手脚）的缺口去补，而它根本不在这三元里。决定严格按原设想收口。

- **撤销定时任务入口**：`C:\Users\FDA\.dsh\preset-editor\presets.json` 移除 `@deepseek-ai/dsh-tool-schedule`，文件字节数回到 **690**，与改动前完全一致；全程**未创建任何定时任务**（`schedule_list` 始终 `total:0`）。
- **记忆冲突消解**：`memory_forget mem-20261122-9d61328e`。该条两个断言均已失效——「面板无凭据即 200」（已修成 401）、「是否契约未决」（已由 `mem-20261122-0d073194` 确证）。留 `mem-20261122-0d073194` 作唯一有效版本。
- **手脚缺口重新定性**：`ctx.sandbox` 是**子进程**沙箱（约束 bash/pwsh 的文件访问），不是插件写盘 API；`dsh-fs-sandbox` 围栏的是 `ctx.fs` 的五个写操作。沙箱机制本就在（web-app bundle 加载了 `dsh-sandbox` + `dsh-sandbox-policy`），当前会话策略是 `danger-full-access`。**真正的缺口是 `controlled_write` 绕过统一策略**。
- **修法**：`createWriteGuard` 增加第三个可选参数 `modeOf(exec)`；`apply()` 用 `ctx.inject(['sandboxPolicy'], cb)`（非 `ctx.get`，见 `mem-20261122-d09e910e`）拿到服务，在 guard 里 `policy.resolve({ session: exec.agent })` 取 `mode`，`read-only` 即拒绝写入。`workspace-write` 无需额外检查——guard 原本就把写入锁在 `config.workspaceRoot` 内，比策略根更严。
- **单测**：`smoke.mjs` 25 → **30/30**，新增 5 条：read-only 拒绝、workspace-write/danger-full-access 放行、策略不削弱越界判定、无策略服务时保持原行为、策略只作用于本插件拥有的写工具。`panel-test` 14/14 未回归。
- **未验证**：真机 `read-only` 拒绝——当前会话策略是 `danger-full-access`，差异不可见；验证需切策略，而切换会影响该会话全部受限能力（含 `pwsh`），故留作待办而非擅自执行。
