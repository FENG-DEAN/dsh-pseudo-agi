# 构建、装载与验收

## 0. 前置

- Node ≥ 20.11，pnpm ≥ 9
- DSH `0.2.2-rc.5`（四个包的 peer 版本都钉在这个版本；跨大版本请重跑一次类型检查）

## 1. 构建与自检

```bash
pnpm install
pnpm clean:build       # tsc 不删陈旧产物：删掉的源文件会留下 .js 并被发布出去
pnpm -r run build      # 顺序由依赖图决定：memory/tools → scaffold → governance
pnpm -r run typecheck
pnpm verify            # build + smoke + store-test + load-test + panel-test + bundle-test + release-check
```

| 脚本 | 覆盖什么 |
| --- | --- |
| `pnpm smoke` | 纯逻辑，不依赖 DSH 服务：Markdown 往返、召回、候选提交、预算、脚手架纪律、路径围栏、知识库迁移、指标、JSONL |
| `pnpm store-test` | 知识库位置：指针优先级、`.pseudo-agi` 前缀映射、迁移/校验/回滚、四层默认路径一致 |
| `pnpm load-test` | 用**真实的** `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-tools` 加载四层：工具注册、guard 否决、pre-step 注入、`assemble()` 结果、卸载回收、`kb_store` 端到端 |
| `pnpm panel-test` | 面板路由、数据契约、签名 cookie 鉴权、跟随知识库指针 |
| `pnpm bundle-test` | 分发：自包含产物、单 spec 安装、patch 五行解析、面板客户端、http URL 在线安装 |
| `pnpm release-check` | 发布闸门：版本/元数据/LICENSE、stale 编译产物、tarball 清单与禁止项、组合包产物不含宿主包 |

它们都在临时目录里跑，不会碰工作区的 `.pseudo-agi/`。

## 2. 分发

包名与顺序：

| 包 | 说明 |
| --- | --- |
| `@pseudo-agi/memory` | 记忆层 |
| `@pseudo-agi/tools` | 手脚层（含 `kb_store`） |
| `@pseudo-agi/scaffold` | 意识脚手架（注入纪律，不做路由） |
| `@pseudo-agi/governance` | 治理层（对前两者只有编译期类型依赖） |
| `@pseudo-agi/panel` | 浏览器面板（Host 路由 + 客户端半侧）；面板内可发起知识库迁移/回滚（`POST /pseudo-agi/api/store`，需重启生效） |
| `@pseudo-agi/store` | 知识库位置：指针解析 + 迁移/回滚（纯库，不是插件） |
| `@pseudo-agi/bundle` | 分发单元：`dsh.bundle.patch` + `cordis.patch.yml` |

### 2.1 一条 spec 安装（在线、GitHub 或本地，推荐）

`@pseudo-agi/bundle` 是**开箱即用**的：六个实现包编译后随包携带在 `vendor/node_modules/@pseudo-agi/*`，面板客户端是包内的 `client.js`，两者都已提交进仓库。装它一个就够了，安装时不需要构建，也不需要解析任何外部包名。

```bash
pnpm pack-bundle
# → dist/pseudo-agi-bundle-0.4.0.tgz + .manifest.json（sha256、包版本、文件数）；挂 Release 用
```

四种安装入口：

| 入口 | spec |
| --- | --- |
| 本地文件 | `pnpm add ./dist/pseudo-agi-bundle-0.4.0.tgz` |
| 在线 tarball | `pnpm add https://example.com/pseudo-agi-bundle-0.4.0.tgz`（GitHub Release、静态站点、对象存储都可以） |
| GitHub 仓库 | `pnpm add "github:<owner>/<repo>#<commit>"`（仓库已带 `vendor/` 与 `client.js`，安装时不构建） |
| 插件页 | 把上面任一 spec 贴进插件管理器的安装输入框（`parseInstallSpec` 认绝对路径、tarball URL、Git 地址、registry 包名） |

为什么必须自包含：插件管理器一次只接受一条 spec，而 `@pseudo-agi/*` 不在任何 registry 上——只声明依赖的 bundle 装上去会以 `ERR_PNPM_FETCH_404` 失败（`@pseudo-agi/store` 是第一个 404 的）。**不能**用 `bundledDependencies` 解决：实测 `pnpm pack` 会顺着 workspace 软链接把宿主包（`@deepseek-ai/*`）一起打进 tarball。所以改为把编译产物复制进包内 `vendor/` 并提交，`layers/*.js` 用相对路径指向它——这样从 Git 安装（没有安装步骤）同样成立。

