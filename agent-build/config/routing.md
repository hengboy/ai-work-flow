# Agent 路由治理

## 1. 事实优先级

- v2 runtime 的 canonical run、lease、receipt 与 decision 是最高事实。
- `workflow-contract.json` 是 phase、action owner、I/O contract、转换与 receipt 的最高事实。
- 已验证的 canonical claim input 不得由对话摘要、旧 prompt 或调用者偏好替换。
- runtime 在 completion 事务中创建的证据与 ReviewPacket 高于聊天中的内容副本。
- roles、controls、policies 只声明角色能力和平台约束，不改变 workflow 状态。
- 本文件只治理选择、调度与授权，不覆盖 runtime 或 contract。
- 事实冲突时停止使用低优先级来源，并重新读取高优先级状态。
- 响应截断、JSON 损坏或会话切换不构成重新执行 action 的理由。
- 路径、SHA、digest、lease 与 receipt 必须从机器事实复核。

## 2. 主代理边界

- **Coding** 与 **Planning** 都是主代理。
- 两者互不作为子代理，也不彼此委派。
- **Planning** 负责发现、确认、规划工件、任务模式与规划提交。
- **Planning** 不实施源码、不进入 **Coding** 流程，也不预授权实现。
- **Coding** 消费已批准计划，或分诊用户直接授权的 Bug/小功能，并持续调度实施 workflow。
- **Coding** 不修改规划决定，不以实现便利重写规格。
- 主代理只通过 workflow broker 读写 run 状态。
- 主代理不得直接读取、搜索、枚举或编辑工作区，不得执行 Shell、Skill、Git、浏览器或网络检索。
- **Planning** 将仓库事实发现交给 **File Explorer**，将 spec/plan、tasks 和本地提交分别交给 **Planning Writer**、**Task Planner** 和 **Git Operator**。
- **Planning** 在 confirm 阶段完成事实与产品决定后、创建 planning context 前确定 `task_mode`；single 跳过 `planning.write_tasks`，split 才委派 **Task Planner**。
- **Coding** 有批准计划时调用 `coding_start_plan({plan_path})`，由 runtime 验证真实工件并推导 canonical PlanBundle。
- **Coding** 没有批准计划时，只接受用户直接授权的可复现 Bug 或小功能，并以用户原文调用 `coding_start_direct({objective})`。
- 直接 run 的首个 action 必须是 `coding.triage`。**Coding** 可把范围定位和外部研究分别委派给 **File Explorer** 与 **Researcher**，但只自行分类、定义可观察验收和验证交接。
- 直接 Bug 必须路由到 **Bug Fixer** 的 `coding.fix_direct`；小功能必须路由到 **Full Stack Coder** 的 `coding.implement`。
- 跨域架构、数据库/schema 迁移、安全/权限、公共 API/契约、多个独立交付任务，或仍有产品决定/广泛验收歧义时，`coding.triage` 必须以不可恢复的 `PLANNING_REQUIRED` 终止。用户必须另行启动 **Planning**，**Coding** 不得拆小规避。
- run 启动后主代理只调度 `workflow_claim_next` 返回的 action owner，并调用响应指定的 completion tool。
- 主代理遇到决定门禁时只转交 runtime 中的唯一决定。

## 3. 角色选择

- 仓库事实发现与精确入口定位交给 **File Explorer**。
- 官方一手资料研究与单一报告交给 **Researcher**。
- 指定普通文档维护交给 **Document Maintainer**。
- spec 与 plan 分别交给 **Planning Writer** 的对应分支。
- split/single task 集合交给 **Task Planner**。
- 已批准计划、小功能实施与项目初始化交给 **Full Stack Coder** 的不同 action 分支。
- 直接 Bug 与当前 blocking finding 的最小修复交给 **Bug Fixer** 的不同 action 分支。
- 本地 Git 生命周期交给 **Git Operator**，并始终串行。
- Agent 生成与环境切换交给 **Environment Operator**。
- 双轴审查编排交给 **Code Reviewer**，叶子轴分别交给 **Review Standards** 和 **Review Spec**。
- 角色选择以 contract owner 为准，类别说明只帮助理解。

## 4. ActionDispatch

- dispatch 前必须成功取得 canonical lease。
- dispatch 必须携带 claim 响应中完整且原样的 input。
- dispatch 必须明确 action ID、目标、允许范围和完成边界。
- dispatch 必须携带 runtime 提供的所有 source、evidence 与 packet 输入。
- dispatch 必须列出可观察验收与要求执行的 checks。
- dispatch 不得通过自然语言增加 contract 未声明的必需字段。
- dispatch 不得省略空值之外的必需输入，也不得用摘要替代 ref。
- 子代理返回后先验证 TaskResult 的 result、summary 与 contract 结果字段。
- 验证后由主代理调用 dispatch 明确指定的 completion tool。
- 无 canonical lease 的 workflow action 不得执行。

## 5. 调度与并发

- 写入 action 默认串行。
- 所有 Git mutation 始终串行，不与其他 Git action 重叠。
- 只有 runtime 同时 dispatch 且写入范围互斥的 actions 才可并行。
- 共享规划工件、同一 worktree 或同一 artifact 目录视为相交范围。
- **Review Standards** 与 **Review Spec** 可用同一 packet 并行执行。
- 不同任务使用各自 `run_id`、worktree 和预算，可在同一仓库并行推进；同一任务由幂等 start 恢复同一 run。
- active lease 只阻塞所属 run；等待过期或完成后重新 claim，不重复 dispatch。
- 30 分钟 lease 过期后可接管；旧结果只有未产生新 lease 时仍可完成，否则返回 `superseded`。
- 每次 completion 后重新 claim，再决定下一 action。
- 不根据历史 phase 表、对话记忆或预计结果预取下一 action。

## 6. Receipt 与恢复

- 子代理只返回固定 TaskResult，不读写 run 元数据。
- 主代理只提交 `lease_id`、`result`、`summary` 和 completion contract 声明的顶层结果字段；不得提交 `run_id`、`action_id` 或嵌套 `error`，失败结果的 `code`、`message` 与适用的 `finding_ids` 必须位于顶层。
- runtime 在单次事务中校验结果、创建证据或 ReviewPacket、登记 receipt 并推进 phase。
- 重复 completion 返回同一 canonical receipt；响应损坏通过 `workflow_resume` 与 `workflow_claim_next` 恢复，不重复执行。
- 无参恢复只自动选择唯一未完成 run；多个候选返回 `selection_required`。

## 7. 授权边界

- 分析、发现、研究或审查不等于修改授权；用户明确要求修复 Bug 或实现小功能本身构成该 direct run 的本地实施授权。
- **Planning** 授权不等于 **Coding** 实施授权。
- 实施授权只覆盖批准计划，或 `coding.triage` 从用户直接请求冻结的 objective、IDs 与 acceptance，以及本地验证。
- 自动流程不包含 push、tag、发布、PR 或任何远端修改。
- 自动流程不包含 stash、reset、clean、amend 或跳过 hook。
- **Git Operator** 不进行实现编辑或环境生成。
- **Environment Operator** 不进行项目实现编辑或 Git mutation。
- 支持子代理不扩大父 action 的写入、网络或 Git 权限。
- 需要新产品决定、删除授权或远端操作时必须停止并请求明确授权。
- 平台无法强制的边界仍作为角色必须遵守的契约。
