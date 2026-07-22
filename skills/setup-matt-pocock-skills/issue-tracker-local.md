# 问题跟踪器：本地 Markdown

此仓库中的问题和规格说明（您可能将规格说明称为 PRD）以 Markdown 文件的形式存储在 `.scratch/` 目录中。

## 约定

- 每个功能一个目录：`.scratch/<feature-slug>/`
- 规格说明文件为 `.scratch/<feature-slug>/spec.md`
- 实现相关的问题按单个工单分别存储于 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，编号从 `01` 开始——绝不使用单一的合并工单文件
- 问题的分类状态记录在每个问题文件顶部附近的 `Status:` 行中（参见 `triage-labels.md` 了解角色字符串）
- 注释和讨论历史追加到文件底部的 `## Comments` 标题下

## 当某个技能要求“发布到问题跟踪器”

请在 `.scratch/<feature-slug>/` 下创建一个新文件（如果需要，先创建该目录）。

## 当某个技能要求“获取相关工单”

请读取所引用路径下的文件。通常情况下，用户会直接传递路径或工单编号。

## 导航操作

由 `/wayfinder` 使用。**地图** 是一个包含每个工单对应 **子文件** 的文件。

- **地图**：`.scratch/<effort>/map.md` — 包含笔记、已做出的决策以及当前存在的模糊点等内容。
- **子工单**：`.scratch/<effort>/issues/NN-<slug>.md`，编号从 `01` 开始，问题内容写在正文中。`Type:` 行用于记录工单类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行用于记录状态（`claimed`/`resolved`）。
- **阻塞关系**：文件顶部附近有一行 `Blocked by: NN, NN`。当阻塞列表中的所有文件状态均为 `resolved` 时，该工单即被解除阻塞。
- **前沿工单**：扫描 `.scratch/<effort>/issues/` 目录，查找未关闭、未阻塞且未认领的工单；按编号顺序优先选择最早的工单。
- **认领**：在开始任何工作之前，将 `Status` 设置为 `claimed` 并保存。
- **解决**：在 `## Answer` 标题下添加答案，将 `Status` 设置为 `resolved`，然后在 `map.md` 中的“已做出的决策”部分追加一条上下文指针（gist + 链接）。

