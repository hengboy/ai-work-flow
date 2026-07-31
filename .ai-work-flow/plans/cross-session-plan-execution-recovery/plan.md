# 跨会话目录计划执行恢复

## Plan Metadata

- plan-id: `cross-session-plan-execution-recovery`
- status: `ready-for-implementation`

## Problem Statement

当前目录式计划的契约主要存在于代理模板和 README 中，缺少独立、可验证、可持久化的执行 runtime。Coding 在新会话中只能依赖会话上下文判断计划是否已启动、任务执行到何处、评审或冲突是否已处理，无法可靠地区分“尚未开始”“执行中断”“Git 操作已完成但状态未登记”和“已完成的新旧计划版本”。这会导致重复派发、重复提交、重复评审、重复合并，或在身份不可信时错误接管旧 branch、worktree 和脏现场。

现有 `execution-runtime/execution-cli.mjs` 服务于 `.scratch/<feature>/spec.md + issues/` 协议，实际按单 ticket 串行执行。它的 checkpoint、schema、命令和状态转换不能表达目录式计划的 task graph、同 frontier 多 claim、task 级双轴评审、逐 task 汇入、main 同步、聚合评审与最终整合。直接扩展或复用其状态会混淆两套协议，并给现有执行带来兼容风险。

因此需要新增目录计划专用的 canonical runtime，将 `.ai-work-flow/plans/<plan-id>/plan.md` 与可选 `tasks/` 契约落实为版本化 checkpoint 和严格状态机。runtime 必须在同一 Git common dir 内跨会话恢复全部关键阶段，观察并验证 Git 事实后幂等补记状态，同时对损坏、身份不一致、活动锁、路径逃逸和不完整评审 fail closed。

## Solution

在 `execution-runtime/` 中新增独立 canonical `plan-execution-cli.mjs`、当前版本 plan checkpoint schema 及目录计划专用模块。新 runtime 与现有 `execution-cli.mjs` 并存：使用独立命令、独立 schema、独立 checkpoint 命名空间和独立状态模型，不导入、不迁移、不兼容旧 checkpoint，也不改变 `.scratch/<feature>/spec.md + issues/` 的行为。

执行入口先解析显式 plan ID、计划目录或 `plan.md` 路径；仅在未指定时自动发现合法目录式计划。prepare 冻结 planning commit、plan digest、完整 task graph、确定性 run/branch/worktree identity 和执行模式，并在 Git common dir 下原子创建 checkpoint。没有 `tasks/` 时物化一个 synthetic task；目录存在但为空或任一 task 非法时阻塞。

所有状态 mutation 由跨进程 run lock 保护并通过纯状态转换完成。Git Operator 是唯一调用 mutation 命令和执行 Git mutation 的角色；Coding 负责 discover/prepare/status、按 frontier 编排 claim 与委派，但通过 Git Operator 调用固定 runtime mutation。Full Stack Coder 只在获授 task worktree/write scope 内实施或恢复现场并返回结构化 FSC handoff；Code Reviewer 按冻结的 ReviewManifest 执行 task 或 final 双轴评审。

task graph 按 `blocked_by` 计算 frontier。同一 frontier 可同时存在多个独立 `in_progress` claim 和 FSC 执行，但全部 Git mutation 严格串行；每个 task 从同一 feature HEAD 建立确定性的 branch/worktree，完成 task scope 评审后按 task 编号依次汇入 feature，整层 frontier 全部汇入后才开放下一层。全部 task 完成后依次执行 main sync、final review、必要修复及用户决定、经验证的 ff-only final integration 和 cleanup。

恢复时 runtime 以 checkpoint 为信任锚，联合观察 repo/common dir、worktree、branch、base/start commit、HEAD ancestry、路径范围、提交、manifest 和整合结果。可证明已完成但未登记的动作采用幂等落盘；活动 claim 必须经用户确认旧会话停止后才能 reclaim；任何未提交现场原样保留，不 reset、clean、覆盖或重建。

## Goals and Success Criteria

1. **G1：目录计划可被稳定识别并形成不可混淆的 run。** 显式输入始终优先；自动发现对零、唯一和多个候选给出确定结果；同一仓库相对 plan 路径与同一 planning commit 始终产生相同 `run_id`，新 planning commit 产生新 run，terminal run 不再被自动发现。
2. **G2：计划工件在执行前被完整冻结和验证。** 目录计划、显式旧平铺计划和 synthetic task 均可形成规范 task graph；连续编号、向后依赖、无环、来源 digest、字段完整性和同 frontier `write_scope` 互斥任一失败时不创建可执行 claim。
3. **G3：checkpoint 是跨会话恢复的唯一执行状态来源。** 当前 schema 能持久化完整执行事实；损坏、旧版本、plan/commit/common-dir 身份不匹配的 checkpoint 均 fail closed，且不会导入旧 runtime 状态。
4. **G4：所有 mutation 保证单 writer、合法顺序和幂等性。** 活动锁阻止并发写；仅可验证失效锁可恢复；每个命令在合法重试时返回既有结果，在非法 phase、身份或重放输入下零状态推进。
5. **G5：frontier 并发执行与串行 Git mutation同时成立。** 同一 frontier 可为全部可调度 task 建立独立 claim 并并发委派，且 task branch/worktree 基于相同 feature HEAD；提交、评审冻结、task 汇入、同步和最终整合由 Git Operator 严格串行，同 frontier 未全部汇入前下一 frontier 不可 claim。
6. **G6：task 与 final 评审可跨会话精确恢复。** 每次评审冻结 scope、range、digest、coverage 和 ReviewManifest；中断后复用同一 manifest 并展示已记录 findings；blocking finding 必须进入修复，用户决定和 finding IDs 被持久化，重新评审覆盖新的完整 committed range，选择继续时不自动复审。
7. **G7：Git 已发生、checkpoint 未登记的边界可安全恢复。** task commit、task merge、main sync、final fast-forward 和 cleanup 在新进程中能通过预期身份与 Git 事实验证后补记，且不产生重复提交、派发、manifest 或 merge。
8. **G8：活动 claim 与脏现场只能人工授权接管。** status 显示旧 task/session/claim；未确认时 reclaim 被拒绝；确认后旧 claim 作废并生成新 claim，原 worktree 改动保持不变，FSC 恢复后重新运行 Verification 并提交新的结构化 handoff。
9. **G9：代理、文档和安装资产形成一致发布单元。** 四个角色模板、README、导航、runtime reference、资产校验、事务计划和三平台生成物均引用实际存在的命令/schema，临时 HOME/XDG_CONFIG_HOME 安装完整且事务失败不留下部分安装。
10. **G10：现有 runtime 和用户现场保持兼容。** 现有 `execution-cli.mjs`、spec checkpoint/schema、命令和测试行为不变；禁止的 Git 操作不会被引入；回滚不删除 terminal/blocked checkpoint、未知 branch/worktree 或未提交现场。

