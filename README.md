# AI Work Flow

为 Codex、Claude Code 和 OpenCode 提供统一的专职代理工作流：**Coding** 是默认入口，负责路由、等待和汇总；**Planning** 是可选入口，负责问询并生成完整计划。

## 快速开始

### 前置条件

- Node.js
- Git
- Codex、Claude Code 或 OpenCode 至少一个客户端，且已完成配置
- 当前用户对对应全局配置目录具有读写权限

首次使用建议先预览写入路径，再安装、校验：

```sh
npm ci
node agent-build/install.mjs --dry-run
node agent-build/install.mjs
node agent-build/install.mjs validate
```

`--dry-run` 只显示计划写入内容，不写文件；`validate` 只校验角色资产和配置，不写文件。默认生成全部平台的 agents 和平台配置，也可以限定生成平台：

```sh
node agent-build/install.mjs --platform codex
node agent-build/install.mjs --platform claude,opencode
```

完整安装中的 `--platform` 只限制 agents 和平台配置的生成范围；共享 Skills 和 runtime 仍会安装到 Codex、Claude Code 和 OpenCode 的全局目录。只想初始化环境配置和路由时使用 `init`。

## 日常操作

| 操作 | 命令 | 作用 |
| --- | --- | --- |
| 完整安装 | `node agent-build/install.mjs` | 同步 Skills、运行时、配置和 agents |
| 初始化 | `node agent-build/install.mjs init` | 只初始化配置和路由，不安装 Skills/runtime，也不生成 agents |
| 生成 | `node agent-build/install.mjs generate [--platform ...]` | 根据当前配置生成 agents |
| 校验 | `node agent-build/install.mjs validate` | 校验角色资产和当前配置 |
| 帮助 | `node agent-build/install.mjs --help` | 显示完整命令格式 |
| 环境列表 | `node agent-build/install.mjs env` | 列出环境及当前选择；`env list` 是兼容别名 |
| 创建环境 | `node agent-build/install.mjs env create <name>` | 从当前解析配置创建完整环境副本 |
| 使用环境 | `node agent-build/install.mjs env use <name>` | 校验并事务式生成后切换环境 |
| 删除环境 | `node agent-build/install.mjs env delete <name>` | 删除非默认环境 |
| 环境状态 | `node agent-build/install.mjs env status` | 显示环境、平台和生成状态 |

### 配置模型

默认环境文件为：

```text
${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/environments/default.json
```

非默认环境使用同目录下的 `<name>.json`，由 `.environment` 标记选择；环境配置按角色、平台和字段覆盖默认值，未提供字段继续继承。OpenCode 的 `options` 例外：一旦覆盖就整体替换。默认环境必须保留全部受管理角色及三平台完整配置，非默认环境可以只记录差异。完整安装会补齐完全缺失的 Planning、Planning Writer、Task Planner 或 Bug Fixer；已有但残缺的角色配置仍会失败。旧默认环境完全缺失 Bug Fixer 时，`validate` 和 `generate` 还可只在内存中使用该角色的默认配置且不改写环境文件，下一次完整安装再持久化补齐。修改环境文件后，通过 `$generate-ai-work-flow-agents` 校验并重新生成，或直接依次运行 `validate` 和 `generate`；新会话才会读取更新后的 agents。环境切换应使用 `env use <name>`，不要手工改写 `.environment`。

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

生成位置及全局配置副作用：

- Codex：`~/.codex/agents/*.toml`；更新 `~/.codex/config.toml` 的代理深度下限，并维护 `~/.codex/AGENTS.md` 中的受管理片段
- Claude Code：`~/.claude/agents/*.md`；维护 `~/.claude/CLAUDE.md` 中的受管理片段
- OpenCode：`$XDG_CONFIG_HOME/opencode/agents/*.md`，未设置时为 `~/.config/opencode/agents/*.md`；更新同目录根部的 `opencode.json`，设置默认主代理和代理深度下限
- 共享运行时和配置：`$XDG_CONFIG_HOME/ai-work-flow/`，未设置时为 `~/.config/ai-work-flow/`

