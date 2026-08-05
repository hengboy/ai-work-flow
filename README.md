# AI Work Flow

AI Work Flow 为 Codex、Claude Code 和 OpenCode 提供共享的 Planning、Coding、14 个 Agents、5 个 Skills 和可恢复执行 runtime。流程状态由机器契约维护，提示词只消费 snapshot、canonical inputs 和 artifact refs。

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
node execution-runtime/workflow-cli.mjs start --repository <repo> --kind coding --request-json '{"objective":"<verbatim Bug or small feature request>"}'
node execution-runtime/workflow-cli.mjs status --repository <repo> --run-id <run_id> [--action-id <action_id>]
node execution-runtime/workflow-cli.mjs claim --repository <repo> --run-id <run_id> --action-id <action_id> --claimant <session> --owner-pid <pid> --input-json '<json>'
node execution-runtime/workflow-cli.mjs finish --repository <repo> < receipt.json
node execution-runtime/workflow-cli.mjs support-validate --repository <repo> < support.json
node execution-runtime/workflow-cli.mjs recover --repository <repo> --run-id <run_id> --action-id <action_id>
node execution-runtime/workflow-cli.mjs decide --repository <repo> --run-id <run_id> < decision.json
node execution-runtime/workflow-cli.mjs artifact-create --repository <repo> --run-id <run_id> < artifact.json
node execution-runtime/workflow-cli.mjs artifact-verify --repository <repo> --run-id <run_id> < artifact-ref.json
```

`start` 对同一来源类型、摘要和任务模式幂等，不同任务身份创建独立 run。计划型 coding start 使用 `plan_digest + task_mode`；直接 Bug/小功能 start 使用严格的 `{objective}` request，runtime 对其 canonical JSON 求摘要并固定为 single，两种输入不能混用。同一仓库可用不同 `run_id` 和 worktree 并行执行多个 Coding 任务；claim、锁和 recover 预算均按 run 隔离。`claim` 接收 `{fields, artifacts}`，按 action 的命名 I/O contract 校验非空值后完整持久化；重复 claim 返回原 input，调用者不能替换。`finish` 校验必需 `outputs`、error 字段、artifact kind/run/digest，并交叉核对 canonical 上游 receipt、SHA、PathChange、finding IDs 与 coverage；状态不一致时不推进 phase。损坏或截断的响应通过 `status --action-id` 恢复，不重新执行 action。

Agents 不获得运行这些写命令所需的工作区权限。安装器为 Codex、Claude Code 和 OpenCode 注册 `execution-runtime/workflow-broker.mjs` 提供的 MCP `workflow_state` 工具；broker 只接受固定 operation，只允许当前启动仓库，并直接调用 runtime API。它没有命令执行接口，写入范围由 store 固定为 Git common dir 的 `.git/ai-work-flow/`。

`workflow_state` 的仓库级 `status` 可省略 `run_id` 并用可选 `kind` 返回当前契约下的 run 列表；指定 `run_id` 时返回单个 canonical snapshot。`contract` 只接受 `operation` 字段，不接受 repository/kind。Coding 启动预检发生在 run 外，不是 SupportReceipt，也不得调用 `support_validate`；目标仓库无需保存 execution runtime schema 副本。

公共对象为 `WorkflowSnapshot`、`ActionReceipt`、`SupportReceipt`、`ArtifactRef` 和 `ReviewPacketRef`。SupportReceipt 由稳定 caller/call ID 标识；`support_validate` 从 active caller 派生 owner 并校验委派关系，但不推进 phase。完整规划上下文、变更证据、审查轴结果和聚合审查结果分别使用 `planning_context`、`change_evidence`、`review_axis_result` 和 `review_result` artifact；Agent 交接只传不超过 1 KiB 的 ref。ReviewPacket 还必须绑定完整 runtime identity，并包含规格来源、验收证据和验证记录。

## 自动流程

Planning 在确认阶段完成需求事实与产品决定后、创建 `planning_context` 前确定 single/split 模式。两种模式都生成 spec 与 plan；split 随后生成 tasks，single 跳过 `planning.write_tasks` 直接进入规划提交。决定记录在 snapshot 的 `decision_history`，后续 action 必须绑定前一 canonical receipt。Planning 只负责调度和产品决定，不直接读取、检索或编辑文件，也不自行联网研究；这些工作分别委派给契约角色。

Coding 支持两种互斥来源。有批准计划时，先将计划工件及当前字段元数据兼容性预检交给 File Explorer，再用验证后的 plan digest/task mode 幂等选择该任务的 run；没有计划时，用户可直接授权一个可复现 Bug 或小功能，并以原始 objective 幂等选择该任务的 run。Coding 只跟进 `start` 返回的 `run_id`，不因同仓库其他任务的 active claim 等待。runtime 随后执行 `coding.triage`，再分别路由给 Bug Fixer 或 Full Stack Coder。跨域架构、数据库/schema 迁移、安全/权限、公共 API/契约、多个独立交付任务，或仍有产品决定/广泛验收歧义的请求必须以不可恢复的 `PLANNING_REQUIRED` 结束，用户需另行启动 Planning。Coding 自身不直接检索或修改工作区。

两种来源随后共享本地提交、ReviewPacket、双轴审查、blocking finding 修复、完整复审、main 同步、fast-forward 整合和安全清理。修复与完整复审最多两轮；同一 finding 重现时立即产生一个用户决定。main 漂移最多自动 resync 两次，每次冻结新提交并重新审查。

Git mutation 仅由 Git Operator 串行执行。自动授权不包含 push、stash、reset、clean、amend、tag、PR 或远端修改。完成记录默认保留，只有显式 prune 才清理。

## Agents 与 Skills

`roles.json`、controls、policies 和 workflow contract 共同生成角色能力、命名 action I/O 和结果结构。14 个角色模板固定使用七段接口：角色结果、能力与控制、允许的 Actions 与输入、执行循环、完成标准、决策条件、结果回执。Environment Operator 独占 Agent 生成与环境切换；Git Operator 只负责本地 Git 生命周期。`routing.md` 只保留人类可读治理，不复制进 prompt。

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

workflow contract digest 变化后，未结束的旧 run 继续 fail-closed，不自动迁移或回写历史 spec、plan、tasks；发布前应完成或明确放弃这些 run。自动授权仍不包含浏览器、额外网络、push、tag、发布或其他远端操作。
