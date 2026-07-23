---
name: run-plan-to-completion
description: "执行已签署的实施计划，完成任务、评审、整合与执行记录提交。"
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# Run Plan to Completion

将由 `$write-plan` 写入的实施计划执行、评审并合并到 `main`。这是唯一的执行入口；它编排现有 module，而不在此重述其实现。生命周期所有权和硬性约束见 [执行架构](references/execution-architecture.md)。

## 前置条件

- 输入必须是 `<target-project>/.ai-work-flow/plans/<planId>/plan.md`；运行时从此路径推导 `planId`，并拒绝其他位置或兼容路径。
- 计划目录必须包含由 `$to-tasks` 写入的 `tasks/NN-<task-slug>.md`。
- 在 skill 目录运行 `npm run check:runtime`；安装与失败处理见 [运行时依赖](references/installation.md)。

## JSON 时间

执行计划和 Checkpoint 中的所有日期时间字段必须使用 `Asia/Shanghai`，以带 `+08:00` 偏移的 RFC 3339 格式写入或更新。不得写入 UTC `Z` 时间戳；schema 验证失败时停止流程。

## 1. 初始化

1. File Explorer 从 canonical `plan.md` 路径推导 plan ID；调用方 `planId` 不是输入，且不被信任。Full Stack Coder 使用调用方提供的执行分支。
2. 记录 baseline，并在该 baseline 创建执行 worktree。
3. 物化并验证 `execution-plan.json` 与 Checkpoint，但不提交。

**完成条件：** main 中的计划目录包含通过 schema 校验的执行计划与 Checkpoint，执行 worktree 干净。

## 2. 恢复

1. File Explorer 重新从必填 canonical `planPath` 推导 plan ID，再读取已有记录并按 [恢复完整性](references/recovery-integrity.md) 验证；`invalid` 时向 Coordinator 报告 diagnostics 并停止。
2. 仅在记录允许时复用或重建执行 worktree；路径变动时更新 Checkpoint。
3. 从有效 Checkpoint 的状态继续：`executing`、`reviewing`、`integrating` 或 `complete`。

**完成条件：** 返回有效 Checkpoint 和匹配的 worktree，或返回唯一、精确的 blocked 诊断。

## 3. 执行

1. Coordinator 按确定顺序逐项委派每个可执行 Frontier，直至 blocked、需要评审输入或全部任务完成。
2. `delegated` 使用 [Completion Adapter 协议](references/completion-protocol.md)；Coordinator 仅协调自动判定的低风险单任务给 Full Stack Coder。
3. Full Stack Coder 在 main 记录每个任务的终态并更新本地任务复选框；blocked 结果立即报告给 Coordinator。

**完成条件：** 所有任务为 `done` 时进入 `reviewing`；否则返回可恢复状态或 blocked 结果。

## 4. 评审与整合

1. Coordinator 在稳定差异后委派 Code Reviewer 完成 Standards 与需求两轴评审；用户确认的修复委派 Full Stack Coder。
2. Coordinator 仅在 `approved: true` 且 `findingsSummary` 非空时协调整合生命周期。
3. Full Stack Coder 完成执行记录的最终提交；Coordinator 汇总结果。

**完成条件：** main 包含唯一的执行记录提交；若合并后清理失败，保留 `merged` 并且下次只重试清理。