安装器和生成器保留受管理片段之外的用户内容，以及其他名称的全局 agents、Skills 和工具配置。角色表和 Skills 表中列出的同名目标属于受管理内容：同名 agent 会更新，同名 Skill 目录会按仓库版本整体同步，升级时也会清理明确支持的旧受管理路径。升级前应先运行 `--dry-run` 检查目标路径。

`env status` 会报告每个平台/角色的 `in-sync`、`drifted` 或 `shadowed` 状态。项目级或用户级同名 agent 可能遮蔽全局生成结果；生成成功不代表新会话一定使用该全局 agent，应先处理状态输出中的 `reasons`。

## 工作流

项目包含两套独立协议：目录式 **Planning Spec/Plan/Task** 由 Planning、Coding 和 Git Operator 按代理指令协调；canonical **Spec/Ticket** 由 `execution-cli.mjs` 持久化 Execution plan、Checkpoint 和执行状态。前者位于 `.ai-work-flow/plans/`，没有 planning CLI 或 runtime；后者位于 `.scratch/`，只有它提供 canonical runtime 与跨会话 Checkpoint 恢复。两套 spec 格式和兼容边界互不转换。

### 使用流程

```text
Planning 持续问询并通过共享理解门禁 -> 写入/校验 spec.md -> 计算原始字节 SHA-256 -> 写入绑定的 plan.md -> 选择拆分或不拆分 -> 创建 planning commit -> 新会话由 Coding 实施
```

1. 在 **Planning** 主代理中说明目标。Planning 先让 File Explorer 查明仓库事实，再一次只问一个决定，沿影响结果的设计分支持续追问并按依赖顺序解决。只有关键分支、验收场景、范围边界、假设和未决问题全部收敛，且用户明确批准复述的共享理解后，Planning Writer 才完整写入 `.ai-work-flow/plans/<plan-id>/spec.md`。门禁通过前不会生成后续规划工件；新信息或需求变化会重新打开问询。已有且需求未变化的 spec 会先校验、总结并再次确认，不会静默重写。
2. spec 写后必须满足固定中文章节、`status: approved` 和 `开放问题: N/A`，并只描述需求与验收边界。File Explorer 对保存后的原始完整字节计算 SHA-256；随后 Planning Writer 写入 `plan.md`，通过 `source_spec` 和 `source_spec_digest` 绑定该规格。任一写入、校验或摘要失败都会短路后续阶段。
3. plan 校验成功后明确选择“拆分”或“不拆分”。拆分时先确认完整任务草案的颗粒度，再按当前 plan 原始完整字节摘要全量替换 `tasks/NN-short-name.md`；不拆分时需明确确认删除全部旧 tasks。计划一旦重写，旧 tasks 立即不可执行。
4. 确认最终工件后，由 Planning 委派 Git Operator 创建只包含当前目录 spec、plan 和完整 tasks 集合或 tasks 删除的本地 planning commit。Planning 到此结束，不实施代码。
5. 打开新会话并使用默认的 **Coding** 主代理，明确要求实施 `.ai-work-flow/plans/<plan-id>/plan.md`。Coding 会复核 spec/plan 原始字节摘要绑定、planning commit 和任务模式，再进入单任务或拆分实施流程。

### 手工 Git worktree 参考

本节命令只供人工维护仓库时参考，不属于 Coding、Git Operator 或 canonical runtime 的自动执行协议。自动执行时不要手工提交、rebase、push、切换或清理其受管分支/worktree；应由 Git Operator 或 runtime 完成并验证 Git mutation。

人工流程中，每项功能使用独立分支和独立 worktree，主工作树只负责更新 `main`、整合和清理。以下命令在主工作树根目录开始执行，并在同一个终端会话中完成；`git status --short` 必须无输出：

```sh
git status --short
git switch main
git pull --ff-only

feature=my-feature
branch="feature/$feature"
worktree="$PWD/.worktrees/$feature"

exclude_file="$(git rev-parse --git-path info/exclude)"
grep -qxF '/.worktrees/' "$exclude_file" || printf '\n/.worktrees/\n' >> "$exclude_file"
git worktree add -b "$branch" "$worktree" main
cd "$worktree"
```

