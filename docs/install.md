# 构建、装载与验收

## 0. 前置

- Node ≥ 20.11，pnpm ≥ 9
- DSH `0.2.2-rc.5`（四个包的 peer 版本都钉在这个版本；跨大版本请重跑一次类型检查）

## 1. 构建与自检

```bash
pnpm install
pnpm -r run build      # 顺序由依赖图决定：memory/tools → scaffold → governance
pnpm -r run typecheck
pnpm verify            # build + smoke(27) + load-test(18)
```

- `pnpm smoke`：25 项纯逻辑，不依赖 DSH 服务（Markdown 往返、召回、候选提交、预算、脚手架纪律、路径围栏、指标、JSONL）。
- `pnpm load-test`：用**真实的** `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-tools` 加载四层，验证工具注册/guard 否决/pre-step 注入/`assemble()` 结果/卸载回收。

两者都在临时目录里跑，不会碰工作区的 `.pseudo-agi/`。

## 2. 分发

包名与顺序：

| 包 | 说明 |
| --- | --- |
| `@pseudo-agi/memory` | 记忆层 |
| `@pseudo-agi/tools` | 手脚层 |
| `@pseudo-agi/scaffold` | 意识脚手架（注入纪律，不做路由） |
| `@pseudo-agi/governance` | 治理层（对前两者只有编译期类型依赖） |
| `@pseudo-agi/bundle` | 分发单元：`dsh.bundle.patch` + `cordis.patch.yml` |

发布前 `packages/pseudo-agi-bundle/package.json` 里的 `workspace:^0.1.0` 需要换成真实版本（`pnpm publish` 会自动替换）。只想本地试跑时，用 `pnpm link`/`file:` 把四个包装进 DSH 的插件安装位置即可，只要 Loader 能按包名解析到它们。

## 3. 装载

DSH 安装 bundle 的方式（插件管理器或 profile 的 `cordis.yml`）由你的部署决定，本工程只保证格式正确：

1. `@pseudo-agi/bundle` 的 `package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`；
2. `cordis.patch.yml` 用 `- insert: [...]` 追加四行插件；
3. 每行 `name` 是包名，`id` 是本 patch 内的唯一 id，`config` 整体传给插件的 `Config`。

如果直接写进 profile 而不用 bundle，等价写法：

```yaml
- insert:
    - id: pseudo-agi-memory
      name: '@pseudo-agi/memory'
      config:
        root: .pseudo-agi/memory
    - id: pseudo-agi-tools
      name: '@pseudo-agi/tools'
      config:
        workspaceRoot: .
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
| `workspaceRoot` | `.` | `root` 与 `file` 证据引用解析的基准。**会话 cwd 与宿主 cwd 不一致时必须显式设置** |
| `root` | `.pseudo-agi/memory` | 记忆树根目录（相对 `workspaceRoot`） |
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
| `workspaceRoot` | `.` | 所有相对路径的基准 |
| `knowledgeRoots` | `docs`、`.pseudo-agi/memory` | 只读检索可读的目录 |
| `writeRoots` | `.` | 受控写入可写的目录 |
| `maxScanBytes` | `524288` | 单文件扫描上限 |
| `maxSnippetChars` | `240` | 命中行截断长度 |
| `maxWriteBytes` | `262144` | 单次写入上限 |
| `maxDepth` | `6` | 检索递归深度 |
| `writeRequiresApproval` | `true` | 写操作是否走 `ask`（本工程 profile 里设为 `false`，边界交给 guard） |
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
| `workspaceRoot` | `.` | `root` 解析基准。**宿主进程 cwd 通常不是工程目录，必须显式设置** |
| `root` | `.pseudo-agi/governance` | JSONL 目录（相对 `workspaceRoot`） |
| `maxSessions` | `256` | 内存指标表容量（LRU 淘汰） |
| `maxRecentLines` | `50` | `governance_report` 返回的尾部行数 |
| `journal` | `true` | `false` 时只留内存指标 |

## 5. 验收清单

装好后逐条验证（在 DSH 会话里操作）：

1. **工具出现**：让模型列出可用工具，应看到 `memory_recall`、`memory_candidate`、`memory_commit`、`memory_forget`、`kb_search`、`kb_read`、`controlled_write`、`governance_report`。
2. **空召回要说没找到**：`memory_recall({ query: "从未记录过的事情" })` → `found: false`，且 note 明确"只能回答没找到"。
3. **检索带来源**：`kb_search({ query: "审批" })` → 每条命中都是 `path:line`；乱造词 → `found: false`。
4. **写入需审批**：`controlled_write({ path: "tmp/demo.md", content: "hi" })` → 触发审批；在 `approval policy = never` 的会话里应直接 `rejected`。
5. **guard 是否决不是审批**：`controlled_write({ path: "../escape.md", content: "x" })` → 即使批准也应被拒（"路径越界"）；`path: ".git/config"` 同理。
6. **证据门**：`memory_candidate` 不带 `evidence` → 参数校验失败；`evidence: [{kind:"file",ref:"不存在.md"}]` → 拒绝并列出缺失来源。
7. **沉淀闭环**：先 `kb_read` 一个真实文件 → 用它的路径做证据 `memory_candidate` → `memory_commit` → 再 `memory_recall` 应命中；`.pseudo-agi/memory/<layer>/` 下出现 Markdown 文件。
8. **每轮注入**：连续两轮对话，第二轮的系统提示里应出现 `当前长期记忆（每步刷新…）` 块（`.pseudo-agi/working.md` 同步更新）。
9. **脚手架注入**：任一轮的首步 → 会话日志出现一条 `pseudo-agi-scaffold` 来源的消息，以 `[伪AGI·脚手架] 本轮纪律` 开头；同一轮的后续步不再出现。
10. **治理数据**：`governance_report({})` 返回计数；`.pseudo-agi/governance/<sessionId>.jsonl` 每行一个 `{at, sessionId, kind, detail}`。
11. **卸载即消失**：停用 `@pseudo-agi/memory` 后，四个 memory 工具与该 prompt 上下文同时消失；`kb_*` 与治理仍工作。停用 `@pseudo-agi/governance` 不影响其余三层。

## 6. 回滚与取证

- 停用某层 = 删掉 patch 里对应行（或 `disabled: true`），不需要改代码。
- 记忆是文件：`git diff .pseudo-agi/memory` 即可审阅新增/改动的记录，删文件即删除记忆。
- 审计是 JSONL：`kind` 取值 `step`/`turn`/`tool`/`memory`/`route`/`error`，可 grep 回放。
- `working.md` 与 `governance/*.jsonl` 都是投影/产物，可以安全删除。
