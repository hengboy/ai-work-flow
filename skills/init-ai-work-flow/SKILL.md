---
name: init-ai-work-flow
description: 为当前项目联合初始化根 MEMORY.md、.ai-work-flow/index/ 代码导航及其在 CLAUDE.md、AGENTS.md 中的维护约束。首次在项目使用代码导航，或首次进入目录式 ReviewManifest 审查前使用。
---

# 初始化 AI Work Flow

## 触发场景

- 首次在当前项目使用 `$project-code-navigation`。
- 首次进入目录式 ReviewManifest 审查，尚未建立提交绑定的项目 standards source。
- 根 `MEMORY.md` 或 `.ai-work-flow/index/feature-navigation.md` 缺失，需要基于真实仓库资料联合初始化。

本 Skill 是项目级联合初始化入口，不是 `agent-build install.mjs init`；后者只负责全局配置和路由初始化。不要添加 managed marker，也不要生成项目初始化 runtime。

## 初始化流程

1. 先读取真实仓库资料，包括项目指令、README、构建文件、目录结构和已确认入口；未知路径的发现保持 `$project-code-navigation` 规定的 File Explorer/Full Stack Coder 边界。
2. 先检查项目根 `MEMORY.md`。不存在时创建以下最小结构，内容必须来自已确认的仓库事实；无法确认的内容标为 `待确认` 或向用户提出问题：

   ```markdown
   # 项目上下文

   ## 领域术语

   ## 仓库约束

   ## 职责

   ## 模块边界
   ```

3. `MEMORY.md` 已存在时，不得覆盖或重排任何已有用户内容；只在适合的位置补充缺失的 `# 项目上下文`、`## 领域术语`、`## 仓库约束`、`## 职责`、`## 模块边界`，并保留原文。补充内容仍须基于真实仓库资料，无法确认则标为 `待确认` 或提出问题。
4. 随后初始化 `.ai-work-flow/index/feature-navigation.md`，记录真实功能关键词、入口路径和模块边界；只在项目真实存在对应层时创建 `frontend-navigation.md` 或 `backend-navigation.md`。
5. 检查项目根 `CLAUDE.md` 和 `AGENTS.md`。文件不存在时创建；文件已存在时保留全部已有内容，并在未包含同名章节时追加以下约束段落。重复执行不得重复追加或重排已有内容：

   ```markdown
   ## AI Work Flow 维护约束

   - 职责或模块边界变化时，必须在同一轮改动中同步维护根 `MEMORY.md`。
   - 文件入口、路由、API，或文件的新增、移动、重命名、拆分、合并、删除及主职责变化时，必须在同一轮改动中同步维护 `.ai-work-flow/index/` 下的对应导航索引。
   - `MEMORY.md`、导航索引与相关实现必须纳入同一提交范围。
   ```

6. 验证索引中的非计划路径真实存在，检查 `MEMORY.md` 五个章节齐全，并确认 `CLAUDE.md`、`AGENTS.md` 各包含一份上述维护约束。不得猜测入口、职责或边界。
7. `MEMORY.md` 是目录式 ReviewManifest 与提交绑定的 standards source，必须与索引一起提交。职责、模块边界、文件入口、路由或 API 变化时，必须在同一轮改动中同步维护 `MEMORY.md` 和对应索引。

## 成功标准

- 根 `MEMORY.md` 包含项目上下文、领域术语、仓库约束、职责和模块边界五个章节，已有用户内容未被覆盖或重排。
- `.ai-work-flow/index/feature-navigation.md` 已创建且只记录已验证的仓库事实；frontend/backend 索引只在对应层真实存在时创建。
- 根 `CLAUDE.md` 和 `AGENTS.md` 各包含一份 `AI Work Flow 维护约束`，已有用户内容未被覆盖、重排或重复追加。
- 所有新增或修改文件已纳入同一提交范围，`MEMORY.md` 可作为 ReviewManifest 的提交绑定 standards source。
- 没有 managed marker、项目初始化 runtime 或对 `agent-build install.mjs init` 职责的改动。

## 回复格式

- **结果：** 说明联合初始化是否完成。
- **更新：** 列出创建或补充的上下文章节、索引与项目指令文件。
- **验证：** 说明已核对的仓库资料、路径和提交范围。
- **阻塞：** 列出待确认事实或需要用户回答的问题。
