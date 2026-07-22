---
name: setup-ai-work-flow
description: 在当前项目中直接初始化 AI Work Flow 的 Agent/Subagent，并配置问题跟踪器、分类标签词汇表和领域文档布局。用于首次安装工作流、重新生成 Codex/Claude Code/OpenCode 代理配置，或更换项目跟踪器与领域文档布局。
---

## 专职代理路由

本技能由 **协调者** 路由。协调者只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **文件探索员**；外部一手资料交给 **研究员**；普通文档交给 **文档维护者**；计划、任务、ADR、交接和跟踪器文本交给 **计划撰写者**；源码、测试、配置、调试和提交交给 **全栈开发者**；稳定差异的双轴评审交给 **代码审查者**。除文件探索员外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `.ai-work-flow/agents/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由协调者执行。

# 设置 AI 工作流技能

直接初始化工程技能所依赖的每个仓库：

- **专职代理** — 为 Codex、Claude Code 和 OpenCode 生成 Agent/Subagent 配置
- **问题跟踪器** — 问题存放的位置（默认为 GitHub；本地 Markdown 也开箱即用）
- **分类标签** — 用于五个标准分类角色的字符串
- **领域文档** — `CONTEXT.md` 和 ADR 的存放位置，以及阅读这些文档的消费规则

代理初始化使用本技能内置的确定性脚本。脚本读取 `assets/agents/bodies/` 中统一维护的角色主体模板，再追加各平台 formatter；问题跟踪器和领域文档配置仍由提示驱动。先生成代理配置，再探索项目、展示发现并与用户确认其余设置。

## 流程

### 0. 初始化专职代理

将当前 Git 仓库根目录作为目标项目；若当前目录不在 Git 仓库中，则使用当前工作目录。用户明确指定其他目标时才覆盖该路径。

定位本 `SKILL.md` 所在的技能目录，然后执行：

```sh
node "<技能目录>/scripts/agent-workflow.mjs" setup --target "<项目根目录>"
```

默认生成 Codex、Claude Code 和 OpenCode 三套配置。仅当用户明确限制平台时，追加 `--platform codex`、`--platform claude`、`--platform opencode` 或逗号分隔组合。

该命令可重复执行：保留目标项目已有配置和 `AGENTS.md` / `CLAUDE.md` 的无关内容，只更新受管理的代理文件与标记区块。命令失败时停止，不要手工重写部分生成结果；报告脚本给出的具体冲突位置。

若用户只要求初始化 Agent/Subagent，完成本步骤后直接进入“完成”。若用户要求完整设置 AI Work Flow，则继续以下流程。

### 1. 探索工程配置

查看当前仓库，了解其初始状态。阅读现有内容，不要假设：

- `git remote -v` 和 `.git/config` — 这是 GitHub 仓库吗？是哪一个？
- 仓库根目录下的 `AGENTS.md` 和 `CLAUDE.md` — 是否存在？其中是否已有 `## Agent skills` 部分？
- 仓库根目录下的 `CONTEXT.md` 和 `CONTEXT-MAP.md`
- `docs/adr/` 目录及任何 `src/*/docs/adr/` 子目录
- `docs/agents/` — 此技能的先前输出是否已存在？
- `.scratch/` — 表明本地 Markdown 问题跟踪约定已被采用
- 是否已安装 `triage` 技能？（与此技能并列的 `triage` 文件夹，或可用技能中包含 `triage`。）这决定了 B 节是否执行。
- 单体仓库信号 — 存在 `pnpm-workspace.yaml`、`package.json` 中的 `workspaces` 字段，或填充了带有各自 `src/` 的 `packages/*`。仅在真正大型的多包仓库中才会出现；若无这些迹象，则为单上下文仓库，几乎涵盖所有仓库。

### 2. 展示发现并提问

总结现有内容与缺失部分。然后按顺序处理各节——一节一个问题，再进入下一节。

每节开头给出推荐答案，方便用户直接接受。仅当选项确实有分歧时才提供简短说明；若探索已明确结论，则直接跳过该节（如未安装 `triage` 技能时跳过 B 节，无单体仓库时跳过 C 节）。

**A 节 — 问题跟踪器。**

