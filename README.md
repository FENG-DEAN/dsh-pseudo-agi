# 伪AGI · DSH 插件工程

三个**相互独立、可单独卸载**的 DSH 插件，加一个只读治理层，通过 Cordis 生命周期、事件、上下文注入串成闭环。

**角色分配是这套东西的前提：意识就是模型（不是插件）；插件只提供意识自己做不到的事——改自己的上下文、跨步持久化、强制边界、留下轨迹。**

```
用户输入
  → DSH 原生 Agent Loop
  → agent/pre-step ──► scaffold：本轮首步注入一条纪律（不路由、不选工具）
                    └► memory：按预算重算本步注入块
  → 系统提示词装配（memory 的 systemPrompt.context）
  → 模型判断这一步做什么、调哪个工具
  → tools/pre-execute ──► tools：写操作按配置决定是否 ask（当前关闭）
  → tools.guard()     ──► tools：单调否决（路径越界 / 禁止段 / 禁止扩展名）
  → 工具执行 ──► memory_recall / kb_search / kb_read / controlled_write
  → tools/result ──► governance：记录工具三元组
  → agent/turn-stopping ──► memory：刷新 working.md（仅变化时）；governance：记轮次
```

> 关键点：**没有"AGI 插件"，也没有"控制器"**。判断权归模型；scaffold 只注入纪律并留痕，memory 是 Markdown 真源 + 预算召回，tools 是带 guard 边界的手脚，governance 只观察。四层任一切除，其余仍可运行。

## 目录

| 路径 | 作用 |
| --- | --- |
| [packages/pseudo-agi-memory](packages/pseudo-agi-memory) | 分层记忆：工作 / 情景 / 语义 / 程序；Markdown 真源；`memory_recall`、`memory_candidate`、`memory_commit`、`memory_forget` |
| [packages/pseudo-agi-tools](packages/pseudo-agi-tools) | 受控手脚：`kb_search`、`kb_read`、`controlled_write` + `ctx.tools.guard()` |
| [packages/pseudo-agi-scaffold](packages/pseudo-agi-scaffold) | 意识脚手架：每轮首步注入纪律 + 发 `scaffold-step` 事件；**不做路由、不选工具** |
| [packages/pseudo-agi-governance](packages/pseudo-agi-governance) | 治理层：只读观察器 + 指标 + JSONL 审计 + `governance_report` |
| [packages/pseudo-agi-bundle](packages/pseudo-agi-bundle) | 分发单元：`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` |
| [docs/architecture.md](docs/architecture.md) | 事件流、注册/释放清单、与 DSH 契约的对应关系 |
| [docs/spec-compliance.md](docs/spec-compliance.md) | 三条硬约束逐条对照；方案里几处 API 名称的纠正 |
| [docs/install.md](docs/install.md) | 构建、打包、装载、最小闭环配置、验收清单 |

## 三条硬约束怎么落实

**1. 生命周期与 disposer。** 所有 `ctx.*` 注册（工具、guard、事件监听、prompt context、服务注入）都由 Fiber 管理，插件卸载即回收。工程里唯一"Cordis 未管理"的资源是治理层的 JSONL 写入队列，用 `ctx.effect()` 注册了 drain：

```ts
ctx.effect(() => async () => { await journal.flush() })
```

没有任何自建定时器、watcher、连接，也没有手动调用 disposer。

**2. 工具必须用 `defineTool` 声明。** 所有工具都来自 `@deepseek-ai/dsh-tools` 的 `defineTool()`，参数与输出都用 DSH 自有 schema DSL（`type: 'object'` 必须显式 `additionalProperties`），没有 zod、没有裸 JSON Schema，`execute()` 返回值与 `output.schema` 一一对应。

**3. 安全分层。** guard 与审批**不混用**：

- `ctx.tools.guard()` 只返回拒绝原因，是**单调否决**，跑在所有 `tools/pre-execute` 之后、工具体之前。
- 审批走 `tools/pre-execute` 返回 `{ kind: 'ask', reason, displayReason }`，由 DSH 的 `ctx.approval` 裁决；审批只覆盖**这一次调用**，永远不能推翻 guard。
- 写工具自己再校验一次（同步 guard 只能做字符串判断，符号链接/存在性在工具体内 async 复核）。
- 凭据最小化：不读环境变量、不落盘密钥、审计日志**不记录工具参数**。

## 快速开始

```bash
pnpm install
pnpm build          # 每个包各自 tsc 到 lib/
pnpm typecheck
```

装载与验收见 [docs/install.md](docs/install.md)。只想要最小闭环时，启用 `pseudo-agi-memory` + `pseudo-agi-tools` 两层即可（控制器与治理层可选）。

## 这个方案能做到 / 明确做不到

**能做到**：跨会话的 Markdown 记忆与预算内注入；带来源的召回；路径边界由 guard 单调否决；每轮可审计的纪律注入与工具轨迹；指标与 JSONL 回放。

**做不到**：模型参数之外的持续学习、自主目标、绕过 guard 的提权、在 `node:vm` 里假装安全。所有能力都锁在"可卸载、可撤销、可审计"的边界内——这正是它叫"伪AGI"的原因。

## 状态

已在本机验证（Node 24.14 / pnpm 10.32 / TypeScript 5.9，DSH `0.2.2-rc.5`）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 四包编译 | `pnpm -r run build` | 通过 |
| 纯逻辑/存储/围栏/指标 | `pnpm smoke` | 27/27 |
| 真实服务加载 + 注入 + 卸载 | `pnpm load-test` | 18/18 |

`load-test` 加载的是**真实的** `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools`，因此这三点是按真机语义验证的，不是替身：

- `ToolsService.register()` 的 disposer 通过 Cordis tracker 绑到**调用方** fiber，卸载 memory 层后工具与 prompt 上下文同时消失；
- `app.tools.checkGuards()` 的否决路径真实生效（越界路径、`.git`、`.ps1` 都被拦住）；
- `app.systemPrompt.assemble()` 的装配结果里确实出现了 `pseudo-agi:memory` 上下文，且未被插值。

构建过程中修掉的五个实际问题（含两个安全相关）记录在 [docs/spec-compliance.md](docs/spec-compliance.md#3-构建期修掉的真实缺陷)。
