# 项目上下文

## 领域术语

- **Workflow contract**：workflow、phase、action、owner、转换、`TaskResult`、结构化交接内容、预算和决策代码的唯一机器事实来源。
- **TaskResult**：所有 action 的唯一 JSON 交接接口，固定包含 `result`、`summary` 和 contract 声明的结果字段。
- **TaskResult schema**：`task-result-schemas.json` 独立声明交付字段类型和嵌套结构，并以 `contract_digest` 绑定 workflow contract。
- **Return acceptance template**：编译进主代理与 owner 提示词的分支级 `TaskResult` 字段、可选字段和完整结构约束；主代理每次委派时必须附带。
- **Structured handoff**：`planning_context`、`change_evidence`、`review_basis`、`review_packet`、`review_disposition`、`review_axis_result` 与 `review_result` 直接以完整对象传递。
- **Review disposition**：`coding.prepare_review` 对 committed diff 的 fail-closed 审查分流证据；只有首次直接 Bug/小功能且九项 criteria 全部通过时为 `skipped_small_change`，否则为 `dual_axis`。
- **Review basis binding**：首次审查、复审和 resync 都冻结结构化来源、验收、scope、用户审查选择与验证记录；packet context、disposition 和 integration SHA 必须一致。
- **Managed content / User content**：生成器负责更新的内容 / 生成器不得改写的用户内容。
- **Capability level**：平台约束的 `enforced`、`instruction-only` 或 `unsupported` 真实等级。

## 仓库约束

- 仓库使用 Node.js ESM；测试入口为 `npm test`，资产校验入口为 `node agent-build/install.mjs validate` 和 `npm run validate:skills`。
- Workflow 只存在于当前会话，不创建 `.git/ai-work-flow` 状态，也不提供跨会话调度恢复。
- 会话中断后依据用户计划、Git 状态和仓库事实重新定位；不要声称恢复先前进度。
- 自动 Git 授权仅含本地 commit、worktree、fast-forward 整合和安全清理；不含 push、stash、reset、clean、amend、tag、PR 或远端修改。
- `skills/` 中的五个受管理 Skill 分发到三平台，但每个角色只能启用 `skills.json` 归属的 Skill；受管理片段之外的用户内容必须保留。
- 根 `MEMORY.md` 是 committed standards source；职责、边界或入口变化时与导航索引同轮维护。

## 职责

- `execution-runtime/` 只负责生成期 workflow contract 与必要的内容校验。
- `agent-build/config/` 负责 roles、controls、policies、Skills 元数据和人类可读 routing 治理。
- `agent-build/runtime/` 负责结构校验、七段 prompt 编译、三平台生成和事务式安装。
- `agent-build/templates/` 只保留 14 个角色独有的判断与完成规则，**Planning**/**Coding** 仅使用 `Task`。
- `skills/` 提供五个用户入口及一级 references/scripts。
- `test/` 验证 contract、`TaskResult`、提示词/Skill 生成、三平台渲染和安装迁移。

## 模块边界

| 模块 | 边界 |
| --- | --- |
| `execution-runtime/workflow-contract.json` | 唯一流程声明；不含服务、存储或身份字段。 |
| `execution-runtime/task-result-schemas.json` | `TaskResult` 顶层字段与嵌套内容的 JSON 类型约束。 |
| `execution-runtime/lib/workflow-contract.mjs` | 校验 contract/schema digest、action I/O、`TaskResult` 类型、审查分流一致性和直接结构化内容。 |
| `agent-build/runtime/asset-catalog.mjs` | 从 contract/roles/controls/policies 编译七段 prompts、分支级返回验收模板和复杂字段约束。 |
| `agent-build/runtime/platform-adapter.mjs` | 生成三平台 Agents，并安全清理精确匹配的旧 MCP 配置。 |
| `agent-build/runtime/workflow.mjs` | 事务式安装 contract-only runtime；仅完整 install 清理仓库历史状态。 |
| `agent-build/runtime/skill-catalog.mjs` | 从 `skills.json` 校验五个 Skills 和确定性 OpenAI 元数据。 |
| `skills/init-ai-work-flow/` | 联合初始化项目 MEMORY、导航和维护约束。 |
| `skills/project-code-navigation/` | **File Explorer** 只读定位；**Full Stack Coder** 随入口或职责变化维护。 |
