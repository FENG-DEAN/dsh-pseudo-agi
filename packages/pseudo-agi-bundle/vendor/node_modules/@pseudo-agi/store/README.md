# @pseudo-agi/store · 知识库位置

伪AGI 的知识库（记忆记录、候选、`working.md`、治理日志）是一棵目录树。默认在
`<workspaceRoot>/.pseudo-agi`，但也可以放在别的盘或同步目录里。

位置存在**数据**里，而不是只存在配置里：

```
<workspaceRoot>/.pseudo-agi/store.json   ← 指针文件，指向当前活动根
```

四层都读这一个文件，所以"换位置"是改一处，而不是改四行配置
（`memory.root` / `tools.knowledgeRoots` / `governance.root` / `panel.storeRoot`）——
那四行正是本项目已经犯过两次的漂移缺陷。

## 解析优先级

1. 指针文件 `<workspaceRoot>/.pseudo-agi/store.json` 里的 `root`
2. 配置项 `storeRoot`（默认 `.pseudo-agi`，相对 workspaceRoot 或绝对）
3. 兜底 `<workspaceRoot>/.pseudo-agi`

指针文件放在固定工作区路径上是有意的：指针不能放在它自己指向的树里，否则会跟着树一起搬走，丢掉旧地址。

## 配置路径的映射

`storePath()` 只改写以 `.pseudo-agi` 开头的路径：

| 配置值 | 解析结果 |
| --- | --- |
| `.pseudo-agi/memory` | `<base>/memory` |
| `.pseudo-agi/governance` | `<base>/governance` |
| `memory`（不含前缀） | `<workspaceRoot>/memory` |
| `D:/other/x` | `D:/other/x`（显式位置，不受指针影响） |

也就是说：已发布的组合包配置**不用改**就自动跟随新位置；显式写死路径的调用方仍然拿得到它要的固定位置。

## 迁移与回滚

`relocateStore()` 的顺序是 **复制 → 校验 → 写指针**：

- 指针最后写，复制失败时活动位置原地不动；
- 校验比的是文件数与字节数，不一致就抛错并不改指针；
- 源数据默认**保留**（`move: true` 才删），删除数据不是常规搬家的副作用；
- 目标非空且未 `overwrite: true` 时拒绝，避免覆盖别人的目录。

`rollbackStore()` 只重新指向，不动数据——因为搬家是复制，旧树还在，所以误搬不会丢记录。

## 模块说明

这是纯库，不是 cordis 插件（和 panel 一样没有构建步骤），无宿主依赖，由
memory / tools / governance / panel 四个包 `import`。
