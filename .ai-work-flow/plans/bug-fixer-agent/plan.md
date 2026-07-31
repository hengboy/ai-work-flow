# Bug Fixer 子代理实施计划

## Plan Metadata

- plan-id: `bug-fixer-agent`
- status: `ready-for-implementation`

## Problem Statement

当前 `coding` 角色缺少一个职责边界明确的专职修复子代理，导致可复现 bug 修复与已获用户明确授权的评审阻塞 finding 修复无法在代理目录、配置、模板和测试中以独立能力建模。需要新增 `bug-fixer`，使其可在既有委派深度、治理规则和生成校验机制内完成受限修复，并将 Git mutation、检索、外部调研和普通文档维护继续交由对应专职角色处理。

## Solution

以现有 `full-stack-coder` 为结构基线，新增 `bug-fixer` 子代理资产并复用 `write-code` policy。将其配置为仅由 `coding` 委派，负责可复现 bug 与用户明确批准的 blocking finding ID 的源码、测试、必要配置变更和验证。通过 `coding` 模板及必要的受管理 routing 规则明确任务分流、finding ID 授权、修复提交和复审决策门禁；不改变 execution runtime 状态机。

## Goals and Success Criteria

- 角色 catalog、模板和三平台默认配置中均存在且仅对应一个 `bug-fixer` 定义。
- `bug-fixer` 使用 `kind: subagent`、`policy: write-code`，并具有符合既有 `full-stack-coder` 风格的代码读写、测试/校验和 Task 委派工具。
- `coding` 仅在任务是可复现 bug，或用户明确批准当前评审结果中的具体 blocking finding ID 时委派 `bug-fixer`。
- 委派图仅新增 `coding -> bug-fixer`，且 `bug-fixer` 仅可委派 `file-explorer`、`git-operator`、`researcher`、`document-maintainer`；无循环且不超过现有 `MAX_AGENT_DEPTH=2`。
- Codex 生成配置为 `model: gpt-5.6-luna`、`reasoning: max`；OpenCode 为 `model: baibai/gpt-5.6-luna`、`variant: max`、`options: {}`；Claude 为 `model: sonnet`、`effort: high`。
- `bug-fixer` 不自行评审、不委派 `code-reviewer`、不自行执行 Git mutation；未知路径、枚举和仓库搜索由 `file-explorer` 处理。
- 未获得当前评审结果中具体 finding ID 的用户明确批准时，不得修复 blocking finding；仅修复获批 ID，不得顺手修复未授权 finding。
- finding 修复后，Git Operator 创建后继于原 `review_commit` 的新提交；新 SHA 不同于原 SHA，且精确等于当前 feature/task HEAD。同步完成后回到新的用户决策点。
- 只有用户明确选择才重新执行完整双轴评审；复审覆盖新的完整 committed range。用户选择继续时，旧 finding 不自动触发复审；新评审再次出现 blocking finding 时再次等待用户决定。
- `node agent-build/install.mjs validate`、临时环境生成验证、`node --test test/agent-workflow.test.mjs` 与 `npm test` 均通过，且真实用户主目录没有生成或待提交产物。
- README 和 feature navigation 中的角色数量、角色能力和模型事实与生成源资产一致。

## User Stories

- 作为 `coding` 主角色，我可以将可复现 bug 交给 `bug-fixer`，使修复工作由专职代码代理完成，同时维持既有 Git、检索和文档职责边界。
- 作为用户，我可以只批准当前评审结果中的指定 blocking finding ID，并确信修复不会扩大到未授权的评审问题。
- 作为用户，我可以在 finding 修复并同步后明确选择重新进行完整双轴评审或继续，而系统不会自动触发复审。
- 作为维护者，我可以通过 catalog、模板、路由、生成结果和自动化测试验证新角色在 Codex、OpenCode、Claude 三个平台上的配置一致性和委派治理。

## Scope

包含：新增 `bug-fixer` 源角色资产、将其加入 `coding` 委派、三平台模型配置、模板中的职责和治理规则、必要的共享 routing 承载、README 与 feature navigation 同步，以及 agent workflow 的相关自动化断言和生成验证。

不包含：checkpoint、execution plan 或 execution runtime 的状态机改造；除非实施测试证明既有状态机无法承载已确定的流程，届时停止并另行确认范围。

