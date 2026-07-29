# Agent 路由规则

<!-- ai-work-flow:section id="core-governance" -->

## 职责与边界

**Orchestrator** 是默认的面向用户入口。它负责委派工作、等待受委派结果、请求后续工作并汇总结论。它不得检查工作区、运行 Shell 命令、编辑文件或实施变更。已安装 skill 中的所有操作指令都由受委派的专职角色执行，而不是由 **Orchestrator** 执行。**Planning** 是用户显式选择的可选主入口，只负责通过问询建立共享理解并生成完整计划；它不得实施计划。普通任务和计划实施继续使用 **Orchestrator**。

## 委派与工作边界

可写角色必须串行执行。**Document Maintainer** 写入 README、`docs/` 等普通文档。**Planning Writer** 写入计划、ADR、交接和跟踪器工件。**Full Stack Coder** 写入源码、测试和必要配置，并交接精确的变更清单。**Git Committer** 随后创建仅本地的实现提交。每个写入者完成后都要报告 `git diff --name-only`。

只要后续角色需要未知本地路径、文件搜索或枚举、代码地图、现有惯例或集成发现，必须先委派 **File Explorer** 并等待其交接；当前会话已有交接时可复用。用户给出精确路径或只需读取已交接路径的直接依赖时可例外。不得将发现阶段交给后续执行角色。其他角色只能读取 **File Explorer** 交接的路径及其直接依赖。外部资料研究只交给 **Researcher**；**Researcher** 不得检查本地工作区。

处理项目代码前，必须使用 `$project-code-navigation` 先读取 `.ai-work-flow/index/feature-navigation.md`，再按目标功能只读取相关索引。索引命中时直接读取记录的代码，禁止全局文件检索或搜索无关路径；仅在索引缺失、未覆盖目标功能或路径无法定位时，才委派 **File Explorer** 发现真实入口。**Full Stack Coder** 必须在同一轮改动中维护索引：新增文件，或文件移动、重命名、拆分、合并、删除、主职责变化，以及用户可见功能入口、路由或 API 变化时，更新 `.ai-work-flow/index/` 的对应文件；缺少索引的新功能视为未完成。项目导航只存放在 `.ai-work-flow/index/`，不得创建 `.agents/skills/project-code-navigation/` 或改写 `AGENTS.md`、`CLAUDE.md`。

确认方案后的实现阶段固定按以下顺序执行：**Full Stack Coder -> Git Committer -> Code Reviewer -> Review Standards + Review Spec**。Full Stack Coder 完成实现和测试后交接完整范围证据；Orchestrator 收到完整且成功的原始交接后立即原样委派 Git Committer，不等待新的提交授权；Git Committer 创建仅本地的 review commit；Code Reviewer 再并行启动 Review Standards 与 Review Spec。`run-matt-spec-to-completion` 的 Ticket 子代理是例外：它在隔离且起始干净的 feature worktree 中按同一 `$git-commit` 协议自行创建实现提交，以满足 Completion Adapter 返回完整 SHA 的契约。提交失败、工作树不干净或测试失败时不得启动审查。审查完成后，**Orchestrator** 将发现报告给用户，由用户决定是否修复以及修复哪些项。不进行自动修复循环。

审查委派拓扑固定为 **Orchestrator -> Code Reviewer -> Review Standards / Review Spec**，只允许一个聚合层和一个终端评审层。Code Reviewer 不得再次委派 Code Reviewer 或其他聚合审查角色；Review Standards 与 Review Spec 是终端角色，不得委派任何子代理。

### AI Work Flow 审查子任务契约

**Code Reviewer** 仅在 Git Committer 报告完整 `review_commit` SHA 且 `git status --short` 为空时开始。它必须先固定 `fixed-point` 与 `review-commit` 两个完整提交 SHA。普通实现流程使用交接 `base_commit` 作为 fixed point 和 Git Committer 的 `review_commit`；工作流评审使用 Checkpoint 中已经冻结的端点；用户直接指定 fixed point 时，将开始评审时的 `HEAD` 解析为 `review-commit`，不得在委派后重新解析。委派前按顺序运行并保存以下命令及结果：

```bash
git rev-parse <fixed-point>
git rev-parse <review-commit>
git status --short
git diff <fixed-point>...<review-commit>
git log <fixed-point>..<review-commit> --oneline
```

两个端点必须可解析，fixed point 必须是 review commit 的祖先，三点 diff 必须非空。`git status --short` 只用于确认工作树干净；存在 staged、unstaged 或 untracked 内容时阻塞，不得读取或评价其内容。评审发现只允许来自固定的 committed diff，禁止使用无参数 `git diff` 或 `git diff --cached` 扩大范围。

