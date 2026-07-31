# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成统一专职代理工作流的配置系统。安装后，**Coding** 是默认入口，负责路由、等待和汇总；**Planning** 是用户显式选择的可选主入口，只负责问询和生成完整计划。实际的发现、研究、写作、实现和评审由专职角色完成。

## 前置条件

- Node.js 运行环境
- 已安装并配置 Codex、Claude Code 或 OpenCode 中至少一个客户端
- 当前用户对对应全局配置目录具有读写权限

## 安装

在仓库根目录执行：

```sh
node agent-build/install.mjs
```

安装会完成以下工作：

- 将自定义技能（`run-matt-spec-to-completion`、`generate-ai-work-flow-agents`、`switch-ai-work-flow-env`、`project-code-navigation`、`git-commit`）同步到 Codex、Claude Code 和 OpenCode 的全局 Skills 目录，并安装共享 execution runtime 及其依赖
- 创建并默认直接使用 `~/.config/ai-work-flow/environments/default.json` 和 `routing.md`；仓库中的 `agent-build/config/default-config.json` 仅作为初始化模板
- 生成三端的 12 个受管理 agent
- 更新三端的路由配置，并从角色目录的 `default_primary` 设置 OpenCode 默认 agent；默认仍为 `coding`
- 保留无关的全局 Skills、agents 和工具配置

默认安装会处理全部平台。只生成指定平台的 agents 时，可以使用：

```sh
node agent-build/install.mjs --platform codex
node agent-build/install.mjs --platform claude,opencode
```

首次安装前想查看将要写入的路径，可使用：

```sh
node agent-build/install.mjs --dry-run
```

## 命令

```sh
# 初始化配置和路由，不生成平台 agents
node agent-build/install.mjs init

# 检查配置，不写入文件
node agent-build/install.mjs validate

# 查看命令格式
node agent-build/install.mjs --help
```

`install` 是完整流程：同步 Skills、初始化配置和路由、安装运行时文件，然后生成 agents。`init` 和 `validate` 适合安装或排查问题；配置更新后的 agents 重新生成应通过 `$generate-ai-work-flow-agents` 完成。

升级安装时，如果全局 `environments/default.json` 完全缺少 `planning` 或 `task-planner`，安装器会从内置默认配置补入缺失角色；仍使用 `git-committer` ID 的默认环境和稀疏环境会迁移为 `git-operator`。配置迁移、核心 runtime/资产和平台代理生成作为一个事务提交。已有角色即使字段残缺也不会被静默修复；此时安装会停止并保留原文件。`validate` 和 `--dry-run` 始终不写入文件，也不执行迁移。

## 模型配置

默认环境配置需要编辑的文件是：

```text
~/.config/ai-work-flow/environments/default.json
```

设置 `XDG_CONFIG_HOME` 后，路径会变为 `$XDG_CONFIG_HOME/ai-work-flow/environments/default.json`。无 `.environment` 标记时直接使用默认环境；非默认环境由 `.environment` 指向 `environments/<name>.json`。环境文件按角色、平台和字段覆盖默认环境，未提供的字段继承默认值；OpenCode 的 `options` 是例外，覆盖时整体替换，避免隐式保留旧选项。因此环境文件只需写差异字段，默认环境仍须保留全部受管理角色及三端完整配置。配置按角色和平台组织，例如：

```json
{
  "version": 1,
  "roles": {
    "coding": {
      "codex": { "model": "gpt-5.6", "reasoning": "medium" },
      "claude": { "model": "sonnet", "effort": "medium" },
      "opencode": {
        "model": "provider/model",
        "variant": "默认变体",
        "options": {}
      }
    }
  }
}
```

实际配置必须保留全部受管理角色及三端配置。Codex 的 `reasoning` 使用非空字符串，可配置 `low`、`medium`、`high` 或模型支持的更高档位（例如 `xhigh`）；Claude Code 的 `effort` 只能使用 `low`、`medium` 或 `high`。OpenCode 的 `model` 可以为 `null`，表示继承主会话模型；需要明确指定时填写提供方和模型，例如 `provider/model`，并按提供方填写 `variant` 或 `options`。

修改默认环境 `environments/default.json` 或当前非默认环境对应的 `environments/<name>.json` 后，调用唯一的更新入口 `$generate-ai-work-flow-agents`：

```text
$generate-ai-work-flow-agents
```

该 Skill 会定位已安装的运行时，先执行 `validate`，验证通过后再执行 `generate`。需要限定平台时，在调用中明确指定 Codex、Claude Code、OpenCode，或它们的组合。生成完成后，新会话才会读取更新后的 agents。

OpenCode 对继承主会话模型或未设置原生 `variant/options` 的角色会输出警告，但不会阻止生成。

环境切换：

