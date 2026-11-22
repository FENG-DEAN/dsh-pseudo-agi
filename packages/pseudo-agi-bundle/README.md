# @pseudo-agi/bundle

分发单元，不是插件。这个包唯一的职责是：在 `package.json` 里声明

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

并随包发布 [cordis.patch.yml](cordis.patch.yml)。Loader 按包名导入五行插件，`config` 整体替换（不深合并）。

五行可单独禁用。只想要最小闭环时，启用 `@pseudo-agi/memory` 与 `@pseudo-agi/tools` 两行即可。

## 知识库位置

每行都带 `storeRoot: .pseudo-agi`，但那只是**默认值**：真正的位置由 `<workspaceRoot>/.pseudo-agi/store.json` 决定，五行共用同一个指针文件。要搬家，让模型执行
`kb_store({ action: "relocate", to: "<绝对路径>" })`，**不要**手工改五行的 `root`——那五处不同步正是本项目已经犯过两次的错误。

`@pseudo-agi/store` 不是插件行，而是三个层的运行时依赖：`pnpm pack` 时它的 tarball 必须一起分发（见 `docs/install.md` §2 的 `overrides`）。

安装与验收见仓库根目录的 [docs/install.md](../../docs/install.md)。
