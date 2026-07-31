# 03 - Git task execution and recovery

- task_id: `plan-git-task-recovery`
- order: `03`
- blocked_by: `plan-state-machine-canonical-cli`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `execution-runtime/plan-runtime/{plan-runtime-service.mjs,plan-git-facts.mjs,plan-worktree-claims.mjs,plan-handoff-integrity.mjs,plan-task-commit.mjs,plan-task-recovery.mjs}; execution-runtime/test/plan-runtime/{plan-git-facts.test.mjs,plan-worktree-claims.test.mjs,plan-handoff-integrity.test.mjs,plan-task-commit.test.mjs,plan-task-recovery-git.test.mjs}; execution-runtime/test/fixtures/plan-task-recovery/`

## Outcome

runtime 可在临时 Git 仓库中验证 task branch/worktree、claim/reclaim、FSC handoff 和 task commit 事实，并在不破坏脏现场的前提下恢复已发生但未登记的 task 执行边界。

## Implementation Checklist

- [ ] 实现只读 Git facts adapter，采集和验证 repo/common dir、refs、worktree registration/path、branch ownership、HEAD、tree、parents、ancestry、dirty paths 和 merge state。
- [ ] 校验每个 frontier 的冻结 feature HEAD，并验证同 frontier task branch/worktree 均从该 HEAD 建立。
- [ ] 将 branch/worktree 创建结果与 checkpoint 中预期 operation 和确定性 identity 绑定，拒绝随机后缀或未知同名资源。
- [ ] 完成 `claim-task` 的 Git 前置和结果事实验证，同时保持 Git mutation 串行。
- [ ] 完成 `reclaim-task` 的显式用户确认、旧 claim 作废和新 claim 生成流程，不重建原 worktree。
- [ ] reclaim 前验证 branch、worktree、base/start、HEAD ancestry 和 dirty path scope；无法证明时保留现场并阻塞。
- [ ] 校验 FSC JSON Handoff envelope 与 completion payload 的 run/task/session/claim、状态、Verification 和摘要一致性。
- [ ] 拒绝旧 claim handoff、scope 越界、状态不一致及不可信 blocked/done payload。
- [ ] 验证 task commit 的 branch、tree、parents、ancestry 和变更路径范围。
- [ ] 支持 task commit 已创建但未登记时，通过唯一匹配的 Git 事实幂等补记且不重复 commit。
- [ ] status 展示旧 claim/session/worktree/start/base、dirty 现场摘要和 reclaim 所需确认。
- [ ] 为活动 claim、人工 reclaim、dirty worktree、旧现场、路径越界、branch 移动和 commit 改写建立临时 Git 测试。
- [ ] 断言所有恢复测试不调用 reset、clean、stash、amend、覆盖 checkout 或删除脏 worktree。
- [ ] 运行本 task 的定向测试并记录结果，更新本 task checklist。

## Acceptance Criteria

- [ ] 同 frontier 的多个 task 可拥有独立 claim/worktree，并均绑定同一冻结 feature HEAD；Git mutation 仍按 operation 串行登记。
- [ ] 活动 claim 在没有显式用户确认时不能 reclaim，确认后旧 claim 作废且新 claim identity 唯一。
- [ ] reclaim 保持原 worktree、未提交内容、refs 和可观察现场不变，并要求恢复 FSC 重新执行冻结 Verification。
- [ ] handoff 只能由匹配活动 claim 且 envelope/payload 状态一致的结果登记。
- [ ] 已创建未登记的 task commit 可由唯一事实补记一次；重复调用不产生新 commit或 revision。
- [ ] branch/worktree/base/HEAD/parent/ancestry/scope 任一异常均 fail closed，且无新 claim、ref、worktree 或现场破坏。
- [ ] 无可信 checkpoint 的疑似旧 branch/worktree 被保留并作为阻塞报告，不被采用、删除或改名。

## Verification Steps

- [ ] 运行 Git facts、worktree claims、handoff integrity 和 task commit 单元测试，预期全部通过。
- [ ] 在临时 Git 仓库中创建同 frontier 多 claim，预期各 task 使用同一冻结 feature HEAD 且拥有独立确定性 worktree。
- [ ] 在活动 claim、确认 reclaim、dirty reclaim 和旧 claim handoff 重放场景中检查 checkpoint、文件内容及 refs。
- [ ] 在 commit 创建后、登记前终止进程并由新进程恢复，预期只补记已有 commit。
- [ ] 注入越界 dirty path、symlink、branch 移动、parent/tree/ancestry 不匹配，预期 revision 和 checkpoint 字节不变。
- [ ] 运行 task 01-02 定向测试及旧 runtime 回归，预期无回归。

## Out of Scope

不实现 task/final ReviewManifest、findings 决策、task merge、main sync、final integration、cleanup、代理契约或安装资产；本 task 的临时 Git 测试只覆盖 task 执行和提交边界。