## User Stories

- 作为 Coding，我希望新会话先 discover/prepare/status，从而无需依赖旧会话上下文即可启动未实施计划或定位准确恢复阶段。
- 作为 Coding，我希望 runtime 返回当前 frontier、所有 claim 和阻塞原因，从而可在宿主并发容量内并行委派互不冲突的 task。
- 作为 Git Operator，我希望每次 mutation 都有明确 phase、run/task/claim 身份和可校验结果，从而串行执行 Git 操作并安全重试中断步骤。
- 作为 Full Stack Coder，我希望 reclaim 后继续原 worktree 的未提交改动，从而不丢弃现场，并在完成后重新运行 task Verification、生成绑定新 claim 的 handoff。
- 作为 Code Reviewer，我希望获得冻结且可复用的 ReviewManifest、完整 committed range 和既有 findings，从而跨会话继续 task 或 final 双轴评审而不改变覆盖范围。
- 作为用户，我希望 runtime 在接管活动 claim、处理 blocking findings 和修复后流程选择时保存我的明确决定，从而避免代理自行推断高风险动作。
- 作为维护者，我希望目录计划 runtime 与旧 spec runtime 隔离，从而发布或回滚新能力时不改变现有执行协议。
- 作为维护者，我希望安装器在三平台生成物中完整携带新 CLI、schema 和代理契约，从而不会出现模板引用缺失 runtime 资产的安装。

## Scope

本计划包含：

- 目录式计划和显式旧平铺计划的 intake、发现、解析、验证、synthetic task 物化及确定性 run identity。
- Git common dir 专用命名空间中的版本化 plan checkpoint、跨进程 run lock、原子写入、损坏检测和 terminal 保留。
- task graph/frontier、多 claim、task/review/fix/sync/integration/cleanup 的纯状态机及全部 canonical CLI 命令。
- branch/worktree/commit/ancestry/path/symlink/ReviewManifest/main sync/task integration/final fast-forward 的事实校验和幂等恢复。
- Coding、Git Operator、Full Stack Coder、Code Reviewer 四角色恢复契约与既有委派拓扑接入。
- README、feature navigation、必要 runtime reference、安装资产清单、事务安装计划和三平台生成测试。
- 单元测试、临时 Git 仓库 E2E、进程边界恢复、发现/接管/负向测试及临时 HOME/XDG_CONFIG_HOME 隔离安装验收。

实施仅修改仓库源码、测试、代理模板、文档和安装生成契约；真实全局 AI Work Flow 安装不在本次执行中发生。

## Implementation Decisions

### Runtime 与 schema 隔离

- `plan-execution-cli.mjs` 是目录计划唯一 canonical 状态转换入口；不得通过直接编辑 checkpoint 或调用旧 `execution-cli.mjs` 推进目录计划。
- plan checkpoint 使用独立 schema ID、schema version、文件命名空间和解析入口。只接受本功能发布的当前 schema；未知版本、旧实验文件和 spec checkpoint 一律拒绝，不迁移、不降级。
- 允许复用现有成熟的进程锁、临时文件加原子 rename、Git/path 完整性和 ReviewManifest 原语。若直接提取共享代码可能改变旧 runtime 行为，优先复制小型稳定原语；只有在旧 runtime 与新 runtime 均有完整回归测试时，才提取无行为变化的共享模块。
- 不对旧 runtime 做大范围重构，不改变其单 ticket 串行语义、命令行参数、checkpoint 路径或 schema。

### 输入优先级、发现与版本身份

- 输入优先级固定为：显式 `plan.md` 路径、显式计划目录、显式 plan ID、未指定输入时自动发现。所有显式形式归一化为仓库相对 canonical plan 路径并验证位于允许根内。
- 自动发现只扫描 `.ai-work-flow/plans/<plan-id>/plan.md` 形式且通过基础结构校验的目录式计划。旧平铺 `.ai-work-flow/plans/<plan-id>.md` 永不参与自动发现，只能显式指定。
- 每个候选以“仓库相对 plan 路径 + 包含该版本计划工件的 planning commit”识别版本。terminal checkpoint 只排除完全相同 run；同一路径在新 planning commit 中仍是新候选。
- 零候选返回结构化、可操作的 `no-candidate` 状态和显式输入提示，不写 checkpoint。唯一候选直接进入 prepare 或已有 run 的 resume/status。多个候选返回路径、planning commit、run/status/phase 和活动 claim 摘要并要求用户显式选择，不写新 checkpoint。
- `planning_commit` 取 Git 历史中包含当前 plan 工件版本的提交，并要求工作树中的 plan/task 内容与该提交一致。显式旧平铺计划同样绑定其 planning commit。
- `run_id` 由规范化仓库相对 plan 路径与 planning commit 通过带版本域分隔的稳定摘要确定性计算。`feature_branch`、各 `task_branch` 和 `.worktrees/` 路径分别由 `run_id`、task identity 和固定命名规则生成；冲突命名不自动加随机后缀，而是验证归属或阻塞。
- 所有路径必须经 realpath/lstat 分段验证位于仓库、Git common dir、计划根或 `.worktrees/` 对应允许根内；任一父级或目标符号链接导致越界或身份不明确时拒绝。

### Task 解析与 frontier

