# Agent 路由治理

`workflow-contract.json` 是 workflow、phase、action、owner、转换、预算和结果结构的唯一事实来源。Agent 每轮先读取 `WorkflowSnapshot`，只调度 `ready_actions`；重复 claim 使用已有 claim 或 canonical receipt。

Coding 和 Planning 在一次阶段授权后持续推进，直到 `complete`、`failed` 或一个 `decision_request`。只有无法从仓库事实、已批准规格或运行记录确定的实质性选择才请求用户决定。

Git mutation 仅由 Git Operator 串行执行，范围限本地 commit、worktree、fast-forward 整合和安全清理。禁止自动 push、stash、reset、clean、tag 或远端修改。主协调与审查角色不获得工作区写权限，只能通过 MCP `workflow_state` broker 写 Git common dir 的运行元数据。

完整审查上下文、验收证据和叶子结果写入 Git common dir 的 run artifacts。聊天与代理交接只传 `ArtifactRef` 或 `ReviewPacketRef`；响应损坏时通过 `status` 和 canonical receipt 恢复，不重新执行 action。

浏览器自动化、可见浏览器、E2E 或视觉检查仍需当前请求明确授权。暂态重试、recover、main resync 和 review fix 预算由 runtime 持久化，Agent 不在提示词中复制或重置。
