# OpenCode Subtask Model Control Research

- Query date: 2026-07-22
- OpenCode baseline: v1.18.4
- Source baseline: [`0a601cf`](https://github.com/anomalyco/opencode/tree/0a601cf334b9a83cc2854108a2b860f25e6e7e8e)

## Sources

- [Agents documentation](https://opencode.ai/docs/agents/)
- [Configuration schema](https://opencode.ai/config.json)
- [Plugins documentation](https://opencode.ai/docs/plugins/)
- [SDK sessions documentation](https://opencode.ai/docs/sdk/#sessions)
- [Server sessions documentation](https://opencode.ai/docs/server/#sessions)

## Findings

### Subagent frontmatter

Markdown-defined subagents use YAML frontmatter. `model` accepts a fully qualified `provider/model-id`; `variant` is a string. Other agent frontmatter fields include `description`, `mode`, `hidden`, `temperature`, `top_p`, `prompt`, `permission`, and `tools`. When a subagent omits `model`, it inherits its parent session's model.

There is no agent-specific formatter setting in this frontmatter or the documented agent configuration surface.

```yaml
---
description: Research OpenCode behavior
mode: subagent
model: openai/gpt-5.2-codex
variant: high
---
```

### Observing execution

After a task runs, its metadata can expose the model and variant used at runtime. This is an implementation observation rather than a documented compatibility contract. The same information can also be observed through source-backed `chat.message` plugin-hook handling and through the session/message APIs.

### Abort and retry

The SDK exposes `client.session.abort({ path: { id } })` to abort a session. New subtasks are created by prompting with a new `SubtaskPartInput`; retrying must create a new child session. Supplying an existing `task_id` resumes that child instead of creating a retry.

### Admission-control limitation

`tool.execute.before` can block a tool call or mutate its arguments, but it cannot inspect the final resolved model. OpenCode has no atomic hook that admits a task only after its model has been resolved. A `chat.message`-based abort-and-retry approach therefore has a small race: the child may begin work before the observer can abort it. The limitation applies to source baseline `0a601cf` and should be revalidated on upgrade.
