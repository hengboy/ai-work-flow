# Spec 驱动的 Planning 工作流

## Plan Metadata

- plan-id: `spec-driven-planning-workflow`
- status: `ready-for-implementation`
- source_spec: `.ai-work-flow/plans/spec-driven-planning-workflow/spec.md`
- source_spec_digest: `<由已保存且确认的 spec.md 完整字节计算的 SHA-256 小写十六进制值>`

## Problem Statement

当前 Planning 流程直接生成 `plan.md`，需求问询、共享理解确认、规格事实、实施计划及任务拆分之间没有可验证的持久化边界。因此，后续重新规划无法可靠地区分需求是否变化，也无法证明计划和任务来自已确认的需求；已有任务可能在计划更新后继续被 Coding 使用。

需要将 Planning 改为 Spec 驱动流程：主代理完成逐项问询并确认共享需求理解后，先持久化唯一需求事实来源 `spec.md`；只有规格写入、格式校验和摘要取得成功后，才生成绑定该规格的 `plan.md`。计划成功后仍由用户选择拆分或不拆分，并以新的计划摘要原子地替换或清理任务。

## Solution

在 `.ai-work-flow/plans/<plan-id>/` 引入固定的 `spec.md` 与 `plan.md` 配对工件，作为目录式规划与实施的唯一工件格式。

将规格定义为 Markdown 模板契约而非新增 planning runtime 或 CLI schema：`spec.md` 固定包含 `Spec Metadata`、`Problem Statement`、`Goals and Success Criteria`、`Users and User Stories`、`Functional Requirements`、`Non-Functional Requirements`、`Scope`、`Interfaces and Data`、`Failure Modes`、`Acceptance Criteria`、`Compatibility and Migration`、`Out of Scope`、`Assumptions`、`Open Questions`。保存前 `Open Questions` 必须为 `N/A`，且规格只描述 what 和验收边界，不得包含文件改动、实施步骤或技术方案。

Planning 主代理维护显式状态机：问询与共享理解确认后，首次规划或需求变化先委派 Planning Writer 完整写入一个精确目标 `spec.md`；确认写入成功并取得实际摘要后，再独立委派 Writer 完整写入一个精确目标 `plan.md`。已有规格未变化时不重写规格，但 File Explorer 必须读取并校验规格，Planning 必须总结共享理解并取得用户明确确认，然后仍重写计划。任务只能通过 `plan.md` 的规格绑定间接绑定规格。

## Goals and Success Criteria

- 每个新模式规划目录都以 `spec.md` 作为唯一需求事实来源，规格元数据 `status` 固定为 `approved`。
- `plan.md` 的状态固定为 `ready-for-implementation`，并必须包含 `source_spec` 与 `source_spec_digest`；摘要为保存后 `spec.md` 完整字节的 SHA-256 小写十六进制。
- 首次规划和需求变化场景严格按“spec 成功写入及校验 -> 实际 digest -> plan 写入”执行；任一前置阶段失败均不得进入后续阶段。
- 既有规格不变时，系统先校验、总结并获得明确确认，再以该规格重写计划；不得静默覆盖或跳过确认。
- 新计划产生后，旧任务立即失效，未经用户确认的新任务草案不得被 Coding 使用。
- 用户明确选择拆分后，任务以新 plan digest 全量替换；明确选择不拆分后，全部旧任务文件被删除并进入单任务模式。
- 缺少有效 `spec.md` 的旧平铺计划和目录式 plan-only 工件均被拒绝进入 Coding，且不迁移、不反向生成规格。

## User Stories

- 作为需求提出者，我希望主代理先逐项澄清并复述共享理解，只有我明确确认后才保存规格，避免计划建立在猜测上。
- 作为规划使用者，我希望 `spec.md` 固化需求和验收边界、`plan.md` 固化实施决策并可验证其规格来源，从而能安全地重新生成计划。
- 作为维护者，我希望已有规格未变化时可校验并复用它，而需求变化时必须重新问询并完整重写规格，避免隐式改写需求事实。
- 作为任务执行者，我希望任何计划更新都使旧任务不可执行，避免 Coding 基于过期任务实施。
- 作为仓库管理员，我希望 planning 最终工件只在明确确认后由 Git Operator 在 `main` 创建一个范围受限的本地原子提交。

## Scope

纳入范围：提示词驱动的 Planning、Planning Writer、Task Planner、Git Operator 与 Coding 行为；角色、委派和权限配置；多平台 adapter 的最窄权限生成；资产目录与安装生成；Node 自动化契约测试；README 与 feature navigation 文档。

