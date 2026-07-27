---
name: git-commit
description: Generate standard Gitmoji + Conventional Commit messages and create one scoped local Git commit after implementation validation.
---

# Scoped Local Commit

Generate a standard Gitmoji + Conventional Commit message, then create one local commit only for the exact paths supplied in the implementation handoff. This skill permits the narrow required Git operation while rejecting destructive or remote-affecting operations.

## Required input

- A confirmed implementation scope.
- `base_commit`, initial `git status --short`, and exact `changed_paths` from Full Stack Coder.
- Successful validation results.

## Procedure

1. Confirm the current `HEAD` exactly equals `base_commit` and the initial status was empty.
2. Derive the current changed-path set from the de-duplicated union of `git diff --name-only <base_commit>` and `git ls-files --others --exclude-standard`. Confirm it exactly matches `changed_paths`; stop on an empty list or an unlisted change.
3. Generate the commit message using the required format below.
4. Stage only the declared paths with `git add -- <changed_paths>`. Verify `git diff --cached --name-only` exactly equals the declared list and that the staged diff is non-empty.
5. Create one local commit and report its full SHA plus `git status --short`.

## Commit Message Format

Use this structure:

```text
:emoji: 中文动词描述

可选正文

可选页脚
```

- The subject must begin with exactly one ASCII Gitmoji code and a space, use Chinese and an action verb, be no longer than 50 characters, and not end with a period. An optional scope may precede the action, for example `:bug: [api] 修复超时重试`.
- Use `:sparkles:` for features, `:bug:` for fixes, `:memo:` for documentation, `:art:` for style, `:recycle:` for refactors, `:zap:` for performance, `:white_check_mark:` for tests, `:package:` for build or dependencies, `:construction_worker:` for CI, `:wrench:` for chores, and `:rewind:` for reverts.
- Add a body only when it explains motivation or a behavior change. Add `BREAKING CHANGE:` for incompatible changes and `Closes #<issue>` or `Fixes #<issue>` when applicable.
- Never add tool attribution such as `Co-Authored-By`.

## Guardrails

- Never run `git push`, `git reset --hard`, `git clean`, `git branch -D`, `git checkout .`, `git restore .`, `git stash`, or `git commit --amend`.
- Never use `git add .`, `git add -A`, or a wildcard to expand the scope.
- Do not request another user authorization for a confirmed implementation scope. Stop only when the declared scope cannot be verified safely.

## 回复格式

正常回答按需使用以下标签；无内容的标签省略。

- **结果：** 报告完整 SHA 和暂存路径。
- **状态：** 报告范围核对和 `git status --short` 结果。
- **阻塞：** 说明无法安全验证提交范围的原因。
