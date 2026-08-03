---
name: git-commit
description: 生成符合 Conventional Commits 1.0.0 且使用中文说明的标准提交信息，并在实现验证后创建一个受控的本地 Git 提交。
---

# 受控本地提交

生成符合 Conventional Commits 1.0.0 且使用中文说明的标准提交信息，然后仅对实现交接中的精确路径创建一个本地提交。本技能只允许必要且范围受控的 Git 操作，并禁止破坏性或影响远程仓库的操作。

## 必要输入

- 已确认的实现范围。
- Full Stack Coder 提供的 `base_commit`、初始 `git status --porcelain=v2 -z` 和精确 `changed_paths: PathChange[]`。
- 已成功执行的验证结果。

## 执行步骤

1. 确认交接记录的初始 `git status --short` 为空、当前 `HEAD` 精确等于 `base_commit`，且交接中的验证命令全部通过。
2. 唯一使用 `git status --porcelain=v2 -z --untracked-files=all` 解析结构化 `PathChange[]`，并按全部字段比较当前集合与 `changed_paths`。不得以换行分割路径；rename/copy 同时保留目标 `path` 与 `source_path`。
3. 按以下格式生成提交信息。
4. 只能以参数数组和 `--` 暂存声明 PathChange 的目标/源路径。确认暂存结构化集合与声明清单完全一致，且暂存差异非空。
5. 创建一个本地提交，并报告完整 `review_commit` SHA 与空的 porcelain 状态。提交 hook 失败时不 reset、clean 或重试；立即重读同一 porcelain `-z` 状态，分别交接真实 index/worktree PathChange 和原始失败原因。

所有预检成功后自动完成精确暂存、提交和清洁状态校验，不再询问是否继续提交。

## 提交信息格式

使用 Conventional Commits 1.0.0 结构：

```text
<type>[optional scope][optional !]: <description>

[optional body]

[optional footer(s)]
```

- 每个提交必须以类型开头，随后可选范围、可选 `!`、英文半角冒号和一个空格。使用 `feat` 表示新增功能，使用 `fix` 表示修复 bug。
- 需要时使用 `build`、`chore`、`ci`、`docs`、`style`、`refactor`、`perf` 或 `test` 等类型。范围必须是圆括号包围的代码区域名，例如 `feat(parser): 支持数组解析`。
- `type`、`scope`、`BREAKING CHANGE` 和 trailer token 等 Conventional Commits 语法元素保持英文；描述、正文、破坏性变更说明和 trailer value 必须使用中文。描述必须紧跟 `: `，简要概括改动。正文可选，必须与描述之间空一行，用于说明上下文或行为变化。
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
