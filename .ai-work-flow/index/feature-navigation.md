| 功能/关键词 | 入口路径 | 模块边界 |
| --- | --- | --- |
| 安装、生成、环境管理 | `agent-build/install.mjs` -> `agent-build/runtime/workflow.mjs` | 事务式安装配置、runtime、Skills 和三平台 Agents；清理明确列出的旧受管理文件。 |
| Workflow 契约与公共结构 | `execution-runtime/workflow-contract.json`、`execution-runtime/lib/workflow-contract.mjs` | 唯一声明 workflow、phase、action owner、转换、预算、决策代码和结构校验。 |
| Run、claim、receipt、恢复与决策 | `execution-runtime/workflow-broker.mjs`、`execution-runtime/lib/workflow-broker.mjs` -> `execution-runtime/lib/workflow-store.mjs`；诊断入口 `execution-runtime/workflow-cli.mjs` | 三平台 Agents 通过窄 MCP 工具调用固定 operation；store 只在 Git common dir 持久化并保证原子、幂等与预算。 |
| Artifact、ReviewPacket 与 runtime identity | `execution-runtime/lib/artifact-store.mjs`、`execution-runtime/lib/review-packet.mjs`、`execution-runtime/lib/runtime-identity.mjs`、`execution-runtime/runtime-identity.json` | 持久化完整结果，冻结 committed review context 和 slice coverage，并绑定整个 runtime 安装身份；聊天只传 ref。 |
| Agent 角色与七段 prompt 编译 | `agent-build/config/{roles,controls,policies}.json`、`agent-build/templates/*.md`、`agent-build/runtime/asset-catalog.mjs` | contract 生成 action 输入/结果，角色模板只保留独有判断；总量限制由编译器校验。 |
| Skills 元数据与生成 | `agent-build/config/skills.json`、`agent-build/runtime/skill-catalog.mjs`、`agent-build/generate-skill-metadata.mjs` | 五个 Skills、frontmatter 和 `agents/openai.yaml` 的单一元数据来源与确定性校验。 |
| 项目上下文初始化 | `skills/init-ai-work-flow/SKILL.md`、`skills/init-ai-work-flow/references/project-context-contract.md`、`skills/init-ai-work-flow/scripts/validate-project-context.mjs` | 联合维护 MEMORY、导航和项目指令，验证章节唯一性与路径真实性。 |
| 代码导航 | `skills/project-code-navigation/SKILL.md`、`skills/project-code-navigation/references/*.md`、`skills/project-code-navigation/scripts/validate-navigation.mjs` | File Explorer 只读定位；Full Stack Coder 随入口/职责变化维护。 |
| Prompt 格式规范 | `docs/prompt-format.md` | 七段 Agent 接口、五段 Skill 接口、字符预算和 artifact 交接规则。 |
| 接口测试 | `test/agent-assets.test.mjs`、`test/workflow-broker.test.mjs`、`test/workflow-runtime.test.mjs` | 覆盖 contract/action、三平台 broker/prompt、Skills、写入隔离、并发 claim、恢复预算、审查复修、main resync 和 ReviewPacket。 |
