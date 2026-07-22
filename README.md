# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成同一套专职代理工作流的技能库。协调者是唯一面向用户的入口，只负责路由、等待和汇总；它不读写工作区、不运行 Shell，也不实施变更。

## 角色

| 角色 | 职责 | 默认档位 |
| --- | --- | --- |
| 协调者 | 调度、等待和汇总 | 平衡 |
| 文件探索员 | 全库枚举、搜索和代码地图 | 快速 |
| 研究员 | 外部官方资料与依赖研究 | 平衡 |
| 文档维护者 | README、`docs` 等常规文档 | 快速 |
| 计划撰写者 | 计划、任务、ADR、交接和 tracker 文案 | 高级 |
| 全栈开发者 | 源码、测试、必要配置、调试和提交 | 高级 |
| 代码审查者 | 在稳定差异上汇总双轴评审 | 高级 |
| 标准审查者 / 规范审查者 | 代码审查者并行启动的内部审查器 | 高级 |

文件探索员独占全库发现，研究员不访问本地工作区。写入者串行执行，完成时报告 `git diff --name-only`。代码审查者仅能并行启动标准审查和规范审查两条评审线；修复后由协调者重新派发评审。

## 通过 Skill 初始化

安装 `skills/setup-ai-work-flow` 后，在需要初始化的项目中调用：

```text
$setup-ai-work-flow 初始化当前项目的 Agent/Subagent
```

Skill 自带生成脚本、平台 formatter 和统一的角色主体模板，会以当前 Git 仓库根目录为目标，直接创建 `.ai-work-flow/agents/` 并生成各平台代理文件，不依赖本仓库路径。每个角色的主体只维护在 `assets/agents/bodies/` 中，生成时分别追加 Codex、Claude Code 和 OpenCode formatter。默认生成三套配置；也可在调用时明确只生成指定平台。

`.ai-work-flow/agents/` 包含可提交的 `config.json`、忽略的 `config.local.json` 示例和统一的 `routing.md`。将 `config.local.example.json` 复制为 `config.local.json` 后，可为个人环境覆盖每个角色的模型或 OpenCode 原生选项。

Skill 只维护自己的代理文件和 `AGENTS.md` / `CLAUDE.md` 标记块。它保留这些文件的无关内容，合并 `.codex/config.toml` 的 `agents.max_depth`（至少为 `2`），并在 `opencode.json` 中禁用原生 `explore`。已有 JSON 无法解析，或无法安全更新的 TOML/标记块，会明确失败并提示手工合并位置。

## 模型配置

配置按 Skill 内置默认值 -> 目标项目 `.ai-work-flow/agents/config.json` -> 未提交的 `config.local.json` 深度合并，后者优先。

- Codex：File Explorer 和 Document Maintainer 默认 `gpt-5.6-terra`；研究、计划、实现和评审默认 `gpt-5.6`。
- Claude Code：轻量角色默认 `haiku`，研究、实现和评审默认 `sonnet`，Planning Writer 默认 `opus`。
- OpenCode：默认继承主会话模型。请在本地覆盖中使用实际启用的 `provider/model`，并按提供方配置原生 `variant` 或 `options`。

OpenCode 没有通用推理档位映射，因此 `validate` 会对继承模型或缺少原生 `variant/options` 的角色发出明确警告。这是提示，不会阻止生成。

输出路径为 `.codex/agents/*.toml`、`.claude/agents/*.md` 和 `.opencode/agents/*.md`。Codex 根配置允许 Reviewer 启动两层内部评审；Claude 仅授权 Reviewer 分派两条评审线；OpenCode Coordinator 作为无文件权限的 primary agent 运行。

## 验证

```sh
npm test
```

测试覆盖配置深度合并和本地优先级、非法推理值、OpenCode 警告、三端生成、用户文件保留，以及 `--dry-run` 不写文件。