- canonical 目录输入为 `plan.md` 和可选 `tasks/NN-<short-name>.md`。不存在 `tasks/` 时创建仅存在于 checkpoint 的 synthetic 单任务；其 source 为 plan、write scope 为计划允许实现范围，Outcome/Checklist/Acceptance/Verification/Out of Scope 从 plan 对应章节规范化冻结。
- `tasks/` 存在时必须至少有一个合法 task 文件；空目录、非连续 `NN`、重复 task ID、文件名/正文 ID 不一致、缺字段或非法格式均阻塞，不得退化为 synthetic task。
- 每个 task 冻结 `task_id`、`order`、`blocked_by`、`source_plan`、`source_plan_digest`、`write_scope`、`Outcome`、`Checklist`、`Acceptance`、`Verification` 和 `Out of Scope`。恢复时重新计算来源 digest，任何差异均阻塞原 run。
- 依赖只允许指向编号更小的 task；校验全部引用存在、无自依赖、无环。frontier 是所有依赖已 integrated 且未进入 claim/完成状态的 task 集合。
- 同一 frontier 中任意两个 task 的规范化 `write_scope` 不得相交；路径前缀覆盖、同文件、宽泛根与子路径均视为相交。冲突在 prepare 阶段阻塞，不通过降低并发或排序来掩盖非法计划。
- 同一 frontier 的 task branch/worktree 从该 frontier 开放时冻结的同一 feature HEAD 创建；完整 frontier 全部按 task 编号 integrated 后，下一 frontier 才以新的 feature HEAD 开放。

### Checkpoint、锁与单 writer

- checkpoint 位于 Git common dir 下目录计划专用命名空间，以 `run_id` 分区，不进入 Git 提交，不写入 main 工作树。checkpoint 只支持同一 Git common dir、同一工作区内跨会话或客户端重启恢复。
- schema 冻结：repo identity、common-dir identity、plan 路径/digest、planning commit、run ID、execution mode、完整 task graph、feature/task branch 与 worktree、frontier snapshot、claims、FSC handoff、task/review commits、ReviewManifest、findings、用户决定、conflict、main sync、task integration、final integration、cleanup 和 terminal result。
- 每次 mutation 先获取 feature/run 级跨进程锁，锁中包含 run、进程、主机、session、创建时间和可验证 owner token。活动 owner 阻塞；只有进程已不存在且 token/run/path 均匹配的失效锁才可原子接管。无法验证时按活动锁处理。
- 写入流程固定为：读取并 schema 校验当前 checkpoint、验证 expected revision 和命令身份、计算纯状态转换、对外部 Git 事实执行只读验证、将完整新状态写入同目录临时文件、fsync 文件及目录、原子 rename、释放锁。失败不得留下半写 checkpoint。
- mutation 请求携带 `run_id`、预期 checkpoint revision，以及适用时的 `task_id`、`session_id`、`claim_id`、manifest ID 或 operation ID。旧 claim/session 重放、envelope/payload 状态不一致、未被 checkpoint 预期的 Git 事实均拒绝。
- mutation 命令的幂等条件是 identity、规范化 payload digest 和已持久化结果完全一致；返回原结果但不增加 revision。相同 identity 配不同 payload、跨 phase 重试或试图覆盖已有决定一律失败并零状态推进。

### 状态模型与角色权限

- run 顶层阶段采用可验证的细粒度状态：`prepared`、`task_execution`、`task_review`、`task_fix`、`task_integration`、`main_sync`、`final_review`、`final_fix`、`final_integration`、`cleanup`、`completed`、`blocked`。每个 task 另有 claim、handoff、commit、review、fix、integration 子状态，允许同一 frontier 多个 task 同时 `in_progress`。
- `blocked` 保存可恢复原因和最后可信阶段，不表示可忽略错误；解除仅能由对应 complete/retry 命令在重新验证事实后完成。`completed` 和不可继续的 terminal blocked 结果保留为 terminal checkpoint。
- Coding 在任何目录计划实施前必须调用 discover/prepare/status。Coding 依据 status 和平台容量选择当前 frontier 的可调度 task并发委派，但不直接执行 Git mutation 或手改 checkpoint。
- Git Operator 是唯一 Git mutation 与 plan runtime mutation 执行者。其调用权限仅限固定 runtime 命令和既有 Git 职责，不获得源码、计划、task、冲突文件或其他普通文件的通用编辑权限。
- Full Stack Coder 只编辑获 claim 的 worktree 和 `write_scope`，处理实现及 task merge conflict；不得调用 mutation CLI。Code Reviewer 只读冻结 manifest/range，并返回结构化 findings；不得改代码或推进状态。
- 禁止所有角色执行 push、stash、amend、reset、clean 或丢弃未提交改动。最终 integration 只允许验证后的 ff-only；不能快进时停止并持久化冲突/阻塞事实。

### Review 与用户决定

- `begin-review --scope task:<task-id>|final` 创建或复用冻结 ReviewManifest。task scope 覆盖该 task 从 start/base 到 task review commit 的完整 committed range，并同时校验 task write scope 与计划验收轴；final scope 覆盖 planning/feature 基线到同步后 feature HEAD 的完整聚合 range和所有 task coverage。
- manifest 固定 scope、base/head、commit range、文件 digest、覆盖轴、task/plan acceptance、创建 operation ID。评审中断只能复用同一 manifest；不得静默重算。若 head 发生合法修复变化，必须由“重新评审”决定创建下一代 manifest并覆盖旧 manifest 后新增的完整 committed range及既有验收范围。
- `record-review` 可按 manifest 增量记录 findings，但 finding ID、severity、axis、location、evidence 和 disposition 必须稳定；新会话 status 展示已记录 findings 和未完成 coverage。
- 任一 blocking finding 使 scope 进入 fix，不能直接接受或整合。`review-decision` 保存用户明确确认的 finding IDs 和处理决定，不接受模型推断。
- 修复提交校验完成后，`post-fix-decision` 只接受 `re-review` 或 `continue`。`re-review` 进入新完整 committed range 的冻结评审；`continue` 明确跳过自动复审并进入 task integration 或 final integration。决定持久化且不可被后续重试覆盖。

### 恢复与 fail-closed

- `in_progress` claim 永不自动接管。status 显示 task、旧 session、claim、worktree、start/base、现场摘要和所需确认；仅当用户明确确认旧会话已停止，Git Operator 才可调用 `reclaim-task` 作废旧 claim并创建新 claim。
- reclaim 不重建 worktree。runtime 验证 repo/common dir、worktree、branch、base/start commit、HEAD ancestry 和变更路径范围；通过后 FSC 以恢复模式继续现有提交及未提交改动，重新执行冻结的 Verification，并生成绑定新 claim 的 handoff。
- 未提交现场始终原样保留。任何带现场的 worktree不得 reset、clean、checkout 覆盖、删除或重建；验证失败时保存/返回阻塞，不自动修复。
- handoff 已保存、提交已创建但未登记、评审已冻结、findings 已记录、用户决定待继续、task merge、main sync、final fast-forward 和 cleanup 中断，均通过观察 Git/文件系统事实、验证预期 identity 后幂等补记。无法唯一证明动作属于当前 operation 时不采用。
- 疑似旧 branch/worktree 且没有可信 checkpoint 时保留并阻塞；不得自动采用、重命名或删除。
- checkpoint 损坏，plan digest/commit 不匹配，run/branch/worktree/claim identity 异常，base/HEAD/commit ancestry 异常，路径越界或 symlink，活动锁，review range/coverage 不完整时 fail closed：命令非零返回、checkpoint revision 不变且不得 claim 新 task。
- completed 后保留 terminal checkpoint，discover 排除相同 run；cleanup 可重复观察并报告当前 run 的已清资源与仍保留资源，不删除未知或不属于 checkpoint 的资源。

