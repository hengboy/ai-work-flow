| 功能/关键词 | 入口路径 | 模块边界 |
| --- | --- | --- |
| 安装、生成、环境管理 | `agent-build/install.mjs` -> `agent-build/runtime/workflow.mjs` | 事务式安装配置、contract、Skills 和三平台 Agents；完整 install 清理历史仓库状态。 |
| Workflow 契约与公共结构 | `execution-runtime/workflow-contract.json`、`execution-runtime/task-result-schemas.json`、`execution-runtime/lib/workflow-contract.mjs` | 声明 action owner、单轮 review/fix/resolution 转换、`TaskResult` 字段与 JSON 类型，并校验 finding 分类、完整 blocking ID 集及三类 integration 证据。 |
| Agent 角色与七段 prompt 编译 | `agent-build/config/{roles,controls,policies}.json`、`agent-build/templates/*.md`、`agent-build/runtime/{asset-catalog,platform-adapter}.mjs` | **Planning**/**Coding** 只有 `Task`；Code Reviewer 并行聚合隔离双轴，Bug Fixer 批量修复 blocking，Git Operator 提交 resolution 并执行证据绑定整合。 |
| Skills 元数据与生成 | `agent-build/config/skills.json`、`agent-build/runtime/skill-catalog.mjs`、`agent-build/generate-skill-metadata.mjs` | 五个 Skills、frontmatter 和 `agents/openai.yaml` 的单一元数据来源与确定性校验。 |
| 项目上下文初始化 | `skills/init-ai-work-flow/SKILL.md`、`skills/init-ai-work-flow/references/project-context-contract.md`、`skills/init-ai-work-flow/scripts/validate-project-context.mjs` | 联合维护 MEMORY、导航和项目指令，验证章节唯一性与路径真实性。 |
| 代码导航 | `skills/project-code-navigation/SKILL.md`、`skills/project-code-navigation/references/*.md`、`skills/project-code-navigation/scripts/validate-navigation.mjs` | **File Explorer** 只读定位；**Full Stack Coder** 随入口或职责变化维护。 |
| Prompt 格式规范 | `docs/prompt-format.md` | 七段 Agent 接口、五段 Skill 接口、字符预算和直接内容交接规则。 |
| 接口测试 | `test/agent-assets.test.mjs`、`test/workflow-contract.test.mjs` | 覆盖 contract、finding 分类、review resolution 门禁、角色资产、无状态生成、旧配置清理和安装迁移。 |
