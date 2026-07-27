# 领域术语表

- **Checkpoint**：一次 execution plan 的持久化执行状态，用于恢复 execution。
- **Checkpoint format**：只接受当前格式；旧格式不迁移、不兼容、不降级，不能用于正常恢复。
- **Checkpoint integrity**：Checkpoint 与恢复所依赖执行事实的一致性；无法验证时，recovery 必须停止，且不得委派新的 ticket。
- **Execution plan**：由 ticket frontier 构成、可被执行和恢复的工作计划。
- **Ticket frontier**：当前可执行且其依赖已满足的一组 ticket；这些 ticket 在当前 execution 中严格顺序执行。
- **Managed content**：平台生成模块明确负责生成和更新的内容。
- **User content**：用户自行维护且平台生成模块不得改写的内容，即使其位于同一平台文件中。
- **Asset catalog**：生成所需角色资产的一致性目录；目录不完整或不一致时，生成必须在任何平台写入前停止。
- **Completion result**：嵌入 JSON Handoff envelope `payload` 的 Ticket 终态结果，包含 Ticket ID、`done`/`blocked` 状态、提交、检查、摘要及 blocked error。
- **Canonical runtime**：`execution-runtime/execution-cli.mjs` 是唯一状态转换入口；`record-ticket` 只从 stdin 接收经 schema 校验、且 envelope 与 payload 状态一致的 JSON Handoff。
- **Feature lock**：同一 feature 的 mutating runtime command 共享的跨进程锁；失效锁可恢复，活动锁会阻止并发 mutation。
- **Capability level**：平台能力矩阵的真实级别；只有平台实际强制的约束标为 `enforced`，其余明确标为 `instruction-only` 或 `unsupported`。
- **Transaction log**：环境生成和切换的持久化恢复输入；恢复前必须按受信根、target、backup、类型和符号链接策略完整验证。非法或身份不明的日志保留现场并停止，不作为可执行指令。
