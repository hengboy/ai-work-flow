# 04 - Review integration and cleanup recovery

- task_id: `plan-review-integration-cleanup`
- order: `04`
- blocked_by: `plan-git-task-recovery`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `execution-runtime/plan-runtime/{plan-runtime-service.mjs,plan-review-manifest.mjs,plan-review-decisions.mjs,plan-task-integration.mjs,plan-main-sync.mjs,plan-final-integration.mjs,plan-cleanup.mjs}; execution-runtime/test/plan-runtime/{plan-review-manifest.test.mjs,plan-review-decisions.test.mjs,plan-task-integration.test.mjs,plan-main-sync.test.mjs,plan-final-integration.test.mjs,plan-cleanup.test.mjs,plan-review-integration-git.test.mjs}; execution-runtime/test/fixtures/plan-review-integration/`

## Outcome

task/final 双轴评审、修复决定、逐 task integration、main sync、ff-only final integration 和 cleanup 均由冻结事实驱动，并可在冲突或进程中断后幂等恢复。

## Implementation Checklist

- [ ] 生成版本化 ReviewManifest，冻结 scope、base/head、完整 commit range、文件 digest、双轴 coverage、验收项和 operation ID。
- [ ] 分离 task 与 final manifest identity；中断时复用同一 generation，不静默重算范围。
- [ ] 校验增量 coverage、稳定 finding ID、severity、axis、location、evidence 和 disposition。
- [ ] 只有 coverage 完整时完成 review；blocking finding 强制进入 fix gate。
- [ ] 持久化用户明确确认的 finding IDs 和 review decision，禁止代理默认决定或覆盖既有决定。
- [ ] 验证 task/final 修复 commit、处理 finding IDs、路径范围和完整新增 committed range。
- [ ] 实现 `post-fix-decision` 的 `re-review` 与 `continue`；前者创建下一代完整 manifest，后者跳过自动复审。
- [ ] 按 task 编号实现串行 integration，并在整个 frontier integrated 后才开放下一 frontier。
- [ ] 观察和补记已发生未登记的 task merge；冲突时持久化预期 identity 而不标记 integrated。
- [ ] 验证 FSC 冲突解决 commit 的 parents、scope、ancestry 和无残留冲突，再完成 task integration。
- [ ] 实现 main sync 预期 refs/commit 校验、冲突状态和已发生未登记的 `complete-sync` 恢复。
- [ ] 在全部 task integrated 且 main sync 完成后开放 final review。
- [ ] 实现 final ff-only integration，拒绝 main 漂移、非快进和 review head 不匹配。
- [ ] 实现 cleanup 资源归属、状态和 dirty 校验，仅清理 checkpoint 明确拥有且允许清理的资源。
- [ ] 保留 terminal checkpoint、blocked 现场、dirty worktree 及所有未知资源，并支持 cleanup 重复观察。
- [ ] 添加 review/fix、task conflict、main sync、final integration 和 cleanup 的单元及临时 Git 集成测试。
- [ ] 运行本 task 的定向测试并记录结果，更新本 task checklist。

## Acceptance Criteria

- [ ] task/final manifest 的范围、digest 和 coverage 冻结不可变；中断重试返回同一 manifest generation。
- [ ] blocking finding 未修复或缺少显式用户决定时，task/final 不能进入 integration。
- [ ] 修复后 `re-review` 覆盖新的完整 committed range，`continue` 明确进入后续 gate 且不自动复审。
- [ ] task 严格按编号汇入，frontier barrier 不可绕过；冲突未验证解决前不得标记 integrated。
- [ ] task merge、main sync 和 final fast-forward 已发生未登记时可由唯一事实补记，且不重复 merge 或移动 ref。
- [ ] final integration 仅接受验证后的 ff-only；main 漂移、非快进或 review head 不匹配时保留 feature 和 checkpoint。
- [ ] cleanup 仅移除可信且干净的 owned 资源，保留 terminal checkpoint、dirty/blocked/未知现场，并可安全重复调用。

## Verification Steps

- [ ] 运行 ReviewManifest、review decision 和 fix flow 定向测试，预期 task/final 双轴与两种 post-fix 分支全部通过。
- [ ] 在临时 Git 仓库中验证多 task 按编号 integration、frontier barrier、task conflict 及解决提交校验。
- [ ] 分别在 task merge、main sync、final fast-forward 已发生未登记处终止并恢复，预期只补记一次。
- [ ] 注入 incomplete coverage、finding ID 冲突、main 漂移、异常 parents/ancestry、非快进和残留 conflict，预期零状态推进。
- [ ] 对 cleanup 注入 dirty、未知和归属不明资源，预期全部保留并在结果中报告。
- [ ] 运行 task 01-03 定向测试及旧 runtime 回归，预期无回归。

## Out of Scope

不更新代理模板、README、导航、安装资产或三平台生成契约；不承担完整跨模块中断矩阵和全仓最终回归。
