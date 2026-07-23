# Completion Adapter 协议

`completion-adapter.mjs` 是唯一解析终态协议的 module。`createNativeAdapter({ spawn, collect })` 按任务 ID 的确定顺序串行派发并收集 Frontier；第一个 blocked 结果或 spawn/collect 失败会立即停止，后续 Frontier 任务保持 pending 且不会派发。需要工作项时，原生任务从执行 worktree 的 `ticket.ref` 读取。

Codex/Claude 和 OpenCode 分别注入自己的原生 `spawn`/`collect` 能力。没有原生能力时，`createUnsupportedAdapter(name)` 只为 Frontier 中按 ID 排序的首项返回结构化 blocked 结果，其余任务保持 pending；它绝不轮询或伪造任务。该适配器不自动重试：它没有 routing 所要求的暂态错误分类与旧子代理已停止证明。Coordinator 仅可按 `routing.md` 在确认满足两项条件后，以新子会话安排重试。

子代理终态格式为：

```text
RESULT: DONE | BLOCKED
COMMITS: <DONE 时为一个或多个完整 SHA；BLOCKED 时为 none>
TESTS: <已运行测试；没有则 none>
SUMMARY: <非空摘要>
ERROR: <仅 RESULT=BLOCKED 时填写，且非空>
```

`completion-result-schema.json` 是字段格式的权威。`normalizeCompletion` 将缺字段、无效或短 SHA、`DONE` 无提交、`DONE` 含 ERROR、`BLOCKED` 含提交转换为 blocked Completion Result。协议错误的 `summary` 固定为 `Completion protocol error`，`error` 说明具体原因。

子代理名为 `Spec Ticket - {task_title}`，使用主代理的模型并加载 `implement` skill。它只编辑、测试和提交实现代码；Coordinator 委派 Full Stack Coder 在 main 更新本地 Issue 复选框和 Checkpoint。