装好之后 profile 里只有 `@pseudo-agi/bundle` 一个包：patch 前四行解析到 `@pseudo-agi/bundle/layers/<layer>`，panel 行解析到**包根** `@pseudo-agi/bundle`——客户端模块系统只承认两段包名，三段子路径会被整行跳过（面板 host 在、左栏入口不在）。包根 `index.js` 因此就是 panel host，转发到 `vendor/…/panel/index.js`。

验收：

```bash
pnpm bundle-test
```

它打包、单 spec 安装、逐条解析五行、加载面板客户端，并用本地 http 服务器真装一次 URL——共 13 项。

### 2.2 开发形态（`link:`）

改源码即生效，代价是 profile 与工程绑在一起。把 `<repo>` 换成你克隆下来的绝对路径：

```jsonc
// profile/package.json
{
  "dependencies": {
    "@pseudo-agi/bundle": "link:<repo>",
    "@pseudo-agi/memory": "link:<repo>/packages/pseudo-agi-memory",
    "@pseudo-agi/tools": "link:<repo>/packages/pseudo-agi-tools",
    "@pseudo-agi/scaffold": "link:<repo>/packages/pseudo-agi-scaffold",
    "@pseudo-agi/governance": "link:<repo>/packages/pseudo-agi-governance",
    "@pseudo-agi/panel": "link:<repo>/packages/pseudo-agi-panel"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@pseudo-agi/bundle"] } }
}
```

同一份 `cordis.patch.yml` 在两种形态下都成立：`@pseudo-agi/bundle/layers/memory` 从 profile 解析到 bundle，转发文件再从 `node_modules` 解析到 workspace 里的 `@pseudo-agi/memory`。

### 2.3 逐层分发（七包 + `overrides`）

需要单独升级某一层、或不想用自包含产物时：

`pnpm pack` 会把 `workspace:^0.3.0` 转成 `^0.3.0`，而 `@pseudo-agi/*` 不在公共 registry 上——所以直接把 bundle 装进 profile 会解析失败。实测可行的组合是「七个 tarball + `overrides` + 七个直接依赖」：

```jsonc
// profile/package.json —— 不用 bundle、直接装六层时：每个插件包都必须是直接依赖，
// 因为 cordis patch 按包名加载，而 pnpm 的严格布局不会把嵌套依赖提升到 profile 根。
// （用 bundle 的话走 §2.1，一条 spec 就够，不需要 overrides。）
{
  "dependencies": {
    "@pseudo-agi/memory": "file:./packs/pseudo-agi-memory-0.4.0.tgz",
    "@pseudo-agi/tools": "file:./packs/pseudo-agi-tools-0.4.0.tgz",
    "@pseudo-agi/scaffold": "file:./packs/pseudo-agi-scaffold-0.4.0.tgz",
    "@pseudo-agi/governance": "file:./packs/pseudo-agi-governance-0.4.0.tgz",
    "@pseudo-agi/panel": "file:./packs/pseudo-agi-panel-0.4.0.tgz",
    "@pseudo-agi/store": "file:./packs/pseudo-agi-store-0.4.0.tgz"
  }
}
```

```yaml
# profile/pnpm-workspace.yaml —— overrides 在 pnpm 11 已迁到这里；
# package.json 里的 "pnpm.overrides" 会被忽略（只有一条警告）。
overrides:
  "@pseudo-agi/memory": "file:./packs/pseudo-agi-memory-0.4.0.tgz"
  "@pseudo-agi/tools": "file:./packs/pseudo-agi-tools-0.4.0.tgz"
  "@pseudo-agi/scaffold": "file:./packs/pseudo-agi-scaffold-0.4.0.tgz"
  "@pseudo-agi/governance": "file:./packs/pseudo-agi-governance-0.4.0.tgz"
  "@pseudo-agi/panel": "file:./packs/pseudo-agi-panel-0.4.0.tgz"
  "@pseudo-agi/store": "file:./packs/pseudo-agi-store-0.4.0.tgz"
```

`@pseudo-agi/store` 必须同时出现在两处：它是三个插件包的**运行时**依赖（不是 peer），缺了它 `memory`/`tools` 一加载就 `ERR_MODULE_NOT_FOUND`；而它们的 `^0.3.0` 只有 override 才能落回本地 tarball。bundle 不需要这一套——它自带 `vendor/`，装它一条 spec 即可（§2.1）。

外加 `.npmrc`：

```ini
auto-install-peers=false
strict-peer-dependencies=false
```

