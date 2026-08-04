# 项目上下文

## 领域术语

- **Managed content**：平台生成模块明确负责生成和更新的内容。
- **User content**：用户自行维护且平台生成模块不得改写的内容，即使其位于同一平台文件中。
- **Asset catalog**：生成所需角色资产的一致性目录；目录不完整或不一致时，生成必须在任何平台写入前停止。
- **ReviewManifest**：普通目录式 Coding 审查使用的不可变清单，冻结提交端点、PathChange、来源、分片、检查与摘要。
- **Capability level**：平台能力矩阵的真实级别；只有平台实际强制的约束标为 `enforced`，其余明确标为 `instruction-only` 或 `unsupported`。
- **Transaction log**：环境生成和切换的持久化恢复输入；恢复前必须按受信根、target、backup、类型和符号链接策略完整验证。非法或身份不明的日志保留现场并停止，不作为可执行指令。

## 仓库约束

- 本仓库使用 Node.js ESM；测试入口为 `npm test`，代理资产还需通过 `node agent-build/install.mjs validate` 校验。
- `skills/` 下含 `SKILL.md` 的目录由完整安装自动分发至 Codex、Claude Code 和 OpenCode；`agent-build install.mjs init` 只初始化全局配置与路由。
- 受管理内容可由生成流程更新；受管理片段之外的用户内容必须保留。项目级 `MEMORY.md` 不使用 managed marker。
- 根 `MEMORY.md` 是目录式 ReviewManifest 的提交绑定 standards source，必须与相关实现和导航索引一同提交并持续维护。

## 职责

- `agent-build/` 负责全局配置、角色资产、Skills 和平台代理的安装、生成与校验。
- `execution-runtime/` 负责 ReviewManifest、Git 路径事实和 runtime provenance 的共享执行逻辑。
- `skills/` 提供三平台共享的用户入口；项目上下文与代码导航初始化、后续导航维护由不同 Skill 分工。
- `test/` 使用 Node 测试运行器验证资产契约、安装事务、三平台生成和 ReviewManifest 行为。

## 模块边界

| 模块 | 边界 |
| --- | --- |
| `agent-build/config/`、`agent-build/templates/` | 定义角色、控制、策略、路由和角色正文，不承载项目级上下文。 |
| `agent-build/runtime/` | 读取仓库资产并规划全局写入；不负责创建项目根 `MEMORY.md` 或项目导航索引。 |
| `execution-runtime/` | 提供提交绑定的审查清单与路径验证，不生成项目业务资料。 |
| `skills/init-ai-work-flow/` | 联合初始化项目根 `MEMORY.md` 与 `.ai-work-flow/index/`。 |
| `skills/project-code-navigation/` | 使用和持续维护既有项目导航，保持 File Explorer 只读定位与 Full Stack Coder 随实现维护的边界。 |
