| 功能/关键词 | 入口路径 | 模块边界 |
| --- | --- | --- |
| CLI 安装、初始化、验证、生成 | `scripts/install.mjs` -> `scripts/private/workflow.mjs` | CLI 转交 `runCli`；安装的 execution runtime 伴随其 `skills` 依赖，支持事务恢复、`env use` 全量激活与能力/digest 状态报告。 |
| 工作流命令、环境管理 | `scripts/private/workflow.mjs` | 依赖 `scripts/private/config.mjs`、`scripts/private/transaction.mjs`、`scripts/private/asset-catalog.mjs`、`scripts/private/paths.mjs`、`scripts/private/platform-adapter.mjs`。 |
| Agent 角色、Policy、路由资产 | `scripts/agent-assets/roles.json`、`scripts/agent-assets/policies.json`、`scripts/agent-assets/routing.md`、`scripts/agent-assets/bodies/*.md` | Asset catalog 校验角色与 Policy 引用；平台生成输出能力等级。 |
| 平台 Agent 生成 | `scripts/private/platform-adapter.mjs` | 生成各平台 Agent 配置与托管内容。 |
| 项目代码导航规则 | `skills/project-code-navigation/SKILL.md` | 维护 `.ai-work-flow/index/` 下的功能导航。 |
| Spec、Ticket 执行 | `execution-runtime/execution-cli.mjs`、`skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs` | 共享 CLI 提供 prepare/claim/record/review/integrate/status 状态机；所有执行模式经 `claim` 的可回收跨进程排他锁与 `record-ticket` 的 canonical JSON Handoff 状态转换。 |
| 执行计划、Checkpoint | `skills/run-matt-spec-to-completion/lib/checkpoint.mjs`、`skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs`、`skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs` | Checkpoint 只持久化仓库内相对路径，拒绝旧绝对或遍历路径；完整性校验确认 worktree 的路径、分支和 Git common-dir，frontier 选择可执行 Ticket。 |
| 测试 | `test/agent-workflow.test.mjs`、`package.json` | `package.json` 的 `test` 脚本使用 Node 测试运行器。 |