理由：这些插件把 `@deepseek-ai/*` 声明为 peer，而那些包由宿主运行时提供、不在 registry 上；让 pnpm 去自动安装必然失败。

**验证结果**（2026-11-23，pnpm 11.28.5）：七个 tarball 全部 pack 成功；按上述配置 `pnpm install --ignore-scripts --no-frozen-lockfile` 退出码 0；`node_modules/@pseudo-agi/` 下 bundle + 六个包齐全；`@pseudo-agi/{memory,tools,governance,panel,store}` 五个包 `import()` 全部成功；`bundle/cordis.patch.yml` 里引用的五个插件名**逐个 `import()` 通过**。

> 旧写法（把 overrides 放到 `package.json` 的 `pnpm` 字段）在 pnpm 11 下不生效：安装会退回 registry 并报 `ERR_PNPM_FETCH_404`。这是 2026-11-22 记录那次验证之后 pnpm 的行为变化。

**分发时要留意的两件事**：

1. `workspaceRoot` 留空即用平台默认 `<home>/dsh-pseudo-agi`，不需要配置；只有想让它检索某个工程的 `docs/` 时才覆盖成绝对路径（历史教训见 [spec-compliance](spec-compliance.md) §3：这个值**绝不能**回退到 `process.cwd()`）；
2. `writeRequiresApproval` 在 bundle 里默认为 `false`（意识即模型），需要人工闸门的部署要显式改成 `true`。

## 3. 装载

DSH 安装 bundle 的方式（插件管理器或 profile 的 `cordis.yml`）由你的部署决定，本工程只保证格式正确：

1. `@pseudo-agi/bundle` 的 `package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"` 与 `dsh.client`（面板浏览器半侧）；
2. `cordis.patch.yml` 用 `- insert: [...]` 追加五行插件（memory / tools / scaffold / governance / panel）；
3. 前四行的 `name` 是 `@pseudo-agi/bundle/layers/<layer>`；**panel 行是裸包名** `@pseudo-agi/bundle`。原因：客户端模块系统用 `exactPackageSpecifier` 判定浏览器模块，只接受 `@scope/name` 两段，三段子路径返回 undefined、整行被跳过；包根 `index.js` 就是 panel host（转发 `vendor/…/panel/index.js`），所以 panel 行既提供 host 路由，又提供 client 半侧的挂载点。`id` 是本 patch 内的唯一 id，`config` 整体传给插件的 `Config`。

如果直接写进 profile 而不用 bundle（六个包都作为 profile 直接依赖或 `link:`），等价写法是裸包名：

```yaml
- insert:
    - id: pseudo-agi-memory
      name: '@pseudo-agi/memory'
      config:
        root: .pseudo-agi/memory
    - id: pseudo-agi-tools
      name: '@pseudo-agi/tools'
      # 省略 config：workspaceRoot 用平台默认 <home>/dsh-pseudo-agi，其余字段用插件默认值
    - id: pseudo-agi-scaffold
      name: '@pseudo-agi/scaffold'
      config:
        enabled: true
        injectPerTurn: 1
    - id: pseudo-agi-governance
      name: '@pseudo-agi/governance'
      config:
        journal: true
```

> **配置是整份覆盖，不是深合并。** 后一层如果重新声明 `pseudo-agi-tools`，必须把 `knowledgeRoots`、`writeRoots` 等全部字段重述一遍，否则会被该层的默认值替换。

### 最小闭环（推荐先跑这个）

只装前两层（记忆 + 手脚），脚手架与治理层先不启用：

```yaml
- insert:
    - id: pseudo-agi-memory
      name: '@pseudo-agi/memory'
    - id: pseudo-agi-tools
      name: '@pseudo-agi/tools'
```

这已经覆盖"检索 → 行动 → 沉淀"：模型能检索知识库、召回/写入记忆、在 guard 边界内写文件。跑通之后再逐步加 `pseudo-agi-scaffold`（纪律注入）与 `pseudo-agi-governance`（可观测）。

## 4. 配置速查

