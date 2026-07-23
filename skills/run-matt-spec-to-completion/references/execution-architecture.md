# 执行架构

## 记录所有权

Coordinator 委派 Full Stack Coder 只在主仓库的 `main` 维护执行记录：canonical `.scratch/<featureSlug>/spec.md`、不可变的 `.scratch/<featureSlug>/execution-plan.json`、可变的 `.scratch/<featureSlug>/checkpoint.json` 与本地 Issue 复选框。feature worktree 只承载Ticket 实现代码及其提交。

执行计划保存 canonical Spec 和 Ticket的仓库相对引用、派生依赖与 revision；正文始终留在 Git 中的 `spec.md` 和Issue 文件。Checkpoint 引用 canonical Spec 路径和执行计划 revision，保存生命周期、Git commit、评审和整合状态。三个 JSON schema 是持久化格式的权威，每次读写都必须验证。

所有 Ticket完成、最终评审通过、合并、worktree 清理和 stash 恢复成功后，Full Stack Coder 才调用 `git-commit` 生成非空 Gitmoji + Conventional Commit message，并将执行记录作为一次汇总提交。`generateCommitMessage({ mainWorktree, featureSlug, executionPlan, files })` 缺失或返回空消息时拒绝提交。若提交在 terminal Checkpoint 写入后中断，恢复会只补做该执行记录提交，绝不把未提交记录视为完成。

## Module 边界

| Module | 输入和输出 | 唯一职责 |
| --- | --- | --- |
| `execution-plan.mjs` | canonical Spec 与 Ticket -> 执行计划 | 物化本地 Markdown、依赖和 revision |
| `checkpoint.mjs` | 执行计划、任务终态 -> Checkpoint | 状态转换和持久化 |
| `checkpoint-integrity.mjs` | worktree、feature slug -> `valid` 或 diagnostics | 验证记录与 Git 事实 |
| `worktree-lifecycle.mjs` | repository、branch -> worktree | 创建、复用、重建、清理 |
| `completion-adapter.mjs` | Frontier、worktree -> Completion Results | 派发、收集和协议规范化 |
| `execution-coordinator.mjs` | 执行输入 -> 生命周期结果 | 连续推进、评审、整合和清理 |

## 不变规则

- 每个 Spec只有一个feature worktree；任务不创建 branch、worktree 或 PR。
- 执行仅接受 canonical `spec.md` 和同目录的本地Issue 文件；缺少 Issue时停止，绝不伪造工作。
- `delegated` 用于多 Ticket和高风险或复杂的单 Ticket；只有内容不超过 1000 字符、工作项不超过两项且不涉及迁移、安全、发布或性能的单 Ticket可使用 `coordinator` mode，由 Coordinator 委派 Full Stack Coder 执行。
- 执行计划是不可变输入；Checkpoint 是唯一的可变执行记录。`done` Ticket的 `end_commit` 必须是实现提交，Git 事实优先于 Checkpoint。
- 子代理只能在feature worktree 编辑、测试和提交实现代码；主代理在 main 更新 Ticket和 Checkpoint。
- Coordinator 在稳定差异后委派 Code Reviewer 完成最终 Standards 与 Spec 两轴评审（单次通过）。评审发现报告给用户，由用户决定是否修复。用户确认的修复由 Full Stack Coder 在 feature worktree 完成。
- 整合在用户确认评审结果后开始；feature worktree 必须干净。main 的无关改动以路径限定 stash 隔离，合并冲突时 abort merge 并恢复 stash。
- 合并成功后，确认执行 HEAD 是 main 的祖先，记录带 stash 引用的 `merged`，清理 worktree、恢复 stash，再使用 `git-commit` 提交执行计划、最终 Checkpoint 与本地 Issue 复选框。清理或恢复 stash 失败时保留 `merged` 或 stash 引用并报告；后续只重试未完成的清理。
- 每次持久化状态或执行 stash、merge、worktree 删除、terminal 记录提交前都先验证 Checkpoint 完整性。恢复时发现 `in_progress` Ticket会停止并保留该状态，直到有已停止 worker 的证据；不会自动重新派发。
- stash 恢复先持久化 `restored` 和 `stash_cleanup_state: pending`，然后删除 stash 并持久化 `dropped`。恢复可重试或校验这个清理步骤；未完成时不能写 terminal Checkpoint。
