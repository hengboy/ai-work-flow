---
name: run-matt-spec-to-completion
description: Execute a canonical Spec/Ticket workflow to completion through the AI Work Flow runtime, including recovery, review, integration, and cleanup.
disable-model-invocation: true
---

# Run Canonical Spec To Completion

## 目标

以 canonical `<repository>/.scratch/<featureSlug>/spec.md` 为输入，通过唯一 runtime 状态入口执行全部 Ticket、最终双轴评审、整合和清理。目录式 `.ai-work-flow/plans/` 不属于本协议。

## 输入前置条件

- spec 同目录存在由 `to-tickets` 生成的 `issues/NN-<slug>.md`。
- 项目存在 `docs/agents/issue-tracker.md`；缺少时阻塞。
- 在 Skill 根目录运行 `npm run check:runtime`。依赖安装与失败处理只在需要时读取 [运行时依赖](references/installation.md)。
- runtime 固定为 `${XDG_CONFIG_HOME:-$HOME/.config}/ai-work-flow/execution-runtime/execution-cli.mjs`，它是 Execution plan 与 Checkpoint 的唯一 writer。
- 所有持久化时间使用 `Asia/Shanghai`、带 `+08:00` 的 RFC 3339，不使用 `Z`。

## Checkpoint 路由

先读取 runtime `status`，再只读取当前状态所需 reference：

| Checkpoint | 读取 | 唯一下一步 | 暂停条件 |
| --- | --- | --- | --- |
| 不存在 | `installation.md`、`execution-architecture.md` | `prepare` 初始化 | spec、issues、tracker 或 runtime 预检失败 |
| `invalid` | `recovery-integrity.md` | 报告 diagnostics | 不猜测、不降级、不重新派发 |
| `executing` 且有未完成 Ticket | `completion-protocol.md`、`execution-architecture.md` | claim/委派/record 最低未完成 Ticket | 现存 `in_progress` worker 无停止证据或 Ticket blocked |
| `executing` 且全部 Ticket done | `execution-architecture.md` | `sync-main` 后 `begin-review`；已有 fix/resync 记录时执行最终评审 | 同步冲突或 review bundle 无效 |
| `reviewing` | `execution-architecture.md` | 完成冻结 manifest 的双轴评审 | blocking findings 需要具体 IDs |
| `fixing` | `execution-architecture.md` | 完成获批修复并调用 `complete-review-fix` | 修复、checks 或追加提交无效 |
| `integrating` | `execution-architecture.md` | `integrate`，成功后 `cleanup` | `resync_required`、stash 授权或整合失败 |
| `complete` | 无 | 只报告最终结果 | 无 |

`complete-review-fix` 后自动执行同步和最终评审，不直接调用 integrate。最终评审再次出现 blocking findings 时进入用户门禁，只接受当前结果中的具体 finding IDs；不得自动循环修复。

## 确定性工作流

1. 初始化或恢复后连续处理最低未完成 Ticket。原生 worker 通过带 `role_id`、`session_id`、`claim_id` 的 canonical JSON Handoff 写入 `record-ticket`；不得把本提示词的通用子代理 JSON 代替 canonical schema。
2. 全部 Ticket done 后 `sync-main`；冲突交 Full Stack Coder 保留双方语义，Git Operator 创建解决提交，再 `complete-sync`。
3. `begin-review` 冻结 ReviewManifest。standards source 使用冻结 review commit 的 `CONTEXT.md`，spec bundle 使用 canonical spec、Ticket/issues 与当前可验证 runtime facts。两叶子接收相同 manifest/digest 和 bundle。
4. `record-review` 写入完整 Standards/Spec 结果与 coverage。无 blocking 自动整合；有 blocking 仅询问具体 IDs，并以 `review-decision fix` 记录。
5. 获批修复由 Full Stack Coder 实施验证、Git Operator 创建晚于 review commit 的提交；`complete-review-fix` 接收非空 checks。随后自动 `sync-main`、`begin-review` 和最终双轴评审。
6. 最终评审通过后 `integrate`。返回 `resync_required` 时重新同步并最终评审；主工作树有 execution record 之外改动时只在用户明确授权后使用 `--allow-stash true`。`merged` 后调用 `cleanup`。

各命令、记录所有权、ReviewManifest 和整合细节以 [执行架构](references/execution-architecture.md) 为准。恢复只按 [恢复完整性](references/recovery-integrity.md)；委派只按 [Completion Adapter 协议](references/completion-protocol.md)。

## 暂停条件

只在 blocking finding IDs、stash 授权、无法自动解决的冲突语义、活动 worker 无停止证据或不可恢复 diagnostics 时请求用户。已授权阶段之间不询问是否继续、是否提交或是否评审。

## 回复格式

- **结果：** 已完成阶段或最终结果。
- **状态：** 当前 Checkpoint、Ticket、评审或整合状态。
- **注意：** 可恢复状态与已确定下一步。
- **阻塞：** 唯一诊断及所需决定。
