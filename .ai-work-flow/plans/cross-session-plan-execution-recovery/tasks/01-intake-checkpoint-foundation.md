# 01 - Plan intake and checkpoint foundation

- task_id: `plan-intake-checkpoint-foundation`
- order: `01`
- blocked_by: `none`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `execution-runtime/plan-runtime/{plan-intake.mjs,plan-task-graph.mjs,plan-identity.mjs,plan-checkpoint-schema.mjs,plan-checkpoint-store.mjs,plan-run-lock.mjs,plan-path-integrity.mjs}; execution-runtime/schemas/plan-execution-checkpoint.schema.json; execution-runtime/test/plan-runtime/{plan-intake.test.mjs,plan-task-graph.test.mjs,plan-identity.test.mjs,plan-checkpoint-schema.test.mjs,plan-checkpoint-store.test.mjs,plan-run-lock.test.mjs,plan-path-integrity.test.mjs}`

## Outcome

目录计划可从显式输入或自动发现结果确定性地解析、冻结为合法 task graph，并以独立版本化 schema、run identity、锁和原子 store 创建或读取可信 checkpoint。

## Implementation Checklist

- [ ] 实现显式 `plan.md`、计划目录、plan ID 和无显式输入自动发现的固定优先级及 canonical 仓库相对路径归一化。
- [ ] 实现零、唯一、多个候选结果，限制自动发现为目录式计划，旧平铺计划仅允许显式输入，并排除相同 run 的 terminal checkpoint。
- [ ] 从 planning commit 读取和校验计划工件，拒绝未提交、内容漂移或无法唯一归属的 plan/task 版本。
- [ ] 解析目录式 task 文件并冻结全部契约字段；支持无 `tasks/` 时的 synthetic task，拒绝空目录及非法 task 文件。
- [ ] 校验连续编号、唯一 task ID、仅向后依赖、引用完整、无环、source digest 和字段完整性。
- [ ] 计算 frontier，并保守校验同 frontier 规范化 `write_scope` 互斥关系。
- [ ] 实现 repo、Git common dir、计划根及 `.worktrees/` 允许根的 realpath/lstat 分段边界和 symlink 拒绝。
- [ ] 由 canonical plan path、planning commit 和版本域生成确定性 run、feature branch、task branch 与 worktree identity。
- [ ] 定义仅接受当前版本的 plan checkpoint schema，覆盖 run、task、claim、review、Git、integration、cleanup、blocked 和 terminal 字段。
- [ ] 建立与 spec runtime 隔离的 Git common-dir checkpoint 命名空间及 revision 模型。
- [ ] 实现临时文件、文件和目录 fsync、原子 rename；失败时保留原 checkpoint 字节。
- [ ] 实现带 run、进程、主机、session、时间和 owner token 的跨进程锁，仅接管可证明失效且身份完全匹配的锁。
- [ ] 添加 intake、graph、identity、path、schema、store 和 lock 单元测试，包括原子写失败注入。
- [ ] 运行本 task 的定向测试并记录结果，更新本 task checklist。

## Acceptance Criteria

- [ ] 相同 canonical plan path 与 planning commit 总是生成相同 run/branch/worktree identity，新 planning commit 生成不同 run。
- [ ] 显式输入优先级、零/唯一/多候选、旧平铺仅显式及 terminal run 排除均返回稳定结构化结果。
- [ ] 缺失 `tasks/` 生成一个完整 synthetic task；空目录、非法格式、错误 digest、非法依赖或 scope 相交在创建 claim/worktree 前阻塞。
- [ ] 有效 checkpoint 可完成当前 schema round trip；未知版本、spec checkpoint、损坏 JSON 和身份不匹配均被拒绝。
- [ ] 活动锁阻止 mutation；只有 owner 不存在且 token/run/path 全部匹配的锁可被接管。
- [ ] 并发写入及 fsync/rename 失败不会产生半写 checkpoint，失败后旧 checkpoint 字节和 revision 不变。
- [ ] 新实现不改变现有 `execution-cli.mjs`、spec schema、checkpoint 路径或命令行为。

## Verification Steps

- [ ] 运行 plan intake、task graph、identity 和 path integrity 定向单元测试，预期全部通过。
- [ ] 运行 checkpoint schema、store 和 run lock 定向单元测试，预期 round trip、并发和失败注入用例全部通过。
- [ ] 使用只读 Git fixture 验证零/唯一/多个候选、旧平铺、synthetic task、terminal 排除和 planning commit 变化。
- [ ] 对非法 graph、scope 前缀覆盖、symlink 逃逸、旧 schema、损坏 checkpoint 和活动锁断言非零结果且无 claim、worktree 或部分 checkpoint。
- [ ] 运行现有 spec runtime 定向测试，预期行为无变化。

## Out of Scope

不实现状态转换命令、Git mutation 事实登记、评审流程、代理模板、安装资产或跨模块 E2E；除经双套回归证明安全的小型稳定原语外，不重构旧 runtime。
