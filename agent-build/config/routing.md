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

<!-- ai-work-flow:section id="planning-governance" -->

## Spec-First 规划治理

新规划工件必须位于 `.ai-work-flow/plans/<plan-id>/`，并同时包含已批准的 `spec.md` 与 `ready-for-implementation` 的 `plan.md`。plan 必须通过 `source_spec` 和对 spec 原始完整字节计算的 SHA-256 小写摘要绑定规格；拆分任务必须通过当前 plan 原始完整字节摘要绑定计划。任一工件缺失、格式非法、路径或摘要不匹配时 fail closed，不得继续写后续工件、实施或提交。

旧平铺计划、plan-only 目录和失效任务均不迁移、不兼容、不得反向生成规格。计划重写立即使旧 tasks 不可执行；只有用户确认后才能全量替换 tasks，或在不拆分模式下删除全部旧 tasks 并确保 `tasks/` 目录本身不存在。平台只能对实际生成的路径权限标为 `enforced`，单目标阶段顺序等提示词约束必须保持 `instruction-only` 语义。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="implementation-governance" -->

## 实施、提交与整合

确认方案后的实现阶段固定按以下顺序执行：**Git Operator prepare -> Full Stack Coder -> Git Operator commit/sync -> Code Reviewer -> Review Standards + Review Spec -> Git Operator integrate/cleanup**。Coding 为每个普通实施生成稳定唯一的 `worktree_id`，分支为 `ai-work-flow/<worktree_id>`，路径为 `.worktrees/<worktree_id>`，并把同一路径传给所有实现和评审角色。Git Operator 在创建前幂等维护共享 Git `info/exclude` 的 `/.worktrees/`；已有路径只能在仓库身份、分支和任务基点全部匹配时恢复，否则停止。Full Stack Coder 只能在该干净 worktree 实现或解决冲突；不得使用整体 `ours/theirs`、删除任一侧实现或机械拼接来解决冲突，无法保留两边有效行为时请求用户裁决。Git Operator 收到完整实现交接后不等待新的提交授权，创建本地 review commit 并同步最新 `main`，再由 Code Reviewer 审查。`run-matt-spec-to-completion` 的 Ticket 子代理也在同一隔离 worktree 契约下执行。提交失败、工作树不干净或测试失败时不得启动审查。

用户明确确认方案或要求实施，即授权为该实现阶段创建仅本地的 review commit；不需要在首次暂存前再次逐项请求授权。此授权不包含 push、amend、reset、clean、stash、切换或删除分支、标签操作，且不包含方案范围之外的已有变更。

所有 Git 操作必须由 **Git Operator** 串行执行，包括 planning commit、feature/task worktree 创建、task review commit、同步、按序汇入、最终整合和清理；并发 task 只能并发非 Git 实施与验证。

**Bug Fixer** 只能在可复现 bug，或用户明确批准当前评审结果中的具体 blocking finding IDs 时替代 Full Stack Coder 执行受限修复，并沿用同一隔离 worktree、初始空状态、验证和结构化交接契约。Bug Fixer 只修复获批范围，不自行评审或执行 Git mutation；finding 修复完成后由 Git Operator 创建后继提交并同步，前置条件通过后返回 Coding 自动继续 task 汇入或最终整合与清理，不进入新的用户决策点。

**Full Stack Coder** 开始前必须记录完整 `base_commit`、空的 `git status --porcelain=v2 -z --untracked-files=all`，且初始状态必须为空；否则停止，不得猜测提交范围。完成后必须交接同一工作树的 `base_commit`、初始空状态、稳定排序的精确 `changed_paths: PathChange[]` 和每条已执行且通过的验证命令与结果。唯一的路径事实源是 porcelain v2 `-z`：每项为 `{record_type,index_status,worktree_status,path,source_path?}`，rename/copy 必须保留两条 Git 原始路径；不得换行分割或从展示文本反解析路径。**Coding** 在收到完整且成功的实现交接后立即原样委派给 **Git Operator**。变更清单为空、当前 `HEAD` 不等于 `base_commit`、当前结构化状态与交接不一致、验证失败或存在未交接的变更时，Git Operator 必须停止且不得暂存任何文件。

