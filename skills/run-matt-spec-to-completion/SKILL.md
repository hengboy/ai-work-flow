---
name: run-matt-spec-to-completion
description: "执行已签署的 Spec，完成 Ticket 实施、评审、整合与执行记录提交。"
disable-model-invocation: true
---

# 执行 Matt Spec 至完成

## 目标

将由 `to-spec` 和 `to-tickets` 写入的 Spec 和 Ticket 执行、评审并合并到 `main`。这是唯一的执行入口；它编排现有 module，而不在此重述其实现。生命周期所有权和硬性约束见 [执行架构](references/execution-architecture.md)。

## 前置条件

- 输入必须是 `<target-project>/.scratch/<featureSlug>/spec.md`；运行时从此路径推导 `featureSlug`，并拒绝其他位置或兼容路径。
- Spec 目录必须包含由 `to-tickets` 写入的 `issues/NN-<slug>.md`。
- 必须存在 `docs/agents/issue-tracker.md`；缺少时先运行 `setup-matt-pocock-skills`。
- 在 skill 目录运行 `npm run check:runtime`；安装与失败处理见 [运行时依赖](references/installation.md)。

## 约束

### JSON 时间

执行计划和 Checkpoint 中的所有日期时间字段必须使用 `Asia/Shanghai`，以带 `+08:00` 偏移的 RFC 3339 格式写入或更新。不得写入 UTC `Z` 时间戳；schema 验证失败时停止流程。

## 执行步骤

### 1. 初始化

1. 解析 canonical `spec.md`，推导 feature slug，并使用 `feat/<feature>` 分支。
2. 记录 baseline，并在该 baseline 创建 feature worktree。
3. 物化并验证 `execution-plan.json` 与 Checkpoint，但不提交。

**完成条件：** main 中的 spec 目录包含通过 schema 校验的执行计划与 Checkpoint，feature worktree 干净。

### 2. 恢复

1. 从 main 读取已有记录，并按 [恢复完整性](references/recovery-integrity.md) 验证；`invalid` 时报告 diagnostics 并停止。
2. 仅在记录允许时复用或重建 feature worktree；路径变动时更新 Checkpoint。
3. 从有效 Checkpoint 的状态继续：`executing`、`reviewing`、`integrating` 或 `complete`。

**完成条件：** 返回有效 Checkpoint 和匹配的 worktree，或返回唯一、精确的 blocked 诊断。

### 3. 执行

1. 连续执行每个可执行 Frontier，直至 blocked、需要评审输入或全部 Ticket 完成。
2. `delegated` 使用 [Completion Adapter 协议](references/completion-protocol.md)；`orchestrator` 仅直接实施自动判定的低风险单 Ticket。
3. 在 main 记录每个 Ticket 的终态并更新本地 Issue 复选框；blocked 结果立即停止流程。

**完成条件：** 所有 Ticket 为 `done` 时进入 `reviewing`；否则返回可恢复状态或 blocked 结果。

### 4. 评审与整合

1. 委派 **Code Reviewer** 完成 Standards 与 Spec 两轴评审（单次通过）。
2. 将评审发现报告给用户，由用户决定是否修复以及修复哪些项。
3. 用户确认后，委派 **Full Stack Coder** 完成用户指定的修复。
4. 修复完成后（或用户确认无需修复），执行整合生命周期。
5. 完成执行记录的最终提交。

**完成条件：** main 包含唯一的执行记录提交；若合并后清理失败，保留 `merged` 并且下次只重试清理。

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 概述已完成的执行阶段或最终结果。
- **状态：** 报告当前 Checkpoint、Ticket 或整合状态。
- **注意：** 说明可恢复状态、用户确认或后续动作。
- **阻塞：** 说明唯一、精确的阻塞诊断和所需决策。
