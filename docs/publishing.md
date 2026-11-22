# 发布

七个包：六个实现包各自发布，`@pseudo-agi/bundle` 发布**打包产物**（不是源码目录）。本文只写"怎么发、发什么、别踩什么"。

## 0. 前置

```bash
pnpm install
pnpm clean:build          # 先清 lib/dist：tsc 不会删陈旧产物
pnpm -r run build
pnpm -r run typecheck
pnpm verify               # 五套测试 + release-check
```

`pnpm release-check` 是发布闸门，逐条打印"实际会发出去的内容"：

- 七包版本一致；`publishConfig.access=public`、`engines.node`、`author`、`LICENSE` 齐备；
- 每个 `lib/` 里的 `.js` 都能在 `src/` 找到对应 `.ts`（**这一条抓到过真事故**：`scaffold` 的 `router.js` 在源码删除后仍被发布）；
- 六个层包的 tarball 清单：必含 `package.json`/`README.md`/`LICENSE`/入口，禁含 `.map`、`node_modules/`、`dist/`、测试文件、`workspace:` 协议；
- 组合包产物：自包含六个实现包、五行入口、`client.js`、`LICENSE`，且**不含任何 `@deepseek-ai/*`**；
- 源码目录的 `prepublishOnly` 闸门在位。

## 1. 认证

```bash
npm login                      # 或：
pnpm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
```

scoped 包默认是私有的，所有包都已声明 `publishConfig.access: "public"`；命令行再带一次 `--access public` 也无害。

## 2. 发布六个实现包

```bash
pnpm -r publish --access public --no-git-checks
```

`-r` 按 workspace 拓扑序发布（`store` 先于依赖它的三个层），并跳过 `private` 的根包。等价的手工顺序：

```bash
pnpm --filter @pseudo-agi/store publish --access public
pnpm --filter @pseudo-agi/memory publish --access public
pnpm --filter @pseudo-agi/scaffold publish --access public
pnpm --filter @pseudo-agi/tools publish --access public
pnpm --filter @pseudo-agi/governance publish --access public
pnpm --filter @pseudo-agi/panel publish --access public
```

## 3. 发布组合包（产物，不是源码目录）

```bash
pnpm pack-bundle
# → dist/pseudo-agi-bundle-0.1.0.tgz + .manifest.json
npm publish dist/pseudo-agi-bundle-0.1.0.tgz --access public
```

**不要**在 `packages/pseudo-agi-bundle` 里跑 `pnpm publish`。原因有两层：

1. `client.js` 是 `pack-bundle` 生成的，源码树里没有，直接发会缺浏览器半侧；
2. `bundledDependencies` 会让 `pnpm pack` 顺着 workspace 软链接展开依赖树，把宿主包一起打进去（实测出现过 `node_modules/@deepseek-ai/cosmokit/LICENSE`）。宿主包必须由使用方的 DSH 提供，不能随插件分发。

为此 bundle 的 `prepublishOnly` 会直接拒绝源码目录发布：

```json
"scripts": { "prepublishOnly": "node ../../scripts/assert-packed-bundle.mjs" }
```

`npm publish <tarball>` 不跑生命周期脚本，所以产物正常发布。

## 4. 发布后验证

```bash
npm view @pseudo-agi/bundle version dist.unpackedSize
npm view @pseudo-agi/memory version

# 干净目录里真装一次
mkdir /tmp/dsh-online && cd /tmp/dsh-online
pnpm init && pnpm add @pseudo-agi/bundle
ls node_modules/@pseudo-agi/bundle/node_modules/@pseudo-agi   # 六个内置包
```

然后在 DSH 里安装 `@pseudo-agi/bundle`（插件页输入包名即可，`install-spec` 同时接受包名、tarball URL、Git 地址与本地路径），重启后按 `docs/install.md` §5 逐条验收。

## 5. 未发布前的分发

发布链路没打通时，`pack-bundle` 的 tgz 本身就是完整的分发单元：放到任意静态 URL，用 `pnpm add https://…/pseudo-agi-bundle-0.1.0.tgz` 或插件页贴地址安装。见 `docs/install.md` §2.1。

## 6. 升级与回滚

1. 七个 `package.json` 的 `version` 一起改（`release-check` 会拦住不一致）；
2. `pnpm clean:build` → `pnpm -r run build` → `pnpm verify`；
3. 先发六个层包，再 `pnpm pack-bundle` + `npm publish`（产物里内置副本的版本由脚本断言与 bundle 版本一致）；
4. 回滚：`npm deprecate` 打标 + 发新补丁版本，不要重发同版本号。

## 7. 已知坑

- **pnpm 的供应链策略**：`pnpm add` 会校验 lockfile 的 supply-chain 策略，刚发布的版本可能被 `minimumReleaseAge` 暂缓；tarball URL 分发不受影响。
- **peer 依赖**：`@deepseek-ai/*` 全部是 peer/可选 peer，由使用方的 DSH 提供；不要把它们写进 `dependencies`。
- **bundle 的 `bundledDependencies` 不能省**：实测去掉之后 pnpm 会忽略 tarball 内的 `node_modules` 并回 registry 解析，直接 `ERR_PNPM_FETCH_404`。
- **`workspace:` 协议**：`pnpm publish` 会自动转换；`pack-bundle` 在改写 manifest 时也显式转换，`release-check` 两头都验。