Git Operator 必须先调用 `$git-commit` 生成提交信息。提交前必须确认当前 `HEAD` 精确等于 `base_commit`、当前 PathChange 集合与交接 `changed_paths` 全字段一致、已通过验证仍完整可用；只能以参数数组和 `--` 暂存交接 PathChange 的目标/源路径，并在提交前复核暂存结构化集合且暂存差异非空。提交必须仅在本地创建，成功后报告完整 `review_commit` SHA 和空的 porcelain 状态。范围不一致、工作树不干净、验证失败或提交 hook 失败时停止并报告精确原因；hook 失败后不得 reset、clean 或重试，必须用同一 parser 重新报告真实 index/worktree PathChange。工作树仍有 staged、unstaged 或 untracked 内容时，不能启动审查；该状态应作为范围或实现阻塞报告，而不是向用户重新请求同一实施阶段的提交授权。

首次 review 的 blocking finding 修复完成后，Git Operator 必须基于修复后的干净 worktree 创建新的本地 review commit，并报告新的完整 SHA。新的 `review_commit` 必须不同于且后继于首次被拒的 `review_commit`，并且新的 `review_commit` 必须精确等于 feature 或 task HEAD；该 SHA 是后续 task 汇入或最终整合使用的提交。缺少新的完整 SHA、复用旧 SHA、不是旧 SHA 的后继或不等于当前 HEAD 时均阻塞，不得继续后续流程。

Git Operator 在整合前重新确认主工作树和 feature worktree 均干净、当前 `main` 精确等于最近成功同步的 fixed point、feature HEAD 精确等于允许整合的 review commit；后者只能是首次双轴审查无阻塞的提交，或通过上述关系和 HEAD 检查的 finding 修复后继提交。若后续整合时 `main` 已前进，返回 `resync_required`，重新同步并重新评审最终提交；同步冲突仍进入既有冲突解决及重新评审流程。门禁通过后仅在主工作树运行 `git merge --ff-only <review_commit>`；主工作树无关改动默认阻塞，保留显式 stash 授权。成功后仅在 worktree 干净、分支已合并的前提下移除 worktree，并用 `git branch -d` 删除本地 feature 分支。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="review-governance" -->

## AI Work Flow 审查契约

**Code Reviewer** 仅在 Git Operator 报告完整 `review_commit` SHA 且 `git status --short` 为空时开始。审查范围由固定的 `fixed-point` 与 `review-commit` 两个完整提交 SHA 构成。普通实现和工作流评审均使用最近同步的 `main_commit` 作为 fixed point，且 review commit 必须精确等于 feature HEAD；用户直接指定 fixed point 时，将开始评审时的 `HEAD` 解析为 `review-commit`，不得在委派后重新解析。审查目标 worktree 的 `HEAD` 必须精确等于 `review-commit`；输入 prompt 中的 range、commit list 或 changed paths 与 ReviewManifest 任一不一致时预检阻塞。Code Reviewer 绝不审查未提交内容。Code Reviewer 委派前按顺序运行并保存以下命令及结果：

```bash
git rev-parse <fixed-point>
git rev-parse <review-commit>
git status --short
git diff <fixed-point>...<review-commit>
git log <fixed-point>..<review-commit> --oneline
```

两个端点必须可解析，fixed point 必须是 review commit 的祖先，三点 diff 必须非空。`git status --short` 只用于确认工作树干净；存在 staged、unstaged 或 untracked 内容时阻塞，不得读取或评价其内容。评审发现只允许来自固定的 committed diff，禁止使用无参数 `git diff` 或 `git diff --cached` 扩大范围。Code Reviewer 及两个叶子不得使用工作树文件读取命令或工具作为 finding 证据，例如无 revision 的 `sed`、`cat`、`rg` 或直接打开 path。每项 finding 必须引用 ReviewManifest shard ID，并引用 `git diff --no-ext-diff <fixed-point>...<review-commit> -- <paths>` 的 hunk；如需上下文，只能使用 `git show <review-commit>:<path>`，且不得基于 committed diff 之外的上下文新增 finding。

Code Reviewer 只根据不可变 `ReviewManifest` 调度审查。ReviewManifest 只由 runtime 机器冻结并校验两个完整 SHA、结构化 commit list、changed paths、review checks、diff command、显式 spec status/source、standards source、稳定 shard IDs 和 digest；它不包含或绑定 Ticket/issues、acceptance evidence、Verification 结果或额外 runtime facts。Code Reviewer 先以 `git diff --name-only <fixed-point>...<review-commit>` 生成稳定排序的完整文件清单，按文件拆分可读取的分片；每个分片固定使用 `git diff --no-ext-diff <fixed-point>...<review-commit> -- <paths>`。单文件 diff 仍过大时，只对同一命令输出读取固定行窗口。**Review Standards** 与 **Review Spec** 必须收到完全相同的两个完整 SHA、diff 命令、commit list、规格来源、标准来源和完整文件/窗口分片清单，以及同一机器冻结的 ReviewManifest 与 digest；不得自行重算 `HEAD`、规格或分片。额外 spec context/bundle 必须由 Code Reviewer 在同一委派中收集、验证并传给两个叶子；其完整性、来源绑定、digest/revision 与两叶子一致性属于 `instruction-only`，不得声称由 ReviewManifest digest 机器绑定或证明。

