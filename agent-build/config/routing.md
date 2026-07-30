# Agent 路由规则

<!-- ai-work-flow:section id="browser-governance" -->

## 浏览器自动化门禁

除非用户在当前请求中明确要求浏览器自动化、E2E 测试或视觉验证，任何角色不得启动、连接或操作 Chrome 或其他可见浏览器，也不得调用 Browser、Chrome DevTools 或 Playwright 等浏览器工具。仓库含有前端代码、浏览器测试配置或既有 E2E 用例不构成授权；优先运行不打开浏览器的测试和检查。获得明确授权后，默认使用无头模式，除非用户明确要求可见浏览器。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="handoff-governance" -->

## 交接读取边界

只能读取用户或上游交接的精确路径及其直接依赖。需要未知路径、文件搜索或枚举时必须停止，并要求委派方先由 **File Explorer** 发现真实入口；不得自行使用 Glob、Grep、`find`、`rg` 或同类命令扩大读取范围。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="retry-governance" -->

## 子代理故障与重试

每个子任务的首次尝试最多重试 2 次，共 3 次；尝试计数只在当前主代理上下文有效。仅可重试可恢复的 429、502/503/504、超时、连接重置或结果未知。明确为硬配额或计费耗尽的 429 不可重试；400/401/403/404、参数或模型配置错误、子代理正常任务失败或测试失败、需求不清均不可重试，但“AI Work Flow 审查契约”允许 Code Reviewer 裁决后重试一次的叶子评审阻塞除外。

429 优先遵从 `Retry-After`，否则等待 30 秒、60 秒；网关或连接错误等待 5 秒、15 秒；单次等待不超过 120 秒。不承诺平台未提供的原子性或精确计时。

每次重试前先进入静止阶段：请求停止旧子代理；只有确认其已终止，才能用全新子会话重试。无法确认终止时必须停止，不得创建可能重复工作的替代会话。OpenCode 的重试必须新建 child session；复用 `task_id` 是恢复，不得用于重试。

重试预算耗尽、错误不可重试或无法确认停止时，启动停止锁：禁止任何新委派、恢复或继续；尽力中止全部已知活跃子代理；主代理不得继续实施或将任务汇总为成功。报告错误类别、尝试数、最后错误、会话状态（包括可能仍在运行的会话）及人工恢复条件，然后结束当前轮次，等待用户明确“继续”或“重试”。人工恢复后先检查旧会话状态；仅在确认没有持续运行的子代理后，才为该任务重置本轮预算，并以全新会话开始。OpenCode 不得传入旧 `task_id`。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="implementation-governance" -->

## 实施、提交与整合

确认方案后的实现阶段固定按以下顺序执行：**Git Committer prepare -> Full Stack Coder -> Git Committer commit/sync -> Code Reviewer -> Review Standards + Review Spec -> Git Committer integrate/cleanup**。Coding 为每个普通实施生成稳定唯一的 `worktree_id`，分支为 `ai-work-flow/<worktree_id>`，路径为 `.worktrees/<worktree_id>`，并把同一路径传给所有实现和评审角色。Git Committer 在创建前幂等维护共享 Git `info/exclude` 的 `/.worktrees/`；已有路径只能在仓库身份、分支和任务基点全部匹配时恢复，否则停止。Full Stack Coder 只能在该干净 worktree 实现或解决冲突；不得使用整体 `ours/theirs`、删除任一侧实现或机械拼接来解决冲突，无法保留两边有效行为时请求用户裁决。Git Committer 收到完整实现交接后不等待新的提交授权，创建本地 review commit 并同步最新 `main`，再由 Code Reviewer 审查。`run-matt-spec-to-completion` 的 Ticket 子代理也在同一隔离 worktree 契约下执行。提交失败、工作树不干净或测试失败时不得启动审查。

用户明确确认方案或要求实施，即授权为该实现阶段创建仅本地的 review commit；不需要在首次暂存前再次逐项请求授权。此授权不包含 push、amend、reset、clean、stash、切换或删除分支、标签操作，且不包含方案范围之外的已有变更。

所有 Git 操作必须由 **Git Committer** 串行执行，包括 planning commit、feature/task worktree 创建、task review commit、同步、按序汇入、最终整合和清理；并发 task 只能并发非 Git 实施与验证。

**Full Stack Coder** 开始前必须记录完整 `base_commit`、空的 `git status --porcelain=v2 -z --untracked-files=all`，且初始状态必须为空；否则停止，不得猜测提交范围。完成后必须交接同一工作树的 `base_commit`、初始空状态、稳定排序的精确 `changed_paths: PathChange[]` 和每条已执行且通过的验证命令与结果。唯一的路径事实源是 porcelain v2 `-z`：每项为 `{record_type,index_status,worktree_status,path,source_path?}`，rename/copy 必须保留两条 Git 原始路径；不得换行分割或从展示文本反解析路径。**Coding** 在收到完整且成功的实现交接后立即原样委派给 **Git Committer**。变更清单为空、当前 `HEAD` 不等于 `base_commit`、当前结构化状态与交接不一致、验证失败或存在未交接的变更时，Git Committer 必须停止且不得暂存任何文件。

