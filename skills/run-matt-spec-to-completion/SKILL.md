---
name: run-matt-spec-to-completion
description: "执行已签署的 Spec，完成 Ticket 实施、评审、整合与执行记录提交。"
disable-model-invocation: true
---

# 执行 AI Work Flow Spec 至完成

## 目标

将由 `to-spec` 和 `to-tickets` 写入的 Spec 和 Ticket 执行、评审并合并到 `main`。已安装环境通过 `$XDG_CONFIG_HOME/ai-work-flow/execution-runtime/execution-cli.mjs` 维护状态；未设置时使用 `~/.config/ai-work-flow/execution-runtime/execution-cli.mjs`。平台 Skill 只调用该 runtime，生命周期所有权和硬性约束见 [执行架构](references/execution-architecture.md)。

## 前置条件

- 输入必须是 `<target-project>/.scratch/<featureSlug>/spec.md`；运行时从此路径推导 `featureSlug`，并拒绝其他位置或兼容路径。
- Spec 目录必须包含由 `to-tickets` 写入的 `issues/NN-<slug>.md`。
- 必须存在 `docs/agents/issue-tracker.md`；缺少时停止并报告项目配置阻塞。
- 在 skill 目录运行 `npm run check:runtime`；安装与失败处理见 [运行时依赖](references/installation.md)。

## 约束

### JSON 时间

执行计划和 Checkpoint 中的所有日期时间字段必须使用 `Asia/Shanghai`，以带 `+08:00` 偏移的 RFC 3339 格式写入或更新。不得写入 UTC `Z` 时间戳；schema 验证失败时停止流程。

## 执行步骤

### 1. 初始化

1. 解析 canonical `spec.md`，推导 feature slug，并使用 `feat/<feature>` 分支。
2. 记录 baseline，并在该 baseline 创建 feature worktree。
3. 通过 runtime 在同一 feature lock 内物化并验证 `execution-plan.json` 与 Checkpoint，但不提交。

**完成条件：** main 中的 spec 目录包含通过 schema 校验的执行计划与 Checkpoint，feature worktree 干净。

### 2. 恢复

1. 从 main 读取已有记录，并按 [恢复完整性](references/recovery-integrity.md) 验证；`invalid` 时报告 diagnostics 并停止。
2. 仅在记录允许时复用或重建 feature worktree；创建前拒绝符号链接父路径，路径变动时由 runtime 更新 Checkpoint。
3. 从有效 Checkpoint 的状态继续：`executing`、`reviewing`、`integrating` 或 `complete`。

**完成条件：** 返回有效 Checkpoint 和匹配的 worktree，或返回唯一、精确的 blocked 诊断。

### 3. 执行

1. 连续执行每个可执行 Frontier，直至 blocked、需要评审输入或全部 Ticket 完成。
2. `delegated` 使用 [Completion Adapter 协议](references/completion-protocol.md)；旧 `orchestrator` plan 仅保留兼容执行语义，所有 Ticket 状态仍经 runtime 的 `claim` 和 stdin JSON Handoff `record-ticket` 变更。
3. 在 main 记录每个 Ticket 的终态并更新本地 Issue 复选框；blocked 结果立即停止流程。

**完成条件：** 所有 Ticket 为 `done` 时进入 `reviewing`；否则返回可恢复状态或 blocked 结果。

### 4. 评审与整合

1. 调用 runtime 的 `begin-review --worktree <feature-worktree>`；工作树不干净、端点无效或三点 diff 为空时停止。保存返回的 `fixed_point`、`review_commit`、`diff_command` 和 `commit_list_command`。
2. 将完全相同的两个 SHA、diff 命令和 commit list 交给 **Code Reviewer**，完成 Standards 与 Spec 两轴评审（单次通过）。
3. 将评审发现报告给用户，由用户决定是否修复以及修复哪些项。
4. 用户确认后，委派 **Full Stack Coder** 完成用户指定的修复。
5. 修复验证后调用 `complete-review-fix --worktree <feature-worktree>`，并从 stdin 提供非空 `checks` JSON；runtime 要求干净工作树和晚于 `review_commit` 的追加修复提交，持久化 `fix_commit` 与验证记录后直接整合，不对同一固定范围自动复审。用户确认无需修复时由 `review-decision approve` 进入整合。
6. 完成执行记录的最终提交。

**完成条件：** main 包含唯一的执行记录提交；若合并后清理失败，保留 `merged` 并且下次只重试清理。

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 概述已完成的执行阶段或最终结果。
- **状态：** 报告当前 Checkpoint、Ticket 或整合状态。
- **注意：** 说明可恢复状态、用户确认或后续动作。
- **阻塞：** 说明唯一、精确的阻塞诊断和所需决策。
