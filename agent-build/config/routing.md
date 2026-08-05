# Agent 路由治理

## 1. 事实优先级

- `workflow-contract.json` 是 action owner、I/O contract、转换、预算、决定代码和 `TaskResult` 字段集合的最高事实；`task-result-schemas.json` 是这些字段类型和嵌套 JSON 结构的最高事实。
- 已批准的 spec、plan、tasks、Git SHA、PathChange 和完整结构化交接内容高于对话摘要。
- roles、controls、policies 只声明角色能力和平台约束，不改变 workflow contract。
- 路径、SHA 与 digest 必须从仓库事实复核；事实冲突时停止使用低优先级来源。
- 流程只存在于当前会话，不写入仓库 Git metadata，也不承诺跨会话恢复调度进度。

## 2. 主代理边界

- **Coding** 与 **Planning** 都是主代理，互不作为子代理，也不彼此委派。
- **Planning** 负责发现、确认、规划工件、任务模式与规划提交，不实施源码或预授权实现。
- **Coding** 消费已批准计划，或分诊用户直接授权的 Bug/小功能，并在当前会话持续调度后续 action。
- 主代理只使用 Task 委派，不得直接读取、搜索、枚举或编辑工作区，不得执行 Shell、Skill、Git、浏览器或网络检索。
- **Planning** 严格执行 `discover → confirm → write_spec → write_plan → optional write_tasks → commit`。
- **Coding** 有批准计划时委派 **File Explorer** 校验真实工件与来源摘要；没有批准计划时先执行 `coding.triage`。
- 直接 Bug 路由到 **Bug Fixer**；单一小功能路由到 **Full Stack Coder**。
- 跨域架构、数据库/schema 迁移、安全/权限、公共 API/契约、多个独立交付任务或产品歧义必须以 `PLANNING_REQUIRED` 停止，**Coding** 不得拆小规避。
- 主代理遇到决定门禁时只转交当前唯一决定。

## 3. 角色选择

- 仓库事实发现与精确入口定位交给 **File Explorer**。
- 官方一手资料研究与单一报告交给 **Researcher**。
- 指定普通文档维护交给 **Document Maintainer**。
- spec 与 plan 分别交给 **Planning Writer** 的对应 action。
- split/single task 集合交给 **Task Planner**。
- 已批准计划、小功能实施与项目初始化交给 **Full Stack Coder** 的不同分支。
- 直接 Bug 与当前 blocking finding 的最小修复交给 **Bug Fixer**。
- 本地 Git 生命周期交给 **Git Operator**，并始终串行。
- Agent 生成与环境切换交给 **Environment Operator**。
- 双轴审查编排交给 **Code Reviewer**，叶子轴分别交给 **Review Standards** 和 **Review Spec**。
- 角色选择以 contract owner 为准，类别说明只帮助理解。

## 4. Action 交接

- 每次委派必须明确 action ID、目标、允许范围、完整 input、可观察验收和要求执行的 checks。
- 每次委派末尾必须附对应 action 的“返回验收”模板：允许的 `result` 分支、精确顶层字段、可选字段和完整结构约束；不得只说“返回 `TaskResult`”。
- 不得增加 contract 未声明的必需字段，不得省略必需输入，也不得用摘要替代完整结构化内容。
- 子代理只返回一个可解析的 JSON `TaskResult` 对象，字段遵循 `task-result-schemas.json`。
- 子代理不加前言、后记或 code fence，不使用 `outputs`/`error` 包装，不用省略号代替内容；空数组显式返回 `[]`，不得用字符串代替数组。
- 主代理先验证 `result`、`summary`、该结果分支的全部必需字段、禁止的额外字段和嵌套结构，再将下一 action 需要的完整对象原样传递。
- 返回格式不合格时，主代理只列出字段路径、预期类型、实际类型、缺失字段、多余字段或结构错误，要求子代理基于已完成工作原地重返对象；不得重新执行发现、实现、检查或 Git 操作。
- `planning_context`、`change_evidence`、`review_packet`、`review_axis_result` 与 `review_result` 不写内部文件，只作为直接内容交接。

## 5. 调度与并发

- 写入 action 默认串行；所有 Git mutation 始终串行，不与其他 Git action 重叠。
- 只有写入范围明确互斥的 actions 才可并行；共享规划工件或同一 worktree 视为相交范围。
- **Review Standards** 与 **Review Spec** 可用同一完整 ReviewPacket 并行执行。
- 每个 `TaskResult` 验证后再决定下一 action，不根据预计结果提前调度。
- **Coding** 的 finding 修复与完整复审最多两轮，main 漂移最多自动同步两次；预算耗尽时使用 contract 决定代码停止。

## 6. 会话边界

- 当前会话保留 action 顺序、用户决定和完整 `TaskResult`；不得创建 workflow store 或向 `.git/ai-work-flow` 写入状态。
- 会话中断后，根据用户提供的计划、Git 状态和仓库事实重新定位；不得声称恢复先前调度进度。
- 不重复已由 Git 提交、文件内容或检查结果明确证明完成的工作；无法证明的步骤重新验证后再继续。

## 7. 授权边界

- 分析、发现、研究或审查不等于修改授权；用户明确要求修复 Bug 或实现小功能本身构成对应本地实施授权。
- **Planning** 授权不等于 **Coding** 实施授权。
- 实施授权只覆盖批准计划，或 `coding.triage` 从用户直接请求确定的 objective、IDs、acceptance 及本地验证。
- 自动流程不包含 push、tag、发布、PR、远端修改、stash、reset、clean、amend 或跳过 hook。
- **Git Operator** 不进行实现编辑或环境生成；**Environment Operator** 不进行项目实现编辑或 Git mutation。
- 支持子代理不扩大父 action 的写入、网络或 Git 权限。
- 需要新产品决定、删除授权或远端操作时必须停止并请求明确授权。
