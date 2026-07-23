---
name: switch-ai-work-flow-env
description: 切换 AI Work Flow 环境预设并重新生成代理。当用户要求切换环境、切换预设、或提到"切换到 xxx 环境"时使用。
---

# 切换 AI Work Flow 环境

基础配置为 `~/.config/ai-work-flow/environments/default.json`；环境预设存储在 `~/.config/ai-work-flow/environments/` 目录下，只需写差异字段，系统会深合并到基础配置。设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/` 目录。本技能绝不在当前项目写入 `.ai-work-flow`、`.codex`、`.claude`、`.opencode`、`AGENTS.md` 或 `CLAUDE.md`。

1. 定位 `~/.config/ai-work-flow/agent-workflow.mjs`；设置 `XDG_CONFIG_HOME` 时，使用 `$XDG_CONFIG_HOME/ai-work-flow/agent-workflow.mjs`。
2. 运行 `node "<该脚本路径>" env` 查看可用环境列表，确认目标环境存在。
3. 运行 `node "<该脚本路径>" env use <环境名>` 切换到目标环境；切换到默认配置时使用 `env use default`。
4. 运行 `node "<该脚本路径>" validate` 验证合并后的配置。验证失败时停止并报告错误，不生成 agents。
5. 运行 `node "<该脚本路径>" generate` 重新生成所有平台的代理。用户明确指定平台时，改用 `--platform codex`、`--platform claude`、`--platform opencode` 或逗号分隔组合。
6. 报告切换结果和更新的代理文件，并提醒用户新会话才会读取生成后的代理。
