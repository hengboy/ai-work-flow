# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成统一专职代理工作流的配置系统。安装后，**Coordinator** 是唯一面向用户的入口，负责路由、等待和汇总；实际的发现、研究、写作、实现和评审由专职角色完成。

## 前置条件

- Node.js 运行环境
- 已安装并配置 Codex、Claude Code 或 OpenCode 中至少一个客户端
- 当前用户对对应全局配置目录具有读写权限

## 安装

在仓库根目录执行：

```sh
node scripts/install.mjs
```

安装会完成以下工作：

- 将自定义技能（`run-matt-spec-to-completion`、`generate-ai-work-flow-agents`）同步到 Codex、Claude Code 和 OpenCode 的全局 Skills 目录
- 创建并默认直接使用 `~/.config/ai-work-flow/environments/default.json` 和 `routing.md`；仓库中的 `scripts/agent-assets/default-config.json` 仅作为初始化模板
- 生成三端的 9 个受管理 agent
- 更新三端的路由配置，并将 OpenCode 默认 agent 设为 `coordinator`
- 保留无关的全局 Skills、agents 和工具配置

默认安装会处理全部平台。只生成指定平台的 agents 时，可以使用：

```sh
node scripts/install.mjs --platform codex
node scripts/install.mjs --platform claude,opencode
```

首次安装前想查看将要写入的路径，可使用：

```sh
node scripts/install.mjs --dry-run
```

## 命令

```sh
# 初始化配置和路由，不生成平台 agents
node scripts/install.mjs init

# 检查配置，不写入文件
node scripts/install.mjs validate

# 查看命令格式
node scripts/install.mjs --help
```

`install` 是完整流程：同步 Skills、初始化配置和路由、安装运行时文件，然后生成 agents。`init` 和 `validate` 适合安装或排查问题；配置更新后的 agents 重新生成应通过 `$generate-ai-work-flow-agents` 完成。

## 模型配置

默认环境配置需要编辑的文件是：

```text
~/.config/ai-work-flow/environments/default.json
```

设置 `XDG_CONFIG_HOME` 后，路径会变为 `$XDG_CONFIG_HOME/ai-work-flow/environments/default.json`。无 `.environment` 标记时直接使用默认环境；非默认环境由 `.environment` 指向 `environments/<name>.json`。环境文件只在 `roles` 的角色名层级与默认环境浅合并：环境中覆盖的角色对象整体替换默认环境同名角色，未覆盖的角色保留，不会递归合并平台或 `options`。被覆盖角色必须提供完整的 `codex`、`claude`、`opencode` 配置及必需字段，因此环境文件不能只写差异字段。配置按角色和平台组织，例如：

```json
{
  "version": 1,
  "roles": {
    "coordinator": {
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
node scripts/install.mjs env use <name>
```

非默认环境由 `.environment` 标记选择。`env use default` 通过删除该标记选择默认环境；无标记时已使用默认环境。该命令不会验证或生成 agents，切换后需另行执行验证和生成，或调用 `$generate-ai-work-flow-agents`。

## 生成位置

- Codex：`~/.codex/agents/*.toml`
- Claude Code：`~/.claude/agents/*.md`
- OpenCode：`$XDG_CONFIG_HOME/opencode/agents/*.md`（未设置时为 `~/.config/opencode/agents/*.md`）
- 共享运行时和配置：`$XDG_CONFIG_HOME/ai-work-flow/`（未设置时为 `~/.config/ai-work-flow/`）

生成器只更新 AI Work Flow 管理的文件和配置片段，不覆盖其他全局 agent 或工具设置。

## 角色

| 角色 | 用途 |
| --- | --- |
| **Coordinator** | 路由、等待和汇总 |
| **File Explorer** | 全库枚举、搜索和代码地图 |
| **Researcher** | 外部官方资料与依赖研究 |
| **Document Maintainer** | README、`docs` 等常规文档 |
| **Planning Writer** | 计划、任务、ADR、交接和 tracker 文案 |
| **Full Stack Coder** | 源码、测试、必要配置和调试 |
| **Code Reviewer** | 汇总标准与需求双轴评审 |
| **Review Standards** / **Review Spec** | Code Reviewer 使用的内部评审角色 |

在任意项目中调用 `$setup-matt-pocock-skills`，只会初始化该项目的 issue tracker 和领域文档；全局 Skills、配置和 agents 由本仓库的安装器维护。

## Skills

本仓库提供以下技能：

### `$run-matt-spec-to-completion`

执行由 `to-spec` 和 `to-tickets` 写入的 Spec 和 Ticket，完成实施、评审并合并到 `main`。这是唯一的执行入口，编排现有模块完成完整生命周期：

1. **初始化** — 解析 spec.md，推导 feature slug，创建 worktree，物化执行计划
2. **恢复** — 从已有 Checkpoint 验证并续接执行
3. **执行** — 逐个执行 Ticket Frontier，委派专职角色实施
4. **评审与整合** — 完成 Standards + Spec 双轴评审、用户确认修复、最终提交

前置条件：Spec 目录须包含 `spec.md` 和 `issues/NN-*.md`，且项目已运行 `setup-matt-pocock-skills`。

### `$generate-ai-work-flow-agents`

验证全局配置并重新生成 Codex、Claude Code、OpenCode agents。默认环境修改 `$XDG_CONFIG_HOME/ai-work-flow/environments/default.json`（未设置时为 `~/.config/ai-work-flow/environments/default.json`）后，或修改非默认环境对应的 `environments/<name>.json` 后，调用此技能使配置生效。切换环境后也需要重新生成 agents：

1. 定位 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`（未设置时为 `~/.config/ai-work-flow/agent-workflow.mjs`）
2. 运行 `validate`，验证失败则停止
3. 运行 `generate`（可按 `--platform` 限定平台）
4. 报告更新的文件，提醒用户新会话才读取更新后的 agents

## 与 Matt Pocock Skills 的关系

`run-matt-spec-to-completion` 最初基于 [Matt Pocock Skills](https://github.com/mattpocock/skills)（基线 `ed37663`）的 `to-spec`/`to-tickets` 产物格式设计。当前本仓库已独立维护，不再与上游同步更新，但产物格式仍保持兼容。

上游提供的技能（`to-spec`、`to-tickets`、`implement`、`code-review`、`ask-matt`、`setup-matt-pocock-skills` 等）作为独立依赖安装。AI Work Flow 仅提供：

- **Coordinator 路由层**：`routing.md` + 9 角色 Agent 定义
- **执行引擎**：`run-matt-spec-to-completion`（适配 `to-spec`/`to-tickets` 产物）
- **配置管理**：`generate-ai-work-flow-agents` + `agent-workflow.mjs`

如需更新上游兼容性，确认 `run-matt-spec-to-completion` 与目标版本 `to-spec`/`to-tickets` 产物格式兼容后，重新运行结构、命名及工件边界验证。

## 开发验证

```sh
npm test
```
