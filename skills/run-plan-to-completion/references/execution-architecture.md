# 执行架构

## 记录所有权

Coordinator 委派 Full Stack Coder 只在主仓库的 `main` 维护执行记录：canonical `.ai-work-flow/plans/<planId>/plan.md`、不可变的 `.ai-work-flow/plans/<planId>/execution-plan.json`、可变的 `.ai-work-flow/plans/<planId>/checkpoint.json` 与本地任务复选框。执行 worktree 只承载任务实现代码及其提交。

执行计划保存 canonical 计划和任务的仓库相对引用、派生依赖与 revision；正文始终留在 Git 中的 `plan.md` 和任务文件。Checkpoint 引用 canonical 计划路径和执行计划 revision，保存生命周期、Git commit、评审和整合状态。三个 JSON schema 是持久化格式的权威，每次读写都必须验证。

所有任务完成、最终评审通过、合并、worktree 清理和 stash 恢复成功后，Full Stack Coder 才调用 `git-commit` 生成非空 Gitmoji + Conventional Commit message，并将执行记录作为一次汇总提交。`generateCommitMessage({ mainWorktree, planId, executionPlan, files })` 缺失或返回空消息时拒绝提交。若提交在 terminal Checkpoint 写入后中断，恢复会只补做该执行记录提交，绝不把未提交记录视为完成。

## Module 边界

| Module | 输入和输出 | 唯一职责 |
| --- | --- | --- |
| `execution-plan.mjs` | canonical 计划与任务 -> 执行计划 | 物化本地 Markdown、依赖和 revision |
| `checkpoint.mjs` | 执行计划、任务终态 -> Checkpoint | 状态转换和持久化 |
| `checkpoint-integrity.mjs` | worktree、plan ID -> `valid` 或 diagnostics | 验证记录与 Git 事实 |
| `worktree-lifecycle.mjs` | repository、branch -> worktree | 创建、复用、重建、清理 |
| `completion-adapter.mjs` | Frontier、worktree -> Completion Results | 派发、收集和协议规范化 |
| `execution-coordinator.mjs` | 执行输入 -> 生命周期结果 | 连续推进、评审、整合和清理 |

## 不变规则

- 每个计划只有一个执行 worktree；任务不创建 branch、worktree 或 PR。
- 执行仅接受 canonical `plan.md` 和同目录的本地任务文件；缺少任务时停止，绝不伪造工作。
- `delegated` 用于多任务和高风险或复杂的单任务；只有内容不超过 1000 字符、工作项不超过两项且不涉及迁移、安全、发布或性能的单任务可使用 `coordinator` mode，由 Coordinator 委派 Full Stack Coder 执行。
- 执行计划是不可变输入；Checkpoint 是唯一的可变执行记录。`done` 任务的 `end_commit` 必须是实现提交，Git 事实优先于 Checkpoint。
- 子代理只能在执行 worktree 编辑、测试和提交实现代码；主代理在 main 更新任务和 Checkpoint。
- Coordinator 在稳定差异后委派 Code Reviewer 完成最终 Standards 与需求两轴评审；用户确认的修复由 Full Stack Coder 在执行 worktree 完成。
- 整合只在 `approved: true` 和非空 `findingsSummary` 后开始；执行 worktree 必须干净。main 的无关改动以路径限定 stash 隔离，合并冲突时 abort merge 并恢复 stash。
- 合并成功后，确认执行 HEAD 是 main 的祖先，记录带 stash 引用的 `merged`，清理 worktree、恢复 stash，再使用 `git-commit` 提交执行计划、最终 Checkpoint 与本地任务复选框。清理或恢复 stash 失败时保留 `merged` 或 stash 引用并报告；后续只重试未完成的清理。
- 每次持久化状态或执行 stash、merge、worktree 删除、terminal 记录提交前都先验证 Checkpoint 完整性。恢复时发现 `in_progress` 任务会停止并保留该状态，直到有已停止 worker 的证据；不会自动重新派发。
- stash 恢复先持久化 `restored` 和 `stash_cleanup_state: pending`，然后删除 stash 并持久化 `dropped`。恢复可重试或校验这个清理步骤；未完成时不能写 terminal Checkpoint。
