# AI Work Flow

为 Codex、Claude Code 和 OpenCode 生成统一专职代理工作流的配置系统。安装后，**Coordinator** 是唯一面向用户的入口，负责路由、等待和汇总；实际的发现、研究、写作、实现和评审由专职角色完成。

与上游 [Matt Pocock Skills](https://github.com/mattpocock/skills) 配合使用，AI Work Flow 仅提供 Coordinator 路由层和执行引擎，不复制上游技能。

## 前置条件

- Node.js 运行环境
- 已安装并配置 Codex、Claude Code 或 OpenCode 中至少一个客户端
- 当前用户对对应全局配置目录具有读写权限
- 已安装 Matt Pocock Skills（提供 `to-spec`、`to-tickets`、`implement`、`code-review` 等技能）

## 安装

在仓库根目录执行：

```sh
node scripts/install.mjs
```

安装会完成以下工作：

- 将自定义技能（`run-matt-spec-to-completion`、`generate-ai-work-flow-agents`）同步到 Codex、Claude Code 和 OpenCode 的全局 Skills 目录
- 创建 `~/.config/ai-work-flow/config.json` 和 `routing.md`
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

唯一需要编辑的文件是：

```text
~/.config/ai-work-flow/config.json
```

设置 `XDG_CONFIG_HOME` 后，路径会变为 `$XDG_CONFIG_HOME/ai-work-flow/config.json`。配置按角色和平台组织，例如：

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

修改配置后，调用唯一的更新入口 `$generate-ai-work-flow-agents`：

```text
$generate-ai-work-flow-agents
```

该 Skill 会定位已安装的运行时，先执行 `validate`，验证通过后再执行 `generate`。需要限定平台时，在调用中明确指定 Codex、Claude Code、OpenCode，或它们的组合。生成完成后，新会话才会读取更新后的 agents。

OpenCode 对继承主会话模型或未设置原生 `variant/options` 的角色会输出警告，但不会阻止生成。

## 生成位置

- Codex：`~/.codex/agents/*.toml`
- Claude Code：`~/.claude/agents/*.md`
- OpenCode：`~/.config/opencode/agents/*.md`
- 共享运行时和配置：`~/.config/ai-work-flow/`

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

## 开发验证

```sh
npm test
```
