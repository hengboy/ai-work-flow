# Agent 路由规则

<!-- ai-work-flow:section id="browser-governance" -->

## 浏览器自动化门禁

只有用户在当前请求中明确要求浏览器自动化、E2E 测试或视觉验证时，角色才能调用 Browser、Chrome DevTools、Playwright CLI 或操作可见浏览器。仓库存在前端或 E2E 配置不构成授权。获准后默认使用无头模式，除非用户明确要求可见浏览器。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="handoff-governance" -->

## 子代理 JSON 交接

子代理最终只返回一份仅供主代理消费的 JSON，不附加 Markdown 或解释：

```json
{
  "status": "done|blocked",
  "summary": "非空摘要",
  "artifacts": [],
  "checks": [],
  "details": {},
  "blocking_reason": "仅 blocked 时存在"
}
```

`done` 不得包含 `blocking_reason`；`blocked` 必须包含非空 `blocking_reason`。`artifacts` 记录产物路径或提交，`checks` 记录实际执行的验证，`details` 使用角色模板规定的字段。不得把缺失输入、失败检查或未完成工作包装为 `done`。主代理验证交接后再转写用户可读摘要。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="retry-governance" -->

## 子代理故障与重试

每个子任务的首次尝试最多重试 2 次，共 3 次。只重试暂态 429、502/503/504、超时、连接重置或结果未知；硬配额/计费 429、400/401/403/404、参数或模型配置错误、正常任务失败、测试失败和需求不清不可重试。429 遵从 `Retry-After`，否则等待 30 秒、60 秒；网关或连接错误等待 5 秒、15 秒；单次等待不超过 120 秒，不承诺平台未提供的原子性或精确计时。

重试前停止旧子代理；只有确认其已终止，才能用全新子会话重试。无法确认终止时启动停止锁：停止新委派、恢复和继续，尽力中止全部已知活跃子代理，报告错误、尝试数、最后错误和会话状态，等待用户明确“继续”或“重试”。恢复后先确认没有持续运行的旧会话，再重置本轮预算。OpenCode 必须新建 child session，复用 `task_id` 只表示恢复。Code Reviewer 可按审查编排契约对可澄清的叶子阻塞额外重试一次。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="planning-governance" -->

## Spec-First 规划治理

Planning 必须通过一次一个问题的持续问询，沿影响结果的设计分支按依赖顺序解决用户决定；仓库事实由 File Explorer 查证。只有事实已查清、关键分支与依赖已解决、验收场景和范围边界具体、假设、矛盾与未决问题为零，且用户明确批准复述的共享理解，共享理解门禁才通过。门禁通过前不得委派 Planning Writer、Task Planner 或 Git Operator；新信息或需求变化会重新关闭门禁。

目录式规划固定使用 `.ai-work-flow/plans/<plan-id>/spec.md` 与同目录 `plan.md`。spec 必须为 `approved`、包含固定章节且 `开放问题` 正文为 `N/A`。spec 写入、校验并取得原始完整字节 SHA-256 后，Planning 必须先暂停并取得用户明确的拆分或不拆分模式；确认前不得写 plan、生成 task 草案或修改 tasks。确认后 plan 才能写入，必须为 `ready-for-implementation`，通过 `source_spec` 和摘要绑定规格，并以 `task_mode: split|single` 绑定已确认模式。Planning 与 File Explorer 都必须校验该字段；缺失、格式非法、模式、路径或摘要不匹配时 fail closed。

spec 只保留确认后的 what、边界与验收共享认知。plan 不重复 spec 的问题陈述、目标、用户故事、范围、范围外事项或假设，只包含技术与代码上下文、实施方案、顺序步骤、任务边界与依赖、具体改动、接口与数据流、失败处理、测试与验证、兼容迁移发布等实施信息。旧平铺计划、plan-only 目录和失效 tasks 不迁移、不兼容、不反向生成规格。计划重写立即使旧 tasks 失效。仅 `task_mode: split` 可由 Task Planner 生成草案并在确认颗粒度后全量替换 tasks；`task_mode: single` 不得生成草案或 task 文件，删除已有 tasks 仍需单独确认，且完成时 `tasks/` 目录必须不存在。规划提交只包含当前 spec、plan 和完整 tasks 集合或已确认删除。平台只能把真实强制的能力标为 `enforced`，阶段顺序保持 `instruction-only`。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="orchestration-governance" -->

