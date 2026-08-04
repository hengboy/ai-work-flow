---
name: switch-ai-work-flow-env
description: 切换到一个已存在的 AI Work Flow 环境预设，并事务式生成该环境对应的受管理 Agents。
---

# 结果目标

原子切换环境标记、配置和受管理 Agents；失败时保留切换前状态。

# 必要前置条件

- 调用者提供精确环境名称。
- 当前没有身份不明的生成事务日志。

# 步骤

1. 直接运行 `node agent-build/install.mjs env use <name>`。命令内部验证目标环境并在同一事务中生成；完成标准：退出码为 0 且报告已切换环境。
2. 运行 `node agent-build/install.mjs env status`。完成标准：当前环境名称正确，受管理平台状态与该预设一致。

# 条件分支

- 环境不存在或配置非法：停止并报告原始错误，不预先 list、validate 或 generate。
- 事务恢复被阻塞：保留日志现场，不手工改写 `.environment`。

# 最终验收

环境标记与生成结果来自同一成功事务；没有重复生成。
