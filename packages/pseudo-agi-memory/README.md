# @pseudo-agi/memory

分层记忆层：**Markdown 是唯一真源**，检索与注入都是它的投影；删掉索引不会丢信息。

## 做什么

- 四个工具：`memory_recall`（带 `path:line` 来源或明确 `found: false`）、`memory_candidate`、`memory_commit`、`memory_forget`
- 两阶段写入：候选先进 `candidates/`，`memory_commit` 才进层目录——**未提交的主张永远不会被召回**
- 每步注入：`agent/pre-step` 按预算重算注入块，经 `systemPrompt.context` 进本次装配
- `working.md` 摘要：`agent/turn-stopping` 时刷新，且仅在内容变化时写

## 不做什么

- 不决定"该记什么"，那是模型的判断
- 不调用其他工具、不路由
- 不在没有证据时假装命中：`file` 证据会在两层都做存在性校验

## 四层

| 层 | 回答什么 |
| --- | --- |
| `working` | 这轮任务里的临时结论 |
| `episodic` | 发生过什么（事件） |
| `semantic` | 什么成立（事实） |
| `procedural` | 该怎么做（方法） |

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `.` | 解析 `root` 与 `file` 证据的基准。**必须显式配绝对路径**——宿主 cwd 通常不是工程目录 |
| `storeRoot` | `.pseudo-agi` | 知识库默认根。被 `<workspaceRoot>/.pseudo-agi/store.json` 指针覆盖，见 [@pseudo-agi/store](../pseudo-agi-store/README.md) |
| `root` | `.pseudo-agi/memory` | 记忆根。以 `.pseudo-agi` 开头时按**活动根**解析，因此换位置不用改这一行 |
| `recallLayers` | 四层全部 | `memory_recall` 默认搜索的层 |
| `injectLayers` | episodic/semantic/procedural | 每步注入的层 |
| `maxInjectTokens` | `900` | 注入预算；中文按 1 token/字估算，建议留 20% 余量 |
| `recallLimit` / `minScore` / `minCoverage` | `6` / `1` / `0.34` | 召回数量与两道门槛 |
| `minConfidenceToInject` | `0.5` | 低于此值的记录只存不注入 |
| `verifyFileEvidence` | `true` | 校验 `file` 证据是否真实存在 |
| `writeWorkingDigest` | `true` | 是否维护 `working.md` |

## 记忆格式

```markdown
---
id: "mem-20261122-abcdef12"
layer: "semantic"
title: "一句话陈述"
confidence: 0.9
tags: ["标签"]
evidence: [{"kind":"file","ref":"docs/architecture.md"}]
createdAt: "2026-11-22T00:00:00.000Z"
updatedAt: "2026-11-22T00:00:00.000Z"
supersededBy: "mem-20261122-1234abcd"   # 可选：已被谁取代
supersedes: ["mem-旧id"]                 # 可选：本记录取代了谁
---

正文……
```

**证据是强制的**：没有 `evidence` 的记录拒绝落盘。`kind` 取 `file | url | tool | session | user`。

## 取代与冲突

- **取代**：`memory_candidate` 接受 `supersedes: [id...]`，提交时给旧记录写 `supersededBy`。文件保留在磁盘上作为历史，但默认的 `scan`（召回 / 注入 / 摘要）都跳过它——可回退，改一行 front-matter 即可。
- **冲突检测**：`memory_recall` 返回 `conflicts`，对命中记录两两比对，满足**同层 + 共享 ≥2 标签 + 标题重叠 ≥2 词**即报出这对 id。它**只报告、不过滤、不重排**：哪条仍然成立是语义判断，归读者。

## 已知限制

- **不做自动裁决**：时间序、置信度衰减都没有。没声明取代关系的两条记录会一起被召回。
- 冲突检测是**启发式，会误报**（实测：两个不同阶段的验收记录会被报成一对）。
- 召回是线性扫描 + 词袋打分，记录数上万时应换倒排索引（当前刻意保持"无持久索引可丢"）。
- 写入没有并发检测：同一 id 的并发提交是最后写入者胜。
- Token 数是估算，不是分词器。
