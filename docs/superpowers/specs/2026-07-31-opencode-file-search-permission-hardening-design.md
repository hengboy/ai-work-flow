# OpenCode 文件搜索权限收敛设计

## 问题陈述

AI Work Flow 要求未知路径的搜索和枚举由 File Explorer 负责，再由其他角色消费已知路径。目前 OpenCode 权限存在多条绕过路径：审查角色拥有 Glob/Grep，多个角色可通过 Bash 调用 `rg`/`find` 等搜索命令，Task 只有整体 `allow`，且可调用内置 `explore`/`general`。这使角色路由成为提示级约束，不能形成强制边界。

## 目标与非目标

目标：

- 在 OpenCode 中强制执行 File Explorer 的未知路径发现职责。
- 以角色 `delegates` 作为 Task 白名单的单一来源，并默认拒绝未声明的 Task 调用。
- 通过 schema/config 生成权限配置，覆盖 Task、Bash、内置代理和审查工具权限。
- 检测 shadow 配置冲突并停止生成，保留用户现场。
- 同步移除 Claude/Codex 审查角色的 Glob/Grep 声明。

非目标：

- 不把 Claude/Codex 的 Bash 命令级限制描述为强制沙箱；这些限制仍是 instruction-only。
- 不阻止获准执行的仓库测试脚本在内部读取文件。
- 不自动删除、覆盖或就地改写未知的项目级、用户级 OpenCode 配置；生成器只能写入带受信身份、且明确属于生成器管理范围的配置区块。
- 不改变业务源码、测试脚本或 Git 提交流程。

## 备选方案与选择

1. **仅更新角色说明**：实现成本低，但不能阻止 Glob/Grep 或 Bash 绕过，放弃。
2. **为所有角色统一禁止 Bash**：边界简单，但会破坏构建、测试、Git 证据和 File Explorer 的职责，放弃。
3. **OpenCode 分层权限生成**：Task 按角色 delegates 白名单，工具权限按角色和命令模式细分，内置代理显式禁用；Claude/Codex 仅同步移除审查 Glob/Grep。选择此方案，因为它保留必要工作流，同时把 OpenCode 的可执行约束落到权限 evaluator。

## 架构和配置模型

权限生成输入必须来自已校验的角色 schema/config：

- `roles`: 角色 ID、平台声明、`delegates`、工具能力声明。
- `delegates`: 角色可调用的 Task 目标白名单，也是 Task 权限生成的唯一来源。
- `bashPolicy`: 每个角色的允许、拒绝、询问命令模式及规则来源标识。
- `builtinAgents`: OpenCode 内置 `explore` 和 `general` 的生成覆盖，固定为 `disable: true`。

生成器输出 OpenCode 全局配置和项目配置；产物只包含生成结果，不写死角色列表或规则。schema 校验必须拒绝未知角色、重复模式、无来源 Bash 规则、Task 白名单与 `delegates` 不一致，以及非法 OpenCode permission 结构。生成配置中的 `builtinAgents.explore` 和 `builtinAgents.general` 固定为 `disable: true`；这只控制生成产物中的内置 agent，不删除或修改用户已有的同名自定义配置。

Task 默认规则为 `* = deny`，再为当前角色的 `delegates` 生成精确 allow。规则顺序和匹配语义由 OpenCode evaluator 适配层统一处理，避免不同生成目标自行解释 glob。

## 角色行为矩阵

| 角色类别 | Task allow 来源 | 直接文件发现 | Bash 策略 |
| --- | --- | --- | --- |
| File Explorer | 该角色 `delegates` | 允许其发现所需工具 | 保持发现所需能力 |
| Full Stack Coder | 仅 File Explorer | 不得直接使用未知路径发现工具 | 放行已知 build/test/Git 检查；明确拒绝 `rg`、`find`、`grep`、`fd`、`git grep`、`git ls-files` 等检索入口；其余 `ask` |
| Code Reviewer | 仅 Review Standards、Review Spec | 移除 Glob/Grep | 仅固定 revision Git 证据 |
| Review Standards | 现有 `delegates` | 移除 Glob/Grep | 仅固定 revision Git 证据 |
| Review Spec | 现有 `delegates` | 移除 Glob/Grep | 仅固定 revision Git 证据 |
| 文档/计划/任务角色 | 现有 `delegates` | 依赖 File Explorer | 仅 Git 检查 |
| Git Operator | 现有 `delegates` | 依赖已知路径 | 仅 `git` 命令 |
| 其他角色 | 现有 `delegates` | 依赖其声明及路由 | 按 schema 中的现有策略生成 |

其中“仅”表示 OpenCode evaluator 的强制规则；Claude/Codex 同步配置中的 Bash 命令限制仅作为角色指令，不应被验收为沙箱能力。

## 生成数据流

