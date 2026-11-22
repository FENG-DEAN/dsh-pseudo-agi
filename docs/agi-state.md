# 工作台与记忆：三份记录，三种用途

这套插件把"意识"当模型、把"记忆"当知识库、把"工具"当手脚。于是运行时会留下三类文件，它们的**归属**不同，开源仓库只带源码，不带任何一类运行时数据。

| 文件 | 回答什么 | 谁写 | 进仓库吗 |
| --- | --- | --- | --- |
| `AGI_STATE.md` | 我正在做什么 | 模型，每轮收工时 | ❌ |
| `.pseudo-agi/memory/**` | 我知道什么（事实真源） | `memory_candidate` → `memory_commit` | ❌ |
| `.pseudo-agi/governance/*.jsonl` | 发生过什么（审计） | 治理层，只追加 | ❌ |
| `<workspace>/docs/**` | 项目知识（`kb_search` 的检索根） | 人 | ✅ 属于项目 |

三类运行时数据都会记录本机绝对路径、端口、会话 id 和未公开的实验结论，所以 `.gitignore` 把它们整体排除。`.pseudo-agi/` 树由各层在首次写入时创建；`AGI_STATE.md` 由 memory 层在**首次加载时创建一份空骨架**（配置项 `createBench`，默认开；已有文件绝不覆盖，`read-only` 会话策略下跳过）。想预置一份带逐节说明的版本，从 [`templates/AGI_STATE.md`](../templates/AGI_STATE.md) 复制到工作区根，覆盖掉骨架即可。

## 工作台不是记忆

这是本设计里最容易被混为一谈的地方：

- **事实记忆**（`.pseudo-agi/memory/`）是四层结构化的记录，带证据、置信度、标签，由 `memory_recall` 召回、每步注入上下文。它回答"什么成立"。
- **工作台**（`AGI_STATE.md`）是自由文本，由模型自己维护。它回答"这一轮在做什么、下一步是什么"。它不需要证据门，也不进召回评分。

两者的交集只有一个：工作台里写下的结论，如果值得长期记住，应该走 `memory_candidate` → `memory_commit` 落成记忆。

## 启动协议

每条固定动作都是为了避免一类已知失败（见 `spec-compliance.md`）：

1. **开工**：`kb_read({ path: "AGI_STATE.md" })` 读工作台，再用 `memory_recall` 取相关事实记忆。冷启动时 procedural 层会先把这条协议本身带出来。
2. **干活**：检索用 `kb_search`（结果必须带 `path:line`，没有就回答"没找到"）；写入用 `controlled_write`（不找人盖章，边界由 `guard` 与宿主的文件策略兜底）。
3. **收工**：追加一条验证记录、改写"下一步"，然后提交（如果项目在自己的 git 仓库里）。
4. **不做**：不做关键词路由（"这一步做什么"是模型的判断）；不把未确认的推断写进 `semantic` 层（先 `memory_candidate`，想清楚再 `memory_commit`）。

## 工作台模板

```markdown
# AGI_STATE — 当前工作台

## 当前目标
## 架构共识
## 当前状态
## 下一步（按优先级）
## 阻塞 / 待决
## 运行环境
## 启动协议
## 验证记录
```

仓库里的 [`templates/AGI_STATE.md`](../templates/AGI_STATE.md) 是同一份骨架，带逐节说明，可直接复制。

## 关于"可回滚"

本工程原来的做法是把记忆与工作台放在 git 里，用 `git diff` / `git checkout` 当回滚手段。开源后这两类文件必须离开仓库边界（它们是单机数据），可回滚性改由下面三条保证：

- 记忆是 Markdown 文件，**删文件即删除记忆**，不需要索引迁移；
- `memory_candidate` → `memory_commit` 两阶段，未提交的主张不进层目录；
- `supersedes` / `supersededBy` 标记取代关系，旧记录留在磁盘上作为历史，默认召回跳过它。

需要版本化的部署可以自己把 `.pseudo-agi/` 放进私有仓库或备份工具——那是部署选择，不是插件前提。
