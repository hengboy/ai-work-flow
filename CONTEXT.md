# 领域术语表

- **Managed content**：平台生成模块明确负责生成和更新的内容。
- **User content**：用户自行维护且平台生成模块不得改写的内容，即使其位于同一平台文件中。
- **Asset catalog**：生成所需角色资产的一致性目录；目录不完整或不一致时，生成必须在任何平台写入前停止。
- **ReviewManifest**：普通目录式 Coding 审查使用的不可变清单，冻结提交端点、PathChange、来源、分片、检查与摘要。
- **Capability level**：平台能力矩阵的真实级别；只有平台实际强制的约束标为 `enforced`，其余明确标为 `instruction-only` 或 `unsupported`。
- **Transaction log**：环境生成和切换的持久化恢复输入；恢复前必须按受信根、target、backup、类型和符号链接策略完整验证。非法或身份不明的日志保留现场并停止，不作为可执行指令。