规划工件目录固定为 `.ai-work-flow/plans/<plan-id>/`。其中 `spec.md` 和 `plan.md` 是新模式必需工件；拆分模式额外包含完整 `tasks/*.md`，不拆分模式不保留任务文件。任务仍记录 `source_plan` 和 `source_plan_digest`，从计划传递规格绑定。

## Implementation Decisions

1. 将 `spec.md` 作为 Markdown 模板契约，固定章节顺序为：`Spec Metadata`、`Problem Statement`、`Goals and Success Criteria`、`Users and User Stories`、`Functional Requirements`、`Non-Functional Requirements`、`Scope`、`Interfaces and Data`、`Failure Modes`、`Acceptance Criteria`、`Compatibility and Migration`、`Out of Scope`、`Assumptions`、`Open Questions`。`Spec Metadata` 至少含 `plan-id` 与 `status: approved`；保存前最后一章必须精确为 `N/A`。规格禁止实施文件清单、实现步骤、技术方案和任务拆分内容。
2. `plan.md` 保留既有 Planning 固定模板和 `status: ready-for-implementation`，在 `Plan Metadata` 中新增且强制填写 `source_spec` 与 `source_spec_digest`。摘要必须对实际保存的规格原始完整字节计算 SHA-256，编码为小写十六进制；不得使用规范化后的文本、摘要内容或预测值。
3. Planning 采用顺序状态机：冲突门禁 -> 问询/共享理解 -> 用户明确确认 -> 写入或复用并校验 spec -> 获取实际 digest -> 写入 plan -> 校验计划绑定 -> 询问拆分或不拆分 -> 用户确认后处理 tasks -> 可选提交确认。首次规划和需求变化必须完整重写规格；规格内容不变时必须复用原文件但仍校验、总结并再次获得明确确认后重写计划。
4. 当目标目录已有 `spec.md` 或 `plan.md` 时，Planning 必须先要求用户在“更新现有方案”与“更换 plan-id”间明确选择。未明确选择不得覆盖。若旧目录缺少有效规格，不能从其计划反推规格，必须按不兼容旧格式阻止流程。
5. Planning Writer 扩展为可写 `spec.md` 或 `plan.md`，但单次委派仅允许一个预先指定的精确目标，且每次都是完整新版本写入。spec 写入委派不得创建或修改 plan/tasks；plan 写入委派不得创建或修改 spec/tasks。该约束在可强制的平台生成最窄写路径，在不能表达文件级权限的平台明确标为 `instruction-only`。
6. File Explorer 在复用规格时负责读取固定路径、验证必需章节、元数据、`Open Questions: N/A` 及规格内容边界；Planning 负责总结校验结果和共享理解，并在用户明确确认后继续。File Explorer 不得把无效规格作为重新生成计划的输入。
7. Task Planner 仅在 plan 成功并用户明确选择拆分后工作，基于新计划和代码地图生成完整 tasks 草案，先展示每个任务的 `outcome`、`blocked_by`、`acceptance`。只有用户明确确认任务颗粒度后，才以新 `source_plan_digest` 全量替换任务集；不得局部保留旧任务。
8. 在 plan 重写开始时将旧 tasks 标记为失效并使 Coding 拒绝使用；在拆分确认前仅允许展示草案。用户明确选择不拆分后，需再次明确确认删除动作，再删除全部旧 task 文件并标明单任务模式。
9. Coding 的进入条件改为同时要求有效目录式 `spec.md`、有效 `plan.md`、匹配的 spec digest，及拆分模式下与当前计划摘要匹配的任务。旧 `.ai-work-flow/plans/<plan-id>.md` 平铺计划、缺少有效 `spec.md` 的 plan-only 目录和已失效任务一律拒绝。
10. 最终 planning commit 继续由 Git Operator 在用户明确确认后于 `main` 创建单个本地原子 commit。允许路径集合严格限于当前计划目录内的 `spec.md`、`plan.md`、拆分模式的完整 `tasks/*.md`，或不拆分模式下同目录旧 tasks 的删除；不得携带源码或无关文件，并沿用现有 checkbox 规则。脏工作树、权限越界、符号链接风险及 hook 失败均阻塞或保留现场。
11. 不新增 planning CLI 或 runtime。所有行为通过角色模板、角色/权限配置、平台 adapter、资产生成、文档和 Node 自动化契约测试实施；能力矩阵中仅将平台真实执行的限制标为 `enforced`，其余标为 `instruction-only`，不宣称提示词约束具备运行时强制性。

## Implementation Changes

