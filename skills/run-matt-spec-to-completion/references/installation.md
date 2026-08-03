# 运行时依赖

安装时必须完整部署 `${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/execution-runtime`，其中 `package.json`、`package-lock.json`、`lib/` 与 schemas 属于同一生产 owner。Skill 私有检查入口仍在 skill 根目录运行：

```bash
npm run check:runtime
```

该预检会加载 runtime 的 schema 验证器；依赖缺失时，验证器在 execution runtime 目录使用其锁文件执行 `npm ci --omit=dev`，随后再次加载。预检失败时，按输出进入 execution runtime 目录运行：

```bash
npm ci --omit=dev
```

再回到 skill 根目录运行 `npm run check:runtime`。不得在 skill 中安装 `ajv` 或 `ajv-formats`，不得复制其他环境的 `node_modules`，也不得从旧 skill lib 路径加载。schema 验证不可用时停止执行。
