# 受管提示词格式

## Agent 接口

每个角色模板严格使用以下七个二级标题，顺序固定且各出现一次：

1. `角色结果`
2. `能力与控制`
3. `允许的 Actions 与输入`
4. `执行循环`
5. `完成标准`
6. `决策条件`
7. `结果回执`

模板显式保留加粗角色名，并只写角色独有判断。`能力与控制` 由 roles、controls 和 policies 注入；`Actions 与输入` 由 workflow contract 的命名 I/O contract、owner 和结果分支注入；`结果回执` 按 workflow/support action 注入 `ActionReceipt` 或 `SupportReceipt`。需要写运行状态的只读角色使用 MCP `workflow_state`，不获得工作区写权限。`routing.md` 仅参与 digest 和治理说明，不复制进角色 prompt。Planning Writer 与 Task Planner 可在“执行循环”内用带 `markdown` info string 的 fenced code block 维护 `spec.md`、`plan.md` 和 task 文件的统一模板。

编译器必须验证：每个 contract action 恰有一个 owner；owner 的角色声明该 action；能力、工具和 control 一致；所有 action/结果字段有结构覆盖。禁止用中文短语、表格行或历史 marker 判断状态机完整性。

单个编译 prompt 不超过 8,000 字符，14 个总量不超过 45,000 字符。Coding、Code Reviewer 和 Git Operator 不携带完整 schema、重试算法或 ReviewPacket 正文。

## Skill 接口

每份 `SKILL.md` 的 YAML frontmatter 只含 `name` 和 `description`。description 是触发条件唯一来源；正文不重复触发词，固定使用：

1. `结果目标`
2. `必要前置条件`
3. `步骤`
4. `条件分支`
5. `最终验收`

每步使用祈使表达并以机器或人工可检查的完成标准结束。分支细节只放一级 `references/`；可重复、易错或解析型逻辑放 `scripts/`。正文不复制 Agent 的状态、Git、重试或交接协议，只引用 runtime action 和结果。

单个 Skill 正文不超过 4,000 字符，五个总量不超过 12,000 字符。`skills.json` 确定 display name、25–64 字符短描述和 default prompt；`openai.yaml` 的所有字符串加引号，default prompt 显式包含 `$skill-name`。

## 交接

聊天只传 `WorkflowSnapshot`、`ActionReceipt`、`SupportReceipt`、`ArtifactRef` 或 `ReviewPacketRef`。完整规划上下文、变更证据、审查上下文、检查输出和叶子结果写本地 artifact。SupportReceipt 必须由直接调用者用原始 input 执行 `support_validate`；响应截断或 JSON 损坏时从 runtime 读取 canonical receipt，不重做 action。