第一阶段：更新 Planning 模板中的状态机、问询和确认语义。定义首次、更新、复用规格、冲突、失败短路、计划重生成、拆分与不拆分分支；规定主代理在两次 Writer 委派间检查写入成功、格式及实际 digest，且 plan 成功后必须询问“拆分”或“不拆分”。同步更新 Coding 模板的工件准入规则和旧格式拒绝语义。

第二阶段：更新 Planning Writer 与 File Explorer/任务协作约束。Writer 模板提供独立的 spec 模板和带来源元数据的 plan 模板，强制单目标完整写入；File Explorer 的规划读取权限与校验职责只覆盖该流程必要工件及其直接依赖。Task Planner 模板定义完整草案、展示字段、用户颗粒度确认、全量替换及不拆分删除前确认。

第三阶段：调整角色、路由和权限配置。修改 `agent-build/config/roles.json`、`policies.json`、`routing.md`、`default-config.json`，使规划角色能够按阶段访问所需路径，同时限制 Writer 单次写入目标；更新 Git Operator 的可提交路径集合和 Coding 的拒绝门禁。对于 OpenCode 等可表达路径白名单的平台，生成 `.ai-work-flow/plans/<plan-id>/spec.md`、`plan.md` 或确认后的 `tasks/*.md` 的最窄权限；无法按单文件或阶段表达的 adapter 输出显式 `instruction-only` 能力说明。

第四阶段：更新生成和安装链路。修改 `agent-build/runtime/platform-adapter.mjs`、`asset-catalog.mjs` 与 `workflow.mjs`，确保各平台安装资产包含一致的新模板、权限与能力声明，并让资产目录完整性校验覆盖新增/更新的 planning 工件。

第五阶段：扩展 `test/agent-workflow.test.mjs` 的 Node 契约测试，覆盖模板文本、路由、权限生成、adapter 输出、资产目录与安装结果的端到端静态契约。使用根 `npm test` 运行 Node test runner 验证；测试不得依赖浏览器自动化。

第六阶段：更新 `README.md` 与 `.ai-work-flow/index/feature-navigation.md`，说明新目录式 spec-first 流程、确认点、摘要绑定、拆分语义、平台能力边界和 breaking change。明确旧规划工件不迁移、不兼容、不能被 Coding 消费。

## Public Interfaces

- 新规划目录接口：`.ai-work-flow/plans/<plan-id>/spec.md`、`.ai-work-flow/plans/<plan-id>/plan.md`，以及仅拆分模式下的 `.ai-work-flow/plans/<plan-id>/tasks/*.md`。
- `spec.md` 公开 Markdown 契约：必需固定章节；`Spec Metadata` 至少有 `plan-id` 和 `status: approved`；`Open Questions` 必须为 `N/A`；内容仅限需求与验收边界。
- `plan.md` 元数据接口：既有 `plan-id`、`status: ready-for-implementation` 外，新增 `source_spec`（当前目录规格路径）和 `source_spec_digest`（规格完整字节 SHA-256 小写十六进制）。
- 任务元数据接口延续 `source_plan`、`source_plan_digest`，并要求后者匹配当前 `plan.md` 的完整字节摘要；任务通过计划而非新增字段绑定规格。
- 用户交互接口：冲突时只能明确选择“更新现有方案”或“更换 plan-id”；计划完成后必须明确选择“拆分”或“不拆分”；拆分须确认任务颗粒度；不拆分须确认删除旧任务；最终 commit 须明确确认。
- 兼容性接口：旧平铺计划、plan-only 目录、失效任务均为拒绝输入，不提供迁移或降级消费接口。

## Data Flow and Failure Modes

数据流为：逐项问询 -> 主代理共享理解总结 -> 用户明确确认 -> Writer 写入或 File Explorer 校验复用 `spec.md` -> 读取实际完整字节并计算 SHA-256 -> Writer 写入引用该 digest 的 `plan.md` -> 校验 plan 元数据与 digest -> 用户选择拆分/不拆分 -> Task Planner 草案与颗粒度确认后全量 tasks 替换，或删除全部 tasks -> 用户确认后 Git Operator 仅提交允许工件。

