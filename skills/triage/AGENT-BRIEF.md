# 编写代理简报

代理简报是在 GitHub 问题或 PR 进入 `ready-for-agent` 状态时发布的结构化注释。它是 AFK 代理将依据的权威规范。原始正文和讨论内容仅作为上下文——代理简报才是合同。

简报说明了**代理应该做什么**，这适用于两种场景：对于问题，即从零开始构建变更；对于 PR，则是针对现有差异还需完成的工作——完善它、填补空白、解决评审意见。无论哪种情况，原则都相同；下面的 PR 示例展示了两者的区别。

## 原则

### 耐用性优先于精确性

问题可能会在 `ready-for-agent` 状态停留数天甚至数周。在此期间，代码库可能会发生变化。编写简报时，请确保其在文件被重命名、移动或重构后仍能保持有效。

- **应**描述接口、类型和行为契约
- **应**明确代理应查找或修改的具体类型、函数签名或配置形状
- **不应**引用文件路径——它们会过时
- **不应**引用行号
- **不应**假设当前的实现结构会保持不变

### 行为导向而非过程导向

描述系统**应该做什么**，而不是**如何实现**。代理会从头探索代码库，并自行做出实现决策。

- **好：**“`SkillConfig` 类型应接受一个可选的 `schedule` 字段，类型为 `CronExpression`”
- **坏：**“打开 src/types/skill.ts，在第 42 行添加一个 schedule 字段”
- **好：**“当用户不带参数运行 `/triage` 时，应看到一份需要关注的问题摘要”
- **坏：**“在主处理函数中添加一个 switch 语句”

### 完整的验收条件

代理需要知道何时完成工作。每份代理简报都必须包含具体且可测试的验收条件。每个条件都应能够独立验证。

- **好：**“运行 `gh issue list --label needs-triage` 返回已完成初步分类的问题”
- **坏：**“分类功能应正常工作”

### 明确的范围边界

说明哪些内容不在本次任务范围内。这可以防止代理过度设计或对相邻功能产生误解。

## 模板

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe what happens now. For bugs, this is the broken behavior.
For enhancements, this is the status quo the feature builds on.

**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate
```

## 示例

### 良好的代理简报（Bug）

```markdown
## Agent Brief

**Category:** bug
**Summary:** Skill description truncation drops mid-word, producing broken output

**Current behavior:**
When a skill description exceeds 1024 characters, it is truncated at exactly
1024 characters regardless of word boundaries. This produces descriptions
that end mid-word (e.g. "Use when the user wants to confi").

**Desired behavior:**
Truncation should break at the last word boundary before 1024 characters
and append "..." to indicate truncation.

**Key interfaces:**
- The `SkillMetadata` type's `description` field — no type change needed,
  but the validation/processing logic that populates it needs to respect
  word boundaries
- Any function that reads SKILL.md frontmatter and extracts the description

**Acceptance criteria:**
- [ ] Descriptions under 1024 chars are unchanged
- [ ] Descriptions over 1024 chars are truncated at the last word boundary
      before 1024 chars
- [ ] Truncated descriptions end with "..."
- [ ] The total length including "..." does not exceed 1024 chars

**Out of scope:**
- Changing the 1024 char limit itself
- Multi-line description support
```

### 良好的代理简报（增强功能）

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Add `.out-of-scope/` directory support for tracking rejected feature requests

**Current behavior:**
When a feature request is rejected, the issue is closed with a `wontfix` label
and a comment. There is no persistent record of the decision or reasoning.
Future similar requests require the maintainer to recall or search for the
prior discussion.

**Desired behavior:**
Rejected feature requests should be documented in `.out-of-scope/<concept>.md`
files that capture the decision, reasoning, and links to all issues that
requested the feature. When triaging new issues, these files should be
checked for matches.

**Key interfaces:**
- Markdown file format in `.out-of-scope/` — each file should have a
  `# Concept Name` heading, a `**Decision:**` line, a `**Reason:**` line,
  and a `**Prior requests:**` list with issue links
- The triage workflow should read all `.out-of-scope/*.md` files early
  and match incoming issues against them by concept similarity

**Acceptance criteria:**
- [ ] Closing a feature as wontfix creates/updates a file in `.out-of-scope/`
- [ ] The file includes the decision, reasoning, and link to the closed issue
- [ ] If a matching `.out-of-scope/` file already exists, the new issue is
      appended to its "Prior requests" list rather than creating a duplicate
- [ ] During triage, existing `.out-of-scope/` files are checked and surfaced
      when a new issue matches a prior rejection

**Out of scope:**
- Automated matching (human confirms the match)
- Reopening previously rejected features
- Bug reports (only enhancement rejections go to `.out-of-scope/`)
```

### 良好的代理简报（PR）

对于 PR，“当前行为”描述的是差异的状态，简报要求代理完成或修复差异，而不是从零开始构建。

```markdown
## Agent Brief

**Category:** enhancement
**Summary:** Finish the contributor's `--json` output flag for `triage list`

**Current behavior:**
The PR adds a `--json` flag that serializes the issue list to JSON. The happy
path works and the diff matches the project's command structure. Two gaps
remain: errors are still printed as human text (not JSON), and the new flag has
no test coverage.

**Desired behavior:**
With `--json`, all output — including errors — is well-formed JSON on stdout,
and the command's exit codes are unchanged. The existing human-readable output
is untouched when the flag is absent.

**Key interfaces:**
- The command's error path should emit `{ "error": string }` under `--json`
  instead of the plain-text error
- Reuse the existing serializer the PR already added; don't introduce a second

**Acceptance criteria:**
- [ ] `triage list --json` emits valid JSON for both success and error cases
- [ ] Exit codes match the non-JSON command
- [ ] A test covers the `--json` success output and one error case
- [ ] Default (non-JSON) output is byte-for-byte unchanged

**Out of scope:**
- Adding `--json` to any other command
- Changing the JSON shape of the success payload the PR already defined
```

### 不良的代理简报

```markdown
## Agent Brief

**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.

**Files to change:**
- src/triage/handler.ts (line 150)
- src/types.ts (line 42)
```

这份简报的问题在于：
- 没有指定类别
- 描述过于模糊（“分类功能出了问题”）
- 引用了会过时的文件路径和行号
- 缺少验收条件
- 没有明确范围边界
- 没有说明当前行为与期望行为之间的区别


