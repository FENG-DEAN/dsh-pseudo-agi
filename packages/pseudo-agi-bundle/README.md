# @pseudo-agi/bundle

分发单元，不是插件。这个包唯一的职责是：在 `package.json` 里声明

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

并随包发布 [cordis.patch.yml](cordis.patch.yml)。Loader 按包名导入四行插件，`config` 整体替换（不深合并）。

四层可单独禁用。只想要最小闭环时，启用 `@pseudo-agi/memory` 与 `@pseudo-agi/tools` 两行即可。

安装与验收见仓库根目录的 [docs/install.md](../../docs/install.md)。