## Implementation Changes

### 阶段 1：目录计划 intake、身份、schema 与 checkpoint store

1. 新增目录计划输入归一化与发现模块，实现显式路径/目录/ID 优先、目录候选自动发现、旧平铺仅显式、零/唯一/多候选结果和 terminal run 排除。
2. 新增 plan/task 解析器与规范化模型，冻结所有 task 字段；实现 synthetic task、空/非法 tasks 阻塞、连续编号、依赖、有向无环、source digest 和同 frontier write scope 互斥校验。
3. 新增确定性 identity 模块，从 repo/common-dir identity、仓库相对 plan 路径、planning commit、run/task identity 生成 run ID、branch 和 `.worktrees/` 路径，并实现 path boundary 与 symlink 拒绝。
4. 定义当前版本 plan checkpoint JSON schema 和运行时 schema 校验，覆盖完整 run/task/review/Git/cleanup/terminal 字段；建立与 spec checkpoint 完全独立的 common-dir 命名空间。
5. 实现 checkpoint store、revision、临时文件/fsync/原子 rename 和 run lock。优先复用经回归验证的旧 runtime 稳定原语；不能证明无行为变化时复制最小原语并保持独立测试。

阶段完成标准：纯文件/Git 只读 fixture 可稳定得到候选、task graph、run identity 和初始 checkpoint；所有非法输入在任何 claim 或 worktree 创建前失败。

### 阶段 2：纯状态机与全部 CLI 命令

1. 新增无 Git mutation 的纯 reducer，显式建模 run phase、task 子状态、多 claim、review/fix decision、integration、cleanup 和 terminal transition；每个 transition 校验 revision、operation identity、claim/session 和 payload digest。
2. 新增 canonical `plan-execution-cli.mjs`，实现 `discover`、`prepare`、`status`、`claim-task`、`reclaim-task`、`record-handoff`、`record-task-commit`、`begin-review`、`record-review`、`review-decision`、`complete-review-fix`、`post-fix-decision`、`integrate-task`、`complete-task-conflict`、`sync-main`、`complete-sync`、`integrate`、`cleanup`。
3. 所有结构化 mutation payload 只从 stdin 读取并先做 schema 校验；stdout 输出统一结构化 envelope，stderr 仅承载诊断。`discover`、`status` 和其他事实查询路径只读且不获取 mutation lock、不写 checkpoint。
4. 为每条命令实现“同 identity + 同 payload digest + 同已存结果”的幂等返回，以及非法 phase、旧 claim/session、状态/payload 不一致和 checkpoint 外事实的零推进拒绝。

阶段完成标准：状态机表驱动测试覆盖每条合法/非法边；CLI 在无 Git mutation 的 fixture 上可从 prepare 推进至 terminal，并证明重复请求不增加 revision。

### 阶段 3：Git、worktree、review 与 integration 事实校验及幂等恢复

1. 实现只读 Git facts adapter，验证 repo/common dir、refs、worktree registration/path、branch ownership、base/start/HEAD、commit/tree、ancestry、dirty paths、merge state 和 main/feature fast-forward 关系。
2. 实现 task branch/worktree 创建前置与登记结果校验，保证同 frontier 基于同一冻结 feature HEAD；Git Operator 执行 mutation，runtime 只接受与 checkpoint 预期 operation 相符的事实。
3. 实现 handoff、已创建未登记 task commit、task review commit、task merge 和 merge conflict 的观察/补记。冲突持久化后由 FSC 在限定 worktree 解决，`complete-task-conflict` 校验解决提交、父提交、路径范围与无残留冲突。
4. 实现 ReviewManifest 生成、digest、range、双轴 coverage 和增量 findings 校验；task 与 final manifest 分域，支持中断复用、blocking fix、用户决定、新完整 range 复审或显式继续。
5. 实现 main sync 的预期 ref/commit 校验、冲突状态与 `complete-sync` 恢复；实现逐 task 编号 integration、frontier barrier、final ff-only integration 和操作已发生未登记时的幂等落盘。
6. 实现 cleanup 资源归属验证和可重复检查：仅清理 checkpoint 明确拥有且状态允许的干净 task/feature worktree 与 branch，保留 terminal checkpoint、blocked 现场和任何未知资源。

阶段完成标准：临时 Git 仓库可在每个 Git 边界杀进程并由新进程恢复，不重复 commit、manifest、merge 或 fast-forward；所有异常 identity、ancestry、path 和 symlink fixture fail closed。

### 阶段 4：四角色契约与编排接入

1. 更新 `agent-build/templates/coding.md`：任何目录计划实施前必须 discover/prepare/status；按 status frontier 和宿主容量发起 claim；活动 claim 必须请求用户确认后通过 Git Operator reclaim；不凭会话记忆重复派发。
2. 更新 `agent-build/templates/git-operator.md`：其作为唯一 plan runtime mutation 与 Git mutation 执行者，按固定命令、stdin payload、串行队列和禁止 Git 操作执行；明确它不获得通用文件编辑权限，冲突编辑必须交还 FSC。
3. 更新 `agent-build/templates/full-stack-coder.md`：只接受绑定 run/task/session/claim/worktree/write scope 的委派；恢复模式保留既有现场、重新执行 Verification；handoff envelope/payload 必须一致并由 Git Operator record。
4. 更新 `agent-build/templates/code-reviewer.md`：仅按冻结 manifest/range/digest/coverage 评审，支持 task/final 双轴与既有 findings；不得自行改变范围、修复或推进决定。
5. 保持现有角色权限边界和委派拓扑：Coding 编排，Git Operator 串行 mutation，FSC 实施/冲突解决，Code Reviewer 只读评审，用户作接管及 finding 流程决定。

