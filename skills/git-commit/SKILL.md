---
name: git-commit
description: 已授权实现或规划 action 完成并通过验证后，根据运行记录创建一个精确范围的本地 Git 提交。
---

# 结果目标

由 Git Operator 创建一个范围准确、检查通过、可供后续审查冻结的本地提交。

# 必要前置条件

- 主代理 dispatch 的当前 action 归 Git Operator，且包含完整 canonical input。
- action 输入包含 base commit、完整 PathChange、检查和验收证据。
- 提交格式见 `references/commit-message.md`。

# 步骤

1. 由 **Git Operator** 按角色的受控本地 Git 流程解析 porcelain v2 PathChange，比较 base/HEAD，使用参数数组与 `--` 暂存精确路径并执行提交。完成标准：返回完整 commit SHA 且 staged/worktree 事实匹配。
2. 将 commit SHA、检查和 PathChange 作为固定 TaskResult 返回主代理，由主代理调用 dispatch 指定的 completion tool。完成标准：runtime 返回 canonical receipt 并进入下一 phase。

# 条件分支

- hook 或检查失败：保留 index/worktree 现场，返回真实错误，不 reset、clean 或自动重试。
- 范围、HEAD 或 lease 漂移：停止并向主代理返回真实错误，不自行读取或修改 workflow 状态。

# 最终验收

提交仅存在本地，消息符合约定，提交范围与 action 输入精确一致，没有 push、amend、stash、reset、clean 或 tag。
