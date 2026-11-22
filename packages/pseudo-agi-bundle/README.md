# @pseudo-agi/bundle

分发单元，也是**唯一需要安装的包**。它把五层实现 + 知识库位置库 + 面板客户端装进一个自包含产物里，所以一条 spec 就能装齐。

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["..."] }
}
```

## 为什么自包含

插件管理器一次只接受**一条 spec**，而 `@pseudo-agi/*` 不在任何 registry 上。一个"只声明依赖"的 bundle 装上去之后必然 `ERR_PNPM_FETCH_404`（实测）。所以发布形态是：

```
pseudo-agi-bundle-<version>.tgz
└── package/
    ├── package.json            # dependencies 是真实 semver，bundledDependencies 列出六个包
    ├── cordis.patch.yml        # 五行，name 全部指向包内子路径
    ├── layers/{memory,tools,scaffold,governance,panel}.js   # export * from '@pseudo-agi/<layer>'
    ├── client.js               # 面板浏览器半侧（factory id = @pseudo-agi/bundle）
    ├── locale/
    └── node_modules/@pseudo-agi/{store,memory,tools,scaffold,governance,panel}/
```

`node_modules` 随 tarball 一起交付，pnpm 会保留（这正是 `bundledDependencies` 的含义）。

## 为什么 patch 里写 `@pseudo-agi/bundle/layers/memory`

插件 patch 的 `name` 是模块说明符，loader 用 `import.meta.resolve` 从 **profile 的 package scope** 解析（`cordis-plugin-loader` 的 `resolve.ts`）。自包含安装后 profile 里只有 `@pseudo-agi/bundle`，六个层包在它自己的 `node_modules` 里，裸包名因此解析不到；子路径从 profile 解析到 bundle，转发文件再从 bundle 目录解析到内置副本。见 [layers/README.md](layers/README.md)。

`link:` 开发安装同样可用：那时 `@pseudo-agi/<layer>` 从 `packages/pseudo-agi-bundle/node_modules` 解析到 workspace 包。

## 面板客户端

浏览器半侧由本包提供（`./client`）而不是 `@pseudo-agi/panel`：客户端模块系统按 **Loader entry 名**对账包，读到的是这个包的 `dsh.client` 声明。代价是面板入口不能再靠删掉 patch 行来卸载——停用 `pseudo-agi-panel` 行只会让面板的数据接口 404，左栏入口仍在。

## 构建与安装

```bash
pnpm pack-bundle                  # → dist/pseudo-agi-bundle-<version>.tgz + .manifest.json
pnpm add ./dist/pseudo-agi-bundle-0.1.0.tgz
pnpm add https://example.com/pseudo-agi-bundle-0.1.0.tgz   # 在线（tarball URL）
```

`pnpm bundle-test` 会打包、单 spec 安装、逐条验证五行解析与客户端半侧，并用本地 http 服务器验证 URL 安装。

安装与验收见仓库根目录的 [docs/install.md](../../docs/install.md)。