```sh
node agent-build/install.mjs env use <name>
```

非默认环境由 `.environment` 标记选择。`env use default` 通过删除该标记选择默认环境；无标记时已使用默认环境。该命令会先验证目标环境，再以单个事务重新生成所有已管理平台的 agents 并更新标记；任一步失败时会恢复原有 agents 和环境选择。事务日志是未经信任的恢复输入，只有通过受信根、目标、备份和符号链接检查后才会执行恢复；非法日志保留现场并停止。

`env status` 输出每个角色的平台 capability matrix：只有平台实际强制的项标记为 `enforced`，其余会明确标记为 `instruction-only` 或 `unsupported` 并产生警告。特别是 Codex 的 `filesystem: none` 不能强制隔离，必须显示为 `unsupported`。

## 生成位置

- Codex：`~/.codex/agents/*.toml`
- Claude Code：`~/.claude/agents/*.md`
- OpenCode：`$XDG_CONFIG_HOME/opencode/agents/*.md`（未设置时为 `~/.config/opencode/agents/*.md`）
- 共享运行时和配置：`$XDG_CONFIG_HOME/ai-work-flow/`（未设置时为 `~/.config/ai-work-flow/`）

生成器只更新 AI Work Flow 管理的文件和配置片段，不覆盖其他全局 agent 或工具设置。

## 共享执行 Runtime

`$XDG_CONFIG_HOME/ai-work-flow/execution-runtime/execution-cli.mjs` 是执行状态的 canonical 接口；未设置 `XDG_CONFIG_HOME` 时使用 `~/.config/ai-work-flow/execution-runtime/execution-cli.mjs`。所有 Ticket 状态都经 runtime 的 feature lock 和 state store 变更，Coding 不直接写 Checkpoint。

```sh
runtime="${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/execution-runtime/execution-cli.mjs"
node "$runtime" claim --repository <repo> --feature <feature> --worktree <repo>/.worktrees/<feature>
node "$runtime" record-ticket --repository <repo> --feature <feature> --worktree <repo>/.worktrees/<feature> < handoff.json
node "$runtime" sync-main --repository <repo> --feature <feature> --worktree <repo>/.worktrees/<feature>
node "$runtime" begin-review --repository <repo> --feature <feature> --worktree <repo>/.worktrees/<feature> < review-manifest-input.json
```

`record-ticket` 只接受 JSON Handoff envelope：它包含 `role_id`、`status`、`summary`、`artifacts`、`checks` 和类型化 `payload`，blocked 时还包含 `error`。裸 Completion Result 不是 runtime 输入。Checkpoint 的 worktree 仅能是仓库内相对路径；绝对路径、遍历路径、符号链接父路径和其他仓库的 worktree 均会停止，而不会迁移或猜测恢复。`sync-main` 冻结精确 `main_commit`；冲突返回未合并路径，由实施角色解决并以 `complete-sync` 完成。结构化评审结果分别记录 Standards 与 Spec 的 verdict、阻塞/建议 finding、manifest digest 和完整 coverage。阻塞 finding 只能由用户确认具体 IDs 后修复；修复会重新同步并最终复审一次。

## 角色

| 角色 | 用途 |
| --- | --- |
| **Coding** | 路由、等待和汇总 |
| **Planning** | 逐题确认目标和关键决策，将完整计划写入 `.ai-work-flow/plans/<plan-id>/plan.md`，再确认是否拆分任务和 planning commit；不实施代码 |
| **File Explorer** | 全库枚举、搜索和代码地图 |
| **Researcher** | 外部官方资料与依赖研究 |
| **Document Maintainer** | README、`docs` 等常规文档 |
| **Planning Writer** | 计划、任务、ADR、交接和 tracker 文案 |
| **Task Planner** | 将已确认计划拆分为可跟踪的实施任务 |
| **Full Stack Coder** | 源码、测试、必要配置和调试 |
| **Code Reviewer** | 汇总标准与需求双轴评审 |
| **Review Standards** / **Review Spec** | Code Reviewer 使用的内部评审角色 |

项目级 issue tracker 和领域文档由目标项目自行维护；全局 Skills、配置和 agents 由本仓库的安装器维护。

## 计划与实施

Planning 将已确认的完整计划写入目录式工件 `.ai-work-flow/plans/<plan-id>/plan.md`，并在计划展示后确认是否拆分任务以及是否创建 planning commit。可选的 `tasks/NN-short-name.md` 任务文件位于同一目录：没有 `tasks/` 表示单任务模式；存在且全部合法的任务文件表示拆分模式；空的或含无效任务文件的 `tasks/` 会阻塞实施。