阶段完成标准：模板静态断言覆盖全部命令、角色边界、恢复入口和禁止行为；不存在绕过 runtime 的目录计划状态推进说明。

### 阶段 5：README、导航、reference 与安装资产

1. 更新 README 和 `.ai-work-flow/index/feature-navigation.md`，说明新会话入口、显式输入优先、自动发现消歧、旧平铺仅显式、人工 reclaim、脏现场恢复、fail-closed、terminal 排除和同工作区/common-dir 限制。
2. 新增或更新必要 runtime reference，列出命令 phase、输入 identity、stdin schema、持久化结果、幂等规则和错误语义；明确新旧 runtime 并存且 schema 不互通。
3. 将新 CLI、schema 和所需共享/独立模块加入安装器 asset catalog、完整性校验和事务复制计划。继续整体复制 `execution-runtime/`，不得以逐文件遗漏方式安装。
4. 更新三平台代理生成/安装期望，确保模板与 runtime/schema 在同一源码变更中发布。记录安装后只有新会话加载新代理契约，既有会话不假定热更新。

阶段完成标准：文档中的每个命令均可由 CLI help/schema 对照验证；三平台临时安装生成物包含一致的新 runtime 和代理契约，缺任一资产时安装在写入前失败。

### 阶段 6：测试与隔离验收

1. 完成 schema/parser/identity/lock/store/state machine/review/integrity 单元测试和临时 Git 仓库 E2E。
2. 为 claim、handoff、commit 未登记、review、用户决定、merge、sync、integrate、cleanup 设置进程终止点，以新进程执行 status/相应幂等命令恢复。
3. 完成 discovery、人工接管、脏 worktree、旧现场、损坏与身份攻击负向矩阵；断言失败时 checkpoint 字节/revision 不变且无新 claim、ref 或 worktree。
4. 在临时 HOME/XDG_CONFIG_HOME 下运行三平台安装生成和事务失败注入，验证不触碰真实全局安装、不留下部分安装。
5. 运行全仓和旧 runtime 回归命令，检查 diff whitespace 及实际变更只包含本功能源码、测试、模板、文档和安装资产。

阶段完成标准：`Testing Decisions` 中 T1-T10 全部通过，且根目录与旧 runtime 回归无行为变化。

## Public Interfaces

### CLI 通用约定

- 调用形式为 `node execution-runtime/plan-execution-cli.mjs <command> [identity options]`。结构化 mutation payload 从 stdin 接收 JSON，必须同时通过 command schema、handoff envelope schema和当前 checkpoint schema约束。
- 所有 mutation 接收 `run_id` 与 `expected_revision`；task 命令另接收 `task_id`，claim 相关命令接收 `session_id`/`claim_id`，review 命令接收 scope/manifest identity。身份既出现在 CLI 选择器也出现在 payload 时必须完全一致。
- 成功返回结构化结果、当前 revision/phase 和已持久化对象；失败返回稳定错误码、当前可信状态摘要和零状态推进保证。状态读取命令不写 checkpoint。

| 命令 | 前置 phase 与输入身份 | 成功持久化结果 | 幂等重试与失败语义 |
|---|---|---|---|
| `discover` | 任意；可选显式 plan ID/目录/plan.md，未指定时自动发现 | 无；唯一已有 run 返回恢复定位，唯一新候选返回 prepare 所需 identity | 纯读取；零候选不写状态，多候选不选择，非法/旧现场返回阻塞摘要 |
| `prepare` | 无该 run checkpoint，或同 run 初始化中断；输入 canonical plan、planning commit、repo/common-dir identity | 当前 schema 初始 checkpoint、完整 task graph、run/branch/worktree identity、`prepared` phase | 相同冻结输入返回既有 run；digest/commit/identity 不同或 terminal 同 run 重启被拒绝，失败不创建半 checkpoint |
| `status` | 已有可信 checkpoint；输入 run 或显式 plan identity | 无；返回 phase、frontier、claims、现场、review/findings/decision、冲突及下一合法命令 | 纯读取；损坏或身份异常只报告 fail-closed，不修复、不 claim |
| `claim-task` | `task_execution`；task 位于当前 frontier、未 claim/完成，输入 run/task/session 和预期 frontier/base | 新 `claim_id`、`in_progress` claim、task branch/worktree 预期 identity 与 start/base | 同 session/operation 重试返回同 claim；已有活动 claim、scope 冲突、frontier 改变或身份异常时零推进 |
| `reclaim-task` | `task_execution` 或可恢复 task 子阶段；存在旧活动记录且用户明确确认旧会话已停止 | 旧 claim 作废原因/确认记录、新 session/claim，保留原 branch/worktree/start/base | 同确认与 operation 返回同新 claim；无明确确认、旧 owner 仍活动、现场验证失败时拒绝且不改现场 |
| `record-handoff` | task 有匹配活动 claim；输入 FSC JSON Handoff envelope 与 completion payload | 绑定 claim 的 handoff、Verification 结果、done/blocked 状态和摘要 | 同 envelope digest 返回既有 handoff；旧 claim/session、envelope/payload 状态不一致、scope 越界时零推进 |
| `record-task-commit` | done handoff 已记录，task commit 已由 Git Operator 创建；输入 claim/task、预期 commit/tree/parents | task commit、task review commit、路径/ancestry 验证和 task `ready_for_review` | 已创建未登记提交可观察后补记；提交身份不唯一、含越界路径或 ancestry 不符时拒绝 |
| `begin-review` | task `ready_for_review`/修复后要求复审，或全部 task 汇入并完成 main sync 后的 final 阶段；`--scope task:<id>\|final` | 冻结 manifest ID、base/head/range/digest、双轴 coverage；进入对应 review phase | 同 scope/head/generation 返回同 manifest；已有冻结 manifest 不重算，range/coverage 不完整时零推进 |
| `record-review` | 对应 review phase 且 manifest 已冻结；输入 reviewer/session、manifest 和结构化 coverage/findings | 增量 coverage、稳定 findings、review completion；blocking 时进入 fix 门槛 | 相同 finding/coverage digest 可重放；manifest/range 不同、finding ID 冲突或遗漏要求 coverage 时拒绝 |
| `review-decision` | review 已完整记录；有 blocking finding 时只允许修复决定，无 blocking 时允许接受后续流程 | 用户确认的 finding IDs、decision、确认 identity/时间；进入 task/final fix 或后续阶段 | 完全相同决定返回既有结果；试图覆盖决定、漏 blocking ID 或非显式用户确认时拒绝 |
| `complete-review-fix` | `task_fix` 或 `final_fix`；输入 scope、决定、修复 commit/range 和已处理 finding IDs | 修复 commit、完整新 committed range、finding disposition，进入等待 post-fix decision | 已存在修复提交可验证补记；越界路径、缺 finding、commit/ancestry 异常时零推进 |
| `post-fix-decision` | 修复已完成且等待用户决定；输入显式 `re-review` 或 `continue` | 决定与确认 identity；前者开放下一代完整 review，后者进入 task integration 或 final integration | 同决定可重试；改变既有决定、自动推断或复审 range 无法形成时拒绝 |
| `integrate-task` | task review 已接受或修复后选择继续；此前编号 task 已汇入，当前 Git 操作串行 | 预期 merge operation、已验证 merge commit/ff 结果、task integrated；整 frontier 完成后开放下一 frontier | 已 merge 未登记可补记；顺序错误、feature HEAD 非预期或冲突时持久化 conflict 并不标记 integrated |
| `complete-task-conflict` | 对应 task integration conflict 已持久化；FSC 已提交冲突解决 | 解决 commit、父提交/路径/无冲突验证、task integrated 或可继续 integration 状态 | 同解决提交可重试；Git Operator 未经 FSC 编辑、残留冲突、父提交或 scope 异常时拒绝 |
| `sync-main` | 全部 task integrated；输入当前 main/feature 预期 refs 与 operation identity | sync operation 预期、base/main/feature 快照；无冲突时记录结果，有冲突时进入 sync conflict | 相同 refs/operation 返回现状；未完成 task、dirty/异常 refs 时零推进 |
| `complete-sync` | main sync 已执行或 conflict 已由 FSC 解决；输入同步/解决 commit 与 refs | 已验证 sync commit、同步后 feature HEAD，进入 final review | 已 sync 未登记可补记；main 漂移、ancestry/parents/scope 异常时拒绝并保留现场 |
| `integrate` | final review 已接受，或 final fix 后明确 `continue`；main/feature refs 与冻结结果仍匹配 | 经验证的 ff-only final integration commit/ref 结果，进入 cleanup | 已 fast-forward 未登记可补记；非快进、main 漂移、review head 不匹配时拒绝，不做 merge/reset |
| `cleanup` | final integration 已验证，或重复检查 terminal run；输入资源清单 identity | owned 资源清理结果、保留项、terminal `completed` result；terminal checkpoint 保留 | 重复调用验证残留并返回同/更新后的清理观测；脏、未知、blocked 或身份不明资源保留且不删除 |

