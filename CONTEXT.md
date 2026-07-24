# 领域术语表

- **Checkpoint**：一次 execution plan 的持久化执行状态，用于恢复 execution。
- **Checkpoint format**：只接受当前格式；旧格式不迁移、不兼容、不降级，不能用于正常恢复。
- **Checkpoint integrity**：Checkpoint 与恢复所依赖执行事实的一致性；无法验证时，recovery 必须停止，且不得委派新的 ticket。
- **Execution plan**：由 ticket frontier 构成、可被执行和恢复的工作计划。
- **Ticket frontier**：当前可执行且其依赖已满足的一组 ticket；这些 ticket 在当前 execution 中严格顺序执行。
- **Managed content**：平台生成模块明确负责生成和更新的内容。
- **User content**：用户自行维护且平台生成模块不得改写的内容，即使其位于同一平台文件中。
- **Asset catalog**：生成所需角色资产的一致性目录；目录不完整或不一致时，生成必须在任何平台写入前停止。
- **Completion result**：一次 ticket 执行的终态结果；当前由文本协议传递，并决定 execution 是否可推进。