在新 worktree 中安装依赖、开发、验证并提交。不要在主工作树修改该功能，也不要让多个 worktree 检出同一分支：

```sh
npm ci
npm test
git status --short
git add <paths>
git commit -m "<type>: <summary>"
```

提交前同步最新 `main` 并再次验证：

```sh
git fetch origin
git rebase origin/main
npm test
git status --short
```

需要通过 PR 协作时，推送功能分支：

```sh
git push -u origin "$branch"
```

仅在本地整合时，返回主工作树并执行快进合并；如果 `main` 已前进，回到功能 worktree 重新 rebase 和验证，不使用强制合并：

```sh
cd -
git switch main
git pull --ff-only
git merge --ff-only "$branch"
npm test
```

功能已整合或 PR 已合并后，在主工作树清理 worktree 和本地分支。不要直接删除 `.worktrees/<feature>` 目录：

```sh
git worktree remove "$worktree"
git branch -d "$branch"
git worktree prune
```

#### Task 执行层级

目录式计划包含 `tasks/*.md` 时，worktree 按以下 Git 基线与汇入关系组织：

```text
main worktree [main]
  -> feature worktree [feature branch]
       -> Task 01 worktree [task branch, base = feature HEAD]
       -> Task 02 worktree [task branch, base = 同一 frontier 的 feature HEAD]
       <- 通过评审的 Task commit 按编号汇入 feature branch
       -> 下一 frontier 的 Task worktree [base = 更新后的 feature HEAD]
  <- 聚合评审通过后，以 --ff-only 汇入 main
```

该图表达提交基线和汇入方向，不规定物理目录嵌套。feature worktree 与 task worktree 都是同一仓库的隔离工作树，具体 task worktree 路径由 Coding 和 Git Operator 分配并验证。

1. **Feature 层**：一次计划实施只有一个 feature branch/worktree，负责聚合所有 Task、解决汇入冲突、执行最终验证和聚合评审。
2. **Frontier 层**：依赖已满足的 Task 构成当前 frontier。`write_scope` 是预计主要修改范围，只用于判断初始并发，不是穷举清单或写入授权边界；声明 scope 互斥的 Task 可以并发实施，同一 frontier 的 task branch 均从开始时相同的 feature HEAD 创建。
3. **Task 层**：每个 Task 使用独立 task branch/worktree，可以修改完成自身验收所必需的源码、测试、配置、导航索引和自己的 checklist。实施发现 `write_scope` 遗漏文件时直接记录实际变更，不修改已批准的 plan 或 task 元数据；实现提交和双轴评审都固定在该 Task 的 base 与 review commit 之间。
4. **汇入层**：Task 通过评审后，由 Git Operator 按编号串行汇入 feature branch，再清理对应 task worktree/branch。当前 frontier 全部汇入后，才从新的 feature HEAD 开放下一 frontier。
5. **最终整合层**：全部 Task 汇入后，feature branch 同步最新 `main` 并接受一次聚合评审；门禁通过后才在主工作树执行 `git merge --ff-only`。

没有 `tasks/` 的单任务计划只创建 feature worktree，不额外创建 task worktree。`run-matt-spec-to-completion` 中的 **Ticket** 也不同于目录式计划的 Task：每个 Spec 只有一个 feature worktree，Ticket 不创建独立 branch、worktree 或 PR，而是在 canonical runtime 和 feature lock 约束下共享该 worktree。Ticket 当前严格串行，一次最多有一个 `in_progress` Ticket。

AI Work Flow 自动执行时使用稳定唯一的 `worktree_id`。已有 `.worktrees/<worktree_id>` 只有在仓库、分支和任务基点完全匹配时才会恢复，否则流程会停止并报告冲突。

### 角色协作