### Checkpoint 与 handoff 接口

- plan checkpoint 为 runtime 私有持久化接口，供 CLI 跨进程读取；代理不得直接构造或编辑。schema version 是严格判别字段，不提供兼容映射。
- FSC completion result 嵌入 JSON Handoff envelope `payload`，至少包含 run/task/session/claim identity、`done|blocked` 状态、变更摘要、Verification、预期 commit 信息或 blocked error。envelope 与 payload 状态必须一致。
- ReviewManifest 和 review result 是版本化结构化对象。manifest 的 scope/range/digest/coverage 一经冻结不可修改；下一轮复审创建新 generation 并显式关联前一 manifest。
- 用户确认对象记录 decision kind、明确 finding IDs 或被接管 claim、确认来源/session 和符合仓库约束的时间戳；不可由代理默认值替代。

## Data Flow and Failure Modes

### 正常数据流

1. Coding 调用 `discover`。显式输入先归一化；无显式输入时返回零/唯一/多候选。唯一候选由 `prepare` 创建 run，已有 run 则直接 `status`。
2. prepare 从 planning commit 读取并验证 plan/task 工件，冻结 digest、task graph、frontier、run/branch/worktree identity；checkpoint store 在 run lock 内原子落盘。
3. Coding 根据 status 和宿主容量选择当前 frontier task。Git Operator 串行调用 `claim-task`，创建/验证各 task branch/worktree；Coding 可并发委派多个 FSC。
4. FSC 在各自 write scope 内实施或恢复，执行 Verification，返回结构化 handoff。Git Operator 串行 `record-handoff`、创建 task commit并 `record-task-commit`。
5. Git Operator `begin-review task:<id>` 冻结 manifest，Code Reviewer 按 manifest 执行双轴评审，Git Operator `record-review`。blocking findings 经用户确认进入 FSC 修复，再由 `complete-review-fix` 与 `post-fix-decision` 选择复审或继续。
6. 评审通过的 task 按编号由 Git Operator 串行 `integrate-task`。冲突写入 checkpoint，FSC 解决后由 `complete-task-conflict` 验证。整个 frontier integrated 后 runtime 才开放下一 frontier。
7. 所有 task integrated 后，Git Operator `sync-main` 并在必要时由 FSC 解决、`complete-sync`。随后 `begin-review final` 冻结聚合 manifest，执行 final 评审和同样的修复决定流程。
8. final gate 通过后，Git Operator 执行并登记 ff-only `integrate`；`cleanup` 只清理可证明属于该 run 的安全资源，保存 terminal checkpoint。

### 中断恢复

- **claim 后中断：** status 显示活动 claim；不自动派发。用户确认旧会话停止后 reclaim，原 worktree 与现场不变。
- **handoff 已生成或已保存：** 相同 claim/envelope digest 由 `record-handoff` 返回或补记，不重新委派已完成 task。
- **commit 已创建未登记：** `record-task-commit` 对预期 branch、tree、parent、scope 和 ancestry 做唯一性验证后补记，不再 commit。
- **评审冻结/记录中断：** `begin-review` 返回同一 manifest；status 展示已记录 findings/coverage，`record-review` 仅补充缺失部分。
- **用户决定后中断：** decision identity 已持久化；恢复直接展示下一合法命令，不再次询问或覆盖决定。
- **task merge/main sync/final fast-forward 已发生未登记：** 对 refs、operation identity、parents 和 ancestry 验证后由对应命令补记，不重复 merge 或移动 ref。
- **cleanup 中断：** 再次观察资源归属和状态，仅处理剩余可安全资源，terminal checkpoint 始终保留。

### Fail-closed 矩阵

