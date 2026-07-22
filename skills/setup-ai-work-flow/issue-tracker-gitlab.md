# 问题跟踪器：GitLab

此仓库的问题和 PRD 都以 GitLab 问题的形式存在。所有操作请使用 [`glab`](https://gitlab.com/gitlab-org/cli) CLI。

## 规范

- **创建问题**：`glab issue create --title "..." --description "..."`。多行描述请使用 heredoc 格式。传递 `--description -` 可打开编辑器。
- **查看问题**：`glab issue view <number> --comments`。使用 `-F json` 可获得机器可读的输出。
- **列出问题**：`glab issue list -F json`，并配合适当的 `--label` 过滤条件。
- **在问题上评论**：`glab issue note <number> --message "..."`。GitLab 将评论称为“notes”。
- **添加/移除标签**：`glab issue update <number> --label "..."` / `--unlabel "..."`。多个标签可以用逗号分隔，或重复该选项。
- **关闭问题**：`glab issue close <number>`。`glab issue close` 不接受关闭时的评论，因此请先用 `glab issue note <number> --message "..."` 发布说明，然后再关闭。
- **合并请求**：GitLab 将 PR 称为“merge requests”。使用 `glab mr create`、`glab mr view`、`glab mr note` 等命令——其用法与 `gh pr ...` 类似，只是将 `pr` 替换为 `mr`，并将 `comment`/`--body` 替换为 `note`/`--message`。

通过 `git remote -v` 即可确定仓库——`glab` 在克隆目录内运行时会自动完成这一操作。

## 合并请求作为分类表面

**MR 作为请求表面：否。** _(如果此仓库将外部合并请求视为功能请求，请设置为 `yes`；`/triage` 会读取此标志。)_

当设置为 `yes` 时，MR 将与问题一样使用相同的标签和状态，并采用 `glab mr` 的等效命令：

- **查看 MR**：`glab mr view <number> --comments` 和 `glab mr diff <number>` 查看差异。
- **列出待分类的外部 MR**：`glab mr list -F json`，然后仅保留作者不是项目成员或所有者的 MR（即贡献者的 MR，而非维护者正在进行的工作）。
- **评论/标记/关闭**：`glab mr note`、`glab mr update --label`/`--unlabel`、`glab mr close`。

与 GitHub 不同，GitLab 会分别对问题和 MR 进行编号，因此一旦你知道维护者指的是哪个类型，`#42` 就不会产生歧义。

## 当技能要求“发布到问题跟踪器”

创建一个 GitLab 问题。

## 当技能要求“获取相关工单”

运行 `glab issue view <number> --comments`。

## 路径查找操作

由 `/wayfinder` 使用。**地图** 是一个单独的问题，其**子问题** 则是工单。

- **地图**：一个标有 `wayfinder:map` 标签的问题，包含 Notes / 决策记录 / Fog 主体。`glab issue create --label wayfinder:map`。（在支持原生史诗的 GitLab 版本中，也可以用史诗来代替地图；而带标签的普通问题则适用于所有版本。）
- **子工单**：在描述顶部写明 `Part of #<map>`，并打上 `wayfinder:<type>` 标签（`research`/`prototype`/`grilling`/`task`）。工单被认领后，会分配给负责开发的人员。
- **阻塞关系**：GitLab 的**原生阻塞链接**——一种标准且用户界面可见的表示方式。通过 `/blocked_by #<n>` 快捷操作添加，以注释形式发布（`glab issue note <child> --message "/blocked_by #<blocker>"`）。原生阻塞链接是 Premium/Ultimate 版本的功能；在免费版（或不可用时），退而求其次，在描述顶部写上 `Blocked by: #<n>, #<n>`。只有当所有阻塞项都被关闭时，工单才会解除阻塞。
- **前沿查询**：`glab issue list -F json`，限定在地图的子问题范围内，剔除任何带有未解决阻塞项的工单——无论是原生的 `blocked_by` 链接指向未关闭的问题（可通过 `glab api projects/:id/issues/:iid/links` 查询），还是描述中写着 `Blocked by` 的未关闭问题——或者已有分配对象；按地图顺序，先到先得。
- **认领**：`glab issue update <n> --assignee @me`——本次会话中的首次修改。
- **解决**：`glab issue note <n> --message "<answer>"`，然后 `glab issue close <n>`，最后在地图的“决策记录”部分追加上下文指针（gist + 链接）。

