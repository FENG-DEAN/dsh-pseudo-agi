# 分发单元：`@pseudo-agi/bundle`

**仓库根就是 bundle 包。** 根目录的 `package.json` 声明了 `dsh.bundle` 与 `dsh.client`，所以：

```bash
pnpm add github:FENG-DEAN/dsh-pseudo-agi          # 粘仓库地址即可，不需要 &path:
```

这正是 DSH 官方插件模板的形态（单包仓库），六个层实现从 `packages/*` 编译后随包携带在 `vendor/`。

## 包内结构

```
（仓库根也是包根）
├── package.json          # 没有 dependencies —— 安装时不需要解析任何包名
├── cordis.patch.yml      # 四行用 layers/* 子路径，panel 行用精确包名（客户端只认两段）
├── layers/{memory,tools,scaffold,governance}.js        # 相对路径指向 vendor（panel 走包根 index.js）
├── client.js             # 面板浏览器半侧（factory id = @pseudo-agi/bundle）
├── locale/
├── vendor/node_modules/@pseudo-agi/{store,memory,tools,scaffold,governance,panel}/
└── packages/             # 六个层包的源码（不进 npm 包；files 白名单排除）
```

`vendor/` 与 `client.js` 是**提交进仓库的生成文件**（见 [vendor/README.md](../vendor/README.md)），由 `pnpm build && pnpm vendor` 重建，`pnpm release-check` 逐文件比对防止忘记重跑。

> 发布产物只含 `files` 白名单：`index.js`、`client.js`、`layers/`、`vendor/`、`cordis.patch.yml`、`locale/`、`README.md`、`LICENSE`。`packages/`、`scripts/`、`docs/` 不进包；pnpm 对 Git 依赖同样按 `files` 打包（实测直装后 `node_modules/@pseudo-agi/bundle` 里没有 `packages/`）。

## 安装

```bash
# GitHub（仓库根就是 bundle，不需要 path:）
pnpm add github:FENG-DEAN/dsh-pseudo-agi

# npm（发布之后）
pnpm add @pseudo-agi/bundle

# Release / 静态 URL 上的 tarball
pnpm add https://github.com/FENG-DEAN/dsh-pseudo-agi/releases/download/v0.4.1/pseudo-agi-bundle-0.4.1.tgz
```

DSH 插件页的安装输入框接受同样的 spec（包名、绝对路径、tarball URL、Git 地址）。

## 配置

**不需要配置就能用。** patch 里故意不写 `workspaceRoot`：留空表示平台默认位置 `<用户主目录>/dsh-pseudo-agi`（Windows 上是 `C:\Users\<你>\dsh-pseudo-agi`），稳定、可写，且不会回退到 DSH 的安装目录。

```text
~/dsh-pseudo-agi/
└── .pseudo-agi/
    ├── memory/{working,episodic,semantic,procedural}/
    ├── governance/*.jsonl
    └── working.md
```

只有想让它直接检索你工程里的 `docs/`（`kb_search`、`kb_read` 的知识根）、或把记忆并进工程时，才覆盖 `workspaceRoot`：

```yaml
# 只覆盖需要的字段；config 是整份替换，不是深合并。
- id: pseudo-agi-memory
  name: '@pseudo-agi/bundle/layers/memory'
  config:
    workspaceRoot: /absolute/path/to/your/project
    root: .pseudo-agi/memory
- id: pseudo-agi-tools
  name: '@pseudo-agi/bundle/layers/tools'
  config:
    workspaceRoot: /absolute/path/to/your/project
    knowledgeRoots: [docs, .pseudo-agi/memory]
    writeRoots: ['.']
    writeRequiresApproval: false
```

`workspaceRoot` 写相对值（如 `.`）会按宿主进程 cwd 解析——那是 DSH 的安装目录，通常不是你想要的；需要时请写绝对路径。

完整五行与全部字段见仓库根的 [cordis.patch.yml](../cordis.patch.yml)；逐字段说明见 [install.md](install.md) §4。

## 使用

装好并重启后，会话里会多出九个工具，左栏出现「鲸鱼娘 AGI」面板：

- `memory_recall` / `memory_candidate` / `memory_commit` / `memory_forget` — 分层记忆
- `kb_search` / `kb_read` — 带 `path:line` 的只读取证
- `controlled_write` — 受 guard 与宿主文件策略约束的写入
- `kb_store` — 查看或搬动知识库位置
- `governance_report` — 本轮轨迹与指标

```text
kb_store({ action: "status" })                              # 知识库在哪
kb_store({ action: "relocate", to: "/data/agi-kb" })        # 换盘（复制 + 校验 + 改指针）
kb_store({ action: "rollback" })                            # 只改指针，不动数据
```

## 构建与发布

```bash
pnpm build && pnpm vendor    # 重建 vendor/ 与 client.js（要提交）
pnpm release-check           # 校验自包含、vendor 同步、无宿主包
pnpm pack-bundle             # 可分发 tgz + manifest（挂 Release 用）
```

安装与验收详见 [install.md](install.md)，发布流程见 [publishing.md](publishing.md)。
