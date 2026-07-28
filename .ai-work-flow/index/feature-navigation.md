| 功能/关键词 | 入口路径 | 模块边界 |
| --- | --- | --- |
| CLI 安装、初始化、验证、生成 | `scripts/install.mjs` -> `scripts/private/workflow.mjs` | CLI 转交 `runCli`；安装器为全局 Skill 复制 runtime handoff schema，并在配置根安装 canonical runtime。 |
| 工作流命令、环境管理 | `scripts/private/workflow.mjs` | 依赖 `scripts/private/config.mjs`、`scripts/private/transaction.mjs`、`scripts/private/asset-catalog.mjs`、`scripts/private/paths.mjs`、`scripts/private/platform-adapter.mjs`。 |
| Agent 角色、Policy、路由资产 | `scripts/agent-assets/roles.json`、`scripts/agent-assets/policies.json`、`scripts/agent-assets/routing.md`、`scripts/agent-assets/bodies/*.md` | Asset catalog 校验角色与 Policy 引用；平台生成输出能力等级。 |
| 平台 Agent 生成 | `scripts/private/platform-adapter.mjs` | 生成各平台 Agent 配置与托管内容。 |
| 项目代码导航规则 | `skills/project-code-navigation/SKILL.md` | 维护 `.ai-work-flow/index/` 下的功能导航。 |
| Spec、Ticket 执行 | `execution-runtime/execution-cli.mjs`、`skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs` | CLI 是 prepare/claim/record/review/fix/integrate/cleanup/status 的唯一状态入口；orchestrator 只协调 CLI 与 runtime-owned Git 特例。 |
| Ticket Handoff、Git 路径与审查清单 | `skills/run-matt-spec-to-completion/lib/{paths,git,review-manifest}.mjs` | `paths` 定义并比较 PathChange，`git` 唯一解析 porcelain v2 `-z`，`review-manifest` 冻结 digest、双轴分片和 coverage。 |
| 执行计划、Checkpoint | `execution-runtime/state-store.mjs`、`skills/run-matt-spec-to-completion/lib/checkpoint.mjs`、`skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs`、`skills/run-matt-spec-to-completion/lib/ticket-frontier.mjs` | state store 是唯一 writer；Checkpoint 保存仓库相对 worktree、冻结 ReviewManifest/digest/coverage、修复证据与 stash 授权，完整性校验 Git 身份、review range 和整合关卡。 |
| 测试 | `test/agent-workflow.test.mjs`、`package.json` | `package.json` 的 `test` 脚本使用 Node 测试运行器。 |