### `@pseudo-agi/memory`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `''` | `root` 与 `file` 证据引用解析的基准。留空即用默认 `<home>/dsh-pseudo-agi` |
| `storeRoot` | `.pseudo-agi` | 知识库默认根；被 `<workspaceRoot>/.pseudo-agi/store.json` 指针覆盖 |
| `root` | `.pseudo-agi/memory` | 记忆树根目录。以 `.pseudo-agi` 开头时按**活动根**解析 |
| `recallLayers` | 全部四层 | 普通召回搜索哪些层 |
| `injectLayers` | semantic/procedural/episodic | 每步注入哪些层 |
| `maxInjectTokens` | `900` | 注入块 token 预算（保守估算 3 字符/token） |
| `recallLimit` | `6` | 默认命中数 |
| `minScore` | `1` | 命中绝对分下限 |
| `minCoverage` | `0.34` | 查询词覆盖下限 |
| `minConfidenceToInject` | `0.5` | 低于此置信度的记录不被注入 |
| `verifyFileEvidence` | `true` | 提交前校验 `file` 证据存在性 |
| `writeWorkingDigest` | `true` | 记忆树变化时刷新 `<root>/../working.md`（每轮首步 + 每次写入 + 轮末） |

### `@pseudo-agi/tools`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `''` | 所有相对路径的基准。留空即用默认 `<home>/dsh-pseudo-agi` |
| `storeRoot` | `.pseudo-agi` | 知识库默认根；被指针文件覆盖 |
| `knowledgeRoots` | `docs`、`.pseudo-agi/memory` | 只读检索可读的目录；`.pseudo-agi` 前缀按活动根解析，绝对路径允许在工作区外（搬家后的知识库） |
| `writeRoots` | `.` | 受控写入可写的目录；要把搬走的库设为可写就往这里加绝对路径 |
| `maxScanBytes` | `524288` | 单文件扫描上限 |
| `maxSnippetChars` | `240` | 命中行截断长度 |
| `maxWriteBytes` | `262144` | 单次写入上限 |
| `maxDepth` | `6` | 检索递归深度 |
| `writeRequiresApproval` | `true` | 写操作是否走 `ask`（本工程 profile 里设为 `false`，边界交给 guard）。`kb_store` 不受此项影响 |
| `deniedSegments` | `.git`、`node_modules`、`.ssh`、`.env` | 永不可读写的路径段 |
| `deniedExtensions` | 可执行/脚本扩展名 | 永不可写入的扩展名 |

### `@pseudo-agi/scaffold`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（`false` 时插件加载即空转） |
| `injectPerTurn` | `1` | 每轮最多注入几条纪律消息 |
| `requireEvidence` | `true` | 追加"未取证的断言须标注未经验证"一条 |
| `discipline` | 三条内置纪律 | 注入正文，可按领域替换；它不参与任何路由判断 |

### `@pseudo-agi/governance`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `''` | `root` 解析基准。留空即用默认 `<home>/dsh-pseudo-agi` |
| `storeRoot` | `.pseudo-agi` | 知识库默认根；被指针文件覆盖 |
| `root` | `.pseudo-agi/governance` | JSONL 目录。以 `.pseudo-agi` 开头时按**活动根**解析 |
| `maxSessions` | `256` | 内存指标表容量（LRU 淘汰） |
| `maxRecentLines` | `50` | `governance_report` 返回的尾部行数 |
| `journal` | `true` | `false` 时只留内存指标 |

## 5. 验收清单

装好后逐条验证（在 DSH 会话里操作）：

1. **工具出现**：让模型列出可用工具，应看到 `memory_recall`、`memory_candidate`、`memory_commit`、`memory_forget`、`kb_search`、`kb_read`、`controlled_write`、`kb_store`、`governance_report`。
2. **空召回要说没找到**：`memory_recall({ query: "从未记录过的事情" })` → `found: false`，且 note 明确"只能回答没找到"。
3. **检索带来源**：`kb_search({ query: "审批" })` → 每条命中都是 `path:line`；乱造词 → `found: false`。
4. **写入需审批**：`controlled_write({ path: "tmp/demo.md", content: "hi" })` → 触发审批；在 `approval policy = never` 的会话里应直接 `rejected`。
5. **guard 是否决不是审批**：`controlled_write({ path: "../escape.md", content: "x" })` → 即使批准也应被拒（"路径越界"）；`path: ".git/config"` 同理。
6. **证据门**：`memory_candidate` 不带 `evidence` → 参数校验失败；`evidence: [{kind:"file",ref:"不存在.md"}]` → 拒绝并列出缺失来源。
7. **沉淀闭环**：先 `kb_read` 一个真实文件 → 用它的路径做证据 `memory_candidate` → `memory_commit` → 再 `memory_recall` 应命中；`.pseudo-agi/memory/<layer>/` 下出现 Markdown 文件。
8. **每轮注入**：连续两轮对话，第二轮的系统提示里应出现 `当前长期记忆（每步刷新…）` 块（`.pseudo-agi/working.md` 同步更新）。
9. **脚手架注入**：任一轮的首步 → 会话日志出现一条 `pseudo-agi-scaffold` 来源的消息，以 `[伪AGI·脚手架] 本轮纪律` 开头；同一轮的后续步不再出现。
10. **治理数据**：`governance_report({})` 返回计数；`.pseudo-agi/governance/<sessionId>.jsonl` 每行一个 `{at, sessionId, kind, detail}`。
11. **知识库位置**：`kb_store({ action: "status" })` → 报告当前根、来源（指针/配置）、记忆条数与字节；看板顶部「知识库位置」显示同一个路径。
12. **换位置（可选，见 §6）**：`kb_store({ action: "relocate", to: "D:/AGI-KB/pseudo-agi" })` → `copiedFiles` 与 `verified: true`；重启后 `kb_store status` 的 `source` 变成 `pointer`。
13. **一条 spec 装齐**：按 §2.1 装 `dist/pseudo-agi-bundle-<version>.tgz`（或它的 URL）→ profile 的 `node_modules/@pseudo-agi/` 下**只有** `bundle` 一个目录，`bundle/node_modules/@pseudo-agi/` 下有六个；重启后五行全部挂载，左栏出现「鲸鱼娘 AGI」。
14. **卸载即消失**：停用 `@pseudo-agi/memory` 后，四个 memory 工具与该 prompt 上下文同时消失；`kb_*` 与治理仍工作。停用 `@pseudo-agi/governance` 不影响其余三层。注意自包含形态下面板入口由 bundle 的 `dsh.client` 提供，停用 `pseudo-agi-panel` 行只会让面板的数据接口 404。