## 实施编排

用户明确批准当前阶段后，Coding 自动完成该阶段内全部确定性步骤：发现、委派、等待、验证、受控本地提交、同步、评审、整合和清理。不得询问“是否继续”“是否提交”或“是否评审”，也不得重复请求已经授予的提交授权。

普通目录式流程为 **Git Operator prepare -> Full Stack Coder -> Git Operator commit/sync/prepare+verify -> Coding 验证原样交接 -> Code Reviewer independent verify -> Review Standards + Review Spec -> Git Operator integrate/cleanup**。单任务用 feature worktree；拆分按依赖 frontier，scope 互斥可并行非 Git 工作，Git 串行。`write_scope` 不是授权；实现限验收所需源码、测试、配置、索引、lockfile 和当前 checkbox，不回写已批准元数据。Git Operator 仅在 commit/sync 成功后用安装运行时 prepare+verify，不执行审查；Coding 验证后才委派 Code Reviewer。

所有文件检索、未知路径定位和代码导航索引读取必须交由 File Explorer 执行；其他角色只消费其精确交接。Full Stack Coder 在新增、移动、重命名、拆分、合并、删除文件或改变入口、路由、API、主职责时随实现维护 `.ai-work-flow/index/`。Coding 只委派执行具体 skill 的可执行角色，不把 skill 当作未指定所有者的工作。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="change-handoff-governance" -->

## 变更交接

实现或修复开始前记录完整 `base_commit`，确认当前 `HEAD` 等于它，并以 `git status --porcelain=v2 -z --untracked-files=all` 证明初始状态必须为空。完成后只用同一 porcelain v2 `-z` 解析稳定排序的 `changed_paths: PathChange[]`；每项为 `{record_type,index_status,worktree_status,path,source_path?}`，rename/copy 必须保留两条 Git 原始路径，不得按换行或展示文本反解析。

实现交接的 `details` 必须包含 `base_commit`、空的 `initial_status`、完整 `changed_paths` 与 `acceptance_evidence`；`checks` 逐条记录成功命令和结果。写入型非实现角色的 `details` 必须包含精确 `target` 与 `changed_paths`。变更为空、HEAD 变化、状态与交接不一致、验证失败或存在未交接变更时返回 `blocked`。

冲突解决必须保留两侧有效行为；整体选择 ours/theirs、删除任一侧实现或机械拼接均不可接受。无法确定正确合并语义时暂停并请求用户裁决。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="git-lifecycle-governance" -->

## Git 生命周期

Git mutation 必须串行并由 Git Operator 执行，包括 planning commit、worktree 创建、review commit、同步、task 汇入、最终整合和清理。普通实施使用稳定唯一 `worktree_id`、`ai-work-flow/<worktree_id>` 分支和 `.worktrees/<worktree_id>`；创建前幂等维护 Git `info/exclude` 的 `/.worktrees/`。既有 worktree 只有仓库、分支和基点全部匹配时才能恢复。

用户确认方案或要求实施即授权当前实现阶段创建仅本地 review commit，不需要首次暂存前再次授权。授权不包括 push、amend、reset、clean、stash、标签、方案外变更或破坏性分支操作。Git Operator 收到成功交接后调用 `$git-commit`，核对 `HEAD == base_commit`、PathChange 全字段和验证；只能用参数数组与 `--` 暂存声明路径，确认 staged 集合一致且非空。hook 失败不 reset、clean 或重试，返回真实 index/worktree 状态。

提交成功后 `details` 包含完整 `full_commit_sha`、`review_commit` 和 `worktree_clean: true`。同步、提交或验证失败时不启动审查。blocking finding 修复提交必须不同于且后继于首次被拒的 review commit，并等于 feature/task HEAD。

整合前确认主工作树与 feature worktree 干净、`main` 等于最近同步 fixed point、feature HEAD 等于允许整合的 review commit。若 main 前进，返回 `resync_required`，同步并重新评审最终提交；同步冲突进入冲突解决与重新评审。通过后只运行 `git merge --ff-only <review_commit>`，再在 worktree 干净且分支已合并时移除 worktree，并用 `git branch -d` 删除本地分支。主工作树无关改动默认阻塞；stash 必须获得本次操作的明确授权。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="review-evidence-governance" -->

## 审查证据契约