Standards 轴只依据绑定到冻结 revision 的仓库 `Standards`、`CONTEXT.md` 等标准来源和 Fowler 基准，`spec.md` 不作为 Standards 轴的标准来源。Review Spec 的规格输入是按流程组成并由代理收集验证的完整 `spec context/bundle`，不是单一文件的泛称：目录式单任务 bundle 是 `.ai-work-flow/plans/<plan-id>/spec.md + plan.md`；目录式拆分 task bundle 是 `spec.md + plan.md + 当前 task + acceptance evidence + Verification 结果`；`run-matt-spec-to-completion` bundle 是 canonical `.scratch/<featureSlug>/spec.md + 对应 Ticket/issues + runtime 执行事实`。这些额外上下文不扩展 ReviewManifest，也不写入或绑定其 digest；对 bundle 的 source binding、digest、revision、完整性和可恢复性检查属于代理 `instruction-only`，缺失或不一致时由代理 fail closed。两个叶子必须由 Code Reviewer 在同一委派中收到相同 bundle；该一致性同样是 `instruction-only`。不得退化为只审 `spec.md`、只审 `plan.md` 或只审当前 task，也不得静默忽略 Ticket/issues、acceptance evidence、Verification 结果或 runtime 执行事实。两个叶子仍接收同一机器冻结的 ReviewManifest 与 digest，并保持 coverage、finding 与审批门禁。

叶子评审分别返回 `{verdict, blocking_findings, advisory_findings, manifest_digest, coverage}`；每项 finding 具有稳定 ID、摘要和证据，coverage 与 findings summary 分字段返回。任一缺失、重复或越界 shard，或 digest 不一致都会阻塞汇总。已完成审查的 findings 必须分成独立的 `**阻塞项：**` 与 `**建议：**` 区块；每个区块内分别保留 Standards、Spec 的来源顺序，不得跨轴合并或重排，无内容的区块省略。`**阻塞项：**` 包含需用户确认的 finding IDs 和决策，`**建议：**` 只报告且不阻止整合；`**阻塞：**` 仅用于审查或流程无法完成的原因。两轴 coverage 完整且无阻塞 finding 才能自动进入整合，建议会保留并报告。任一阻塞 finding 进入 `awaiting_user`，用户只能用确认的 finding IDs 选择修复，不能 approve 绕过。用户确认 finding IDs 且修复完成后，Git Operator 必须创建并验证不同于且后继于首次被拒提交、精确等于 feature 或 task HEAD 的新 `review_commit`，然后再次同步；提交关系、同步或后续整合前置条件任一失败都必须阻塞。全部通过后不再进入 `awaiting_user`，也不再次委派 Code Reviewer，而是自动继续当前层级后续流程：task 级按编号汇入 feature、清理并开放下一 frontier，单任务或最终聚合级进入最终整合与清理。新 `review_commit` 是该后续流程使用的提交。冲突解决后的重新评审规则保持不变。输出截断、连接中断或结果未知时，只重试未完成分片并保持相同 SHA；重试耗尽后请求用户“继续”或“重试”，不得请求新的提交授权。

Review Standards 或 Review Spec 报告阻塞时，Code Reviewer 只有在无需改变 ReviewManifest、digest、固定 SHA、分片范围、规格来源或标准来源，不替叶子评审决定发现或结论，仅通过澄清任务输入或选择已授权执行方式即可消除阻塞时，才能记录明确裁决，并携带原 manifest 与裁决在全新子会话中只重新发起被阻塞的评审一次。需要修改固定输入、扩大范围、解释未批准需求或由用户作决定时必须直接报告用户。该次重试仍阻塞、失败或结果未知时，立即报告用户，不得再次自动重试；这是“子代理正常任务失败不可重试”规则的唯一审查例外。

<!-- ai-work-flow:section-end -->
