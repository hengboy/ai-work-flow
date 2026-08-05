# AI Work Flow

AI Work Flow 为 Codex、Claude Code 和 OpenCode 提供共享的 Planning、Coding、14 个 Agents、5 个 Skills 和可跨会话恢复的执行 runtime。流程状态由机器契约维护，提示词只消费窄工具返回的 dispatch 和 canonical receipt。

## 安装

前置条件为 Node.js、Git，以及至少一个已配置客户端。

```sh
npm ci
node agent-build/install.mjs --dry-run
node agent-build/install.mjs
node agent-build/install.mjs validate
```

完整安装事务式同步配置、Skills、execution runtime 和目标平台 Agents。`--platform codex,claude,opencode` 可限制 Agent 平台；共享 runtime 与 Skills 始终安装。

| 操作 | 命令 |
| --- | --- |
| 完整安装 | `node agent-build/install.mjs` |
| 重新生成 | `node agent-build/install.mjs generate [--platform ...]` |
| 只读校验 | `node agent-build/install.mjs validate` |
| 环境列表 | `node agent-build/install.mjs env` |
| 切换环境 | `node agent-build/install.mjs env use <name>` |
| 环境状态 | `node agent-build/install.mjs env status` |

默认环境位于 `${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/environments/default.json`。切换环境必须使用 `env use`，该命令在同一事务中验证、生成和更新环境标记。生成保留受管理片段之外的用户内容。

## 工作流契约

[`execution-runtime/workflow-contract.json`](execution-runtime/workflow-contract.json) 唯一声明 Planning/Coding workflow、phase、action owner、I/O contract、转换、预算和决定代码。v2 运行记录保存在 Git common dir：

```text
.git/ai-work-flow/v2/runs/<run_id>/run.json
```

v1 run 和 artifact 原样保留但被 v2 忽略，不迁移也不删除。记录不进入项目提交，并由同一仓库的所有 worktree 和新会话共享；原子写入使用同目录临时文件、fsync、rename 和原子锁。

broker 一次性注册窄 MCP 工具：`coding_start_direct`、`coding_start_plan`、`planning_start`、`planning_start_handoff`、`workflow_resume`、`workflow_claim_next`、`workflow_answer`，以及按 I/O contract 固定生成的 `workflow_complete_<contract>`。repository、action、attempt、canonical input、上游 refs 和 artifact 创建均由服务端推导。

计划型 Coding 只提交计划目录或 `plan.md` 路径。runtime 读取真实 spec、plan 和 tasks，核对原始字节摘要与来源关系，并生成 canonical PlanBundle。claim 使用固定 30 分钟 lease；过期后可接管，旧调用者仅在未产生新 lease 时仍可完成，已接管结果返回 `superseded`。

所有正常业务状态均为 `isError=false`：`claimed`、`busy`、`selection_required`、`correction_required`、`decision_required`、`complete`、`failed` 和 `superseded`。只有持久化损坏、broker 无法启动或连续基础设施失败是 fatal MCP error。

## 自动流程

Planning 持久化执行 `discover → confirm → write_spec → write_plan → (split: write_tasks) → commit → complete`。决定通过 `workflow_answer` 绑定当前唯一 decision。

Coding 支持两种互斥来源。有批准计划时使用 `coding_start_plan`；没有计划时，用户可直接授权一个可复现 Bug 或单一小功能并使用 `coding_start_direct`。直接 run 首先分诊：Bug 路由 Bug Fixer，小功能路由 Full Stack Coder；迁移、安全/权限、公共 API、跨业务域架构、多任务或产品歧义返回 Planning handoff。

两种来源共享本地提交、ReviewPacket、双轴审查、blocking finding 修复、完整复审、main 同步、fast-forward 整合和安全清理。修复与完整复审最多两轮，main 漂移最多自动 resync 两次。自动授权不包含 push、stash、reset、clean、amend、tag、PR 或远端修改。

只有 Planning 与 Coding 主代理获得状态工具。实施、Git、审查与支持子代理只返回固定 TaskResult，由主代理调用 dispatch 指定的 completion tool。环境生成、环境切换、项目初始化和只读导航直接调用现有事务式 Skill/脚本，不创建一次性 run。

## Agents 与 Skills

`roles.json`、controls、policies 和 workflow contract 共同生成角色能力、命名 action I/O 和 TaskResult 结构。14 个角色模板固定使用七段接口。Environment Operator 独占 Agent 生成与环境切换；Git Operator 只负责本地 Git 生命周期。

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

平台能力报告区分 `enforced`、`instruction-only` 和 `unsupported`。workflow contract digest 变化后，未结束的旧协议 run 由 v2 忽略；发布前应完成或明确放弃这些 run。
