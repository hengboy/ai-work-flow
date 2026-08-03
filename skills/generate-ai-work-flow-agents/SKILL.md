---
name: generate-ai-work-flow-agents
description: 验证全局 AI Work Flow 配置并重新生成 Codex、Claude Code 或 OpenCode agents。用于修改 ~/.config/ai-work-flow/environments/default.json 或环境预设后使模型、推理强度、OpenCode 模型或 variant 生效，或用户要求重新生成全局 agents 时使用。配置可能包含环境预设覆盖，validate 和 generate 会自动解析当前环境。
---

# 重新生成 AI Work Flow

## 目标

验证全局 AI Work Flow 配置，并重新生成 Codex、Claude Code 或 OpenCode 的 agents。

## 前置条件与约束

无 `.environment` 标记文件时，直接使用 `~/.config/ai-work-flow/environments/default.json`；非默认环境按 `role -> platform -> field` 合并，OpenCode 的 `options` 为整体替换。设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/` 目录。本技能绝不在当前项目写入 `.ai-work-flow`、`.codex`、`.claude`、`.opencode`、`AGENTS.md` 或 `CLAUDE.md`。

## 执行步骤

1. 定位 `~/.config/ai-work-flow/agent-workflow.mjs`；设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`。
2. 默认运行 `node "<该脚本路径>" validate`。用户明确指定单个平台时，直接运行一次对应的 `generate --platform <平台>`，由 CLI 按单平台字段校验。
3. 默认运行 `node "<该脚本路径>" generate`。用户明确指定平台时，使用 `--platform codex`、`--platform claude`、`--platform opencode` 或逗号分隔组合。
4. 报告更新的全局文件，并提醒用户新会话才会读取生成后的 agents。

预检成功后自动完成生成和结果校验，不再询问是否继续生成。只有 validate/generate 失败才停止。

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 说明验证和生成是否完成。
- **更新：** 列出更新的全局文件和目标平台。
- **注意：** 说明新会话才会读取生成后的 agents。
- **阻塞：** 说明验证失败或无法继续的原因。
