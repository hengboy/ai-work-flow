# 上游记录

## 来源

- 仓库: `https://github.com/mattpocock/skills`
- 固定基线: `ed37663cc5fbef691ddfecd080dff42f7e7e350d`

## 关系

AI Work Flow 不再复制上游技能。上游技能（`to-spec`、`to-tickets`、`implement`、`code-review`、`ask-matt`、`setup-matt-pocock-skills` 等）作为独立依赖安装，AI Work Flow 仅提供：

- **Coordinator 路由层**：`routing.md` + 9 角色 Agent 定义
- **执行引擎**：`run-matt-spec-to-completion` 技能（适配 `to-spec`/`to-tickets` 产物）
- **配置管理**：`generate-ai-work-flow-agents` 技能 + `agent-workflow.mjs`

Coordinator 模式下，路由规则通过 `routing.md` 统一管理，不再需要在每个技能中嵌入路由头。其他代理模式下保持原生行为。

## 法律例外

上游来源详情保留在本记录中。项目许可证作为必要的法律材料保留在 `LICENSE` 文件中。

## 手动更新步骤

1. 拉取记录基线之后的上游更改。
2. 确认 `run-matt-spec-to-completion` 与新版本 `to-spec`/`to-tickets` 产物格式兼容。
3. 重新运行结构、命名、品牌以及工件边界验证。