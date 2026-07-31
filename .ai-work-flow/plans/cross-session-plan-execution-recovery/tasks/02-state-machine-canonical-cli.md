# 02 - State machine and canonical CLI

- task_id: `plan-state-machine-canonical-cli`
- order: `02`
- blocked_by: `plan-intake-checkpoint-foundation`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `execution-runtime/plan-execution-cli.mjs; execution-runtime/plan-runtime/{plan-runtime-service.mjs,plan-state-machine.mjs,plan-command-schemas.mjs,plan-command-envelope.mjs,plan-operation-idempotency.mjs}; execution-runtime/schemas/plan-execution-commands.schema.json; execution-runtime/test/plan-runtime/{plan-state-machine.test.mjs,plan-execution-cli.test.mjs,plan-command-schemas.test.mjs,plan-operation-idempotency.test.mjs}`

## Outcome

独立 canonical CLI 可通过严格 stdin schema 和纯状态机执行目录计划的全部查询及 mutation 命令，并对合法重试幂等返回、对非法顺序或身份零状态推进。

## Implementation Checklist

- [ ] 建立无 Git mutation 的纯 reducer，显式建模 run phase、task 子状态、多 claim、review/fix、integration、cleanup、blocked 和 terminal transition。
- [ ] 为每个 transition 校验 expected revision、run/task/session/claim、manifest/operation identity 和规范化 payload digest。
- [ ] 实现 `discover`、`prepare`、`status`、`claim-task` 和 `reclaim-task` 命令接口。
- [ ] 实现 `record-handoff`、`record-task-commit`、`begin-review`、`record-review` 和 `review-decision` 命令接口。
- [ ] 实现 `complete-review-fix`、`post-fix-decision`、`integrate-task` 和 `complete-task-conflict` 命令接口。
- [ ] 实现 `sync-main`、`complete-sync`、`integrate` 和 `cleanup` 命令接口。
- [ ] 统一 CLI identity options、成功 envelope、稳定错误码、可信状态摘要及 stdout/stderr 边界。
- [ ] 所有结构化 mutation payload 仅从 stdin 读取，并在 reducer 执行前完成 command schema、handoff envelope 和 checkpoint schema 校验。
- [ ] 保证 `discover`、`status` 及事实查询路径只读，不获取 mutation lock、不修改 checkpoint。
- [ ] 实现“相同 identity、相同 payload digest、相同已存结果”重试不增加 revision的幂等规则。
- [ ] 拒绝相同 identity 不同 payload、跨 phase 重放、旧 claim/session、envelope/payload 状态不一致及覆盖既有用户决定。
- [ ] 为全部命令建立表驱动合法边、非法边、幂等重试、revision 冲突和字节级零推进测试。
- [ ] 使用无 Git mutation fixture 将状态从 prepare 推进至 terminal。
- [ ] 运行本 task 的定向测试并记录结果，更新本 task checklist。

## Acceptance Criteria

- [ ] `plan-execution-cli.mjs` 暴露计划列出的全部 canonical 命令，且不通过旧 `execution-cli.mjs` 推进状态。
- [ ] 每条 mutation 都要求匹配的 `run_id`、`expected_revision` 及适用的 task/claim/session/manifest/operation identity。
- [ ] malformed stdin、schema 错误、非法 phase、旧身份和不一致 handoff 在 reducer 前或 transition 内失败，checkpoint 字节和 revision 不变。
- [ ] 合法重试返回已持久化结果且 revision 不增加；相同 operation 的不同 payload 被稳定拒绝。
- [ ] 多 claim 与 frontier barrier 在纯状态机中成立，下一 frontier 不会在当前 frontier 全部 integrated 前开放。
- [ ] `discover` 和 `status` 在成功及失败路径均不写 checkpoint。
- [ ] 无 Git fixture 可覆盖从 prepare 到 completed 的完整命令序列及 blocking 恢复分支。

## Verification Steps

- [ ] 运行 state machine 表驱动测试，预期每个合法和非法 transition 均有断言。
- [ ] 运行 CLI、command schema、envelope 和 idempotency 定向测试，预期全部通过。
- [ ] 对每条 mutation 重放相同请求，预期结果一致且 revision 不变。
- [ ] 对非法 phase、旧 claim/session、错误 revision、payload 替换和决定覆盖比较 checkpoint 前后字节，预期完全相同。
- [ ] 对 `discover`、`status` 执行前后检查 checkpoint 命名空间，预期无写入。
- [ ] 运行 task 01 的定向测试和现有 spec runtime 回归，预期无回归。

## Out of Scope

不执行或模拟真实 Git mutation，不实现 Git/worktree 事实采集、ReviewManifest 内容验证、代理模板、安装分发或跨进程临时 Git E2E。
