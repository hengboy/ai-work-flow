---
name: generate-ai-work-flow-agents
description: 验证全局 AI Work Flow 配置并重新生成 Codex、Claude Code 或 OpenCode agents。用于修改 ~/.config/ai-work-flow/environments/default.json 后使模型、推理强度、OpenCode 模型或 variant 生效，或用户要求重新生成全局 agents 时使用。配置可能包含环境预设覆盖，validate 和 generate 会自动解析当前环境。
---

# 重新生成 AI Work Flow

基础配置为 `~/.config/ai-work-flow/environments/default.json`；环境预设存储在 `~/.config/ai-work-flow/environments/` 目录下，只需写差异字段，系统会深合并到基础配置。设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/` 目录。本技能绝不在当前项目写入 `.ai-work-flow`、`.codex`、`.claude`、`.opencode`、`AGENTS.md` 或 `CLAUDE.md`。

1. 定位 `~/.config/ai-work-flow/agent-workflow.mjs`；设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`。
2. 先运行 `node "<该脚本路径>" validate`。验证失败时停止并报告错误，不生成 agents。validate 会自动解析当前环境（如果有 `.environment` 标记文件）。
3. 默认运行 `node "<该脚本路径>" generate`。用户明确指定平台时，改用 `--platform codex`、`--platform claude`、`--platform opencode` 或逗号分隔组合。generate 会自动解析当前环境并合并配置。
4. 报告更新的全局文件，并提醒用户新会话才会读取生成后的 agents。
