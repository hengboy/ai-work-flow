# AI Work Flow

为 Codex、Claude Code 和 OpenCode 提供统一的专职代理工作流：**Coding** 是默认入口，负责路由、等待和汇总；**Planning** 是可选入口，负责问询并生成完整计划。

## 快速开始

### 前置条件

- Node.js
- Codex、Claude Code 或 OpenCode 至少一个客户端，且已完成配置
- 当前用户对对应全局配置目录具有读写权限

首次使用建议先预览写入路径，再安装、校验：

```sh
node agent-build/install.mjs --dry-run
node agent-build/install.mjs
node agent-build/install.mjs validate
```

`--dry-run` 只显示计划写入内容，不写文件；`validate` 只校验配置，不写文件。默认安装全部平台，也可以限定平台：

```sh
node agent-build/install.mjs --platform codex
node agent-build/install.mjs --platform claude,opencode
```

## 日常操作

| 操作 | 命令 | 作用 |
| --- | --- | --- |
| 完整安装 | `node agent-build/install.mjs` | 同步 Skills、运行时、配置和 agents |
| 初始化 | `node agent-build/install.mjs init` | 初始化配置和路由，不生成 agents |
| 生成 | `node agent-build/install.mjs generate [--platform ...]` | 根据当前配置生成 agents |
| 校验 | `node agent-build/install.mjs validate` | 校验当前配置 |
| 帮助 | `node agent-build/install.mjs --help` | 显示完整命令格式 |
| 环境列表 | `node agent-build/install.mjs env list` | 列出环境及当前选择 |
| 创建环境 | `node agent-build/install.mjs env create <name>` | 从当前解析配置创建完整环境副本 |
| 使用环境 | `node agent-build/install.mjs env use <name>` | 校验并事务式生成后切换环境 |
| 删除环境 | `node agent-build/install.mjs env delete <name>` | 删除非默认环境 |
| 环境状态 | `node agent-build/install.mjs env status` | 显示环境、平台和生成状态 |

### 配置模型

默认环境文件为：

```text
${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/environments/default.json
```

非默认环境使用同目录下的 `<name>.json`，由 `.environment` 标记选择；环境配置按角色、平台和字段覆盖默认值，未提供字段继续继承。OpenCode 的 `options` 例外：一旦覆盖就整体替换。默认环境必须保留全部受管理角色及三平台完整配置，非默认环境可以只记录差异。修改环境文件后，通过 `$generate-ai-work-flow-agents` 校验并重新生成；新会话才会读取更新后的 agents。

平台配置按角色组织，例如：

```json
{
  "version": 1,
  "roles": {
    "coding": {
      "codex": { "model": "gpt-5.6", "reasoning": "medium" },
      "claude": { "model": "sonnet", "effort": "medium" },
      "opencode": { "model": "provider/model", "variant": "default", "options": {} }
    }
  }
}
```

Codex 的 `reasoning` 使用非空字符串；Claude Code 的 `effort` 只接受 `low`、`medium` 或 `high`；OpenCode 的 `model` 可以为 `null`，表示继承主会话模型。

生成位置：

- Codex：`~/.codex/agents/*.toml`
- Claude Code：`~/.claude/agents/*.md`
- OpenCode：`$XDG_CONFIG_HOME/opencode/agents/*.md`，未设置时为 `~/.config/opencode/agents/*.md`
- 共享运行时和配置：`$XDG_CONFIG_HOME/ai-work-flow/`，未设置时为 `~/.config/ai-work-flow/`

安装器和生成器只管理 AI Work Flow 自己的文件及配置片段，不覆盖其他全局 agents、Skills 或工具配置。

## 工作流

### 角色协作

Coding 将任务路由给 File Explorer、Researcher、Document Maintainer、Planning Writer、Full Stack Coder、Git Operator 和 Code Reviewer；Planning 可调用 File Explorer、Planning Writer、Task Planner 和 Git Operator。Code Reviewer 再调用 Review Standards 与 Review Spec。Git 操作由 Git Operator 串行执行。

### Planning 产物

Planning 通过问询确认目标和关键决策，将完整计划写入：

```text
.ai-work-flow/plans/<plan-id>/plan.md
```

确认计划后可继续拆分为 `tasks/NN-short-name.md`。没有 `tasks/` 是单任务模式；存在且全部合法的任务文件是拆分模式；空的或含无效任务文件的 `tasks/` 会阻塞实施。Planning 只生成计划，不实施代码。

### 普通实施

确认方案后，流程按 **Git Operator prepare -> Full Stack Coder -> Git Operator commit/sync -> Code Reviewer -> Review Standards + Review Spec -> Git Operator integrate/cleanup** 执行。实现和评审在同一个隔离 worktree 中进行；实现完成并通过验证后创建仅本地 review commit，Code Reviewer 只审查已提交的固定范围。

拆分计划按 `blocked_by` 形成依赖前沿。每个 task 独立实现、提交和双轴评审，Git Operator 按编号顺序汇入 feature；全部 task 完成后进行一次聚合评审。只有评审覆盖完整、无阻塞 finding 且 `main` 未前进时，才使用 `git merge --ff-only` 整合。

评审出现阻塞 finding 时，只修复用户确认的 finding IDs。修复提交必须晚于原 `review_commit` 且等于当前 feature 或 task HEAD；重新同步后由用户明确选择再次执行完整双轴评审，或继续后续流程，不会因旧 finding 自动复审。

