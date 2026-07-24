| 功能/关键词 | 入口路径 | 模块边界 |
| --- | --- | --- |
| CLI 安装、初始化、验证、生成 | `scripts/install.mjs` -> `scripts/private/workflow.mjs` | CLI 转交 `runCli`；工作流命令在 `workflow.mjs` 编排。 |
| 工作流命令、环境管理 | `scripts/private/workflow.mjs` | 依赖 `scripts/private/asset-catalog.mjs`、`scripts/private/paths.mjs`、`scripts/private/platform-adapter.mjs`。 |
| Agent 角色、路由资产 | `scripts/agent-assets/roles.json`、`scripts/agent-assets/routing.md`、`scripts/agent-assets/bodies/*.md` | 资产目录由 `scripts/private/asset-catalog.mjs` 校验与加载。 |
| 平台 Agent 生成 | `scripts/private/platform-adapter.mjs` | 生成各平台 Agent 配置与托管内容。 |
| 项目代码导航规则 | `skills/project-code-navigation/SKILL.md` | 维护 `.ai-work-flow/index/` 下的功能导航。 |
| Spec、Ticket 执行 | `skills/run-matt-spec-to-completion/SKILL.md`、`skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs` | Skill 定义执行入口；orchestrator 编排执行生命周期。 |
| 执行计划、Checkpoint | `skills/run-matt-spec-to-completion/lib/checkpoint.mjs`、`skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs`、`skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs` | Checkpoint 持久化与完整性校验；frontier 选择可执行 Ticket。 |
| 测试 | `test/agent-workflow.test.mjs`、`package.json` | `package.json` 的 `test` 脚本使用 Node 测试运行器。 |
