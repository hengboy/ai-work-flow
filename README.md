# AI Work Flow

AI Work Flow 为 Codex、Claude Code 和 OpenCode 提供共享的 Planning、Coding、13 个专职 Agents、5 个 Skills 和可恢复执行 runtime。流程状态由机器契约维护，提示词只消费 snapshot 和 artifact refs。

## 安装

前置条件为 Node.js、Git，以及至少一个已配置客户端。

```sh
npm ci
node agent-build/install.mjs --dry-run
node agent-build/install.mjs
node agent-build/install.mjs validate
```

完整安装事务式同步配置、Skills、execution runtime 和目标平台 Agents。`--platform codex,claude,opencode` 可限制 Agent 平台；共享 runtime 与 Skills 始终安装。`init` 只初始化全局环境配置和路由，不修改当前项目。

| 操作 | 命令 |
| --- | --- |
| 完整安装 | `node agent-build/install.mjs` |
| 重新生成 | `node agent-build/install.mjs generate [--platform ...]` |
| 只读校验 | `node agent-build/install.mjs validate` |
| 环境列表 | `node agent-build/install.mjs env` |
| 切换环境 | `node agent-build/install.mjs env use <name>` |
| 环境状态 | `node agent-build/install.mjs env status` |

默认环境位于 `${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/environments/default.json`。切换环境必须使用 `env use`，该命令在同一事务中验证、生成和更新环境标记。生成保留受管理片段之外的用户内容；`env status` 报告 `in-sync`、`drifted` 和 `shadowed`。

## 工作流契约

[`execution-runtime/workflow-contract.json`](execution-runtime/workflow-contract.json) 唯一声明 workflow、phase、action owner、合法转换、预算、决策代码和公共结构。运行记录保存在 Git common dir：

```text
.git/ai-work-flow/runs/<run_id>/
  run.json
  actions/<action_id>/attempt-N/{claim,receipt}.json
  artifacts/<artifact_id>.json
  decisions/revision-N.json
```

记录不进入项目提交，并由同一仓库的所有 worktree 和新会话共享。原子写入使用同目录临时文件、fsync 和 rename；每个 run 使用原子目录锁。活动锁返回 busy，只有 owner PID 已确认不存在的锁才会恢复。

统一 CLI 保留给人工诊断和 runtime 测试：

```sh
node execution-runtime/workflow-cli.mjs start --repository <repo> --kind <workflow-kind> --plan-digest <sha256> [--task-mode <single|split>]
node execution-runtime/workflow-cli.mjs status --repository <repo> --run-id <run_id> [--action-id <action_id>]
node execution-runtime/workflow-cli.mjs claim --repository <repo> --run-id <run_id> --action-id <action_id> --claimant <session> --owner-pid <pid>
node execution-runtime/workflow-cli.mjs finish --repository <repo> < receipt.json
node execution-runtime/workflow-cli.mjs recover --repository <repo> --run-id <run_id> --action-id <action_id>
node execution-runtime/workflow-cli.mjs decide --repository <repo> --run-id <run_id> < decision.json
node execution-runtime/workflow-cli.mjs artifact-create --repository <repo> --run-id <run_id> < artifact.json
node execution-runtime/workflow-cli.mjs artifact-verify --repository <repo> --run-id <run_id> < artifact-ref.json
```

`start` 对同一计划摘要和任务模式幂等。`claim` 对已完成 action 返回 canonical receipt，对活动 action 返回已有 claim。`finish` 必须增加 revision、改变 phase 或消耗持久化预算，否则停止为 `WORKFLOW_STALLED`。损坏或截断的响应通过 `status --action-id` 恢复，不重新执行 action。

Agents 不获得运行这些写命令所需的工作区权限。安装器为 Codex、Claude Code 和 OpenCode 注册 `execution-runtime/workflow-broker.mjs` 提供的 MCP `workflow_state` 工具；broker 只接受固定 operation，只允许当前启动仓库，并直接调用 runtime API。它没有命令执行接口，写入范围由 store 固定为 Git common dir 的 `.git/ai-work-flow/`。

公共对象为 `WorkflowSnapshot`、`ActionReceipt`、`ArtifactRef` 和 `ReviewPacketRef`。完整审查上下文、验收证据和叶子结果通过 `artifact_create` operation 保存在本地；Agent 交接只传不超过 1 KiB 的 ref。ReviewPacket 还必须绑定完整 runtime identity，并包含规格来源、验收证据和验证记录。

## 自动流程

Planning 按以下 action 自动推进：事实发现、必要产品决定、spec、plan、single/split tasks、规划提交、完成。Planning 不实施源码。

Coding 在一次实施授权后自动推进：prepare、实现、本地提交、ReviewPacket、双轴审查、blocking finding 修复、完整复审、main 同步、fast-forward 整合和安全清理。修复与完整复审最多两轮；同一 finding 重现时立即产生一个用户决定。main 漂移最多自动 resync 两次，每次冻结新提交并重新审查。

Git mutation 仅由 Git Operator 串行执行。自动授权不包含 push、stash、reset、clean、amend、tag、PR 或远端修改。完成记录默认保留，只有显式 prune 才清理。

## Agents 与 Skills

`roles.json`、controls、policies 和 workflow contract 共同生成角色能力、action 输入和结果结构。13 个角色模板固定使用七段接口：角色结果、能力与控制、允许的 Actions 与输入、执行循环、完成标准、决策条件、结果回执。`routing.md` 只保留人类可读治理，不复制进 prompt。

`skills.json` 是五个 Skills 的元数据来源。每份 `SKILL.md` 只保留结果、前置、步骤、分支和验收；分支细节位于一级 `references/`，可重复校验位于 `scripts/`。`agents/openai.yaml` 可通过以下命令确定性生成并校验：

```sh
npm run validate:skills
```

项目首次接入使用 `$init-ai-work-flow` 创建或补齐根 `MEMORY.md` 与 `.ai-work-flow/index/`。只读定位使用 `$project-code-navigation`；入口、路由、API、文件职责或模块边界变化时由实现角色同轮维护索引和必要的 MEMORY 内容。

## 验证

```sh
npm test
npm run validate:skills
node agent-build/install.mjs validate
node agent-build/install.mjs env status
git diff --check
```

平台能力报告区分 `enforced`、`instruction-only` 和 `unsupported`。审查角色通过 workflow CLI 写运行元数据的边界在当前三平台均标为 `instruction-only`；源码和 Git 权限仍保持只读请求。
