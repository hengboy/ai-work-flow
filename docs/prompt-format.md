# 受管提示词排版规范

## 适用范围

本规范适用于仓库管理的 Skill、角色 Agent 正文和路由规则。平台生成器应原样保留这些 Markdown 指令内容。

## 文档结构

- 每份直接提示词使用一个 `#` 主标题。角色模板依次使用 `## 职责结果`、`## 不可违反约束`、`## 输入前置条件`、`## 确定性工作流`、`## 暂停条件` 和 `## 交接格式`；模板正文需要固定 artifact 模板时可在工作流中插入额外 `##`。`不可违反约束` 保留唯一 `<!-- ai-work-flow:controls -->` 占位，编译器按角色声明顺序注入控制文本和隐藏 control ID 摘要。Skill 使用与自身流程匹配的语义标题。
- 标题、段落和列表之间保留空行；执行步骤使用有序列表。
- `**加粗**` 仅用于角色名、关键状态和标签，例如 `**状态：**`、`**结论：**`、`**阻塞：**`。

## 交接与反馈

子代理最终返回统一且仅供主代理消费的 JSON：`status`、`summary`、`artifacts`、`checks`、`details`，仅 blocked 时增加 `blocking_reason`。角色特有字段放入 `details`；canonical Ticket 的 Handoff schema 保持独立。主代理验证 JSON 后再生成用户可读反馈。

Coding 非完成态使用 `**状态：**`、`**当前角色：**`、`**已完成：**`、`**下一步：**`。进入人工门禁时只提出一个 `**需要你决定：**` 问题。审查结果中的 blocking 与 advisory findings 分别放入 `**阻塞项：**` 与 `**建议：**`，并保留 Standards、Spec 顺序。

目录式 plan/task 完成最终整合与清理且没有 blocking finding 时，Coding 明确告知“已经全部完成”，并依次使用 `**实施结果：**`、`**完成内容：**`、`**验证结果：**`、`**变更范围：**`、`**遗留事项：**`；遗留事项没有内容时写“无”。

| 类型 | 输出契约 |
| --- | --- |
| Coding | 状态摘要、单一决定问题或五段式完成态 |
| Planning | 连续编号的单一问题或规划工件与 commit 交接 |
| 子代理 | 统一 JSON envelope；角色字段进入 `details` |
| 审查角色 | `details.review_result` 保留 verdict、findings、digest 和 coverage |
| 生成、切换与执行 Skill | 结果、更新或状态、注意或阻塞 |

## 受管标记

嵌入用户 `AGENTS.md` 或 `CLAUDE.md` 的受管标记仅是 Markdown 片段，不得注入新的一级标题。