- spec 写入失败、写后不存在、格式非法、缺少必需章节、元数据非法、`Open Questions` 非 `N/A` 或包含实施内容时，停止；不得生成 plan。
- spec digest 无法取得、不是小写 SHA-256 十六进制、或 plan 中的来源路径/摘要与实际规格不一致时，停止；不得拆分或进入 Coding。
- plan 写入失败、格式非法或未正确绑定规格时，停止；不得委派 Task Planner、删除任务或进入 Coding。
- 规格已存在但用户未明确选择更新或更换 plan-id 时停止；缺少有效规格的旧格式不得作为任何反向生成输入。
- 计划被重写时，旧 tasks 必须立即视为失效且不可被 Coding 使用；未取得任务颗粒度确认时不得写入新 tasks；全量替换失败时保留现场并阻止执行。
- 用户选择不拆分但未明确确认删除时停止；删除失败时保留现场、维持不可执行状态，不得声明单任务模式完成。
- 权限越界、目标或任务路径为符号链接/无法安全验证、工作树含影响允许提交范围外的脏改动时阻塞相应写入或提交；不得扩大路径范围绕过检查。
- Git hook 失败时保留工作区和工件现场，不 amend、不回滚用户改动、不宣称提交成功。

## Testing Decisions

在 `test/agent-workflow.test.mjs` 中新增或更新契约测试，使用根 `npm test` 的 Node test runner 运行。测试应断言生成资产与模板文本、配置和 adapter 权限语义一致，不新增 planning runtime 测试夹具或 CLI。

- 首次生成：问询确认后先生成有效 `spec.md`，获得实际 digest 后才允许生成带正确来源元数据的 `plan.md`。
- 已有规格不变：File Explorer 校验、Planning 总结和明确确认是重写 plan 的前置条件，且 spec 不被重写。
- 已有规格变化：必须重新问询、完整重写 spec，再用新实际摘要重写 plan。
- 摘要与顺序：覆盖完整字节 SHA-256 小写格式、来源路径绑定、严格的 spec-before-plan 顺序，以及任一失败的短路。
- 规格校验：缺章、错误 `approved` 状态、`Open Questions` 非 `N/A`、规格混入实施方案时均拒绝继续。
- 冲突和旧格式：已有 spec/plan 的明确选择门禁、旧平铺计划、plan-only 目录和无有效 spec 工件均不能进入 Coding，且不迁移。
- 拆分：验证完整 tasks 草案含 `outcome`、`blocked_by`、`acceptance`，任务颗粒度确认前不可写入/执行，确认后按新 plan digest 全量替换，旧任务不会局部残留。
- 不拆分：验证计划后必须询问选项，用户选择并确认删除后才删除全部旧 tasks 并进入单任务模式。
- 提交范围：验证 Git Operator 只接受当前目录中 spec、plan、完整 tasks 集合或 tasks 删除，拒绝源码、无关文件和未确认提交；沿用 checkbox 规则。
- 平台权限：验证 adapter 在可强制平台生成最窄写权限，在无法强制的平台输出 `instruction-only`，不把提示词约束误标为 `enforced`。

## Rollout and Compatibility

本改动是 breaking change。重新生成并安装所有平台资产后，新 spec-first Planning 流程生效；安装产物、角色模板、权限配置和文档必须来自同一资产目录版本。

不迁移旧 `.ai-work-flow/plans/<plan-id>.md` 平铺计划，也不迁移缺少有效 `spec.md` 的目录式 plan-only 工件。它们保留为不可消费的历史文件，不能用于 Coding，不能从其中反推或生成规格。

回滚仅回滚代码与生成安装资产到先前版本；不得将已经生成的新 `spec.md`/`plan.md`/tasks 当作旧格式降级消费。

## Out of Scope

- 新增 planning CLI、planning runtime 或持久化状态转换入口。
- 迁移、转换或兼容消费旧规划工件。
- 从现有 plan 反推、推测或自动生成 spec。
- 计划完成后自动进入 Coding，或绕过用户对拆分、删除、任务颗粒度和提交的明确确认。
- 将 instruction-only 的提示词限制伪装为所有平台均可运行时强制的安全边界。

## Assumptions

- 现有提示词驱动架构、角色模板、配置、adapter、资产生成和 Node 契约测试足以表达并验证本方案所需的流程契约，无需新增 planning runtime。
- SHA-256 可由现有 Node 工具链在测试/生成约束中稳定计算，且摘要对象可按工件原始完整字节获取。
- `main` 仍是 planning 最终本地 commit 的目标分支，现有 Git Operator checkbox 规则可继续适用。
- 各平台 adapter 的能力差异可被明确分类；不能最窄化到单文件的场景会如实标注为 `instruction-only`，不会被测试或文档描述为强制隔离。

## Further Notes

实施时应以流程状态和工件不变量组织改动，而不是将逐文件清单作为设计主体：模板定义行为，配置和 adapter 传递可执行权限，资产生成确保平台一致性，Node 契约测试防止这些层发生漂移。
