# 范围外知识库

仓库中的 `.out-of-scope/` 目录用于存储被拒绝的功能请求的持久化记录。它有两个用途：

1. **机构记忆** — 记录功能被拒绝的原因，以便在问题关闭时不会丢失相关理由
2. **去重** — 当出现与先前拒绝相匹配的新问题时，技能可以展示之前的决定，而无需重新讨论

## 目录结构

```
.out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

每个文件对应一个 **概念**，而不是一个问题。多个请求同一功能的问题会归入同一个文件。

## 文件格式

文件应以轻松、易读的风格撰写——更像是简短的设计文档，而不是数据库条目。使用段落、代码示例和实例来使推理清晰明了，便于初次接触的人理解。

````markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in
`ThemeConfig`. Supporting multiple themes would require:

- A theme context provider wrapping the entire component tree
- Per-component theme-aware style resolution
- A persistence layer for user theme preferences

This is a significant architectural change that doesn't align with the
project's focus on content authoring. Theming is a concern for downstream
consumers who embed or redistribute the output.

```ts
// 当前的 ThemeConfig 接口并非为运行时切换设计：
interface ThemeConfig {
  colors: ColorPalette; // 单一调色板，在构建时解析
  fonts: FontStack;
}
```
````

## Prior requests

- #42 — "Add dark mode support"
- #87 — "Night theme for accessibility"
- #134 — "Dark theme option"

```

### 文件命名

为概念使用简短且描述性的 kebab-case 命名：`dark-mode.md`、`plugin-system.md`、`graphql-api.md`。名称应足够直观，以便浏览目录的人无需打开文件就能了解被拒绝的内容。

### 理由的撰写

理由应具有实质性——不是简单地说“我们不要这个”，而是说明原因。好的理由会引用：

- 项目范围或理念（“该项目专注于 X；主题设置是下游关注的问题”）
- 技术限制（“支持这一点需要 Y，而这与我们的 Z 架构冲突”）
- 战略决策（“我们选择使用 A 而不是 B，因为……”）

理由应具有长期适用性。避免提及临时情况（“我们现在太忙了”）——那些并不是真正的拒绝，而是推迟处理。

## 何时查看 `.out-of-scope/`

在分类阶段（步骤 1：收集上下文）时，请阅读 `.out-of-scope/` 中的所有文件。评估新问题时：

- 检查请求是否与现有的范围外概念匹配
- 匹配依据是概念相似性，而非关键词——例如，“夜间主题”与 `dark-mode.md` 匹配
- 如果有匹配，向维护者反馈：“这与 `.out-of-scope/dark-mode.md` 类似——我们之前曾因 [理由] 拒绝过这一请求。您现在是否仍有相同看法？”

维护者可能会：

- **确认** — 新问题会被添加到现有文件的“先前请求”列表中，然后关闭
- **重新考虑** — 删除或更新范围外文件，并让问题按正常流程继续分类
- **不同意** — 问题虽有关联但并不完全相同，按正常流程继续分类

## 何时写入 `.out-of-scope/`

仅当某个 **增强功能**（非缺陷）被判定为 `wontfix` 时才进行记录。这同样适用于增强功能的 PR 和普通问题——被拒绝的 PR 会在此处记录，以免同样的请求以新代码的形式再次出现。

如果某项内容因 **已实现** 而被标记为 `wontfix`，则**不应**在此处记录。那属于已开发的功能，而非被拒绝的内容；若将其记录下来，会导致去重检查误判为虚假拒绝。此时应在关闭评论中指明该功能的所在位置。

操作流程如下：

1. 维护者判定某项功能请求不在项目范围内
2. 检查是否已有对应的 `.out-of-scope/` 文件
3. 若存在：将新问题追加到“先前请求”列表中
4. 若不存在：创建新文件，包含概念名称、决定、理由及首个先前请求
5. 在问题评论中说明决定并提及 `.out-of-scope/` 文件
6. 使用 `wontfix` 标签关闭问题

## 更新或移除范围外文件

如果维护者改变了对先前被拒绝概念的看法：

- 删除对应的 `.out-of-scope/` 文件
- 技能无需重新打开旧问题——它们是历史记录
- 触发重新考虑的新问题将按正常流程继续分类


```
