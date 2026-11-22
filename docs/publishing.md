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
- 组合包产物：携带 `vendor/` 六个实现包、五行入口、`client.js`、`LICENSE`，且**不含任何 `@deepseek-ai/*`**；
- `vendor/` 每个文件与编译产物逐字节一致（漏跑 `pnpm vendor` 会直接失败），`client.js` 与 `panel/client.js` 只差 factory id；
- 组合包不声明任何依赖（安装时无需解析包名），`prepublishOnly` 检查生成物在位。

## 0.1 一次性：仓库地址与开源发布

开源仓库建好后，把地址写进八个 manifest（幂等，可重复跑）：

```bash
node scripts/set-repository.mjs https://github.com/<owner>/<repo> --dry-run   # 先看要改什么
node scripts/set-repository.mjs https://github.com/<owner>/<repo>
```

它把 `repository` / `homepage` / `bugs` 写到根与七个包，并在 README 顶部补一行仓库链接。

首次开源与打 tag：

```bash
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
git tag v0.2.0 && git push origin v0.2.0
pnpm pack-bundle
gh release create v0.2.0 dist/pseudo-agi-bundle-0.2.0.tgz dist/pseudo-agi-bundle-0.2.0.manifest.json --generate-notes
```

三种"使用者安装"的地址，推荐按这个顺序对外公布：

```bash
# 1) GitHub 仓库（最快可用，不需要 npm 发布，也不构建）
pnpm add "github:<owner>/<repo>#<commit>&path:packages/pseudo-agi-bundle"

# 2) Release 上的 tgz（可核对 sha256）
pnpm add https://github.com/<owner>/<repo>/releases/download/v0.2.0/pseudo-agi-bundle-0.2.0.tgz

# 3) npm 包名（发布之后）
pnpm add @pseudo-agi/bundle
```

`manifest.json` 里的 `sha256` 供使用者核对；插件页可以直接贴上述任一 spec 安装。

> 仓库里**不含** `.pseudo-agi/` 与 `AGI_STATE.md`：工作台、记忆、审计日志都是运行时数据（含本机绝对路径、端口、会话 id 与未公开的实验结论），由 `.gitignore` 整体排除。首次运行插件自行创建，想预置工作台就从 `templates/AGI_STATE.md` 复制。分工见 [agi-state.md](agi-state.md)。

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

## 3. 发布组合包

bundle 源码目录**本身就是可发布形态**（`vendor/` 与 `client.js` 已提交），所以两种方式都行：

```bash
# 方式一：直接从包目录发布（会跑 prepublishOnly 检查生成物）
pnpm --filter @pseudo-agi/bundle publish --access public

# 方式二：发布 pack-bundle 的产物（可先核对 sha256，再挂 Release）
pnpm pack-bundle
npm publish dist/pseudo-agi-bundle-0.2.0.tgz --access public
```

`prepublishOnly` 会检查 `client.js` 与 `vendor/node_modules/@pseudo-agi/*` 是否在位，缺任何一个就拒绝发布（提示先跑 `pnpm -r run build && pnpm vendor`）。`npm publish <tarball>` 不跑生命周期脚本，所以产物发布不受影响。

**不要**给 bundle 加回 `dependencies` 或 `bundledDependencies`：前者会让安装去 registry 解析 `@pseudo-agi/*`（404），后者会让 `pnpm pack` 顺着 workspace 软链接把宿主包打进 tarball（实测出现过 `node_modules/@deepseek-ai/cosmokit/LICENSE`）。宿主包必须由使用方的 DSH 提供。

## 4. 发布后验证

```bash
npm view @pseudo-agi/bundle version dist.unpackedSize
npm view @pseudo-agi/memory version

# 干净目录里真装一次
mkdir /tmp/dsh-online && cd /tmp/dsh-online
pnpm init && pnpm add @pseudo-agi/bundle
ls node_modules/@pseudo-agi/bundle/vendor/node_modules/@pseudo-agi   # vendor 里的六个实现
test -f node_modules/@pseudo-agi/bundle/client.js                    # 面板浏览器半侧
```

然后在 DSH 里安装 `@pseudo-agi/bundle`（插件页输入包名即可，`install-spec` 同时接受包名、tarball URL、Git 地址与本地路径），重启后按 `docs/install.md` §5 逐条验收。

## 5. 未发布前的分发

发布链路没打通时，`pack-bundle` 的 tgz 本身就是完整的分发单元：放到任意静态 URL，用 `pnpm add https://…/pseudo-agi-bundle-0.2.0.tgz` 或插件页贴地址安装。见 `docs/install.md` §2.1。

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