| 失败 | runtime 行为 | 现场策略 |
|---|---|---|
| checkpoint JSON/schema 损坏或版本未知 | 拒绝所有 mutation 和新 claim，输出恢复诊断 | 原文件保留，不自动重写/迁移 |
| plan/task digest 或 planning commit 不匹配 | 阻塞原 run；新提交仅可形成独立新 run | 不把修改后计划混入旧 run |
| repo/common-dir/run/branch/worktree/claim identity 异常 | 零状态推进 | 未知 ref/worktree 原样保留 |
| base/start/HEAD/commit ancestry 或 parent 异常 | 拒绝登记、评审或整合 | 不 reset、不重建、不猜测提交 |
| write scope 越界、path boundary 失败或 symlink 逃逸 | 拒绝 handoff/commit/cleanup 并阻塞 | 不删除、不覆盖越界路径 |
| 活动 run lock | mutation 返回 busy | 不恢复活动锁；只读 status 可报告 owner |
| 活动 claim 未获用户确认 | reclaim 被拒绝 | 旧 session/claim 和 worktree 保持活动记录 |
| review range/digest/coverage 不完整 | 不完成 review gate、不进入 integration | 复用冻结 manifest 等待补全 |
| blocking findings 未修复或决定缺失 | 只能进入/停留 fix gate | 不接受、不 merge、不自动选择 |
| merge/sync 冲突 | 持久化 conflict 和预期 identity | FSC 处理，Git Operator 不编辑冲突 |
| final 不能 ff-only 或 main 漂移 | final integration 失败 | 不 merge/reset；保留 feature 与 checkpoint |
| 疑似旧 branch/worktree 但无可信 checkpoint | discover/prepare 阻塞并列出资源 | 不自动采用、删除或改名 |
| cleanup 遇到 dirty/未知/归属不明资源 | 记录保留项，可终止为 blocked cleanup | 用户现场与未知资源全部保留 |

所有失败路径必须保证 checkpoint revision 和已持久化对象不发生部分推进；只有“外部 Git 动作已经发生且与 checkpoint 预期 operation 唯一匹配”的恢复路径可以新增一条经验证的完成记录。

## Testing Decisions

### 目标到验收映射

| 测试组 | 对应目标 | 可验证场景与断言 |
|---|---|---|
| **T1 Intake/Discovery** | G1、G2 | 唯一/多个/零候选；显式 ID/目录/plan.md 优先；terminal run 排除；新 planning commit 产生新 run；旧平铺仅显式；`tasks/` 缺失生成 synthetic、空或非法阻塞；输出候选摘要字段完整 |
| **T2 Identity/Schema/Store** | G1、G3、G4 | run/branch/worktree identity 确定性；common-dir 命名空间隔离；当前 schema round trip；旧/损坏 schema 拒绝；锁竞争与失效锁；原子写失败注入后旧 checkpoint 完整 |
| **T3 Graph/Frontier/Claims** | G2、G5 | 连续编号、向后依赖、无环、digest、字段冻结、write scope 互斥；多 frontier barrier；同 frontier 多 claim；同一 feature HEAD；下一 frontier 不提前开放 |
| **T4 State/CLI Idempotency** | G3、G4 | 每个命令的合法 phase、非法 phase、expected revision、operation/payload digest、旧 claim/session、envelope/payload 一致性；合法重试 revision 不变，失败字节级零推进 |
| **T5 Review/Fix Decisions** | G6 | task/final manifest range/digest/双轴 coverage；中断复用；findings 增量恢复；blocking 仅修复；finding IDs 与用户决定冻结；修复后 re-review 完整新 range、continue 跳过自动复审 |
| **T6 Git Recovery E2E** | G5、G7 | 单任务、拆分任务、并发 frontier、串行 Git mutation、task conflict、main sync、final review、ff-only integrate、cleanup；每个已发生未登记动作在新进程补记且无重复 commit/merge/manifest |
| **T7 Reclaim/Dirty Site** | G8 | 活动 claim 无确认拒绝；确认后旧 claim 作废、新 claim 生成；dirty worktree 内容/inode/refs 保持；恢复 FSC 重跑 Verification；旧 claim handoff 重放拒绝 |
| **T8 Integrity/Negative** | G3、G4、G8、G10 | digest/commit/branch/worktree/ancestry/common-dir/symlink/path boundary/checkpoint 损坏、活动锁、review coverage 缺失均 fail closed；无可信旧现场保留并阻塞；禁用 Git 命令静态与行为断言 |
| **T9 Agent/Install** | G9 | 四角色模板包含完整 runtime 契约与权限边界；临时 HOME/XDG_CONFIG_HOME 下三平台生成物包含所有 CLI/schema/module；asset 缺失和事务失败不留下部分安装；真实全局目录未变化 |
| **T10 Compatibility/Rollback** | G9、G10 | 旧 `execution-cli.mjs`、spec schema/checkpoint 和命令快照/测试全通过；共享原语双套回归；功能源码撤销模拟不触碰 checkpoint、未知 branch/worktree 或用户现场 |

### 单元测试

- schema：有效完整 checkpoint、所有 required 字段、版本拒绝、envelope/payload 状态一致性、terminal/blocked 结果。
- intake：目录计划、显式旧平铺、synthetic task、空/非法 tasks、字段规范化、source digest 与 planning commit 解析。
- graph：编号连续、重复/缺失依赖、向后依赖、环、frontier 计算、多 claim 和 frontier barrier。
- identity：稳定 run ID、planning commit 变化、branch/worktree 命名冲突、repo/common-dir identity、允许根与 symlink/path boundary。
- persistence：活动/失效锁、owner token、并发 writer、临时文件、fsync/rename 失败注入、revision 和幂等 payload digest。
- state machine：全部 CLI transition 的前置 phase、成功状态、合法重试、非法顺序、旧 session/claim 重放和零推进。
- review：task/final ReviewManifest、完整 range、digest、双轴 coverage、finding 稳定 ID、blocking gate、两种 post-fix decision。
- Git facts：worktree/branch/base/start/HEAD、dirty paths、commit parents/tree/ancestry、merge state、ff-only 和资源归属。

### 临时 Git 仓库 E2E 与进程恢复

- 覆盖单 synthetic task、多个拆分 task、并发 frontier、严格串行 Git mutation、task merge conflict、blocking review fix、复审/继续两分支、main sync conflict、final review、ff-only integrate 和 cleanup。
- 在以下边界强制终止进程并由新进程恢复：claim 落盘后、handoff 生成前后、commit 已创建未登记、begin-review 已冻结、record-review 部分/完整、用户决定已记录、task merge 前后、sync 前后、integrate 前后、cleanup 部分完成。
- 每个恢复用例断言：不重复 FSC 派发、不重复 commit、不生成第二个同 generation manifest、不重复 findings、不重复 merge/fast-forward，且 checkpoint revision 只在补记新事实时增加一次。

