# @pseudo-agi/panel

左侧栏的「鲸鱼娘 AGI」面板：**只读**视图，看得见五层的状态，不写任何东西。

## 两半

| 半侧 | 位置 | 作用 |
| --- | --- | --- |
| Host | `index.js` | 注册一条同源路由 `GET /pseudo-agi/api/state`，把分层计数、记忆列表、治理事件、`AGI_STATE.md` 摘要算好一次返回 |
| Client | `client.js` | `window.__ModuleLoader__.load` 加载，注册两个 slot：`sidebar.panellist`（左栏入口）与 `main`（面板主体） |

数据全部来自文件——记忆目录、治理 JSONL、`AGI_STATE.md`。**它不调用任何工具、不写文件、不碰 loop**，因此随时可以卸载而不影响 AGI 的任何能力。

## 鉴权（面板自己的责任）

插件注册的 prefix 路由**不在** DSH Host Connection 的鉴权覆盖内（`dsh-host-webserver` 的 `register()` 没有任何 auth 参数）。所以面板自验浏览器会话 cookie：

1. 经 `ctx.inject(['credentials'])` 取 `client-connection/browser-session` 的 secret（key 的运行时形态就是 `<scope>/<id>` 字符串，无需 import 内部包）；
2. 从 `Cookie` 头取 `dsh-auth-<base64url(sha256(authority))>`；
3. 用 HMAC-SHA256 验签，并校验 cookie 绑定的 authority 与请求 `host` 一致、`issuedAt <= now < expiresAt`。

拿不到 secret 的宿主（最小部署、单测环境）会**放行并只告警一次**，避免把面板锁死。验证方式：无 cookie 的请求得 401，浏览器里同源 fetch 会自动带上 cookie 因而正常。

> 同类的 `@local/dsh-preset-editor` 也注册 prefix 路由却不做鉴权——这是 DSH 插件生态的常态。本面板多做一层，是因为它会把 `AGI_STATE.md` 全文和全部记忆标题吐出去。

## 面板内容

- **分层**：四层各自的记录数；
- **记忆**：按更新时间倒序，带 confidence、本地时区日期；**已被取代的记录会变灰、加删除线并标「已取代」**；
- **事件**：治理 JSONL 的尾部，时间按浏览器时区渲染；
- **工作台**：`AGI_STATE.md` 的前 4000 字符。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `workspaceRoot` | `无（必填）` | 读文件与解析路径的基准，必须是绝对路径 |

## 依赖

`inject: ['webServer']`；`credentials` 与 `sandboxPolicy` 之类的服务走**可选注入**，缺席时降级而不是崩溃。

## 已知限制

- 严格只读：想从面板里改记忆或跑工具是不支持的（这是设计，不是缺功能）。
- 没有构建步骤：手写 ESM + 浏览器模块格式，改完需要刷新页面（Host 半侧改动需要重启）。
- 时间戳按浏览器时区渲染；若浏览器与宿主不在同一时区，显示会以浏览器为准。