## 6. 换位置存储（`kb_store`）

知识库默认在 `<workspace>/.pseudo-agi`，也可以放在别的盘或同步目录。位置只有一处真源：

```
<workspace>/.pseudo-agi/store.json      # { "version": 1, "root": "<活动根>" }
```

四层（memory / tools / governance / panel）都读它，所以**不要**手工改四行 `root`——那正是本项目犯过两次的错误（见 [spec-compliance](spec-compliance.md) §3）。

### 操作

```text
kb_store({ action: "status" })
kb_store({ action: "relocate", to: "D:/AGI-KB/pseudo-agi" })
kb_store({ action: "relocate", to: "D:/AGI-KB/pseudo-agi", overwrite: true })   # 目标非空
kb_store({ action: "relocate", to: "D:/AGI-KB/pseudo-agi", move: true })        # 复制后删源
kb_store({ action: "rollback" })                                               # 回到上一个位置
```

- `to` 是绝对路径，或相对 `workspaceRoot`；目标不能在当前库内部，也不能包含当前库。
- 顺序是 **复制 → 校验（文件数 + 字节数）→ 最后写指针**：校验不过就抛错，指针不动，活动位置原地不变。
- 源默认**保留**：误搬不丢数据，`rollback` 只改指针就能回去。只有显式 `move: true` 才删源内容（指针文件永远保留）。
- 目标非空时必须显式 `overwrite: true`，避免覆盖别人的目录。

### 生效时机

四层都在**加载时**解析位置，因此 `relocate` 之后要重启宿主（或重载插件）新位置才全面生效；`kb_store status`、看板「知识库位置」与 `kb_store` 自身每次都重新读指针，可以立刻用来确认。

### 边界

- 会话文件策略 `read-only` 下 `relocate` / `rollback` 被拒绝；`workspace-write` 下不能搬到工作区外；`danger-full-access` 无此限制。`status` 是只读动作，任何策略下都放行。
- 搬出去之后 `kb_search` / `kb_read` 仍可读（知识根可以是绝对路径）；`controlled_write` 只在 `writeRoots` 也显式包含新位置时才可写——读得到不等于写得进。
- `AGI_STATE.md` 与 `docs/` 不跟着搬：前者是工程状态，后者是工程文档。

## 7. 回滚与取证

- 停用某层 = 删掉 patch 里对应行（或 `disabled: true`），不需要改代码。
- 记忆是文件：`.pseudo-agi/memory/**` 就是 Markdown，删文件即删除记忆；想版本化就自己把这个目录纳入私有仓库或备份（开源仓库默认忽略它，见 [agi-state.md](agi-state.md)）。
- 审计是 JSONL：`kind` 取值 `step`/`turn`/`tool`/`memory`/`route`/`error`，可 grep 回放。
- `working.md` 与 `governance/*.jsonl` 都是投影/产物，可以安全删除。
- 知识库位置：删掉 `store.json` 就回到配置默认位置；数据本身不受影响（搬家是复制，不是移动）。
