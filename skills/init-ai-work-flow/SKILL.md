---
name: init-ai-work-flow
description: 项目首次使用代码导航或首次进入目录式审查时，联合初始化根 MEMORY.md、.ai-work-flow/index/ 和项目维护约束。
---

# 结果目标

基于真实仓库资料建立唯一项目上下文与可验证代码导航，不覆盖用户已有内容。

# 必要前置条件

- 当前目录是目标项目根，已读取项目指令、README、构建文件和已知入口。
- 合并规则与章节契约见 `references/project-context-contract.md`。

# 步骤

1. 识别项目形态、稳定术语、仓库约束、职责与模块边界。完成标准：每条内容有仓库事实来源。
2. 创建或补齐根 `MEMORY.md` 的契约章节。完成标准：原有用户内容保留，章节不重复。
3. 创建或补齐 `.ai-work-flow/index/feature-navigation.md`，仅在对应层存在时创建前端或后端索引。完成标准：表中非计划路径真实存在且相对项目根。
4. 在现有 `AGENTS.md`/`CLAUDE.md` 中补充维护约束。完成标准：同一约束只出现一次且 managed/user content 边界保持不变。
5. 运行 `node skills/init-ai-work-flow/scripts/validate-project-context.mjs <project-root>`。完成标准：检查通过。

# 条件分支

- 文件已存在：按 reference 合并缺失章节，不整体重写。
- 路径无法确认：省略或标为 `待确认`，不得猜测。

# 最终验收

MEMORY、索引和项目指令相互一致，验证脚本通过，所有职责与入口可追溯到真实文件。