## Implementation Decisions

- 角色定义以 `full-stack-coder` 的配置结构和工具风格为基线，但职责文字收窄为可复现 bug 与获批 blocking finding 修复。
- 复用现有 `write-code` policy，不向 `policies.json` 增加新 policy，也不改变其他角色的模型配置。
- `bug-fixer` 的 `kind` 固定为 `subagent`；其直接委派目标固定为 `file-explorer`、`git-operator`、`researcher`、`document-maintainer`。不允许 `code-reviewer`。
- 未知文件路径、文件枚举和仓库搜索必须请求 `file-explorer`；外部官方资料仅在确有需要时请求 `researcher`；普通文档变更仅在确有需要时请求 `document-maintainer`；Git mutation、同步和提交一律请求 `git-operator`。
- `coding` 保留常规实现任务到既有角色的分流；仅将可复现 bug 和带有当前评审结果具体获批 finding ID 的修复任务分流到 `bug-fixer`。
- finding 修复输入必须同时具备当前评审结果、blocking 分类和用户明确批准的具体 ID；任一条件缺失即保持等待并返回上层，不委派修复。
- finding 修复完成后由 Git Operator 负责提交与同步验证。提交必须晚于 `review_commit`、SHA 不同于且后继于该提交，并与当前 feature/task HEAD 完全一致；不满足时停止并报告失败。
- 同步后由上层 `coding` 重新向用户呈现决策点。仅用户明确选择复审时运行完整双轴复审，且评审范围为新的完整 committed range；选择继续不由旧 finding 触发复审；新的 blocking finding 仅进入下一轮等待，不自动循环。
- routing sections 固定复用 `browser-governance`、`retry-governance`、`implementation-governance`。仅当角色模板无法可靠承载跨角色 finding ID/复审门禁时，才在 `agent-build/config/routing.md` 增加最小的受管理共享规则。
- 不提高 `MAX_AGENT_DEPTH`：`coding -> bug-fixer -> delegate` 恰好使用现有深度 2。

## Implementation Changes

### 阶段 1：确认并扩展受管理角色目录

1. 修改 `agent-build/config/roles.json`，新增 `bug-fixer` catalog 条目，设定 `kind: subagent`、`policy: write-code`、指定 delegates、工具集合和三个 routing sections。
2. 在同一 catalog 的 `coding.delegates` 中加入 `bug-fixer`，不调整既有 `full-stack-coder`、reviewer 或其他委派关系。
3. 对照 catalog 中的既有深度与委派校验约束，确保新增边不形成循环，且二级委派停在既有允许深度内。

### 阶段 2：配置平台模型并编写角色行为

1. 修改 `agent-build/config/default-config.json`，为 `bug-fixer` 添加 Codex、OpenCode 和 Claude 的默认配置，字段和值严格使用已确认模型决策。
2. 新增 `agent-build/templates/bug-fixer.md`，使用受管理角色模板格式定义输入条件、可执行工作、委派边界、验证责任、禁止自行评审和禁止 Git mutation 的规则。
3. 在模板中将 finding 修复流程固化为：验证当前 blocking finding 与用户具体 ID 授权，限制修复范围，验证变更，交接 Git Operator 提交/同步，校验新提交与 `review_commit` 及当前 HEAD 的关系，返回 `coding` 的新用户决策点。
4. 修改 `agent-build/templates/coding.md`，明确常规实现与 bug/finding 修复的分流条件，并明确 `coding` 在 finding 修复完成后只根据用户明确选择决定是否发起独立双轴复审。
5. 检查 `agent-build/config/routing.md` 对现有 routing sections 的表达能力；仅当必须以共享受管理内容保证 finding ID 授权、后继提交和复审门禁跨模板一致时，加入最小规则，不修改无关路由内容。

### 阶段 3：同步面向维护者的事实

1. 修改 `README.md` 的角色和模型说明，加入 `bug-fixer` 的定位、委派关系和三平台模型事实，保持现有文档结构。
2. 修改 `.ai-work-flow/index/feature-navigation.md`，更新角色数量及导航中受管理角色相关事实，确保与 roles catalog 一致。

### 阶段 4：建立可执行的治理与生成回归

