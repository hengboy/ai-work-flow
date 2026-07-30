# Coding 全 Worktree 实施流程

## Summary

- 所有由 **Coding** 主代理发起的仓库实施，包括普通任务与 `$run-matt-spec-to-completion`，统一在独立 feature worktree 中完成编码、测试、提交、冲突解决和代码评审。
- 最终评审前先将最新 `main` 合入 feature worktree；冲突也在 feature worktree 解决并验证。评审通过后，将已评审提交以 `--ff-only` 整合到 `main`。
- 阻塞发现必须由用户确认修复项后才能修复；修复完成自动复审一次。仍有阻塞项时再次等待用户，不自动循环。仅有非阻塞建议时报告后自动合并。
- 合并成功后自动移除 worktree，并以安全的 `git branch -d` 删除已合并本地分支。

## Implementation Changes

- 扩展现有 **Git Committer**，不新增浅层角色，使其负责五个阶段：创建 worktree、受控提交、同步 `main`、最终整合、清理。Full Stack Coder 仍独占代码与冲突内容编辑，Code Reviewer 始终在 feature worktree 审查固定提交范围。
- 普通流程固定为：`Git Committer prepare -> writable implementation roles -> Git Committer commit/sync -> Code Reviewer -> 用户确认阻塞修复 -> sync/review -> integrate -> cleanup`。Coding 必须把同一 worktree 路径传给所有实施与评审角色。
- 普通任务使用稳定且唯一的 `worktree_id`，分支为 `ai-work-flow/<worktree_id>`，路径为 `.worktrees/<worktree_id>`；已有路径只能在仓库身份、分支和任务基点完全匹配时恢复，否则阻塞。
- Worktree lifecycle 在创建前幂等维护共享 Git `info/exclude` 中的 `/.worktrees/`，避免主工作树出现 `?? .worktrees/`，同时保留现有路径、符号链接和仓库身份校验。
- 为 Spec runtime 增加 `sync-main` 和 `complete-sync` 转换。同步记录精确 `main_commit`；无冲突时直接形成同步提交，冲突时返回精确未合并路径，由 Full Stack Coder 保留两边语义并验证，再由 Git Committer 完成合并提交。
- 禁止用整体 `ours/theirs`、删除一侧实现或机械拼接来“解决”冲突。无法同时保持两边有效行为时停止并请求用户裁决。
- `begin-review` 的 fixed point 改为最近一次同步的 `main_commit`，review commit 必须等于 feature HEAD。若评审后 `main` 再次前进，`integrate` 在任何合并前返回 `resync_required`，重新同步并重新评审最终提交。
- 最终整合要求：主工作树和 feature worktree 状态符合门禁、当前 `main` 等于评审 fixed point、feature HEAD 等于已通过评审的提交；随后在主工作树执行 `git merge --ff-only <review_commit>`。主工作树无关改动默认阻塞，不会被覆盖；保留现有显式 stash 授权能力。
- 更新路由正文、角色正文、README 和代码导航索引，使普通流程与 Spec runtime 使用同一套 worktree、评审、冲突和清理语义。

## Interfaces And Review Gate

- 新增结构化 Review Result，按 Standards/Spec 两轴分别返回 `verdict`、`blocking_findings`、`advisory_findings`、manifest digest 和完整 coverage；每个 finding 带稳定 ID、摘要和证据。
- 违反明确规格或仓库标准、正确性或安全性问题、测试或构建失败、缺少必需验证属于阻塞发现；判断性异味和非必需改进属于非阻塞建议。聚合层不得降级叶子评审的阻塞结论。
- `record-review` 只有在 coverage 完整且两轴均无阻塞发现时才自动进入整合；非阻塞建议保留并报告。
- 有阻塞发现时进入 `awaiting_user`。`review-decision fix` 必须携带用户确认的 finding IDs；不再允许通过 `approve` 绕过阻塞项。
- `complete-review-fix` 不再直接整合，而是回到同步与最终复审。每次复审仍有阻塞项时重新等待用户，不自动修复。
- Checkpoint 以兼容字段扩展同步状态、结构化评审结果和评审尝试。已有 terminal checkpoint 保持可读；缺少新门禁证据的非 terminal checkpoint 必须重新同步并完成结构化评审后才能合并。

## Test Plan

- 验证 `.worktrees/` 被本地排除，创建、恢复、错误仓库、路径冲突和符号链接场景均保持安全。
- 覆盖 `main` 未变化、无冲突前进、发生文本冲突、评审后再次前进四条同步路径；冲突 fixture 的最终内容必须同时保留两边行为。
- 验证冲突解决提交必须重新测试和评审，未经评审的 SHA、过期 fixed point、脏 worktree 或不完整 coverage 均不能进入 `main`。
- 验证阻塞发现必须等待用户选择，修复后自动复审一次；非阻塞建议会被报告但不会阻止整合。
- 验证 `--ff-only` 整合、失败后的可恢复状态，以及成功后只删除已合并且干净的 worktree 和本地分支。
- 更新三平台生成测试，确认 Coding、Full Stack Coder、Git Committer 和评审角色均收到相同 worktree 契约。
- 保持当前 147 项基线测试通过，并运行新增 runtime 和生成测试及完整 `npm test`。
- 本次实现自身也从当前本地 `main` 创建独立 worktree，完成提交和双轴评审；零阻塞后同步并合并回 `main`，不触碰现有其他 worktree。
- 合并后运行完整安装，原子迁移当前全局 `orchestrator` 配置到 `coding`，生成 Codex、Claude Code、OpenCode agents，并用 `env status` 验证三平台均为 in-sync。

## Assumptions

- 目标分支固定为本地 `main`，不执行 push。
- 计划文件本身仍属于实施前工件；进入实施阶段后的源码、测试、必要配置和配套文档全部在 feature worktree 写入。
- 自动清理仅使用可证明已合并的 `git branch -d`；任何脏状态、恢复失败或身份不一致都会保留现场并停止。
- 全局 agents 更新后仅新会话读取新规则。
