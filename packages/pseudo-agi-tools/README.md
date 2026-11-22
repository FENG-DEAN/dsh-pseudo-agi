# @pseudo-agi/tools

受控手脚：只读取证 + 带边界的写入。

## 做什么

| 工具 | 作用 |
| --- | --- |
| `kb_search` | 在知识根里字面检索，结果带 `path:line`；没有就明确说 `found: false` |
| `kb_read` | 读工作区文本文件的指定行区间，越界会报错而不是静默截断 |
| `controlled_write` | 写 UTF-8 文本，经三重校验后才落盘 |

## 不做什么

- 不记忆、不决定做什么
- 不执行代码、不联网

## 三道关卡

一次写入依次经过：

1. **审批门**（可选）：`tools/pre-execute` 返回 `{ kind: 'ask' }`，由 `ctx.approval` 裁决；只覆盖这一次调用。默认关闭（`writeRequiresApproval: false`）——意识即模型，写操作不找人盖章。
2. **单调否决**：`ctx.tools.guard()` 跑在所有 `pre-execute` 之后、工具体之前。它**只能拒绝**，任何审批都翻不了案。检查：路径是否在工作区、是否落在禁止段（`.git` / `node_modules` / `.ssh` / `.env`）、是否禁止扩展名（`.exe` / `.ps1` 等）、文件名是否含禁止片段。
3. **统一文件策略**：读取 DSH 的 `ctx.sandboxPolicy`（经 `ctx.inject(['sandboxPolicy'])`），当前会话为 `read-only` 时**直接拒绝**。注意会话要从 `exec.agent.session` 取——`exec.agent` 是 `Agent` 不是 `Session`。

工具体自己还会再校验一次（`writeRoots`、大小上限、denied），写临时文件 → 检查 `exec.signal` → rename。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `.` | 工作区根。**必须显式配绝对路径**，依赖宿主 cwd 会让围栏失去意义 |
| `knowledgeRoots` | `['docs', '.pseudo-agi/memory']` | `kb_search` 的检索根 |
| `writeRoots` | `['.']` | 允许写入的子目录（相对 `workspaceRoot`） |
| `writeRequiresApproval` | `true` | 是否让写操作走审批；本项目部署置为 `false` |
| `maxWriteBytes` | `256 KB` | 单次写入上限 |
| `maxScanBytes` / `maxSnippetChars` / `maxDepth` | `512 KB` / `240` / `6` | 检索与读取的上限 |
| `deniedSegments` | `.git` / `node_modules` / `.ssh` / `.env` | 路径中出现即拒绝 |
| `deniedExtensions` | `.exe` / `.dll` / `.so` / `.dylib` / `.bat` / `.cmd` / `.ps1` | 拒绝写入的扩展名 |

## 边界说明

这是**策略围栏，不是内核沙箱**：检查发生在可信代码里，信任"模型能控制的只有路径"这一前提。进程被攻破、TOCTOU、网络访问都不在覆盖范围内。真正的内核级隔离由 DSH 的 `ctx.sandbox` 进程后端负责（Windows 上是 ACL 受限令牌），那是 `pwsh` 消费的，不是本工具。

## 已知限制

- 只写 UTF-8 文本，没有删除或移动操作。
- `guard` 是同步的，只能做字符串判断；符号链接与实际存在性在工具体内异步复核。
- 审批门默认关闭，因此那条代码路径在正常部署中不会被触发（见 `docs/spec-compliance.md` §4 的「未验证」标记）。
