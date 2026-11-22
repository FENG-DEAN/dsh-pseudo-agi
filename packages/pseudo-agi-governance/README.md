# @pseudo-agi/governance

只读观察器：看得到一切，不改变任何决策。

## 做什么

- 监听 memory / scaffold / tools 发的事件，累加内存指标（轮次、步数、工具调用与失败、记忆命中、脚手架注入、治理事件数）。
- 按会话把事件追加到 `.pseudo-agi/governance/session-<id>.jsonl`——**只记结构，不记参数内容**。
- 提供 `governance_report` 工具：返回步数、脚手架注入率、工具失败率、记忆命中率与最近事件尾巴。

## 不做什么

- 不否决、不重排、不注入：它连一条消息都不往上下文里放。
- 不读工具参数（审计只记工具名、调用 id、是否出错）。
- 不持有运行时引用：只通过事件观察。

> 这样设计是为了让"关掉治理层"成为纯粹的减法——关掉它，其余四层行为完全不变。

## 事件

| 事件 | 来源 | 记录内容 |
| --- | --- | --- |
| `agent/pre-step` / `agent/turn-stopping` / `agent/error` | Agent Loop | 步、轮、错误 |
| `tools/result` | 工具管线 | `{ name, callId, isError }` |
| `pseudo-agi/memory-recall` | memory | 查询词数、命中数、扫描数、是否命中 |
| `pseudo-agi/scaffold-step` | scaffold | 本轮是否注入 |

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `.` | JSONL 目录的基准。**必须显式配绝对路径**——用 `process.cwd()` 会让写入静默失败（本项目踩过两次） |
| `root` | `.pseudo-agi/governance` | 日志目录（相对 `workspaceRoot`） |
| `journal` | `true` | 是否落 JSONL；关掉后只有内存指标 |
| `maxSessions` | `256` | 内存中保留的会话数，超出按最近使用淘汰 |
| `maxRecentLines` | `50` | `governance_report` 返回的事件尾巴长度 |

## 已知限制

- JSONL 是**追加写，没有轮转**：长期运行需要外部清理，或改用 `maxSessions` + 定期归档。
- 失败被记成布尔值，不含错误文本——要看错误得回会话日志。
- 指标在内存里，进程重启即清零（JSONL 仍在盘上）。