1. 修改 `test/agent-workflow.test.mjs`，将 `bug-fixer` 纳入 catalog、模板一致性、routing sections、生成结果、平台模型字段、委派图、实施契约和文档/index 事实断言。
2. 添加 finding 治理断言：无当前评审结果具体获批 ID 时不得修复；只允许修复获批 ID；不得委派 `code-reviewer` 或执行 Git mutation；finding 修复提交必须后继于 `review_commit` 且等于当前 feature/task HEAD；同步后复审必须由用户明确选择且覆盖新 committed range；旧 finding 不自动触发复审；新 blocking finding 再次等待。
3. 使用项目现有临时目录或测试生成机制生成 Codex 与 OpenCode 配置，断言生成输出含 Luna Max 字段，并清理临时产物，不向 `~/.codex`、`~/.claude`、`~/.config/opencode` 写入或提交生成物。
4. 不新增 `skills/run-matt-spec-to-completion/test/*.test.mjs` 测试，除非实施中实际修改 execution runtime 状态机；若出现该需求，停止当前实施并请求新的范围确认。

### 阶段 5：验证和交付准备

1. 运行 `node agent-build/install.mjs validate`，确认所有受管理资产、catalog、模板和路由关系通过校验。
2. 运行针对 Codex/OpenCode 的临时环境生成验证，确认模型字段、delegate 和模板内容被正确渲染。
3. 运行 `node --test test/agent-workflow.test.mjs`，随后运行 `npm test`。
4. 检查工作区变更，确保没有用户主目录运行时生成物或不在本计划范围内的文件进入变更集。

## Public Interfaces

受管理角色目录和各平台代理配置新增 `bug-fixer`，这是 agent-build 配置接口的加法扩展：上层 `coding` 可在已定义条件下将任务委派给该角色，生成的 Codex、OpenCode 与 Claude 角色配置可识别该名称及其模型设置。

不修改产品业务 API、CLI 参数或 schema；不修改 checkpoint format、execution plan 格式、Completion result schema 或 execution runtime 状态转换接口。现有 `full-stack-coder`、`code-reviewer` 和其他角色的公开配置名称与行为保持兼容。

## Data Flow and Failure Modes

| 阶段 | 正常数据流 | 失败模式与处理 |
| --- | --- | --- |
| Bug 输入 | `coding` 接收可复现 bug，确认复现信息和预期/实际行为后委派 `bug-fixer`。 | 无法复现或输入不足时，`bug-fixer` 返回所缺复现信息，不猜测修复。 |
| Finding 输入 | `coding` 提供当前评审结果、blocking finding 和用户明确批准的具体 finding ID 后委派。 | finding 非 blocking、不是当前评审结果、未提供具体获批 ID 或授权含糊时，保持等待，不改代码。 |
| 路径检索 | `bug-fixer` 将未知路径、枚举和仓库搜索交给 `file-explorer`，获得已发现的入口和依赖后再读取。 | `file-explorer` 无法定位或返回冲突信息时，停止扩大搜索并将阻塞信息返回上层。 |
| 修复与验证 | `bug-fixer` 在授权范围内修改源码、测试和必要配置，并运行相关验证。 | 测试、校验或修复验证失败时，修复代理诊断并在授权范围内迭代；无法解决时返回失败证据，不伪报完成。 |
| 外部资料与文档 | 仅在需要官方资料时委派 `researcher`，仅在普通文档需要同步时委派 `document-maintainer`。 | 委派失败、资料不足或文档角色无法完成时，保留已有修改状态并向 `coding` 报告阻塞，不越权代办。 |
| Git handoff | `bug-fixer` 将已验证变更交接 `git-operator` 完成同步和提交；Git Operator 验证新 SHA 后继于且不同于 `review_commit`，并精确等于当前 feature/task HEAD。 | Git mutation、同步或 SHA/HEAD 关系校验失败时，停止 finding 流程并返回明确失败原因；`bug-fixer` 不自行执行 Git 命令 mutation。 |
| 复审决策 | Git 同步后控制权返回 `coding`，由用户明确选择重新完整双轴评审或继续。 | 未选择复审时不得由旧 finding 自动复审；新评审产生 blocking finding 时再次等待具体 ID 授权，不自动循环。 |
| 资产生成 | 校验通过后在临时目标生成平台代理配置，并检查输出。 | catalog、模板、routing 或生成失败时由既有事务与资产校验保证失败零写入；清理临时输出并修正源资产后重试。 |

