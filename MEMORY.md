# 项目上下文

## 领域术语

- **Workflow contract**：workflow、phase、action、owner、转换、预算、决策代码和公共结构的唯一机器事实来源。
- **WorkflowSnapshot**：当前 run 的稳定快照，包含 revision、phase、ready actions、active claims、budgets 和可选 decision request。
- **ActionReceipt**：workflow action attempt 的 canonical 结果，包含结构化 outputs；重复 finish 或跨会话恢复必须使用同一 receipt。
- **SupportReceipt**：稳定 caller/call ID 标识的 support action 结果，经 broker 校验但不推进 phase。
- **ArtifactRef**：本地完整证据的稳定摘要引用；`ReviewPacketRef` 是审查上下文引用，另有 planning context、change evidence 和 review result artifacts。
- **Runtime identity**：execution runtime 受管理文件及 contract 的安装完整性身份。
- **Workflow state broker**：三平台共享的窄 MCP 工具；只接受固定 runtime operation，并只对当前仓库 Git common dir 的运行记录写入。
- **Managed content / User content**：生成器负责更新的内容 / 生成器不得改写的用户内容。
- **Capability level**：平台约束的 `enforced`、`instruction-only` 或 `unsupported` 真实等级。

## 仓库约束

- 仓库使用 Node.js ESM；测试入口为 `npm test`，资产校验入口为 `node agent-build/install.mjs validate` 和 `npm run validate:skills`。
- run、claim、receipt、decision 和 artifacts 只写 Git common dir 的 `.git/ai-work-flow/`，不得进入项目提交。
- 自动 Git 授权仅含本地 commit、worktree、fast-forward 整合和安全清理；不含 push、stash、reset、clean、amend、tag、PR 或远端修改。
- `skills/` 中的五个受管理 Skill 分发到三平台；受管理片段之外的用户内容必须保留。
- 根 `MEMORY.md` 是 committed standards source；职责、边界或入口变化时与导航索引同轮维护。

## 职责

- `execution-runtime/` 负责 workflow contract、状态转换、原子 run store、统一 CLI、workflow state broker、ReviewPacket 和 runtime identity。
- `agent-build/config/` 负责 roles、controls、policies、Skills 元数据和人类可读 routing 治理。
- `agent-build/runtime/` 负责结构校验、七段 prompt 编译、三平台生成和事务式安装。
- `agent-build/templates/` 只保留 14 个角色独有的判断与完成规则，Environment Operator 与 Git Operator 权限分离。
- `skills/` 提供五个用户入口及一级 references/scripts。
- `test/` 通过公共接口验证状态机、幂等恢复、ReviewPacket、prompt/Skill 生成和三平台渲染。

## 模块边界

| 模块 | 边界 |
| --- | --- |
| `execution-runtime/workflow-contract.json` | 唯一流程声明；提示词和测试不得复制状态表。 |
| `execution-runtime/lib/workflow-store.mjs` | Git common dir 原子持久化、claim/finish/recover/decision/support validation；不执行实现工作。 |
| `execution-runtime/lib/workflow-broker.mjs` | 将固定 MCP operations 路由到 runtime API；拒绝其他仓库、任意命令和未声明字段。 |
| `execution-runtime/lib/review-packet.mjs` | 冻结 committed review context 并返回 ref；聊天不承载完整上下文。 |
| `agent-build/runtime/asset-catalog.mjs` | 从 contract/roles/controls/policies 编译并校验七段 prompts。 |
| `agent-build/runtime/skill-catalog.mjs` | 从 `skills.json` 校验五个 Skills 和确定性 OpenAI 元数据。 |
| `skills/init-ai-work-flow/` | 联合初始化项目 MEMORY、导航和维护约束。 |
| `skills/project-code-navigation/` | File Explorer 只读定位；Full Stack Coder 仅随已授权实现维护索引。 |