Coding 将任务路由给 File Explorer、Researcher、Document Maintainer、Planning Writer、Full Stack Coder、Bug Fixer、Git Operator 和 Code Reviewer；Planning 可调用 File Explorer、Planning Writer、Task Planner 和 Git Operator。Bug Fixer 只处理可复现 bug 和用户明确批准的当前 blocking finding IDs，并可调用 File Explorer、Git Operator、Researcher 与 Document Maintainer。Code Reviewer 再调用 Review Standards 与 Review Spec。Git 操作由 Git Operator 串行执行。

### Planning 产物

Planning 通过问询确认目标和关键决策，写入配对工件：

```text
.ai-work-flow/plans/<plan-id>/spec.md
.ai-work-flow/plans/<plan-id>/plan.md
```

`spec.md` 是唯一需求事实来源，固定为 `approved`；`plan.md` 固定为 `ready-for-implementation`，并绑定 spec 原始完整字节的 SHA-256。确认计划后可继续拆分为 `tasks/NN-short-name.md`，每个 task 绑定当前 plan 原始完整字节摘要。没有 `tasks/` 是单任务模式；存在且全部合法的任务文件是拆分模式；空目录、摘要失效或部分替换都会阻塞实施。Planning 只生成规划工件，不实施代码。

这是 breaking change。旧 `.ai-work-flow/plans/<plan-id>.md` 平铺计划和缺少有效 `spec.md` 的 plan-only 目录不会迁移、兼容或反向生成规格，Coding 必须拒绝消费；历史文件可保留，但不能进入正常实施。

### 普通实施

确认方案后，流程按 **Git Operator prepare -> Full Stack Coder -> Git Operator commit/sync -> Coding 委派 File Explorer prepare ReviewManifest -> Code Reviewer -> Review Standards + Review Spec -> Git Operator integrate/cleanup** 执行。实现和评审在同一个隔离 worktree 中进行；实现完成并通过验证后创建仅本地 review commit，Code Reviewer 只审查已提交的固定范围。

拆分计划按 `blocked_by` 形成依赖前沿。每个 task 独立实现、提交和双轴评审，Git Operator 按编号顺序汇入 feature；全部 task 完成后进行一次聚合评审。评审覆盖完整、无阻塞 finding 且 `main` 未前进时自动使用 `git merge --ff-only` 整合；存在阻塞 finding 时进入下一段所述的用户决策门禁。

评审出现阻塞 finding 时，只修复用户确认的 finding IDs。修复提交必须晚于原 `review_commit` 且等于当前 feature 或 task HEAD；重新同步并验证前置条件后，普通目录式流程自动汇入 task 或执行最终整合与清理，不执行第二次评审，也不再询问是否继续。

### Spec/Ticket canonical runtime

`run-matt-spec-to-completion` 是 Spec/Ticket 执行入口，消费 `to-spec` 和 `to-tickets` 生成的产物。输入必须是：

```text
<target-project>/.scratch/<featureSlug>/spec.md
```

同目录必须有 `issues/NN-<slug>.md`。`run-matt-spec-to-completion` Skill 还会在委派前检查项目中的 `docs/agents/issue-tracker.md`；这是 Skill 前置条件，不是 `execution-cli.mjs` 的 schema 校验。Canonical runtime 位于：

```sh
runtime="${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/execution-runtime/execution-cli.mjs"
```

`execution-runtime/` 是生产所有权边界：`lib/*.mjs`、`review-manifest-cli.mjs`、四个 schemas、`package.json` 和锁文件一并安装。Skill 只保留编排说明、references、私有 scripts 和测试，不提供旧 lib 或 CLI 转发路径。

初始化、认领 Ticket、记录交接、同步、评审和整合均通过 runtime 完成，例如：

```sh
node "$runtime" prepare --repository <repo> --branch ai-work-flow/<feature> \
  --spec <repo>/.scratch/<feature>/spec.md --worktree <repo>/.worktrees/<feature>
node "$runtime" claim --repository <repo> --feature <feature> \
  --role-id <role> --session-id <session> --worktree <repo>/.worktrees/<feature>
node "$runtime" record-ticket --repository <repo> --feature <feature> \
  --worktree <repo>/.worktrees/<feature> < handoff.json
```

