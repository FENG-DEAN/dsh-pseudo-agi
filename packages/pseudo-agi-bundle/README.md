# @pseudo-agi/bundle

鲸鱼娘 AGI 的分发单元，也是**唯一需要安装的包**。它把五层实现 + 知识库位置库 + 面板客户端装在一起，装它一个就够。

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["..."] }
}
```

## 为什么随包携带实现（vendor）

DSH 的 bundle 规范是**开箱即用**：从 Git 或 npm 安装时不会有构建步骤，`client.js` 也由宿主直接加载。所以：

```
package/
├── package.json          # 没有 dependencies —— 安装时不需要解析任何包名
├── cordis.patch.yml      # 五行，name 全部指向包内子路径
├── layers/{memory,tools,scaffold,governance,panel}.js   # 相对路径指向 vendor
├── client.js             # 面板浏览器半侧（factory id = @pseudo-agi/bundle）
├── locale/
└── vendor/node_modules/@pseudo-agi/{store,memory,tools,scaffold,governance,panel}/
```

这些生成文件**提交在仓库里**（见 [vendor/README.md](vendor/README.md)），由 `pnpm -r run build && pnpm vendor` 重建，`pnpm release-check` 会逐文件比对防止忘记重跑。

## 安装

```bash
# npm（发布之后）
pnpm add @pseudo-agi/bundle

# 直接从 GitHub 安装（不需要构建，仓库里已带产物）
pnpm add "github:<owner>/<repo>#<commit>&path:packages/pseudo-agi-bundle"

# 发布产物 / GitHub Release 上的 tarball
pnpm add https://github.com/<owner>/<repo>/releases/download/v0.1.0/pseudo-agi-bundle-0.1.0.tgz
```

DSH 插件页的安装输入框接受同样的 spec（包名、绝对路径、tarball URL、Git 地址）。

## 配置

patch 里每行都带 `workspaceRoot: .`，那是**相对宿主进程 cwd** 的，必须覆盖成你的工程绝对路径。最小可用覆盖（写进 profile 的 `cordis.patch.yml`）：

```yaml
# 只覆盖需要的字段；config 是整份替换，不是深合并。
- id: pseudo-agi-memory
  name: '@pseudo-agi/bundle/layers/memory'
  config:
    workspaceRoot: /absolute/path/to/your/project
    storeRoot: .pseudo-agi
    root: .pseudo-agi/memory
- id: pseudo-agi-tools
  name: '@pseudo-agi/bundle/layers/tools'
  config:
    workspaceRoot: /absolute/path/to/your/project
    storeRoot: .pseudo-agi
    knowledgeRoots: [docs, .pseudo-agi/memory]
    writeRoots: ['.']
    writeRequiresApproval: false
```

完整五行与全部字段见包内的 [cordis.patch.yml](cordis.patch.yml)；逐字段说明见 [docs/install.md](../../docs/install.md) §4。

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
pnpm -r run build && pnpm vendor    # 重建 vendor/ 与 client.js（要提交）
pnpm release-check                  # 校验自包含、行尾一致、无宿主包
pnpm pack-bundle                    # 可分发 tgz + manifest（挂 Release 用）
```

安装与验收详见仓库根目录的 [docs/install.md](../../docs/install.md)，发布流程见 [docs/publishing.md](../../docs/publishing.md)。
