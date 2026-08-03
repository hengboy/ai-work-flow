---
name: switch-ai-work-flow-env
description: 切换 AI Work Flow 环境预设并重新生成代理。当用户要求切换环境、切换预设、或提到"切换到 xxx 环境"时使用。
---

# 切换 AI Work Flow 环境

## 目标

切换 AI Work Flow 环境预设，并重新生成目标平台的 agents。

## 前置条件与约束

默认环境为 `~/.config/ai-work-flow/environments/default.json`；其他环境预设按 `role -> platform -> field` 与默认环境合并，OpenCode `options` 整体替换。设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/` 目录。本技能绝不在当前项目写入 `.ai-work-flow`、`.codex`、`.claude`、`.opencode`、`AGENTS.md` 或 `CLAUDE.md`。

## 执行步骤

1. 定位 `~/.config/ai-work-flow/agent-workflow.mjs`；设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`。
2. 运行 `node "<该脚本路径>" env` 查看可用环境列表，确认目标环境存在。
3. 运行 `node "<该脚本路径>" env use <环境名>` 切换到目标环境；切换到默认配置时使用 `env use default`。
4. `env use` 已事务化验证并生成受管 agents；不得在其后重复 `validate` 或 `generate`。
5. 报告切换结果和更新的代理文件，并提醒用户新会话才会读取生成后的代理。

目标存在且预检成功后自动完成事务式切换、生成和结果校验，不再询问是否继续切换。

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 说明目标环境和切换结果。
- **更新：** 列出重新生成的 agents 和目标平台。
- **注意：** 说明新会话才会读取生成后的 agents。
- **阻塞：** 说明环境不存在、配置无效或无法继续的原因。