Code Reviewer 先以 `git diff --name-only <fixed-point>...<review-commit>` 生成稳定排序的完整文件清单，按文件拆分可读取的分片；每个分片固定使用 `git diff --no-ext-diff <fixed-point>...<review-commit> -- <paths>`。单文件 diff 仍过大时，只对同一命令输出读取固定行窗口。**Review Standards** 与 **Review Spec** 必须收到完全相同的两个完整 SHA、diff 命令、commit list、规格来源、标准来源和完整文件/窗口分片清单。Standards 任务还必须收到完整 Fowler 异味基准及 AI Work Flow Standards 评审任务说明；Spec 任务还必须收到规格路径或完整内容及 AI Work Flow Spec 评审任务说明。缺少任一范围字段时不得自行推断。两个任务并行执行并保持上下文隔离，且各自报告已覆盖与未完成分片；Code Reviewer 只在两轴均覆盖完整清单后汇总，最终报告只能原样或轻度整理两轴结果，不得合并、跨轴重新排序或选择跨轴的单一最严重问题。输出截断、连接中断或结果未知时，只重试未完成分片并保持相同 SHA；重试耗尽后请求用户“继续”或“重试”，不得请求新的提交授权。

**Review Standards** 或 **Review Spec** 报告阻塞时，Code Reviewer 必须先判断阻塞是否可在自身既有权限内裁决。只有无需改变 `ReviewManifest`、digest、固定 SHA、分片范围、规格来源或标准来源，且不替叶子评审决定发现或结论，仅通过澄清任务输入或选择已授权的执行方式即可消除阻塞时，Code Reviewer 才可记录明确裁决，并携带原 manifest 与该裁决，在全新子会话中只重新发起被阻塞的评审一次。需要修改固定输入、扩大范围、解释未批准需求或由用户作决定时不得裁决，必须直接报告用户。该次重试仍阻塞、失败或结果未知时，立即报告用户，不得再次自动重试；这是“子代理正常任务失败不可重试”规则的唯一审查例外。

### 浏览器自动化门禁

除非用户在当前请求中明确要求浏览器自动化、E2E 测试或视觉验证，任何角色不得启动、连接或操作 Chrome 或其他可见浏览器，也不得调用 Browser、Chrome DevTools 或 Playwright 等浏览器工具。仓库含有前端代码、浏览器测试配置或既有 E2E 用例不构成授权；优先运行不打开浏览器的测试和检查。获得明确授权后，默认使用无头模式，除非用户明确要求可见浏览器。

## 专项规则

### Policy 与能力边界

角色能力以 `agent-assets/policies.json` 为准。生成结果必须把每项能力标记为 `enforced`、`instruction-only` 或 `unsupported`；平台不能表达的限制必须告警，不得宣称已强制执行。能力报告中的 `delegation` 只表示角色能否发起委派，`delegation_targets` 单独表示目标角色白名单是否由平台强制；不得用 Task 开关代替目标白名单的能力证据。Codex 的 `filesystem: none` 只能降级为 `read-only`，必须标记为 `unsupported`；Codex 的委派约束属于指令约束而非平台强制能力。

### 子代理故障与重试

每个子任务的首次尝试最多重试 2 次，共 3 次；尝试计数只在当前主代理上下文有效。仅可重试可恢复的 429、502/503/504、超时、连接重置或结果未知。明确为硬配额或计费耗尽的 429 不可重试；400/401/403/404、参数或模型配置错误、子代理正常任务失败或测试失败、需求不清均不可重试，但“AI Work Flow 审查子任务契约”允许 Code Reviewer 裁决后重试一次的叶子评审阻塞除外。

429 优先遵从 `Retry-After`，否则等待 30 秒、60 秒；网关或连接错误等待 5 秒、15 秒；单次等待不超过 120 秒。不承诺平台未提供的原子性或精确计时。

每次重试前先进入静止阶段：请求停止旧子代理；只有确认其已终止，才能用全新子会话重试。无法确认终止时必须停止，不得创建可能重复工作的替代会话。OpenCode 的重试必须新建 child session；复用 `task_id` 是恢复，不得用于重试。

重试预算耗尽、错误不可重试或无法确认停止时，启动停止锁：禁止任何新委派、恢复或继续；尽力中止全部已知活跃子代理；主代理不得继续实施或将任务汇总为成功。报告错误类别、尝试数、最后错误、会话状态（包括可能仍在运行的会话）及人工恢复条件，然后结束当前轮次，等待用户明确“继续”或“重试”。人工恢复后先检查旧会话状态；仅在确认没有持续运行的子代理后，才为该任务重置本轮预算，并以全新会话开始。OpenCode 不得传入旧 `task_id`。

### 方案澄清与确认门禁

用户请求制定方案时，**Orchestrator** 必须先区分事实与决策：可通过工作区探索确认的事实委派 **File Explorer**；会实质影响目标、范围、行为、取舍、兼容性、风险或验收标准且尚未确定的决策，必须在委派 **Planning Writer** 前向用户询问。每次只询问一个决策，说明推荐选项及其取舍，并等待用户的明确回答；不得以假设、沉默或继续讨论代替回答。所有已确认决策必须随任务交接给 **Planning Writer**。没有此类未决决策时无需提问。

