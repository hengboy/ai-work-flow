# 05 - Agent contracts installation and documentation

- task_id: `plan-agent-install-documentation`
- order: `05`
- blocked_by: `plan-review-integration-cleanup`
- source_plan: `../plan.md`
- source_plan_digest: `44a3f8685cc127d73b626796d5e66a38b285eeb36887df7f5ad2d3c1b34fabf7`
- write_scope: `agent-build/templates/{coding.md,git-operator.md,full-stack-coder.md,code-reviewer.md}; README.md; CONTEXT.md; .ai-work-flow/index/feature-navigation.md; execution-runtime/plan-execution-reference.md; agent-build/**/asset-catalog*; agent-build/**/transaction*; agent-build/**/platform*; agent-build/test/**; test/**/agent*; test/**/installer*; test/**/platform*`

## Outcome

四角色编排契约、README/CONTEXT/导航/reference、安装资产和三平台生成物形成与 canonical runtime 一致且可隔离验证的发布单元。

## Implementation Checklist

- [ ] 更新 Coding 模板，要求目录计划执行前调用 discover/prepare/status，并仅依据可信 status 编排 frontier。
- [ ] 明确 Coding 按宿主容量并发委派同 frontier task，但不执行 Git/runtime mutation或直接编辑 checkpoint。
- [ ] 规定活动 claim 必须取得用户确认后由 Git Operator reclaim，不凭会话记忆重复派发。
- [ ] 更新 Git Operator 模板，规定其为唯一 plan runtime mutation 和 Git mutation 执行者，并使用固定命令、stdin payload 和串行队列。
- [ ] 保持 Git Operator 无普通源码、计划、task 或冲突文件编辑权限，并声明禁止 push、stash、amend、reset 和 clean。
- [ ] 更新 Full Stack Coder 模板，要求委派绑定 run/task/session/claim/worktree/write scope。
- [ ] 规定 FSC 恢复模式保留原现场、重新运行 Verification，并返回 envelope/payload 一致的结构化 handoff。
- [ ] 更新 Code Reviewer 模板，要求只读冻结 manifest/range/digest/coverage，支持 task/final 双轴及既有 findings。
- [ ] 明确 reviewer 不改变 scope、不修复代码、不调用 mutation、不推断用户决定。
- [ ] 更新 README、CONTEXT 和 feature navigation，说明新会话入口、输入优先级、发现消歧、旧平铺限制、人工 reclaim、脏现场、fail-closed 和 terminal 排除。
- [ ] 编写 runtime reference，逐项记录命令 phase、identity、stdin schema、持久化结果、幂等及错误语义。
- [ ] 明确 plan runtime 与 spec runtime 并存、schema 不互通且仅支持同一 common dir/工作区恢复。
- [ ] 将完整 `execution-runtime/`、schema 和四角色模板纳入 asset catalog、完整性校验及事务复制计划。
- [ ] 更新三平台生成和安装期望，确保 runtime/schema/template 同版本发布且安装前完成资产校验。
- [ ] 记录安装后仅新会话加载新代理契约，不假定既有会话热更新。
- [ ] 添加模板静态断言、CLI/reference 对照、asset 缺失和事务失败测试。
- [ ] 在临时 HOME/XDG_CONFIG_HOME 中执行三平台隔离安装测试，断言不接触真实全局安装。
- [ ] 运行本 task 的定向测试并记录结果，更新本 task checklist。

## Acceptance Criteria

- [ ] 四角色模板覆盖全部 runtime 命令、权限边界、恢复入口、人工决定和禁止行为，不存在绕过 canonical runtime 的状态推进说明。
- [ ] README、CONTEXT、导航和 reference 对 plan/spec runtime 的入口、隔离边界及 fail-closed 语义描述一致。
- [ ] reference 中每个命令均可与 CLI help、command schema 和持久化对象对照。
- [ ] asset catalog 在任何平台写入前验证 CLI、schema、依赖模块和四角色模板完整性。
- [ ] 三平台临时安装生成物包含一致的新 runtime 和代理契约；任一资产缺失或事务中断均不留下部分安装。
- [ ] 隔离安装测试不修改真实 HOME、真实 XDG_CONFIG_HOME 或全局 AI Work Flow 安装。
- [ ] 现有角色委派拓扑和旧 spec runtime 文档行为保持兼容。

## Verification Steps

- [ ] 运行四角色模板静态断言，预期命令、权限、reclaim、review 和禁止 Git 行为全部匹配。
- [ ] 运行 CLI help/schema/reference 对照测试，预期不存在缺失、拼写漂移或未记录命令。
- [ ] 在临时 HOME/XDG_CONFIG_HOME 中运行三平台生成和安装测试，比较 runtime/schema/template 资产。
- [ ] 注入 asset catalog 缺失和事务中途失败，预期目标目录无部分版本。
- [ ] 检查测试前后真实全局安装目录，预期无变化。
- [ ] 运行 task 01-04 定向测试、现有 agent/installer 测试及旧 runtime 回归，预期无回归。

## Out of Scope

不改动 Planning/Task Planner 的计划生成流程，不执行真实全局安装，不新增 runtime 状态行为，也不以文档或静态测试替代前置模块的单元和 Git 集成测试。