Ticket 终态通过带 claim identity 的 JSON Handoff 写入；裸 Completion Result 不是 runtime 输入。全部 Ticket 完成后，runtime 记录精确的 `main_commit`，处理同步冲突，再冻结包含提交端点、来源、分片和 digest 的 ReviewManifest。开始评审时必须显式提供 Spec 状态和已提交的 standards source；自动流程使用冻结 `review_commit` 中的 `CONTEXT.md`。评审结果必须覆盖 Standards 与 Spec 两个轴；阻塞 finding 只能由用户确认具体 ID 后修复。

Runtime 中的修复完成后，`complete-review-fix` 将执行状态恢复到同步与最终评审阶段；最终评审仍有阻塞 finding 时再次等待用户，不自动继续修复。

### Spec/Ticket 跨会话恢复

Checkpoint 只接受当前格式；旧字段、旧绝对路径或未知格式不会迁移、兼容或降级恢复。恢复前必须验证 Checkpoint integrity：执行计划 revision、canonical 路径、baseline、branch/worktree、Ticket 条目及各 Ticket 提交都必须与 Git 事实一致。`invalid` 时停止并报告精确 diagnostics，不猜测、不降级、不重派已完成 Ticket。

有效 Checkpoint 按状态继续：`executing` 从最低未完成 Ticket 继续，`reviewing` 进入冻结 manifest 评审或等待用户决定，`fixing` 等待追加修复提交。`integrating` 还需检查 review decision：已有 fix decision/commit 时先同步并执行最终评审，最终评审通过后才整合和清理；`complete` 只报告结果。runtime 没有 Ticket reclaim/reset 命令；存在 `in_progress` Ticket 时保留现场并停止，不会自动重派。

## 角色与 Skills

### 角色

| 角色 | 职责边界 |
| --- | --- |
| Coding | 按唯一状态表路由、等待、验证交接并自动推进人工门禁之间的步骤 |
| Planning | 问询、确认并按 spec-first 状态机生成规格与计划，不实施代码 |
| File Explorer | 读取导航索引并在必要时聚焦发现入口与直接依赖 |
| Researcher | 只读取外部官方来源，并写入 `.ai-work-flow/research/<topic>.md` |
| Document Maintainer | 只维护 README、docs 等普通文档 |
| Planning Writer | 单次完整写入一个目录式 spec 或 plan |
| Task Planner | 将已确认计划拆分为可跟踪任务 |
| Full Stack Coder | 实现源码、测试、必要配置，并随实现维护代码导航索引 |
| Bug Fixer | 受限修复可复现 bug 或获批 blocking finding；Codex `gpt-5.6-luna`/`max`，OpenCode `baibai/gpt-5.6-luna`/`max`，Claude `sonnet`/`high` |
| Git Operator | 受控执行 Git 工作流 |
| Code Reviewer | 编排 Standards + Spec 双轴评审 |
| Review Standards / Review Spec | 分别执行标准与规范评审 |

### Skills

| Skill | 入口 | 输入 | 结果 |
| --- | --- | --- | --- |
| `run-matt-spec-to-completion` | `$run-matt-spec-to-completion` | canonical Spec、Tickets 和项目 issue tracker | 实施、评审、整合及执行记录 |
| `generate-ai-work-flow-agents` | `$generate-ai-work-flow-agents` | 已修改的环境配置，可选平台范围 | 校验并重新生成指定平台 agents |
| `switch-ai-work-flow-env` | `$switch-ai-work-flow-env` | 已存在的环境名称 | 事务式切换环境并重新生成受管理 agents |
| `project-code-navigation` | `$project-code-navigation` | 当前项目代码结构 | 维护 `.ai-work-flow/index/` 导航索引 |
| `git-commit` | `$git-commit` | Full Stack Coder 的结构化交接 | 创建仅本地、路径范围精确的实现提交 |

## 平台能力边界

