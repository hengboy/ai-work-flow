# 问题跟踪器：GitHub

此仓库的问题和 PRD 均以 GitHub 问题的形式存在。所有操作均使用 `gh` CLI 完成。

## 约定

- **创建问题**：`gh issue create --title "..." --body "..."`。多行正文请使用 heredoc。
- **查看问题**：`gh issue view <number> --comments`，并使用 `jq` 过滤评论，同时获取标签。
- **列出问题**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，并根据需要添加适当的 `--label` 和 `--state` 过滤条件。
- **在问题上发表评论**：`gh issue comment <number> --body "..."`
- **添加/移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭问题**：`gh issue close <number> --comment "..."`

通过 `git remote -v` 推断仓库——在克隆目录内运行时，`gh` 会自动完成此操作。

## 拉取请求作为分类表面

**PR 作为请求表面：否。** _(如果此仓库将外部 PR 视为功能请求，则设置为 `yes`；`/triage` 会读取此标志。)_

当设置为 `yes` 时，PR 将与 issues 使用相同的标签和状态，并采用 `gh pr` 的等效命令：

- **查看 PR**：`gh pr view <number> --comments`，以及使用 `gh pr diff <number>` 查看差异。
- **列出待分类的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然后仅保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的 PR（删除 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论/标记/关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 在 issues 和 PRs 之间共享同一个编号空间，因此单纯的 `#42` 可能指代两者之一——可通过 `gh pr view 42` 解决，若失败则回退至 `gh issue view 42`。

## 当技能要求“发布到问题跟踪器”

创建一个 GitHub 问题。

## 当技能要求“获取相关工单”

运行 `gh issue view <number> --comments`。

## 路径查找操作

由 `/wayfinder` 使用。**地图**是一个单独的问题，其**子问题**作为工单。

- **地图**：一个标有 `wayfinder:map` 标签的问题，包含 Notes / Decisions-so-far / Fog 正文。`gh issue create --label wayfinder:map`。
- **子工单**：作为 GitHub 子问题链接到地图（通过 `gh api` 调用子问题端点）。如果未启用子问题功能，则将子工单添加到地图正文中的任务列表，并在子工单正文顶部写上 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。工单被认领后，将分配给主导开发人员。
- **阻塞**：GitHub 的**原生问题依赖关系**——最标准且用户界面可见的表示方式。使用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 添加一条边，其中 `<blocker-db-id>` 是阻塞者的数字**数据库 ID**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 会报告 `issue_dependencies_summary.blocked_by`（仅显示未解决的阻塞——实时关卡）。如果无法使用依赖关系功能，则在子工单正文顶部添加一行 `Blocked by: #<n>, #<n>`。当所有阻塞者都被关闭时，工单即被解除阻塞。
- **前沿查询**：列出地图的未完成子工单（`gh issue list --state open`，限定为地图的子问题或任务列表），剔除任何带有未解阻塞（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有未解决的问题）或已有分配对象的工单；按地图顺序优先选择。
- **认领**：`gh issue edit <n> --add-assignee @me`——本次会话中的首次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，随后 `gh issue close <n>`，并在地图的 Decisions-so-far 中追加一个上下文指针（gist + 链接）。

