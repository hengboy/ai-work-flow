---
name: git-commit
description: 生成符合 Conventional Commits 1.0.0 的标准提交信息，并在实现验证后创建一个受控的本地 Git 提交。
---

# 受控本地提交

生成符合 Conventional Commits 1.0.0 的标准提交信息，然后仅对实现交接中的精确路径创建一个本地提交。本技能只允许必要且范围受控的 Git 操作，并禁止破坏性或影响远程仓库的操作。

## 必要输入

- 已确认的实现范围。
- Full Stack Coder 提供的 `base_commit`、初始 `git status --short` 和精确 `changed_paths`。
- 已成功执行的验证结果。

## 执行步骤

1. 确认当前 `HEAD` 精确等于 `base_commit`，且初始状态为空。
2. 使用 `git diff --name-only <base_commit>` 与 `git ls-files --others --exclude-standard` 的去重并集生成当前变更路径集。确认它与 `changed_paths` 完全一致；清单为空或存在未声明路径时停止。
3. 按以下格式生成提交信息。
4. 只能通过 `git add -- <changed_paths>` 暂存声明的路径。确认 `git diff --cached --name-only` 与声明清单完全一致，且暂存差异非空。
5. 创建一个本地提交，并报告完整 SHA 与 `git status --short`。

## 提交信息格式

使用 Conventional Commits 1.0.0 结构：

```text
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

- 每个提交必须以类型开头，随后可选范围、可选 `!`、英文半角冒号和一个空格。使用 `feat` 表示新增功能，使用 `fix` 表示修复 bug。
- 需要时使用 `build`、`chore`、`ci`、`docs`、`style`、`refactor`、`perf` 或 `test` 等类型。范围必须是圆括号包围的代码区域名，例如 `feat(parser): 支持数组解析`。
- 描述必须紧跟 `: `，简要概括改动，并使用仓库既有语言。正文可选，必须与描述之间空一行，用于说明上下文或行为变化。
- 页脚可选，必须在正文后空一行。每行页脚使用 trailer 格式：`Token: value` 或 `Token #value`。例如 `Refs: #123`。
- 破坏性变更必须使用类型/范围后的 `!`，或在页脚使用大写 `BREAKING CHANGE: <description>`。使用 `!` 时，描述应说明破坏性变更。
- 不得添加 `Co-Authored-By` 等工具归属信息。

## 安全边界

- 不得运行 `git push`、`git reset --hard`、`git clean`、`git branch -D`、`git checkout .`、`git restore .`、`git stash` 或 `git commit --amend`。
- 不得使用 `git add .`、`git add -A` 或通配符扩大范围。
- 已确认的实现范围不得再次请求用户授权；只有无法安全验证声明范围时才停止。

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 报告完整 SHA 和暂存路径。
- **状态：** 报告范围核对和 `git status --short` 结果。
- **阻塞：** 说明无法安全验证提交范围的原因。