## Testing Decisions

- 在 `test/agent-workflow.test.mjs` 中覆盖新增角色的 catalog 到模板到默认配置的一一对应关系，以及 `coding` 对 `bug-fixer` 的唯一新增委派边。
- 断言三平台模型配置的精确字段和值：Codex Luna/Max reasoning、OpenCode Luna/Max variant 与空 options、Claude Sonnet/high effort。
- 断言 `bug-fixer` 的 policy、kind、工具和 delegates，特别是允许 `file-explorer`、`git-operator`、`researcher`、`document-maintainer`，禁止 `code-reviewer` 与直接 Git mutation。
- 断言三个复用 routing sections 存在且渲染一致；若增加共享 routing 内容，断言 finding ID 授权、后继提交、同步和用户复审门禁都被受管理内容覆盖。
- 断言 `coding` 的任务分流：常规实现维持既有路径，可复现 bug 和明确获批 finding 进入 `bug-fixer`，未授权 finding 不进入修复。
- 断言 finding/复审治理的完整行为：只修获批 ID、提交关系正确、复审由用户明确选择、复审范围是新完整 committed range、旧 finding 不自动复审、新 blocking finding 再次等待。
- 通过临时目标运行 Codex/OpenCode 生成验证，检查生成文本含预期 Luna Max 字段；不使用真实用户主目录作为验证目标。
- 执行 `node agent-build/install.mjs validate`、`node --test test/agent-workflow.test.mjs` 和 `npm test`。除非实际改动 execution runtime 状态机，否则不扩展 `skills/run-matt-spec-to-completion/test/*.test.mjs`。

## Rollout and Compatibility

这是新增角色的加法变更。既有 `full-stack-coder` 的常规实现能力、reviewer 拓扑和现有角色模型保持不变；`coding` 仅增加受条件约束的 `bug-fixer` 委派入口。

安装和生成继续使用现有事务与 asset catalog 校验，源资产不完整或不一致时失败且不写入目标。回滚方式为移除新增角色源资产、`coding` delegate、关联文档和测试，再运行 validate/generate；不迁移或修改持久化数据。

## Out of Scope

- 修改 checkpoint format、execution plan/runtime 状态机，除非测试发现既有复用存在缺口且已获得新的范围确认。
- 自动修复全部评审问题、修复未获授权的 finding，或自动触发复审和重复复审循环。
- 修改现有 reviewer 角色、`full-stack-coder` 的既有职责，或除 `bug-fixer` 外任何角色的 Luna/模型配置。
- 提升 `MAX_AGENT_DEPTH`、引入新 policy，或对 `policies.json` 做常规改动。
- 向 `~/.codex`、`~/.claude`、`~/.config/opencode` 写入、保留或提交运行时生成物。
- 与新增 `bug-fixer` 无直接关系的重构、格式化或文档重写。

## Assumptions

- 现有 `full-stack-coder` 已提供可复用的 `write-code` policy、工具表达模式及模板结构，足以作为 `bug-fixer` 的直接基线。
- 当前 agent-build catalog 和生成校验已验证 delegate 图、深度、模板和三平台默认配置的一致性，且 `MAX_AGENT_DEPTH` 保持为 2。
- 现有 Git Operator 已能执行同步、提交以及提交与当前 HEAD 关系的验证；本变更只将 finding 修复流接入既有能力。
- 现有独立双轴评审机制已能接受完整 committed range 并产生带 finding ID 与 blocking 分类的当前评审结果；本变更只增加显式用户决策门禁。
- README 与 feature navigation 中存在可更新的角色数量、角色导航和模型说明位置，且它们是由本计划覆盖的受维护事实。

## Further Notes

实施时应保持源资产、模板渲染结果、README、feature navigation 和测试断言的同一事实来源，避免将 finding 授权或复审门禁仅写入某一个平台代理的产物。所有生成验证应使用仓库控制的临时路径，验证结束后清理，以保证用户主目录和提交范围不受影响。