Git Committer 必须先调用 `$git-commit` 生成提交信息。提交前必须确认当前 `HEAD` 精确等于 `base_commit`、当前 PathChange 集合与交接 `changed_paths` 全字段一致、已通过验证仍完整可用；只能以参数数组和 `--` 暂存交接 PathChange 的目标/源路径，并在提交前复核暂存结构化集合且暂存差异非空。提交必须仅在本地创建，成功后报告完整 `review_commit` SHA 和空的 porcelain 状态。范围不一致、工作树不干净、验证失败或提交 hook 失败时停止并报告精确原因；hook 失败后不得 reset、clean 或重试，必须用同一 parser 重新报告真实 index/worktree PathChange。工作树仍有 staged、unstaged 或 untracked 内容时，不能启动审查；该状态应作为范围或实现阻塞报告，而不是向用户重新请求同一实施阶段的提交授权。

Git Committer 在整合前重新确认主工作树和 feature worktree 均干净、当前 `main` 精确等于评审 fixed point、feature HEAD 精确等于已通过审查的 review commit。若 `main` 已前进，返回 `resync_required`，先同步并重新评审最终提交。门禁通过后仅在主工作树运行 `git merge --ff-only <review_commit>`；主工作树无关改动默认阻塞，保留显式 stash 授权。成功后仅在 worktree 干净、分支已合并的前提下移除 worktree，并用 `git branch -d` 删除本地 feature 分支。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="review-governance" -->

## AI Work Flow 审查契约

**Code Reviewer** 仅在 Git Committer 报告完整 `review_commit` SHA 且 `git status --short` 为空时开始。审查范围由固定的 `fixed-point` 与 `review-commit` 两个完整提交 SHA 构成。普通实现和工作流评审均使用最近同步的 `main_commit` 作为 fixed point，且 review commit 必须精确等于 feature HEAD；用户直接指定 fixed point 时，将开始评审时的 `HEAD` 解析为 `review-commit`，不得在委派后重新解析。Code Reviewer 绝不审查未提交内容。Code Reviewer 委派前按顺序运行并保存以下命令及结果：

```bash
git rev-parse <fixed-point>
git rev-parse <review-commit>
git status --short
git diff <fixed-point>...<review-commit>
git log <fixed-point>..<review-commit> --oneline
```

两个端点必须可解析，fixed point 必须是 review commit 的祖先，三点 diff 必须非空。`git status --short` 只用于确认工作树干净；存在 staged、unstaged 或 untracked 内容时阻塞，不得读取或评价其内容。评审发现只允许来自固定的 committed diff，禁止使用无参数 `git diff` 或 `git diff --cached` 扩大范围。

Code Reviewer 只根据不可变 `ReviewManifest` 调度审查。ReviewManifest 固定两个完整 SHA、结构化 commit list、changed paths、checks、diff command、显式 spec status/source、standards source、稳定 shard IDs 和 digest。Code Reviewer 先以 `git diff --name-only <fixed-point>...<review-commit>` 生成稳定排序的完整文件清单，按文件拆分可读取的分片；每个分片固定使用 `git diff --no-ext-diff <fixed-point>...<review-commit> -- <paths>`。单文件 diff 仍过大时，只对同一命令输出读取固定行窗口。**Review Standards** 与 **Review Spec** 必须收到完全相同的两个完整 SHA、diff 命令、commit list、规格来源、标准来源和完整文件/窗口分片清单，以及同一完整 ReviewManifest 与 digest；不得自行重算 `HEAD`、规格或分片。

叶子评审分别返回 `{verdict, blocking_findings, advisory_findings, manifest_digest, coverage}`；每项 finding 具有稳定 ID、摘要和证据，coverage 与 findings summary 分字段返回。任一缺失、重复或越界 shard，或 digest 不一致都会阻塞汇总。两轴 coverage 完整且无阻塞 finding 才能自动进入整合，建议会保留并报告。任一阻塞 finding 进入 `awaiting_user`，用户只能用确认的 finding IDs 选择修复，不能 approve 绕过。修复完成后必须再次同步并自动最终复审一次；仍有阻塞项时再次等待用户，不自动循环。输出截断、连接中断或结果未知时，只重试未完成分片并保持相同 SHA；重试耗尽后请求用户“继续”或“重试”，不得请求新的提交授权。

Review Standards 或 Review Spec 报告阻塞时，Code Reviewer 只有在无需改变 ReviewManifest、digest、固定 SHA、分片范围、规格来源或标准来源，不替叶子评审决定发现或结论，仅通过澄清任务输入或选择已授权执行方式即可消除阻塞时，才能记录明确裁决，并携带原 manifest 与裁决在全新子会话中只重新发起被阻塞的评审一次。需要修改固定输入、扩大范围、解释未批准需求或由用户作决定时必须直接报告用户。该次重试仍阻塞、失败或结果未知时，立即报告用户，不得再次自动重试；这是“子代理正常任务失败不可重试”规则的唯一审查例外。

<!-- ai-work-flow:section-end -->