审查只接受完整 `fixed-point` 与 `review-commit` SHA 的已提交范围。Code Reviewer 预检并保存：

```bash
git rev-parse <fixed-point>
git rev-parse <review-commit>
git status --short
git diff <fixed-point>...<review-commit>
git log <fixed-point>..<review-commit> --oneline
```

两个端点必须可解析，fixed point 是 review commit 的祖先，diff 非空，审查 worktree 的 `HEAD` 等于 review commit 且工作树干净。输入 range、commit list 或 changed paths 与 ReviewManifest 不一致时阻塞。禁止用无参数 `git diff`、`git diff --cached` 或工作树文件读取命令取证。每项 finding 引用 ReviewManifest shard ID 和 `git diff --no-ext-diff <fixed-point>...<review-commit> -- <paths>` hunk；上下文只使用 `git show <review-commit>:<path>`，不得从 committed diff 外新增 finding。

ReviewManifest 机器冻结端点、commit list、真实 PathChange、review checks、diff、spec/standards source、稳定 shards 和 digest。envelope 绑定 manifest、原始 verify input、两种 digest、runtime provenance、prepare verification，严验 known fields/type/mode/shard/command/bundle。manifest 机器绑定 acceptance evidence/Verification digest；`spec_status=present` 时同时绑定 spec/plan/可选 task；`spec_status=absent` 时输入不得提供 mode/spec/plan/task 路径且生成的 single bundle sources 必须为空。Git Operator 以同一安装 CLI prepare 后立即用原始 stdout verify，再逐字节交 Coding 原样转交；Code Reviewer 独立 verify Git facts。全程禁摘要、删改/重建 envelope、切换仓库 CLI。目录式 present 单任务 bundle 为 `.ai-work-flow/plans/<plan-id>/spec.md + plan.md`；拆分 task 加当前 task、acceptance evidence 与 Verification 结果；聚合绑定 spec+plan。不得退化为 instruction-only、单文件审查或静默遗漏上下文。

runtime provenance 绑定 source identity/revision 与摘要，禁绝对路径。安装同事务写 provenance/runtime/agents。CLI fail closed；旧/缺失/篡改/协议/来源漂移须 install/generate，禁 fallback/静默兼容/自动修复；重复生成幂等。

Standards 轴使用冻结 revision 的仓库 Standards、`MEMORY.md` 等来源，`spec.md` 不是 Standards 来源；仓库规则优先，跳过工具规则。Spec 轴查缺失/部分需求、scope creep、行为错误。叶子保留 `{verdict, blocking_findings, advisory_findings, manifest_digest, coverage}`；finding 有稳定 ID 和证据。shard/digest 不完整即阻塞。

<!-- ai-work-flow:section-end -->

<!-- ai-work-flow:section id="review-orchestration-governance" -->

## 审查编排与门禁

审查拓扑固定为 **Git Operator prepare+verify -> Coding 验证并原样转交 -> Code Reviewer 独立 verify -> Review Standards / Review Spec**。Code Reviewer 调度前逐项核对用户需求/批准标准与 `acceptance_evidence`、`verification`；“CLI 能运行”等无关证据返回单数 `blocking_reason`，不伪造 finding。通过后只根据不可变 ReviewManifest 调度；present 并行两叶子，absent 只 Standards。两叶子接收完全相同的 SHA、diff、commit list、来源、shards、manifest/digest、原始 verify input及相同 spec bundle。保留 Standards、Spec 原顺序，不跨轴合并或重排。

coverage 完整且无 blocking finding 时自动整合；advisory findings 只报告。blocking finding 进入 `awaiting_user`，用户必须确认具体 finding IDs，不能 approve 绕过。普通目录式流程的获批修复验证并形成合格后继 review commit 后，自动同步并继续：task 汇入、清理和下一 frontier，或单任务/聚合最终整合与清理；不执行第二次评审，也不进入新的用户决策点。冲突解决或 `resync_required` 后仍重新评审最终提交。

结构、协议、provenance、来源、digest、revision、shard、bundle、语义失败不重试；仅治理列出的瞬时错误在停止旧会话后重试。叶子仅在 manifest、digest、SHA、shards 和来源均不变且只需澄清时，由 Code Reviewer 在新会话重试一次；仍阻塞即报告用户。

<!-- ai-work-flow:section-end -->