### Spec/Ticket canonical runtime

`run-matt-spec-to-completion` 是 Spec/Ticket 执行入口，消费 `to-spec` 和 `to-tickets` 生成的产物。输入必须是：

```text
<target-project>/.scratch/<featureSlug>/spec.md
```

同目录必须有 `issues/NN-<slug>.md`，项目必须有 `docs/agents/issue-tracker.md`。Canonical runtime 位于：

```sh
runtime="${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/execution-runtime/execution-cli.mjs"
```

初始化、认领 Ticket、记录交接、同步、评审和整合均通过 runtime 完成，例如：

```sh
node "$runtime" prepare --repository <repo> --branch ai-work-flow/<feature> \
  --spec <repo>/.scratch/<feature>/spec.md --worktree <repo>/.worktrees/<feature>
node "$runtime" claim --repository <repo> --feature <feature> \
  --role-id <role> --session-id <session> --worktree <repo>/.worktrees/<feature>
node "$runtime" record-ticket --repository <repo> --feature <feature> \
  --worktree <repo>/.worktrees/<feature> < handoff.json
```

Ticket 终态通过带 claim identity 的 JSON Handoff 写入；裸 Completion Result 不是 runtime 输入。全部 Ticket 完成后，runtime 记录精确的 `main_commit`，处理同步冲突，再冻结包含提交端点、来源、分片和 digest 的 ReviewManifest。评审结果必须覆盖 Standards 与 Spec 两个轴；阻塞 finding 只能由用户确认具体 ID 后修复。

Runtime 中的修复完成后，`complete-review-fix` 将执行状态恢复到同步与最终评审阶段；最终评审仍有阻塞 finding 时再次等待用户，不自动继续修复。

### 跨会话恢复

恢复前必须验证 Checkpoint integrity：执行计划 revision、canonical 路径、baseline、branch/worktree、任务条目及各任务提交都必须与 Git 事实一致。`invalid` 时停止并报告精确 diagnostics，不猜测、不降级、不重派已完成任务。

有效 Checkpoint 按状态继续：`executing` 从最低未完成 frontier 继续，`reviewing` 进入冻结 manifest 评审，`fixing` 等待追加修复提交，`integrating` 只做整合和清理，`complete` 只报告结果。`in_progress` Ticket 在无法证明原 worker 已停止时不会自动重派。

## 角色与 Skills

### 角色

| 角色 | 职责边界 |
| --- | --- |
| Coding | 路由、等待受委派结果并汇总 |
| Planning | 问询并生成完整计划，不实施代码 |
| File Explorer | 全库枚举、搜索和代码地图 |
| Researcher | 外部官方资料研究并写入带引用报告 |
| Document Maintainer | 维护 README、docs 等普通文档 |
| Planning Writer | 只写目录式完整实施计划 |
| Task Planner | 将已确认计划拆分为可跟踪任务 |
| Full Stack Coder | 实现源码、测试、必要配置和修复 |
| Git Operator | 受控执行 Git 工作流 |
| Code Reviewer | 编排 Standards + Spec 双轴评审 |
| Review Standards / Review Spec | 分别执行标准与规范评审 |

### Skills

| Skill | 入口 | 输入 | 结果 |
| --- | --- | --- | --- |
| `run-matt-spec-to-completion` | `$run-matt-spec-to-completion` | canonical Spec、Tickets 和项目 issue tracker | 实施、评审、整合及执行记录 |
| `generate-ai-work-flow-agents` | `$generate-ai-work-flow-agents` | 已修改的环境配置，可选平台范围 | 校验并重新生成三平台 agents |
| `switch-ai-work-flow-env` | `$switch-ai-work-flow-env` | 已存在的环境名称 | 事务式切换环境并重新生成受管理 agents |
| `project-code-navigation` | `$project-code-navigation` | 当前项目代码结构 | 维护 `.ai-work-flow/index/` 导航索引 |
| `git-commit` | `$git-commit` | Full Stack Coder 的结构化交接 | 创建仅本地、路径范围精确的实现提交 |

## 安全与一致性

- 安装、环境切换和生成使用事务计划；失败时保留原状态并按受信根、目标、备份、类型和符号链接策略验证恢复输入。
- 同一 feature 的 mutating runtime command 使用跨进程 feature lock，Checkpoint 由 state store 唯一写入。
- Checkpoint integrity 不通过时停止；恢复不会猜测路径、迁移旧绝对路径或重派未确认已停止的任务。
- 评审只针对固定 `fixed-point` 与 `review-commit` 的 committed diff；两个评审轴共享同一 ReviewManifest、digest、提交范围和分片清单。
- 阻塞 finding 只能通过用户确认的 finding IDs 进入修复；修复必须产生晚于已评审提交的新提交，后续评审行为由对应的普通实施或 Runtime 契约决定。
- 整合前要求主工作树和 feature worktree 干净、提交端点精确匹配且 `main` 未前进；默认使用 `git merge --ff-only`。
- 升级安装只迁移明确支持的缺失角色和旧角色 ID；已有角色字段残缺时停止，不静默修复。
- 浏览器自动化、E2E 测试或视觉验证只有在当前请求明确要求时才允许；交接读取只能使用用户或上游交接的精确路径及其直接依赖。

## 开发验证

```sh
npm test
node agent-build/install.mjs validate
```
