# vendor：随包携带的六层实现

这里存放 bundle 包（= 仓库根）发布时**随包携带**的六个实现包，由 `pnpm vendor` 从 `packages/*` 编译产物复制而来，**要提交进仓库**。

## 为什么提交生成物

DSH 的 bundle 规范是"开箱即用"：

- 从 Git 仓库安装 bundle 时，**不会**为它的兄弟包执行安装步骤，`workspace:` 协议在 workspace 之外也无法解析；
- `client.js` 这类前端产物由宿主直接加载，不会在使用者机器上重新构建。

所以编译产物与浏览器产物必须是仓库的一部分。这也是 `package.json` 里没有 `dependencies` 的原因——这个包不需要任何安装步骤。

## 布局

```
vendor/node_modules/@pseudo-agi/
├── store/        index.js, index.d.ts
├── memory/       lib/*.js, lib/*.d.ts
├── tools/        …
├── scaffold/     …
├── governance/   …
└── panel/        index.js, client.js
```

用真正的 `node_modules` 形状是为了让解析保持普通：`memory` 里的 `@pseudo-agi/store` 从 `vendor/node_modules/@pseudo-agi/memory/` 向上查找，落在 `vendor/node_modules/@pseudo-agi/store`。

`layers/*.js` 用相对路径指向这里（例如 `../vendor/node_modules/@pseudo-agi/memory/lib/index.js`），所以安装后的包不依赖任何外部包名。宿主侧的 `@deepseek-ai/*` 仍是 peer，由使用者的 DSH 提供。

## 维护

```bash
pnpm -r run build     # 先编译六个层包
pnpm vendor           # 重建 vendor/ 与 client.js
pnpm release-check    # 校验 vendor 与 lib 逐文件一致（防止忘记重跑）
```

`pnpm verify` 会在测试前自动跑一次 `pnpm vendor`。