> 解释：问题跟踪器是本仓库问题的存放位置。以问题为导向的技能，如 `triage`、`wayfinder` 和 `code-review`，会依据此配置查找或更新工作。请选择您实际用于跟踪工作的地点。

默认立场：这些技能专为 GitHub 设计。若 `git remote` 指向 GitHub，则建议使用 GitHub。若指向 GitLab（`gitlab.com` 或自托管实例），则建议使用 GitLab。否则（或用户偏好），可选择：

- **GitHub** — 问题存放在仓库的 GitHub Issues 中（使用 `gh` CLI）
- **GitLab** — 问题存放在仓库的 GitLab Issues 中（使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI）
- **本地 Markdown** — 问题以文件形式存放在本仓库的 `.scratch/<feature>/` 目录下（适用于个人项目或无远程仓库的仓库）
- **其他**（Jira、Linear 等）— 请用户用一段话描述其工作流程；技能将以自由文本记录下来

将所选方案记录在 `docs/agents/issue-tracker.md` 中。GitHub 和 GitLab 模板均带有“PR 作为请求入口”标志，默认为 **关闭** — 请保持关闭，无需开启；若用户希望将外部 PR 纳入分类队列，可在文件中稍后自行切换该标志。

**B 节 — 分类标签词汇表。** 若未安装 `triage` 技能（通过探索已知），则直接跳过本节——未安装的技能无需标签。

若已安装，则只提一个问题：

> 您是否希望保留默认的分类标签？（推荐：**是**）

默认标签为五个标准角色，每个标签的字符串与其名称一致：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。若用户选择“是”，则原样写入。仅当用户表示不使用默认标签（通常是因为其跟踪系统已采用其他名称，如 `bug:triage` 对应 `needs-triage`）时，才收集替代方案，以便 `triage` 使用现有标签而避免重复。

**C 节 — 领域文档。** 默认为 **单上下文** — 仓库根目录下的一份 `CONTEXT.md` + `docs/adr/`。这几乎适用于所有仓库，无需询问即可写入。

仅当探索发现单体仓库迹象时，才提供 **多上下文** 布局——根目录下的 `CONTEXT-MAP.md` 指向各上下文的 `CONTEXT.md` 文件。随后确认用户所需的具体布局。

### 3. 确认并编辑

向用户展示以下内容的草稿：

- 待添加到正在编辑的 `CLAUDE.md` 或 `AGENTS.md` 中的 `## Agent skills` 区块（选择规则见第 4 步）
- `docs/agents/issue-tracker.md`、`docs/agents/domain.md` 和 `docs/agents/triage-labels.md` 的内容（后一项仅在安装 `triage` 技能时包含）

允许用户在写入前进行编辑。

### 4. 写入

**选择要编辑的文件：**

- 若 `CLAUDE.md` 存在，则编辑之。
- 否则，若 `AGENTS.md` 存在，则编辑之。
- 若两者均不存在，则请用户决定创建哪一份——切勿代为选择。

切勿在已有 `CLAUDE.md` 时创建 `AGENTS.md`（反之亦然）——始终编辑已存在的文件。

若所选文件中已存在 `## Agent skills` 区块，则就地更新其内容，而非追加重复部分。不得覆盖用户对周边章节的修改。

区块内容如下：

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

仅当安装了 `triage` 技能且 B 节已执行时，才包含 `### Triage labels` 子区块，并写入 `docs/agents/triage-labels.md`。若未安装，则两者均省略。

随后，以本技能文件夹中的种子模板为起点，写入相关文档文件：

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub 问题跟踪器
- [issue-tracker-gitlab.md](./issue-tracker-gitlab.md) — GitLab 问题跟踪器
- [issue-tracker-local.md](./issue-tracker-local.md) — 本地 Markdown 问题跟踪器
- [triage-labels.md](./triage-labels.md) — 标签映射（仅在安装 `triage` 技能时）
- [domain.md](./domain.md) — 领域文档消费规则及布局

对于“其他”问题跟踪器，请根据用户的描述从零开始编写 `docs/agents/issue-tracker.md`。

### 5. 完成

告知用户设置已完成，并说明哪些工程技能将从此类文件中读取信息。同时提醒用户日后可直接编辑 `docs/agents/*.md` — 只有在需要更换问题跟踪器或从头开始时，才需重新运行本技能。