角色模板中的权限和职责是工作流契约，但三平台不能统一强制所有边界。`agent-build/config/controls.json` 定义稳定控制 ID、单条约束和可映射的 Policy 要求，`roles.json` 按角色声明控制项。安装、生成和 `env status` 保留每个平台/角色的 `CAPABILITY` matrix，并在其后输出 `CONTROL` matrix；`WARNING CONTROL` 汇总所有未达到 `enforced` 的控制项。级别含义如下：

| 级别 | 含义 |
| --- | --- |
| `enforced` | 生成器能通过该平台的权限或沙箱配置强制 |
| `instruction-only` | 只能依赖 agent 指令遵守，平台没有等价强制能力 |
| `unsupported` | 当前平台 adapter 无法表达或证明该约束 |

关键差异：Codex 只对允许读取/写入的文件系统模式提供部分沙箱强制；Claude Code 的文件系统边界是 `instruction-only`；OpenCode 能强制文件系统、是否允许委派，以及 Researcher 的报告路径类别，但不能按一次委派动态限制 Writer 只能写 spec 或 plan，也通常不能限制具体委派目标。控制项包含多个 capability 时采用最弱级别，顺序为 `unsupported < instruction-only < enforced`；没有平台能力映射的语义控制固定为 `instruction-only`。阶段顺序、单目标写入和用户确认仍是 `instruction-only`。三平台的 shell、Git 和委派目标多为 `instruction-only`，network/browser 约束均为 `unsupported`。因此这些角色边界不能视为统一安全沙箱，运行高风险任务前应检查 `env status` 的 capability 与 control 警告。

## 安全与一致性

- 安装、环境切换和生成使用事务计划；普通异常会立即回滚。进程中断可能暂留 transaction journal 和部分状态，下一次非 dry-run 安装、生成或环境切换会先验证并恢复；非法或身份不明的 journal 会保留现场并阻塞。
- 同一 feature 的 mutating runtime command 使用跨进程 feature lock，Checkpoint 由 state store 唯一写入。并发 mutation 不排队而是立即失败；死亡进程留下的失效锁可恢复，仍活动或无法确认的锁会阻塞。
- Checkpoint integrity 不通过时停止；恢复不会猜测路径、迁移旧绝对路径或重派未确认已停止的任务。
- 评审只针对固定 `fixed-point` 与 `review-commit` 的 committed diff；两个评审轴共享同一 ReviewManifest、digest、提交范围和分片清单。
- 阻塞 finding 只能通过用户确认的 finding IDs 进入修复；修复必须产生晚于已评审提交的新提交，后续评审行为由对应的普通实施或 Runtime 契约决定。
- 整合前要求 feature worktree 干净、提交端点精确匹配且 `main` 未前进；主工作树中的未知改动默认阻塞。Spec/Ticket runtime 允许当前 execution records，并只在显式 `--allow-stash true` 授权后暂存其他改动；默认使用 `git merge --ff-only`。
- 升级安装只迁移明确支持的缺失角色和旧角色 ID；已有角色字段残缺时停止，不静默修复。
- 浏览器自动化、E2E 测试或视觉验证只有在当前请求明确要求且平台提供相应工具时才允许；既有测试配置不构成授权。交接读取只能使用用户或上游交接的精确路径及其直接依赖。
- 子代理使用统一的 `{status,summary,artifacts,checks,details,blocking_reason?}` JSON handoff；canonical Ticket 仍使用 runtime schema，不与通用 handoff 格式合并。

## 开发验证

```sh
npm test
node agent-build/install.mjs validate
npm test --prefix skills/run-matt-spec-to-completion
npm run check:runtime --prefix skills/run-matt-spec-to-completion
```

`run-matt-spec-to-completion` package 只承载 Skill 私有测试与检查入口。生产依赖由 `execution-runtime/package.json` 和锁文件拥有；`check:runtime` 加载该 runtime 的 schema 验证器，依赖缺失时在 runtime 目录按锁文件自动执行生产依赖安装，仍失败则停止 Spec/Ticket 执行。
