# Completion Adapter 协议

`completion-adapter.mjs` 只接受并校验 canonical JSON Completion Result。`createNativeAdapter({ spawn, collect })` 按任务 ID 的确定顺序串行派发并收集 Frontier；第一个 blocked 结果或 spawn/collect 失败会立即停止，后续 Frontier 任务保持 pending 且不会派发。需要工作项时，原生任务从执行 worktree 的 `ticket.ref` 读取。

Codex/Claude 和 OpenCode 分别注入自己的原生 `spawn`/`collect` 能力。没有原生能力时，`createUnsupportedAdapter(name)` 只为 Frontier 中按 ID 排序的首项返回结构化 blocked 结果，其余任务保持 pending；它绝不轮询或伪造任务。该适配器不自动重试：它没有 routing 所要求的暂态错误分类与旧子代理已停止证明。Coding 仅可按 `routing.md` 在确认满足两项条件后，以新子会话安排重试。

子代理终态为 JSON：

```json
{
  "ticket_id": "01",
  "status": "done|blocked",
  "commits": ["<full-sha>"],
  "checks": ["<check>"],
  "changed_paths": ["<PathChange>"],
  "summary": "<non-empty summary>",
  "error": "<blocked only>"
}
```

`completion-result-schema.json` 是字段格式的权威。文本 `RESULT/COMMITS/TESTS` 不再是兼容入口。JSON Handoff envelope 必须带 `role_id`、`session_id` 和 `claim_id`，并与 payload 的 `status`、`summary`、`checks` 和可选 `error` 逐值一致；runtime 会将其与当前 Ticket 持久化的 claim identity 一次性核对。

子代理名为 `Spec Ticket - {task_title}`，使用主代理的模型并加载 `implement` 与 `$git-commit` skill。它是隔离 feature worktree 中受限的 Full Stack Coder + Git Operator：开始前记录 `base_commit` 和空的 porcelain v2 状态；完成实现和检查后，唯一以 porcelain v2 `-z` 生成 `changed_paths: PathChange[]`。只有当前 `HEAD` 仍精确等于 `base_commit`、结构化范围核对通过且验证成功时，才按 `$git-commit` 创建仅本地的实现提交并返回完整 SHA；不得等待额外的提交授权。Coding 委派 Full Stack Coder 在 main 更新本地 Issue 复选框和 Checkpoint。