单任务模式由 Coding 只委派一个 **Full Stack Coder** 完成整个计划。拆分模式按 `blocked_by` 计算依赖前沿并发实施；每个 task 的代码、测试、必要配置和 checkbox 进入同一个 task review commit，经 **Code Reviewer** 对该 task 做 Standards + Spec 双轴评审后，Git Operator 按编号顺序汇入 feature，再开放下一前沿。全部 task 汇入后执行一次聚合双轴评审；只有评审覆盖完整、无阻塞 finding 且 `main` 未前进时，才以 `--ff-only` 整合。

## Skills

本仓库提供以下技能：

### `$run-matt-spec-to-completion`

执行由 `to-spec` 和 `to-tickets` 写入的 Spec 和 Ticket，完成实施、评审并合并到 `main`。这是唯一的执行入口，编排现有模块完成完整生命周期：

1. **初始化** — 解析 spec.md，推导 feature slug，创建 worktree，物化执行计划
2. **恢复** — 从已有 Checkpoint 验证并续接执行
3. **执行** — 逐个执行 Ticket Frontier，委派专职角色实施
4. **同步、评审与整合** — 同步最新 `main` 后，以同步提交为 fixed point 执行 Standards + Spec 双轴评审；阻塞 finding 需用户确认具体 ID，修复后重新同步并最终复审一次
5. **整合与清理** — 仅在 `main` 未前进、feature HEAD 等于已审查提交时执行 `git merge --ff-only`，随后安全移除干净 worktree 和已合并本地分支

前置条件：Spec 目录须包含 `spec.md` 和 `issues/NN-*.md`，项目还须提供 `docs/agents/issue-tracker.md`。

### `$generate-ai-work-flow-agents`

验证全局配置并重新生成 Codex、Claude Code、OpenCode agents。默认环境修改 `$XDG_CONFIG_HOME/ai-work-flow/environments/default.json`（未设置时为 `~/.config/ai-work-flow/environments/default.json`）后，或修改非默认环境对应的 `environments/<name>.json` 后，调用此技能使配置生效。`env use` 已在事务内重新生成受管理 agents；仅在不通过该命令修改配置时才需要调用此技能：

1. 定位 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`（未设置时为 `~/.config/ai-work-flow/agent-workflow.mjs`）
2. 运行 `validate`，验证失败则停止
3. 运行 `generate`（可按 `--platform` 限定平台）
4. 报告更新的文件，提醒用户新会话才读取更新后的 agents

### `$project-code-navigation`

为当前项目初始化、使用并持续维护 `.ai-work-flow/index/` 代码导航索引。索引按真实代码记录功能关键词与页面、路由、API、Service、任务等入口；修改代码前必须先用索引定位，且文件或功能入口变化必须在同一轮改动中更新索引。仅在项目实际包含相应层时创建 `frontend-navigation.md` 或 `backend-navigation.md`。

### `$git-commit`

根据 Full Stack Coder 的 `base_commit`、空的初始状态、精确 `changed_paths` 和通过的验证结果创建一个仅本地的实现提交。它只暂存声明的路径，在提交前核对当前 HEAD、完整路径集合、暂存清单与非空差异，并禁止 push、amend、reset、clean、stash 和扩大暂存范围。成功时返回完整 `review_commit` SHA 和空工作树；已确认方案的实现阶段无需为该提交重复请求用户授权。

### 自动提交与审查

确认实现后，角色按 **Full Stack Coder -> Git Operator -> Code Reviewer -> Review Standards + Review Spec** 自动推进。Code Reviewer 只审查提交后的固定 SHA 范围，绝不读取未提交内容。大差异会按固定端点的文件和行窗口分片，两个审查轴使用相同清单；中断时只重试未完成分片，端点不会变化。

## AI Work Flow 评审与执行契约

`run-matt-spec-to-completion` 消费 `to-spec` 和 `to-tickets` 生成的 Spec/Ticket 结构。双轴评审方法借鉴成熟工程工作流，但固定提交范围、三角色评审拓扑、模型配置、权限边界、Checkpoint 和整合门禁均由 AI Work Flow 独立定义和维护。

`to-spec`、`to-tickets`、`implement` 和 `code-review` 可以作为独立能力安装。AI Work Flow 提供：

- **多主入口路由层**：`routing.md` + 12 角色 Agent 定义；Coding 为默认入口，Planning 为可选 plan-only 入口
- **执行引擎**：`run-matt-spec-to-completion`（适配 `to-spec`/`to-tickets` 产物）
- **配置管理**：`generate-ai-work-flow-agents` + `agent-workflow.mjs`
- **项目导航**：`project-code-navigation` + 目标项目 `.ai-work-flow/index/`

如需调整产物兼容性，确认 `run-matt-spec-to-completion` 与目标 `to-spec`/`to-tickets` 结构兼容后，重新运行结构、命名及工件边界验证。

## 开发验证

```sh
npm test
```
