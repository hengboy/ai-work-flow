# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成同一套专职代理工作流的技能库。Coordinator 是唯一面向用户的入口，只负责路由、等待和汇总；它不读写工作区、不运行 Shell，也不实施变更。

## 角色

| 角色 | 职责 | 默认档位 |
| --- | --- | --- |
| Coordinator | 调度、等待和汇总 | 平衡 |
| File Explorer | 全库枚举、搜索和代码地图 | 快速 |
| Researcher | 外部官方资料与依赖研究 | 平衡 |
| Document Maintainer | README、`docs` 等常规文档 | 快速 |
| Planning Writer | 计划、任务、ADR、交接和 tracker 文案 | 高级 |
| Full-Stack Coder | 源码、测试、必要配置、调试和提交 | 高级 |
| Code Reviewer | 在稳定差异上汇总双轴评审 | 高级 |
| Review Standards / Spec | Reviewer 并行启动的内部评审器 | 高级 |

File Explorer 独占全库发现，Researcher 不访问本地工作区。写入者串行执行，完成时报告 `git diff --name-only`。Code Reviewer 仅能并行启动 Standards 和 Spec 两条评审线；修复后由 Coordinator 重新派发评审。

## 安装与生成

在本仓库根目录运行：

```sh
node scripts/agent-workflow.mjs init --target /path/to/project
node scripts/agent-workflow.mjs validate --target /path/to/project
node scripts/agent-workflow.mjs generate --target /path/to/project
```

`init` 创建目标项目的 `.ai-work-flow/agents/`：可提交的 `config.json`、忽略的 `config.local.json` 示例、以及统一的 `routing.md`。将 `config.local.example.json` 复制为 `config.local.json` 后，可为个人环境覆盖每个角色的模型或 OpenCode 原生选项。

```sh
node scripts/agent-workflow.mjs generate --target /path/to/project --platform codex,claude
node scripts/agent-workflow.mjs generate --target /path/to/project --dry-run
```

生成器只维护自己的代理文件和 `AGENTS.md` / `CLAUDE.md` 标记块。它保留这些文件的无关内容，合并 `.codex/config.toml` 的 `agents.max_depth`（至少为 `2`），并在 `opencode.json` 中禁用原生 `explore`。已有 JSON 无法解析，或无法安全更新的 TOML/标记块，会明确失败并提示手工合并位置。

## 模型配置

配置按 `agents/default-config.json` -> 目标项目 `.ai-work-flow/agents/config.json` -> 未提交的 `config.local.json` 深度合并，后者优先。

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