1. 读取 schema/config 与角色资产目录，确认资产完整且角色 ID 唯一。
2. 校验 `delegates`、工具声明、Bash 规则来源和平台能力。
3. 读取受信范围内的 OpenCode 全局、用户级和项目级配置，识别内置代理 shadow 冲突。
4. 若发现同名未知 shadow 配置，立即停止，不删除、不覆盖，并保留现场。
5. 由同一模型生成角色 Task deny/allow、Bash 规则、审查工具移除和内置代理 disable 配置。
6. 对生成结果执行 schema/config 校验、完整性检查和冲突检查。
7. 仅校验通过后写入目标配置；失败时不得写入任何平台配置。

## 冲突与错误处理

- `explore`/`general` 存在项目级或用户级同名自定义配置，且无法证明其为受信生成内容：报 shadow conflict，停止生成，保留原文件。此时不产生新的平台写入；“生成配置中禁用内置 agent”仍是无冲突时的产物要求，不构成删除同名用户配置的授权。
- 角色 delegates 指向未知角色、产生循环或与产物不一致：schema error，停止生成。
- Bash 规则缺少明确来源、使用不支持的匹配语法或与平台能力冲突：config error，停止生成。
- 目标配置存在未知用户内容：只报告冲突，不自动清理；已知生成区块必须具备可验证身份后才允许更新。
- 任一平台生成失败或产物完整性校验失败：回滚本次尚未完成的写入，并保留已有用户配置和诊断信息。

## 平台差异

OpenCode 支持 `permission.task` 按 agent glob 模式、`permission.bash` 按命令模式，并允许通过 `disable: true` 覆盖内置 agent，因此承担强制收敛责任。Claude/Codex 同步删除 Code Reviewer、Review Standards、Review Spec 的 Glob/Grep 声明，但其命令级 Bash 约束标为 `instruction-only`，不能声称实现同等强制能力。能力矩阵必须区分 `enforced`、`instruction-only` 和 `unsupported`，生成器不得把后两者升级为强制策略。

## 安全边界

该设计阻止代理直接通过 Glob/Grep 或 Bash 搜索入口绕过角色路由，保护的是工具调用路径和委派边界。获准运行的仓库 build/test 脚本仍可能在进程内部读取文件，这不属于文件系统沙箱，也不在本设计试图阻止的范围内。Full Stack Coder 对未知命令采用 `ask`，防止无人值守流程借助未分类命令绕过拒绝列表；拒绝列表覆盖常见搜索入口，但不替代 OpenCode 的命令匹配校验。

## 迁移与生成行为

迁移先生成审计报告，列出将移除的审查 Glob/Grep、Task 白名单变化、Bash 规则和内置 agent 覆盖。检测到 shadow 冲突时报告准确路径并停止，用户配置原样保留。无冲突且 schema 校验通过后，生成器以受信标识写入 OpenCode 配置，并同步更新 Claude/Codex 角色声明；生成产物必须包含 `explore`/`general` 的 `disable: true`，但不得删除或覆盖未知同名用户配置。重复生成必须幂等，只更新生成区块，不改写用户内容。

## 测试与验收标准

- 角色声明测试读取三个审查角色的生成输入，断言其不含 Glob/Grep。
- schema/config 测试以非法 fixture 为输入，断言未知角色、非法 delegates、无来源 Bash 规则和不一致产物均失败，并返回对应错误类别。
- permission evaluator 测试逐项提交允许和拒绝的 Task 调用，断言默认规则为 deny，且只允许当前角色 `delegates`；Full Stack Coder 仅允许 File Explorer，Code Reviewer 仅允许 Review Standards/Review Spec。
- Bash 测试逐项提交搜索命令、未分类命令和角色专属 Git/build/test 命令，断言结果分别为 deny、ask 和预期 allow/匹配结果。
- 内置代理测试检查无冲突生成产物，断言 `explore`/`general` 均为 `disable: true`。
- shadow 冲突测试分别注入用户级和项目级未知同名配置，断言报告准确路径、返回 shadow conflict、目标配置字节不变且没有任何新写入；同时验证无冲突产物仍包含上述两个 `disable: true`，不要求也不允许删除未知同名配置。
- 生成完整性测试确认所有角色、平台和权限区块均有受信来源；注入任一校验失败后断言目标配置不发生部分写入，连续两次成功生成的受信区块字节一致且用户区块不变。
- 验收必须保存并检查 OpenCode 产物通过 schema/config 校验的结果，并用 evaluator 的 allow/deny 结果证明未知路径发现只能经 File Explorer 的 Task 路由；另以能力矩阵或角色声明检查明确 Claude/Codex 的 Bash 限制仅为 `instruction-only`，不得将其作为拒绝结果验收。

## 涉及文件范围

- OpenCode 全局权限配置生成模板及其项目/用户配置适配层。
- 角色 schema/config、角色 delegates 与 Bash policy 声明。
- 权限生成器、OpenCode permission evaluator 适配层及冲突检测器。
- Claude/Codex 的 Code Reviewer、Review Standards、Review Spec 角色声明。
- schema/config、evaluator、Task allowlist、Bash 拒绝、内置代理 disable、shadow 冲突和生成完整性测试。

不修改业务源码、仓库测试脚本或用户未知配置，也不包含 Git 提交。
