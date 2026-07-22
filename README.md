# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成同一套专职代理工作流的技能库。**Coordinator** 是唯一面向用户的入口，只负责路由、等待和汇总；它不读写工作区、不运行 Shell，也不实施变更。

## 角色

| 角色 | 职责 | 默认档位 |
| --- | --- | --- |
| **Coordinator** | 调度、等待和汇总 | 平衡 |
| **File Explorer** | 全库枚举、搜索和代码地图 | 快速 |
| **Researcher** | 外部官方资料与依赖研究 | 平衡 |
| **Document Maintainer** | README、`docs` 等常规文档 | 快速 |
| **Planning Writer** | 计划、任务、ADR、交接和 tracker 文案 | 高级 |
| **Full Stack Coder** | 源码、测试、必要配置、调试和提交 | 高级 |
| **Code Reviewer** | 在稳定差异上汇总双轴评审 | 高级 |
| **Review Standards** / **Review Spec** | **Code Reviewer** 并行启动的内部审查器 | 高级 |

**File Explorer** 独占全库发现，**Researcher** 不访问本地工作区。写入者串行执行，完成时报告 `git diff --name-only`。**Code Reviewer** 仅能并行启动 **Review Standards** 和 **Review Spec** 两条评审线；修复后由 **Coordinator** 重新派发评审。

## 全局安装

在本仓库根目录执行一次：

```sh
node scripts/install.mjs
```

安装命令会将全部 `skills/*` 同步到 `~/.codex/skills`、`~/.claude/skills` 和 `~/.config/opencode/skills`，只覆盖同名的 AI Work Flow Skill。它同时初始化 `~/.config/ai-work-flow/config.json` 与 `routing.md`，并生成 9 个受管理 agents 到 `~/.codex/agents`、`~/.claude/agents` 和 `~/.config/opencode/agents`。设置 `XDG_CONFIG_HOME` 时，后两类配置根改为 `$XDG_CONFIG_HOME`。

安装保留无关的全局 Skills、agents 和工具配置。它会把 Codex 的 `agents.max_depth` 提升到至少 `2`，更新 Codex/Claude 全局指令文件中的受管理路由块，并在 OpenCode 配置中设定 `default_agent: "coordinator"`；旧的 `agent.explore: false` 会被移除。

在任意项目中调用 `$setup-matt-pocock-skills`，只会完成项目的 issue tracker 和领域文档设置。全局 Skills、配置和受管理 agents 的安装与持久化由 `scripts/install.mjs` 负责。

## 模型配置

唯一可编辑配置为 `~/.config/ai-work-flow/config.json`（或 `$XDG_CONFIG_HOME/ai-work-flow/config.json`）。首次安装时由内置默认值创建，不再生成或读取 `config.local.json`。更新模型、推理强度或 OpenCode 原生选项后，调用 `$regenerate-ai-work-flow`；它会先验证配置，再重新生成全局 agents。

新会话会读取重新生成后的 agents。

- Codex：File Explorer 和 Document Maintainer 默认 `gpt-5.6-terra`；研究、计划、实现和评审默认 `gpt-5.6`。
- Claude Code：轻量角色默认 `haiku`，研究、实现和评审默认 `sonnet`，Planning Writer 默认 `opus`。
- OpenCode：默认继承主会话模型。请在本地覆盖中使用实际启用的 `provider/model`，并按提供方配置原生 `variant` 或 `options`。

OpenCode 没有通用推理档位映射，因此 `validate` 会对继承模型或缺少原生 `variant/options` 的角色发出明确警告。这是提示，不会阻止生成。

输出路径为 `~/.codex/agents/*.toml`、`~/.claude/agents/*.md` 和 `~/.config/opencode/agents/*.md`。Codex 根配置允许 Reviewer 启动两层内部评审；Claude 仅授权 Reviewer 分派两条评审线；OpenCode Coordinator 作为无文件权限的 primary agent 运行。

## 验证

```sh
npm test
```

测试覆盖全局安装、统一配置、非法推理值、OpenCode 警告、三端生成、用户文件保留，以及 `--dry-run` 不写文件。
