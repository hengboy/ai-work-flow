# AI Work Flow

AI Work Flow 为 Codex、Claude Code 和 OpenCode 提供共享的 **Planning**、**Coding**、14 个 Agents、5 个 Skills，以及当前会话内的原生无状态编排。子代理通过固定 `TaskResult` 直接交接完整结构化内容，不依赖额外服务或仓库状态存储。

## 安装

前置条件为 Node.js、Git，以及至少一个已配置客户端。

```sh
npm ci
node agent-build/install.mjs --dry-run
node agent-build/install.mjs
node agent-build/install.mjs validate
```

完整安装事务式同步配置、Skills、contract-only `execution-runtime/` 和目标平台 Agents。`--platform codex,claude,opencode` 可限制 Agent 平台；共享 contract 与 Skills 始终安装。

| 操作 | 命令 |
| --- | --- |
| 完整安装 | `node agent-build/install.mjs` |
| 重新生成 | `node agent-build/install.mjs generate [--platform ...]` |
| 只读校验 | `node agent-build/install.mjs validate` |
| 环境列表 | `node agent-build/install.mjs env` |
| 切换环境 | `node agent-build/install.mjs env use <name>` |
| 环境状态 | `node agent-build/install.mjs env status` |

默认环境位于 `${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/environments/default.json`。切换环境必须使用 `env use`，该命令在同一事务中验证、生成和更新环境标记。生成保留受管理片段之外的用户内容。

完整 install 会删除执行目录中旧的 Broker/CLI/store/identity 文件、三平台中精确匹配的旧 `ai-work-flow` MCP 配置，以及当前 Git common dir 的 `.git/ai-work-flow` 历史状态。`--dry-run` 只报告；generate、validate 和 env 操作不删除仓库状态。旧 MCP 配置若已被改写，安装器会停止并报告冲突。

## 工作流契约

[`execution-runtime/workflow-contract.json`](execution-runtime/workflow-contract.json) 是纯生成期流程接口，声明 **Planning**/**Coding** workflow、phase、action owner、I/O contract、转换、`TaskResult` 字段、结构化交接内容、预算和决定代码。[`execution-runtime/task-result-schemas.json`](execution-runtime/task-result-schemas.json) 独立约定每个交付字段的 JSON 类型与嵌套结构，并通过 `contract_digest` 与流程 contract 绑定。

`TaskResult` 是一个可解析的 JSON 对象，固定包含 `result`、`summary` 和当前结果分支声明的字段；`result` 只能是 `completed`、`retryable_failure`、`needs_decision` 或 `failed`。`planning_context`、`change_evidence`、`review_packet`、`review_axis_result` 与 `review_result` 直接携带完整 JSON 内容。数组字段必须返回数组，空数组使用 `[]`，不能以字符串代替。

生成提示词会为每类 action 注入返回验收模板，包括允许的结果分支、精确顶层字段、字段类型和复杂对象内部约束。**Planning**/**Coding** 在每次委派末尾附该模板并按字段路径验收；子代理只返回一个 JSON `TaskResult` 对象，格式错误时仅重返对象，不重复实际工作。

## 自动流程

**Planning** 在当前会话执行 `discover → confirm → write_spec → write_plan → (split: write_tasks) → commit`。**Coding** 在当前会话完成分诊、实施、本地提交、ReviewPacket、双轴审查、blocking finding 修复、复审、main 同步、fast-forward 整合和安全清理。

**Planning**/**Coding** 只有 `Task`，不直接使用 Shell、Git、文件编辑或网络。实施、Git、审查与支持子代理返回固定 `TaskResult`，主代理验证完整内容后传给下一 action。自动授权不包含 push、stash、reset、clean、amend、tag、PR 或远端修改。

流程不会创建 `.git/ai-work-flow` 状态。会话中断后必须根据用户提供的计划、Git 状态和仓库事实重新定位，不承诺恢复先前调度进度。

## Agents 与 Skills

`roles.json`、controls、policies 和 workflow contract 共同生成角色能力、命名 action I/O 和 `TaskResult` 结构。14 个角色模板固定使用七段接口。**Environment Operator** 独占 Agent 生成与环境切换；**Git Operator** 只负责本地 Git 生命周期。

`skills.json` 是五个 Skills 的元数据来源。项目首次接入使用 `$init-ai-work-flow` 创建或补齐根 `MEMORY.md` 与 `.ai-work-flow/index/`。只读定位使用 `$project-code-navigation`；入口、路由、API、文件职责或模块边界变化时由实现角色同轮维护索引和必要的 MEMORY 内容。

## 验证

```sh
npm test
npm run validate:skills
node agent-build/install.mjs --dry-run
node agent-build/install.mjs validate
node agent-build/install.mjs env status
git diff --check
```

平台能力报告区分 `enforced`、`instruction-only` 和 `unsupported`。配置、事务日志和 Git porcelain 自身的格式标识不属于 workflow 协议概念。
