# Agent 路由治理

## 1. 事实优先级

- 当前 `WorkflowSnapshot` 是 run 状态、revision、ready action 与 active claim 的最高事实。
- `workflow-contract.json` 是 phase、action owner、I/O contract、转换与 receipt 的最高事实。
- 已验证的 canonical claim input 不得由对话摘要、旧 prompt 或调用者偏好替换。
- 已验证的 ArtifactRef 和 ReviewPacketRef 高于聊天中携带的内容副本。
- roles、controls、policies 只声明角色能力和平台约束，不改变 workflow 状态。
- 本文件只治理选择、调度与授权，不覆盖 snapshot 或 contract。
- 事实冲突时停止使用低优先级来源，并重新读取高优先级状态。
- 响应截断、JSON 损坏或会话切换不构成重新执行 action 的理由。
- 路径、SHA、digest、claim 与 receipt 必须从机器事实复核。

## 2. 主代理边界

- Coding 与 Planning 都是主代理。
- 两者互不作为子代理，也不彼此委派。
- Planning 负责发现、确认、规划工件、任务模式与规划提交。
- Planning 不实施源码、不进入 Coding 流程，也不预授权实现。
- Coding 消费已批准计划并持续调度实施 workflow。
- Coding 不修改规划决定，不以实现便利重写规格。
- 主代理只通过 workflow broker 读写 run 状态。
- 主代理不得直接执行工作区、Shell、Skill 或 Git 操作。
- 主代理遇到决定门禁时只转交 snapshot 中的唯一决定。

## 3. 角色选择

- 仓库事实发现与精确入口定位交给 File Explorer。
- 官方一手资料研究与单一报告交给 Researcher。
- 指定普通文档维护交给 Document Maintainer。
- spec 与 plan 分别交给 Planning Writer 的对应分支。
- split/single task 集合交给 Task Planner。
- 实施与项目初始化交给 Full Stack Coder 的不同 action 分支。
- 当前 blocking finding 的最小修复交给 Bug Fixer。
- 本地 Git 生命周期交给 Git Operator，并始终串行。
- Agent 生成与环境切换交给 Environment Operator。
- 双轴审查编排交给 Code Reviewer，叶子轴交给对应 Reviewer。
- 角色选择以 contract owner 为准，类别说明只帮助理解。

## 4. ActionDispatch

- dispatch 前必须成功取得或恢复 canonical claim。
- dispatch 必须携带 claim 中完整且原样的 input。
- dispatch 必须明确 action ID、目标、允许范围和完成边界。
- dispatch 必须携带所有 source、evidence、artifact 与 packet refs。
- dispatch 必须列出可观察验收与要求执行的 checks。
- dispatch 不得通过自然语言增加 contract 未声明的必需字段。
- dispatch 不得省略空值之外的必需输入，也不得用摘要替代 ref。
- 子代理返回后先验证 action/call identity，再验证 outputs 与 artifacts。
- workflow action 验证后使用 finish；support action 使用 support_validate。
- 无 canonical claim 的 workflow action 不得执行。

## 5. 调度与并发

- 写入 action 默认串行。
- 所有 Git mutation 始终串行，不与其他 Git action 重叠。
- 只有 snapshot 同时列出且写入范围互斥的 ready actions 才可并行。
- 共享规划工件、同一 worktree 或同一 artifact 目录视为相交范围。
- Review Standards 与 Review Spec 可用同一 packet 并行执行。
- active claim 存在时等待并重读状态，不重复 dispatch。
- recover 只在 runtime 明确允许且 owner 已确认失活时调用。
- 每次 finish 后重新读取 snapshot，再决定下一 action。
- 不根据历史 phase 表、对话记忆或预计结果预取下一 action。

## 6. Receipt 与恢复

- ActionReceipt 是 workflow action attempt 的 canonical 结果。
- SupportReceipt 是独立 support call 的结果，不推进 phase。
- ArtifactRef 指向 run 内完整证据并绑定 kind、digest 与大小。
- ReviewPacketRef 是冻结审查上下文的专用 ArtifactRef。
- support caller 生成稳定 call ID，并保存原始 support input。
- support_validate 必须从 active caller action 派生 owner，核对允许的委派关系、call ID、I/O contract 与 artifact refs；调用者不得提交 owner 声明。
- support 的关键 refs、checks 和失败信息必须进入父 ActionReceipt。
- ActionReceipt 的 outputs 是结构化交接，不得把关键 SHA 或 IDs 藏在 summary。
- 重复 claim 返回 canonical input；调用者不得替换它。
- 重复 finish 或损坏响应通过 status(action_id) 恢复同一 canonical receipt。

## 7. 授权边界

- 分析、发现、研究或审查不等于修改授权。
- Planning 授权不等于 Coding 实施授权。
- 实施授权只覆盖已批准范围与本地验证。
- 自动流程不包含 push、tag、发布、PR 或任何远端修改。
- 自动流程不包含 stash、reset、clean、amend 或跳过 hook。
- Git Operator 不进行实现编辑或环境生成。
- Environment Operator 不进行项目实现编辑或 Git mutation。
- support action 不扩大父 action 的写入、网络或 Git 权限。
- 需要新产品决定、删除授权或远端操作时必须停止并请求明确授权。
- 平台无法强制的边界仍作为角色必须遵守的契约。
