# AI Work Flow 全量修复与优化计划

## Summary

采用分阶段兼容策略，继续支持现有 `version: 1` 配置。实施顺序为：安全修补 → Environment 原子激活 → Policy 与风险路由 → 结构化交接。

成功标准：

- 非法 Environment 名称和配置内容无法逃逸路径或注入平台 frontmatter。
- 环境切换失败或进程中断后，不会留下 marker 与 agents 不一致的混合状态。
- 三个平台明确报告哪些权限是强制执行、哪些仅靠指令。
- 简单任务走短路径，高风险任务保留确认门禁。
- 子代理交接能通过统一 JSON envelope 验证并由主代理转写。

## Implementation Changes

### 阶段 A：安全 normalization

- 新建配置解析 module，统一处理 Environment 名称、配置合并、字段验证和来源诊断。
- 自定义环境名限制为 1–64 位字母、数字、点、下划线或连字符；拒绝 `.`、`..`、路径分隔符、控制字符、绝对路径和符号链接逃逸。
- 默认环境继续要求所有角色、所有平台配置完整；非默认 Environment 允许按角色、平台和字段局部覆盖。
- `opencode.options` 作为不透明对象整体替换，不进行递归合并；显式 `null` 保留其覆盖语义。
- 拒绝未知角色、未知平台字段、非有限 JSON 值以及 model、variant 中的换行或控制字符。
- Claude/OpenCode frontmatter 的所有动态标量统一安全序列化，禁止直接字符串插值。
- 为路径逃逸、换行注入、未知字段和恶意 marker 增加回归测试，作为第一批独立发布。

### 阶段 B：Environment 激活生命周期

- `env use <name>` 改为完整 activation：解析 → 验证 → 生成计划 → dry-run 预览 → 暂存 → 激活 → 清理。
- 安装器记录当前受管平台；`env use` 默认更新全部受管平台，不允许只切 marker。
- 新增 `env status`，显示当前环境、resolved config digest、各平台生成 digest、能力警告和漂移状态。
- 为写入计划增加事务日志、同目录临时文件和备份；失败时逆序恢复，进程中断后由下一次命令先恢复未完成事务。
- 删除操作先重命名为备份，全部写入成功后才清理；用户内容和非受管 agents 始终保留。
- `env create` 保持当前完整复制行为，并增加 `--minimal` 创建空 overlay；现有环境文件无需迁移。
- `validate` 默认验证全部平台；`generate --platform` 只要求目标平台可生成，但仍检查全局结构和未知字段。

### 阶段 C：Policy、入口与风险路由

- 用一个 Policy catalog 取代 `workspace` 的模糊抽象，声明 filesystem、shell、network、browser、git、write scope 和 delegation capabilities。
- 平台 adapter 输出 `enforced`、`instruction-only` 或 `unsupported` 能力矩阵；可配置却发生越权映射时生成失败，平台本身无法表达的限制明确警告。
- 共享规则只保留在生成后的 routing 中；角色正文删除重复规则，避免策略漂移。
- Codex、Claude Code、OpenCode 对项目读写任务默认转交 Orchestrator；纯问答或用户明确指定原生模式时允许绕过。
- 路由分为纯问答、只读发现、局部可逆写入、广泛或高风险操作四档。只有后两档要求方案或授权确认。
- 导航索引改为优先证据而非绝对门禁：索引命中先使用；过期或缺失时允许目标 module 内聚焦搜索，跨 module 才委派 File Explorer。
- 同一 worktree 保持单 writer；只有独立 worktree、明确文件所有权和确定合并顺序时允许并行。
- 共享或脏 worktree 提交前展示最终文件快照并确认一次；AI 创建且基线干净的隔离 worktree 允许按已批准计划自动提交。
- 本地开发地址的无头 E2E、截图可自动运行；可见浏览器、登录态和外部站点继续要求明确授权。
- 评审发现全部交给用户选择，不增加自动修复循环；发生修复后允许对新差异重新评审。

### 阶段 D：结构化结果

- 增加通用 Handoff result envelope：`role_id`、`status`、`summary`、`artifacts`、`checks`、可选 `error` 和类型化 payload；人类回复由该结果渲染。
- 更新 `CONTEXT.md`、README、Skill 文档和项目导航索引，记录 Policy decision、Environment activation、Handoff result 等术语。

## Public Interfaces

- 配置版本保持 `1`；完整默认配置与稀疏 Environment overlay 同时受支持。
- `env use` 从“只切 marker”变为事务化激活；`env status` 和 `env create --minimal` 为新增命令。
- Handoff schema 使用 `additionalProperties: false`；`blocked` 必须包含 error，`done` 禁止 error。
- 所有 persisted path 使用仓库相对路径；所有 Environment path 必须是 environments 目录的直接子文件。

## Test Plan

- 保留现有 86 项测试，并逐阶段保持全绿。
- 覆盖 `../`、绝对路径、反斜杠、控制字符、符号链接和 frontmatter 换行注入。
- 覆盖稀疏字段合并、显式 `null`、`options` 整体替换、未知字段和单平台生成。
- 对事务的每个写入步骤注入失败，验证即时回滚和重启恢复。
- 对三平台生成结果做 capability matrix、默认入口、用户内容保留和幂等快照测试。
- 对四档风险路由、索引过期回退、浏览器门禁、写入并发和 Git 授权做行为测试。
- 覆盖 handoff 状态、字段约束、无效 commit、blocked 结果和人工修复后复审。

## Assumptions

- 不引入配置 v2，也不自动重写用户现有 Environment 文件。
- 根 CLI 保持 Node ESM，不增加生产依赖。
- “原子激活”通过事务日志、原子 rename 和可恢复回滚实现，不宣称跨文件系统的单指令原子性。
- Orchestrator 是项目任务的默认入口，不是不可绕过的强制入口。
- 最终评审发现始终由用户决定是否修复。
- 四个阶段必须可独立发布和回滚，后续阶段不得阻塞安全修补发布。
