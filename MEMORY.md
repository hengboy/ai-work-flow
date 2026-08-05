# 项目上下文

## 领域术语

- **Workflow contract**：workflow、phase、action、owner、转换、预算、决策代码和公共结构的唯一机器事实来源。
- **Narrow workflow tools**：Planning/Coding 主代理使用的启动、恢复、claim、answer 和 contract completion 工具；不接受 repository、action、attempt 或 canonical input。
- **Lease**：`workflow_claim_next` 为 ready action 创建的 30 分钟租约；过期可接管，旧结果在接管后返回 `superseded`。
- **TaskResult**：实施、Git、审查和支持子代理返回的固定结果，由主代理提交给 dispatch 指定的 completion tool。
- **Canonical PlanBundle**：runtime 从真实 spec、plan、tasks、摘要和来源关系确定性推导的计划输入。
- **Runtime identity**：execution runtime 受管理文件及 contract 的安装完整性身份。
- **Workflow broker v2**：三平台共享的窄 MCP 工具目录；从启动 cwd 推导仓库，只对 Git common dir 的 `.git/ai-work-flow/v2/` 写入。
- **Managed content / User content**：生成器负责更新的内容 / 生成器不得改写的用户内容。
- **Capability level**：平台约束的 `enforced`、`instruction-only` 或 `unsupported` 真实等级。

## 仓库约束

- 仓库使用 Node.js ESM；测试入口为 `npm test`，资产校验入口为 `node agent-build/install.mjs validate` 和 `npm run validate:skills`。
- v2 run、lease、receipt、decision 和内部 artifacts 只写 Git common dir 的 `.git/ai-work-flow/v2/`；v1 数据保留但忽略，不得迁移或删除。
- 自动 Git 授权仅含本地 commit、worktree、fast-forward 整合和安全清理；不含 push、stash、reset、clean、amend、tag、PR 或远端修改。
- 新受管 worktree 必须是仓库内已注册且由本地 exclude 忽略的 `.worktrees/<单层名称>`；runtime 拒绝 sibling、嵌套、符号链接或其他仓库的 worktree。
- `skills/` 中的五个受管理 Skill 分发到三平台，但每个角色只能启用 `skills.json` 归属的 Skill；受管理片段之外的用户内容必须保留。
- 根 `MEMORY.md` 是 committed standards source；职责、边界或入口变化时与导航索引同轮维护。

## 职责

- `execution-runtime/` 负责 workflow contract、v2 状态转换、原子 run/lease store、窄 workflow broker、内部 evidence/ReviewPacket 和 runtime identity。
- `agent-build/config/` 负责 roles、controls、policies、Skills 元数据和人类可读 routing 治理。
- `agent-build/runtime/` 负责结构校验、七段 prompt 编译、三平台生成和事务式安装。
- `agent-build/templates/` 只保留 14 个角色独有的判断与完成规则，Environment Operator 与 Git Operator 权限分离。
- `skills/` 提供五个用户入口及一级 references/scripts。
- `test/` 通过公共接口验证状态机、幂等恢复、ReviewPacket、prompt/Skill 生成和三平台渲染。

## 模块边界

| 模块 | 边界 |
| --- | --- |
| `execution-runtime/workflow-contract.json` | 唯一流程声明；提示词和测试不得复制状态表。 |
| `execution-runtime/lib/workflow-v2-store.mjs` | Git common dir v2 原子持久化、PlanBundle、lease、completion、受管 worktree 校验、resume 和 decision；旧 store 不再由 broker 调用。 |
| `execution-runtime/lib/workflow-broker.mjs` | 注册启动、恢复、claim、answer 和 contract completion 窄工具；仓库从 broker cwd 推导。 |
| `execution-runtime/lib/review-packet.mjs` | 冻结 committed review context 并返回 ref；聊天不承载完整上下文。 |
| `agent-build/runtime/asset-catalog.mjs` | 从 contract/roles/controls/policies 编译并校验七段 prompts。 |
| `agent-build/runtime/skill-catalog.mjs` | 从 `skills.json` 校验五个 Skills 和确定性 OpenAI 元数据。 |
| `skills/init-ai-work-flow/` | 联合初始化项目 MEMORY、导航和维护约束。 |
| `skills/project-code-navigation/` | File Explorer 只读定位；Full Stack Coder 仅随已授权实现维护索引。 |