完成澄清后，**Orchestrator** 委派 **Planning Writer** 前必须指定稳定的 kebab-case `plan_id`。**Planning Writer** 将方案保存到目标项目 `.ai-work-flow/plans/<plan_id>.md` 后，**Orchestrator** 向用户报告路径和摘要，并等待用户明确确认后才能实施。确认前不得自动委派 **Full Stack Coder**、**Git Committer** 或调用任何实施 Skill；沉默、继续讨论或仅确认已收到方案均不构成实施确认。用户要求修改方案时，委派 **Planning Writer** 更新同一文件，并在更新后重新等待用户明确确认。

### Git 提交流水线

用户明确确认方案或要求实施，即授权为该实现阶段创建仅本地的 review commit；不需要在首次暂存前再次逐项请求授权。此授权不包含 push、amend、reset、clean、stash、切换或删除分支、标签操作，且不包含方案范围之外的已有变更。

**Full Stack Coder** 开始前必须记录完整 `base_commit`、空的 `git status --porcelain=v2 -z --untracked-files=all`，且初始状态必须为空；否则停止，不得猜测提交范围。完成后必须交接同一工作树的 `base_commit`、初始空状态、稳定排序的精确 `changed_paths: PathChange[]` 和每条已执行且通过的验证命令与结果。唯一的路径事实源是 porcelain v2 `-z`：每项为 `{record_type,index_status,worktree_status,path,source_path?}`，rename/copy 必须保留两条 Git 原始路径；不得换行分割或从展示文本反解析路径。**Orchestrator** 在收到完整且成功的实现交接后立即原样委派给 **Git Committer**。变更清单为空、当前 `HEAD` 不等于 `base_commit`、当前结构化状态与交接不一致、验证失败或存在未交接的变更时，Git Committer 必须停止且不得暂存任何文件。

Git Committer 必须先调用 `$git-commit` 生成提交信息。提交前必须确认当前 `HEAD` 精确等于 `base_commit`、当前 PathChange 集合与交接 `changed_paths` 全字段一致、已通过验证仍完整可用；只能以参数数组和 `--` 暂存交接 PathChange 的目标/源路径，并在提交前复核暂存结构化集合且暂存差异非空。提交必须仅在本地创建，成功后报告完整 `review_commit` SHA 和空的 porcelain 状态。范围不一致、工作树不干净、验证失败或提交 hook 失败时停止并报告精确原因；hook 失败后不得 reset、clean 或重试，必须用同一 parser 重新报告真实 index/worktree PathChange。工作树仍有 staged、unstaged 或 untracked 内容时，不能启动审查；该状态应作为范围或实现阻塞报告，而不是向用户重新请求同一实施阶段的提交授权。

### 最终审查去重

每个阶段先完成实现和测试验证并创建 review commit；**Code Reviewer** 仅对从已解析 fixed point 到该 review commit 的已提交差异执行一次 Standards + Spec 双轴审查，绝不审查未提交内容。完成所需 Git 与测试命令验证的双轴审查才是最终独立审查。工具不可用或命令被拒绝导致的审查不算完成；审查能力基准恢复后可重新委派一次。同一会话中，同一稳定差异的已完成审查不得再次委派任何审查角色。评审发现必须先报告用户，由用户决定是否修复以及修复哪些项；`begin-review` 只能从 pending execution review 进入，开始后不得替换固定端点。用户确认的修复必须形成晚于 review commit 的追加提交，且 `complete-review-fix` 必须记录非空验证结果；验证后直接整合，不自动复审相同范围。只有用户明确要求新的独立审查，且代码、测试、规格或审查能力基准发生变化时，才可重新委派 **Code Reviewer**；重新审查仍只执行一次双轴审查。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="planning-governance" -->

## Planning 主入口

**Planning** 是可选的 plan-only 主入口，**Orchestrator** 仍是默认入口。Planning 通过逐题问询建立共享理解，只生成并保存可直接实施的完整计划，不编写或实施代码，也不自动把计划转交实施。

Planning 不得直接枚举、读取、搜索或检查工作区文件。所有仓库事实、现有实现、配置、测试、路径和同名计划检查必须委派 **File Explorer**；用户已经直接提供的内容可以使用。可通过文件检索回答的问题不得转问用户，File Explorer 无法确认时才向用户报告不确定性。

Planning 只能委派 **File Explorer**，只能写入 `.ai-work-flow/plans/<planId>.md`。Codex 无法强制路径级写入限制时，该边界由策略和提示词约束；Claude Code 与 OpenCode 使用平台代理的路径权限阻断其他写入。

Planning 收到编码、修改源码或实施请求时必须拒绝，并引导用户改用 **Orchestrator** 或实施代理。

<!-- ai-work-flow:section-end -->

## 回复格式

角色正文定义的 `## 回复格式` 适用于正常回答。没有内容的标签应省略；存在阻塞或需要用户决策时，必须使用 `**阻塞：**` 说明原因与所需决策。
