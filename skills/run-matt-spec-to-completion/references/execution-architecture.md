# 执行架构

## 记录所有权

Canonical runtime 在主仓库的 `main` 维护执行记录：canonical `.scratch/<featureSlug>/spec.md`、不可变的 `.scratch/<featureSlug>/execution-plan.json`、可变的 `.scratch/<featureSlug>/checkpoint.json` 与本地 Issue 复选框。feature worktree 只承载 Ticket 实现代码及其提交；Coding 不访问 worktree，也不写 Checkpoint。

执行计划保存 canonical Spec 和 Ticket 的仓库相对引用、派生依赖与 revision；正文始终留在 Git 中的 `spec.md` 和 Issue 文件。Checkpoint 引用 canonical Spec 路径和执行计划 revision，worktree 与 main worktree 只保存仓库相对路径。旧绝对路径或遍历格式明确拒绝且不迁移。schema 是持久化格式的权威，每次读写都必须验证。

所有 Ticket完成、最终评审通过、合并、worktree 清理和 stash 恢复成功后，canonical runtime 将 execution record allowlist 作为一次汇总提交，消息固定为 `chore(ai-work-flow): record <feature> execution`。若提交在 terminal Checkpoint 写入后中断，恢复会只补做该执行记录提交，绝不把未提交记录视为完成。

## Module 边界

| Module | 输入和输出 | 唯一职责 |
| --- | --- | --- |
| `spec-intake.mjs` | canonical Spec 与 Ticket -> 执行计划 | 物化本地 Markdown、依赖和 revision |
| `execution-cli.mjs` | 命令、JSON Handoff -> 状态结果 | canonical runtime API；mutating command 共享 feature lock |
| `state-store.mjs` | validated Checkpoint transition -> 原子文件替换 | 唯一生产 Checkpoint writer 和锁所有者 |
| `checkpoint.mjs` | 执行计划、任务终态 -> Checkpoint | 纯状态转换、schema 形状验证和由 state store 独占调用的底层原子写入 |
| `checkpoint-integrity.mjs` | worktree、feature slug -> `valid` 或 diagnostics | 验证记录与 Git 事实 |
| `worktree-lifecycle.mjs` | repository、branch -> worktree | 创建、复用、重建、清理 |
| `completion-adapter.mjs` | Frontier、worktree -> Completion Results | 派发、收集和协议规范化 |
| `execution-coding.mjs` | 执行输入 -> lifecycle 结果 | 通过 state store 协调委派与 lifecycle，不直接写 Checkpoint |

## 不变规则

- 每个 Spec只有一个feature worktree；任务不创建 branch、worktree 或 PR。
- 执行仅接受 canonical `spec.md` 和同目录的本地Issue 文件；缺少 Issue时停止，绝不伪造工作。
- `delegated` 用于多 Ticket和高风险或复杂的单 Ticket；只有内容不超过 1000 字符、工作项不超过两项且不涉及迁移、安全、发布或性能的单 Ticket可使用 `coding` mode，由 Coding 委派 Full Stack Coder 执行。
- 执行计划是不可变输入；Checkpoint 是唯一的可变执行记录。`done` Ticket的 `end_commit` 必须是实现提交，Git 事实优先于 Checkpoint。
- 子代理只能在 feature worktree 编辑和测试实现代码；它是受限的 Full Stack Coder + Git Committer，必须从空工作树记录 `base_commit`，并只以 `git status --porcelain=v2 -z --untracked-files=all` 生成结构化 `changed_paths: PathChange[]`。验证成功且当前 `HEAD` 仍精确等于 `base_commit` 后，才按 `$git-commit` 的精确文件范围规则创建仅本地的实现提交，canonical runtime 才能记录带 role/session/claim identity 的 JSON Handoff Ticket 终态。canonical runtime 在 main 更新 Ticket 和 Checkpoint，面向用户的 Coding 只协调。
- `begin-review` 冻结包含端点、commit list、diff command、spec 状态/来源、standards 来源、shards 和 digest 的唯一 `ReviewManifest`。`record-review` 必须返回同一 digest 和完整 shard coverage；审查发现报告给用户。用户确认的修复必须形成晚于 `review_commit` 的追加提交，并由 `complete-review-fix` 持久化 `fix_commit` 与非空验证记录后直接前进，不自动复审同一范围。`awaiting_user -> fixing -> integrating` 不得回到 review。
- 整合在用户确认评审结果后开始；feature worktree 必须干净，且分支 HEAD 必须精确等于获批的 `review_commit`，存在已记录修复时则必须精确等于 `fix_commit`。merge 直接使用该关卡 commit SHA，合并后持久化的 `integration.execution_head` 也必须保持同一提交。main 的无关改动默认阻塞；仅 `integrate --allow-stash true` 先持久化授权后，才可执行路径限定 stash、merge 与恢复。
- runtime Git mutation allowlist 仅包括 feature worktree 生命周期、checkpoint 固定 review/fix SHA 的 merge/abort、已持久化授权的 stash 操作，以及当前 feature 的 execution-plan、checkpoint 和 issues execution record。清理或恢复 stash 失败时保留 `merged` 或 stash 引用并报告；后续只重试未完成的清理。
- 每次持久化状态或执行 stash、merge、worktree 删除、terminal 记录提交前都先验证 Checkpoint 完整性。恢复时发现 `in_progress` Ticket会停止并保留该状态，直到有已停止 worker 的证据；不会自动重新派发。
- stash 恢复先持久化 `restored` 和 `stash_cleanup_state: pending`，然后删除 stash 并持久化 `dropped`。恢复可重试或校验这个清理步骤；未完成时不能写 terminal Checkpoint。