### Discovery、接管与负向验收

- discovery fixture 分别产生零、唯一、多个候选；多个候选逐项验证路径、planning commit、run/status/phase/活动 claim 摘要；所有只读分支断言无 checkpoint 写入。
- terminal checkpoint 排除相同 run，但同路径新 planning commit 可发现；显式旧平铺可 prepare，自动发现永不返回旧平铺。
- 构造无 checkpoint 的同名 branch/worktree、活动 claim、脏 worktree、越界 dirty path、symlink 链、common-dir 更换、branch 被移动、commit ancestry 被改写、损坏 checkpoint 和活动锁，逐项断言保留现场、零推进且不创建新 claim。

### 安装与最终命令

- 在临时 `HOME`/`XDG_CONFIG_HOME` 中运行三平台安装生成测试，核对四角色恢复契约、`plan-execution-cli.mjs`、plan schema 及全部依赖模块；注入 asset catalog 和事务中途失败，断言目标目录无部分版本。
- 最终至少运行：
  - 仓库根目录 `npm test`
  - `skills/run-matt-spec-to-completion/` 下 `npm test`
  - `skills/run-matt-spec-to-completion/` 下 `npm run check:runtime`
  - 新增 plan runtime 定向单元与临时 Git E2E 测试命令
  - 现有 agent 模板/生成定向测试命令
  - 现有 installer/三平台生成/事务定向测试命令
  - `git diff --check`
- `npm run check:runtime` 和旧 runtime 测试是共享原语改动的强制门禁；若无法通过，则撤回共享提取并使用独立最小实现。

## Rollout and Compatibility

- 新 plan runtime、当前 schema、四角色模板、安装资产、README/导航/reference 和测试必须在同一源码变更中发布，避免代理引用尚未安装的命令或 runtime 接受模板未描述的状态。
- 现有 `execution-runtime/execution-cli.mjs`、spec checkpoint/schema、`.scratch/<feature>/spec.md + issues/` 输入和现有命令行为保持兼容。目录计划是新增接口，不替换、不迁移旧协议。
- 功能启用前已开始的目录计划执行、实验 checkpoint、旧 branch/worktree 不自动采用。用户可显式从可信计划版本创建新 run，但 runtime 遇到疑似旧现场时保留并阻塞，要求人工处理。
- 安装器仍整体复制 `execution-runtime/`，并在任何平台写入前验证完整 asset catalog。安装后仅新会话加载新的代理契约；已启动会话不假定热加载，也不作为恢复可信来源。
- 本次验收只使用仓库源码和临时 HOME/XDG_CONFIG_HOME。真实全局 AI Work Flow 安装必须另行获得用户确认，发布计划不得自动执行。
- rollout 先以全套单元、临时 Git E2E、三平台隔离安装和旧 runtime 回归作为门禁；不设置会改变协议的降级模式或旧 schema fallback。
- 回滚只撤销本功能的源码、测试、代理生成契约、文档和安装资产引用，使旧 runtime 继续可用。回滚脚本或说明不得删除 Git common dir 中的 terminal/blocked checkpoint、未知 branch/worktree、脏 worktree 或任何用户现场；这些资源保留供人工确认。

## Out of Scope

- 跨机器、跨 Git common dir或重新 clone 后恢复。
- 远端 checkpoint、云同步、共享数据库或多主 writer。
- push、远端 branch、Pull Request 创建或托管平台集成。
- 在真实全局 HOME/XDG_CONFIG_HOME 中安装或切换 AI Work Flow。
- 迁移、导入、兼容功能启用前已开始的执行、旧 plan checkpoint 或 spec runtime checkpoint。
- 自动接管仍活动的 session/claim，或无需用户确认的 reclaim。
- 自动丢弃、reset、clean、覆盖、重建或删除脏 worktree 和未提交现场。
- 修改 Planning/Task Planner 的计划和 task 工件生成流程。
- 将目录计划转换为 `.scratch/<feature>/spec.md + issues/`，或反向转换。
- 对现有 `execution-cli.mjs` 的无关重构、状态模型改造或命令扩展。
- 扩张 Git Operator 的通用文件编辑权限，或扩张其他角色的 Git/runtime mutation 权限。
- push、stash、amend、reset、clean 及任何丢弃未提交改动的 Git 工作流。

## Assumptions

- planning commit 可从本地 Git 历史中确定，并且 prepare 时 canonical plan/task 工件内容与该提交一致；未提交或无法归属到唯一提交的计划版本不可执行。
- Git common dir 是 checkpoint 持久化与恢复的信任边界；只支持同一 common dir、同一工作区内的新会话或客户端重启。
- 仓库已有或可局部复用成熟的进程锁、原子替换、Git/path 完整性和 ReviewManifest 原语；复用必须通过新旧 runtime 双套回归证明无行为变化。
- 平台并发容量由 Coding/宿主提供；runtime 不调度线程或代理，只验证 task 是否属于当前 frontier、write scope 是否互斥及 claim 是否可创建。
- Git Operator 可以调用固定 plan runtime 并执行既有授权的 Git mutation，但不能借此编辑普通文件或冲突内容。
- 日期、时间、时间戳精度与序列化格式沿用仓库 runtime 的既有约束；时间不参与 run identity，只用于审计、锁与用户确认记录。
- 用户决定必须显式持久化，包括活动 claim 接管确认、blocking finding IDs、review decision 及修复后的 `re-review|continue` 选择；会话文字不能替代 checkpoint 记录。
- task write scope 能以仓库相对路径或受支持的规范路径模式表达，并可做保守的相交判定；无法证明互斥时按相交阻塞。
- 本地 Git 提供 worktree、merge/ancestry 和 atomic ref 查询所需能力；不依赖远端可用性。

## Further Notes

- 后续若拆分实施 task，应严格按 `Implementation Changes` 六个阶段建立依赖；状态机和 Git facts adapter 必须在代理模板接入前具备定向测试，安装资产必须在 CLI/schema 路径稳定后更新。
- task 拆分时应让旧 runtime 回归、plan runtime E2E 和安装事务测试分别成为显式验收项，避免共享原语、代理契约和分发资产由单一 task 隐式承担。
