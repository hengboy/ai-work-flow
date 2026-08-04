---
name: generate-ai-work-flow-agents
description: 修改 AI Work Flow 环境配置或预设后，校验当前解析配置并重新生成 Codex、Claude Code 和 OpenCode Agents。
---

# 结果目标

让当前环境解析配置与受管理 runtime、contract 和 Agents 保持同一 digest，并输出生成结果。

# 必要前置条件

- 当前环境文件已保存，目标平台范围已明确；未指定时使用全部平台。
- 使用仓库或已安装的 `agent-build/install.mjs`。

# 步骤

1. 运行一次 `node agent-build/install.mjs generate [--platform ...]`。该命令内部完成配置验证和事务式生成；完成标准：退出码为 0 且没有事务恢复错误。
2. 运行 `node agent-build/install.mjs env status`。完成标准：目标平台的受管理 Agents 为 `in-sync`，runtime 与 contract digest 一致。

# 条件分支

- 配置错误：报告精确字段并停止，不预先或随后单独重复运行 `validate`/`generate`。
- 平台 shadow：报告 shadow 路径；生成成功不等于新会话会加载全局 Agent。

# 最终验收

只执行了一次 generate，目标平台状态可验证，新会话可读取更新后的 Agents。
