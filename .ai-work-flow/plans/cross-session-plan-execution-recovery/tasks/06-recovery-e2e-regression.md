# 06 - Recovery E2E and full regression

- task_id: `plan-recovery-e2e-regression`
- order: `06`
- blocked_by: `plan-agent-install-documentation`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `execution-runtime/test/e2e/plan-execution-recovery.e2e.test.mjs; execution-runtime/test/e2e/plan-execution-interruptions.e2e.test.mjs; execution-runtime/test/e2e/plan-execution-negative.e2e.test.mjs; execution-runtime/test/e2e/plan-execution-installation.e2e.test.mjs; execution-runtime/test/fixtures/plan-execution-e2e/; test/plan-execution-full-regression.test.mjs; package.json`

## Outcome

目录计划 runtime 通过完整临时 Git E2E、中断恢复矩阵、负向身份攻击、三平台隔离安装和全仓兼容性回归，证明 T1-T10 可作为发布门禁。

## Implementation Checklist

- [ ] 建立完整临时 Git harness，隔离 repo、Git common dir、HOME、XDG_CONFIG_HOME、refs、worktree 和 checkpoint。
- [ ] 覆盖单 synthetic task、多个拆分 task、同 frontier 并发 claim 与严格串行 Git mutation。
- [ ] 覆盖 task review、blocking fix、`re-review`、`continue`、task conflict、main sync conflict、final review、ff-only integration 和 cleanup。
- [ ] 在 claim 落盘后设置进程终止点并由新进程执行 status/reclaim 恢复。
- [ ] 在 handoff 生成前后及保存后设置终止点，断言不重复 FSC 派发或 handoff。
- [ ] 在 task commit 已创建未登记处设置终止点，断言只补记已有 commit。
- [ ] 在 begin-review、部分/完整 record-review 和用户决定后设置终止点，断言复用 manifest/findings/decision。
- [ ] 在 task merge、main sync、final fast-forward 前后设置终止点，断言不重复 Git 操作。
- [ ] 在 cleanup 部分完成处设置终止点，断言仅继续清理剩余可信资源并保留 terminal checkpoint。
- [ ] 覆盖零/唯一/多个 discovery 候选、terminal 排除、新 planning commit 和显式旧平铺计划。
- [ ] 覆盖人工 reclaim、dirty worktree 保持、旧 claim handoff 拒绝和无 checkpoint 旧现场保留。
- [ ] 注入损坏/旧 schema、digest/commit/common-dir 不匹配、活动锁、branch/worktree 身份异常和 ancestry 攻击。
- [ ] 注入 path boundary、symlink、scope 越界、review coverage 缺失、main 漂移、非快进及 cleanup 未知资源攻击。
- [ ] 对所有负向场景断言 checkpoint 字节/revision 不变，且无新 claim、ref、worktree 或现场破坏。
- [ ] 在临时 HOME/XDG_CONFIG_HOME 中运行三平台完整安装及事务失败 E2E。
- [ ] 运行新 runtime 全部定向单元/集成测试，并确认前五项测试仍独立覆盖各自核心能力。
- [ ] 运行仓库根 `npm test`、旧 runtime 测试和 `npm run check:runtime`。
- [ ] 运行 agent 模板、installer、三平台生成和事务测试。
- [ ] 运行 `git diff --check` 并核对实际变更范围。
- [ ] 汇总 T1-T10 对应测试证据，更新本 task checklist。

## Acceptance Criteria

- [ ] 单 task、多 task、并发 frontier、评审修复、冲突、同步、final integration 和 cleanup 的端到端路径全部通过。
- [ ] 每个规定中断点均可由新进程恢复，不重复派发、commit、manifest、finding、merge 或 fast-forward。
- [ ] 只有补记新外部事实时 revision 增加一次；幂等重试和所有负向路径均保持 checkpoint 字节不变。
- [ ] 活动 claim、dirty/旧现场、未知资源、身份攻击和损坏 checkpoint 均 fail closed 且现场保持。
- [ ] 三平台隔离安装包含完整 runtime/schema/template，事务失败无部分安装且真实全局目录不变。
- [ ] T1-T10 均有可执行测试证据，前五项单元及集成测试没有被 E2E 替代。
- [ ] 根 `npm test`、旧 runtime 测试、`check:runtime`、agent/installer 定向测试和 `git diff --check` 全部通过。
- [ ] 现有 `execution-cli.mjs`、spec checkpoint/schema 和用户现场行为无回归。

## Verification Steps

- [ ] 运行新增 plan runtime 单元及临时 Git E2E 命令，预期全部通过。
- [ ] 运行完整中断矩阵，预期每个恢复点满足无重复副作用和精确 revision 断言。
- [ ] 运行 discovery、reclaim、dirty site 和完整负向攻击矩阵，预期全部 fail closed。
- [ ] 在临时 HOME/XDG_CONFIG_HOME 下运行三平台安装和事务失败注入，预期隔离及原子性断言通过。
- [ ] 在仓库根运行 `npm test`，预期通过。
- [ ] 在 `skills/run-matt-spec-to-completion/` 运行 `npm test`，预期通过。
- [ ] 在 `skills/run-matt-spec-to-completion/` 运行 `npm run check:runtime`，预期通过。
- [ ] 运行现有 agent 模板、生成、installer 和事务定向测试，预期通过。
- [ ] 运行 `git diff --check`，预期无 whitespace error。
- [ ] 将测试结果映射到 T1-T10，预期无缺失测试组。

## Out of Scope

不新增前五项未实现的核心能力，不用 E2E 替代模块单元或集成测试，不执行真实全局安装、push、远端操作或旧 checkpoint 迁移，也不修改本功能以外的无关代码。
