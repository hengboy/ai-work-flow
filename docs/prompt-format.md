# 受管提示词格式

## Agent 接口

每个角色模板严格使用以下七个二级标题，顺序固定且各出现一次：

1. `角色结果`
2. `能力与控制`
3. `允许的 Actions 与输入`
4. `执行循环`
5. `完成标准`
6. `决策条件`
7. `结果返回`

模板显式保留加粗角色名，并只写角色独有判断。`能力与控制` 由 roles、controls、policies 和 `skills.json` 所有权注入；`Actions 与输入` 由 workflow contract 的命名 I/O contract、owner 和结果分支注入；`结果返回` 注入固定 `TaskResult` 规则。**Planning**/**Coding** 仅获得 `Task`，其他角色按职责获得最小工具集。`routing.md` 仅参与 digest 和治理说明，不复制进角色 prompt。

编译器必须验证：每个 contract action 恰有一个 owner；owner 的角色声明该 action；能力、工具和 control 一致；所有 action/结果字段均在 `task-result-schemas.json` 中有类型覆盖，且其 `contract_digest` 与 workflow contract 一致。禁止用中文短语、表格行或历史 marker 判断转换完整性。

单个编译 prompt 不超过 8,000 字符，14 个总量不超过 45,000 字符。**Coding**、**Code Reviewer** 和 **Git Operator** 不携带完整 schema 或 ReviewPacket 正文。

## Skill 接口

每份 `SKILL.md` 的 YAML frontmatter 只含 `name` 和 `description`。description 是触发条件唯一来源；正文不重复触发词，固定使用：

1. `结果目标`
2. `必要前置条件`
3. `步骤`
4. `条件分支`
5. `最终验收`

每步使用祈使表达并以机器或人工可检查的完成标准结束。分支细节只放一级 `references/`；可重复、易错或解析型逻辑放 `scripts/`。正文不复制 Agent 的 Git、重试或交接协议，只引用 action 和结果。

单个 Skill 正文不超过 4,000 字符，五个总量不超过 12,000 字符。`skills.json` 确定 owner、display name、短描述和 default prompt；Codex 用每角色 `skills.config`、Claude 用预加载列表、OpenCode 用名称级 permission，只允许 owner 调用。

## 交接

子代理在聊天中只返回一个使用 2 个空格缩进的多行 JSON `TaskResult` 对象；`planning_context`、`change_evidence`、`review_packet`、`review_axis_result` 与 `review_result` 直接携带完整 JSON 内容。`task-result-schemas.json` 约束顶层与嵌套字段类型，主代理验证后将所需对象原样传给下一 action。流程只存在于当前会话；中断后根据计划、Git 状态和仓库事实重新定位。
