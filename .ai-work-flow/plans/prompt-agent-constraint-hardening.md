# Prompt 与 Agent 约束加固实施计划

## 目标

- 计划 ID 固定为 `prompt-agent-constraint-hardening`；本文件是用户确认后新实施会话的唯一实施计划输入。
- 在不扩展角色集合、平台集合或产品功能的前提下，关闭当前仍未实现或仍漂移的提示词、生成器、平台权限、环境状态、审查、Handoff、Git 提交和 execution runtime 契约。
- 保持 `agent-build/config/routing.md` 为共享治理内容的唯一源；生成器从该源编译角色所需子集进入最终 agent body，使没有文件读取能力的 Claude/OpenCode Orchestrator 也能获得必需规则，同时禁止在 body 中手工复制第二份治理真相。
- 使 capability 输出只陈述平台配置可证明的事实：只有真实负向测试证明越权被平台阻止时才标记 `enforced`，其余为 `instruction-only` 或 `unsupported`。
- 使三平台生成内容可由标准解析器 round-trip，动态 model、variant、effort、reasoning、options 和正文不产生 TOML/YAML/JSON 注入或双重转义。
- 使 `env status` 比较 planned rendered bytes、磁盘受管文件和平台实际解析/覆盖事实，按角色/平台报告 `in-sync`、`drifted` 或 `shadowed`，且不读取、散列、记录或输出用户 secret。
- 使计划确认、计划提交、实现、review commit、Standards/Spec 审查、修复追加提交、integration 与 cleanup 形成可执行且不矛盾的顺序；所有 Checkpoint mutation 继续只通过 canonical runtime。
- 完成时，三平台 parser round-trip、OpenCode 权限负向测试、临时仓库端到端流程、特殊路径、身份冲突、hook 失败、篡改和 shadow 检测均有行为测试；`npm test`、`node --test test/agent-workflow.test.mjs` 与 `git diff --check` 全部通过。

### 与既有计划的关系

- `.ai-work-flow/plans/ai-work-flow-hardening-remediation-plan.md` 是更宽范围的历史整改计划；本计划只承接其中尚未实现或当前代码仍漂移的提示词/子代理契约，不重做已通过现有行为测试的路径、事务和 Checkpoint 完整性工作。
- `.ai-work-flow/plans/git-committer-authorized-scope.md` 是历史提交授权方案；本计划保留其“结构化路径、特殊路径无歧义、不得按相关性扩权”的原则，但冻结更严格的计划提交门禁、实现干净基线和 stash 单独授权规则。
- 两份旧计划不得作为第二事实来源，也不得在实施中被修改。若它们与当前代码事实、`CONTEXT.md` 的领域约束或本计划冻结决策冲突，以当前代码事实、`CONTEXT.md` 和本计划为准；若三者仍无法得出唯一行为，按停止条件重新规划。

## 需求

1. **治理编译：** `agent-build/config/routing.md` 继续是共享治理的唯一 managed source。角色 body 只保存角色专属职责、输入、排除条件和回复格式；`agent-build/runtime/asset-catalog.mjs` 解析 routing 中有稳定 ID 的受管片段，`agent-build/runtime/platform-adapter.mjs` 按 `roles.json` 的片段引用编译最终正文。缺失、重复、嵌套错误或未引用的必需片段必须在任何平台写入前失败。
2. **不可读 routing 的角色：** Claude Orchestrator 只有 `Task`，OpenCode Orchestrator 将采用 deny-by-default；二者不得依赖运行时读取 `$XDG_CONFIG_HOME/ai-work-flow/routing.md` 才能遵守核心委派、计划确认、提交、审查、重试与停止规则。最终 body 必须包含由唯一源编译的所需子集，并保留治理来源/版本标识以供状态检查。
3. **OpenCode 权限：** 权限对象必须先拒绝平台已知的独立权限键，再按 role.tools、policy 和 delegate 关系精确放行。至少覆盖 `read`、`edit`、`glob`、`grep`、`bash`、`task`、`skill`、`webfetch`、`websearch`、`question`、`external_directory`；发现平台新增但 adapter 未建模的权限键时，catalog/测试必须失败或 capability 降级，不得默认为允许。
4. **能力诚实性：** OpenCode 现有 reviewer 命令模式中的 `git branch*`、`git diff*`、`node --test*`、`npm test*` 不能作为“只读 shell/git 已强制”的证据。只有参数级负向 evaluator 能拒绝创建/切换分支、外部 diff/helper、输出写文件、测试副作用和命令拼接时才可升级；本计划完成前相应能力保持 `instruction-only` 或 `unsupported`。
5. **Codex TOML：** 移除 `body.replaceAll('\n', '\\n')` 的预转义。正文只经过一次正确 TOML 基本字符串或多行字符串序列化；标准 TOML parser round-trip 后 `developer_instructions` 必须与源/编译正文逐字节一致，真实换行不得变成字面 `\\n`。
6. **Claude/OpenCode frontmatter：** 动态 model、effort、variant、options 及描述必须由结构化对象安全序列化；生成后立即按对应 YAML/JSON 语义解析验证。控制字符、冒号、引号、`---`、换行、Unicode、数组和嵌套 options 不得改变字段边界或正文边界。
7. **Primary 能力：** 区分“角色 kind 为唯一 primary”“平台配置支持默认 primary”“平台强制所有用户入口只能经 Orchestrator”三个事实。OpenCode 可报告其 `default_agent` 的实际配置级别；Codex/Claude 不得声称平台强制 Orchestrator 为唯一入口。项目级 shadow 存在时，不得继续报告有效默认入口。
8. **环境配置与状态：** 配置按 `role -> platform -> field` 合并，OpenCode `options` 整体替换。`generate --platform` 只验证所选平台的最终字段，但仍验证全局 catalog、角色和未知字段。`env status` 以 `planGeneration` 生成的期望 bytes 为基准逐个对比磁盘，检查受管 marker/manifest 和有效平台配置，并检测项目级同名 agent、内联同名 agent 配置及旧/残留同名用户配置。
9. **状态分类：** `in-sync` 表示期望文件 bytes、受管配置和有效角色解析均一致且无覆盖；`drifted` 表示受管目标缺失、被篡改、解析失败或 manifest 不一致；`shadowed` 表示项目级或更高优先级同名定义会覆盖受管角色。一个角色可附带多个原因，但 overall 按 `shadowed > drifted > in-sync` 汇总。输出只包含角色 ID、状态、受信路径类别、差异类型和非敏感 digest，不输出配置值或文件正文。
10. **run-spec 状态机：** `skills/run-matt-spec-to-completion/SKILL.md` 必须给出每条命令的完整 `--repository`、`--feature`、按需 `--worktree` 参数，以及固定顺序 `begin-review -> record-review -> review-decision approve|fix -> Full Stack Coder 修复 -> Git Committer 追加提交 -> complete-review-fix -> integrate -> cleanup`。修复提交不可省略，`complete-review-fix` 只能记录已存在且晚于 `review_commit` 的干净追加提交。
11. **协议清理：** 清理 references、schemas 和 lib 中已经沉积的 `execution-plan.mjs`、`planId`、每阶段重复评审、旧文本 Completion 主协议等描述。JSON Handoff 是 canonical；旧文本 Completion 不再是正常路径，不得作为第二入口。旧 Checkpoint/协议不迁移、不兼容、不降级。
12. **计划提交门禁：** 用户明确确认实施后，先由 Git Committer 接收独立 `plan_artifact_handoff`，只提交已批准的本计划文件。该提交成功且工作树恢复干净后，才记录新的 implementation `base_commit` 并启动 Full Stack Coder；plan artifact commit 不得混入 implementation review commit，也不得被审查成实现差异的一部分。
13. **runtime-owned Git mutation：** merge、受限 worktree 生命周期、Checkpoint/execution record commit 是 canonical runtime 特例，必须明确标记，不伪装成 Git Committer。Ticket 实现、普通实现、计划工件和 review fix 提交仍由 Git Committer 协议负责。runtime 特例只能操作声明的路径、引用和固定提交消息格式。
14. **stash 授权：** 自动 stash 不属于一般实施确认。integration 发现 main 存在 execution record 之外的改动时默认阻塞；只有当前 execution 请求提供独立、明确的 stash 授权参数，runtime 在 mutation 前持久化该授权事实后，才可进入现有事务化 stash 状态机。不得从“确认实施”“同意整合”或旧计划推断授权。
15. **审查分支：** review manifest 的 `spec_status=absent` 时只运行 Standards；`spec_status=present` 时运行 Standards + Spec。不得通过“未找到”静默推断 absent；调用者必须显式提供状态和来源检查结果。
16. **统一 review manifest：** manifest 至少包含 `fixed_point`、`review_commit`、结构化 `commit_list`、`diff_command`、`spec_status`、`spec_source`、`standards_source`、稳定排序的 `shards`/shard IDs 和 manifest digest。所有叶子任务接收同一不可变 manifest；不得分别重算 `HEAD`、文件列表、命令或规格状态。
17. **审查输出：** 移除不可验证的“400 字”硬限制。发现摘要与覆盖清单分字段记录；任何摘要预算都不得包含 manifest、shard IDs、已覆盖/未完成清单和必要文件行引用。未覆盖 shard 时审查不得完成。
18. **Handoff 身份与一致性：** claim 持久化并返回 `claim_id`、`expected_role_id` 和 workflow `session_id`。JSON Handoff envelope 必须携带相同身份；runtime 同时校验 Ticket ID、claim 当前状态、role/session/claim identity，以及 envelope 与 payload 的 `status`、`summary`、`checks`、`error` 逐值一致。矛盾、重放或身份错误必须零状态推进失败。
19. **结构化路径集合：** Full Stack Coder、Git Committer、Ticket completion、plan artifact handoff 和 runtime execution record commit 都使用由 `git status --porcelain=v2 -z --untracked-files=all` 派生的结构化数组，不再以换行分隔字符串集合表示路径。结构必须保留 index/worktree 状态、目标路径及 rename/copy 的源路径，支持空格、换行、引号、反斜杠、前导连字符和其他 Git 合法特殊字符。
20. **hook 失败：** Git Committer 在 hook/commit 失败后重新读取 porcelain `-z`，分别报告 index 与 worktree 的真实结构化状态；不得笼统声称“未暂存”“工作树未变化”或自行 reset。失败后授权/交接按契约消费，后续动作必须重新建立状态证据。
21. **代码导航职责：** `project-code-navigation` Skill 只负责使用索引或维护 `.ai-work-flow/index/`，不直接修改源码；源码实现始终归 Full Stack Coder。索引命中后必须聚焦验证入口职责及请求所需直接依赖，不能只因路径存在就认定有效，也不能无理由扩大全仓搜索。
22. **Environment Skills：** `generate-ai-work-flow-agents` 描述字段级合并和 OpenCode options 整体替换；单平台生成遵循 CLI 单平台验证语义。`switch-ai-work-flow-env` 只执行 `env`/`env list` 和一次事务化 `env use <name>`，不再事后重复 `validate`/`generate`。
23. **角色与 catalog：** `roles.json` 的 description 改为“触发条件 + 必需输入 + 排除条件”。catalog 验证 role kind 枚举、恰好一个 primary、role/tool/delegate 唯一性、policy 完整性、delegate-policy 一致性、委派环、工具与权限关系、routing section 引用以及 body 一一对应；任一错误在 planned write 前停止。
24. **测试升级：** 关键句存在断言只保留为少量 smoke test；主要验收改为三平台 parser round-trip、OpenCode 权限 evaluator 负向测试、临时仓库 plan->commit->implement->review、run-spec review/fix/integrate、生成物篡改/同名 shadow、身份和矛盾 Handoff、特殊路径与 hook 失败行为测试。
25. **真实安装隔离：** 实施和验证不得直接修改 `~/.codex`、`~/.claude`、`~/.config/opencode` 或真实 `~/.config/ai-work-flow`。安装、生成、篡改和 shadow 场景只使用临时 `HOME`/`XDG_CONFIG_HOME` 与临时项目。源码完成并经用户接受后，再由 `generate-ai-work-flow-agents` Skill 更新真实安装。

## 实施决策

### 0. 执行基线与计划工件提交

**依赖：** 用户明确确认本计划；确认只授权 plan artifact 本地提交，不授权 stash、push、amend、reset、clean 或实现范围外变更。

**步骤：**

1. Git Committer 记录 `plan_base_commit=$(git rev-parse HEAD)`，用 porcelain v2 `-z` 读取完整状态；状态必须只包含 `.ai-work-flow/plans/prompt-agent-constraint-hardening/prompt-agent-constraint-hardening-plan.md`。
2. Orchestrator 传递独立 `plan_artifact_handoff`：`plan_id`、计划路径、`plan_base_commit`、结构化 `changed_paths`、用户确认事实和计划校验结果。它不能复用 Full Stack Coder handoff，也不能夹带任何实现文件。
3. Git Committer 只暂存该精确路径，提交信息固定遵循 `$git-commit`，意图为 `docs(plan): 批准 prompt agent 约束加固计划`；提交成功后记录完整 `plan_commit` 和空 porcelain 状态。
4. 以 `plan_commit` 作为 implementation `base_commit`。Full Stack Coder 开始前再次确认工作树为空；后续 implementation review manifest 的 `fixed_point` 必须是 `plan_commit` 或基于它冻结的后续阶段基线，不能把 plan commit 纳入 implementation diff。

**完成条件：** 计划是独立提交、当前工作树干净、implementation baseline 已冻结。

**停止条件：** 计划之外存在任何 staged/unstaged/untracked 项；计划内容在确认后变化；hook 失败；HEAD 改变；无法无歧义解析特殊路径。不得自动 stash 或把其他文件并入计划提交。

### 1. 建立共享治理编译与 catalog 语义边界

**依赖：** 阶段 0 完成。

**文件：**

- `agent-build/config/routing.md`
- `agent-build/config/roles.json`
- `agent-build/config/policies.json`
- `agent-build/templates/*.md`
- `agent-build/runtime/asset-catalog.mjs`
- `agent-build/runtime/managed-content.mjs`
- `agent-build/runtime/platform-adapter.mjs`
- `skills/project-code-navigation/SKILL.md`
- `test/agent-workflow.test.mjs`

**步骤：**

1. 先为 catalog 关系、routing 片段、编译正文和 navigation 职责写失败测试；不从旧计划复制期望文本。
2. 在 routing 中给共享规则片段增加唯一、稳定的 managed section ID。`roles.json` 只引用 section ID，不保存片段正文；body 删除共享流程副本，仅保留角色专属规则和编译插槽/来源说明。
3. `loadAgentAssets()` 解析并验证 routing section，按 role 生成不可变 `compiledBodies`；三个 renderer 只接收 compiled body。源 body、routing 与编译结果分别可诊断，但只有 routing 持有共享规则正文。
4. 扩展 catalog 跨资产校验：kind 只允许 `primary|subagent|reviewer`，恰好一个 primary；ID、delegate、tool 均唯一；delegate 必须存在且图无环；`delegation=none` 不得有 delegate/Task，`review-only` 只能指向 reviewer；工具能力不得与 filesystem/network/delegation policy 明显冲突。
5. 将 description 改为可判定的触发条件、必需输入和排除条件；测试三平台生成描述与 catalog 一致。
6. 拆分 navigation Skill 的“使用索引”“维护索引”“源码实施”边界。索引命中只允许读取入口和完成请求所需的直接 import/caller/schema 依赖；路径存在但职责、符号或路由不匹配时判定 stale，并转为聚焦发现。

**完成条件：** 删除任一必需 routing section、制造重复 primary/工具、委派环或 policy/tool 冲突都会在零平台写入前失败；Claude/OpenCode Orchestrator 生成正文无需读取文件即可包含必需共享治理；源 body 不含共享规则手工副本。

**停止条件：** 需要创建第二个治理内容文件；section 选择只能依赖易漂移的自然语言匹配；catalog 无法在写入前获得完整资产；为修正 Skill 而让 Skill 本身获得源码写权限。

### 2. 加固三平台序列化、权限评估与环境状态

**依赖：** 阶段 1 的 compiled body 与 catalog 验证稳定。

**文件：**

- `agent-build/runtime/platform-adapter.mjs`
- `agent-build/runtime/config.mjs`
- `agent-build/runtime/workflow.mjs`
- `agent-build/runtime/managed-content.mjs`
- `agent-build/config/policies.json`
- `agent-build/config/roles.json`
- `skills/generate-ai-work-flow-agents/SKILL.md`
- `skills/switch-ai-work-flow-env/SKILL.md`
- `test/agent-workflow.test.mjs`
- `package.json` 及新增的根 `package-lock.json`（仅用于标准 TOML/YAML parser 的测试依赖；不得成为已安装 runtime 的生产依赖）

**步骤：**

1. 先添加标准 TOML/YAML parser round-trip 测试。Codex 用一次 TOML string 序列化正文；Claude/OpenCode 先构造无原型数据对象，再用安全 YAML/JSON flow mapping 序列化动态字段，并在测试中按平台 frontmatter 解析。
2. renderer 返回 `{ bytes, parsedMetadata, compiledBody, capabilityEvidence }` 或等价结构；生成计划在写入前校验 round-trip 的字段和正文。生产 serializer 只用本地确定性代码；parser 依赖限定为测试，避免破坏安装后无外部依赖的 CLI。
3. OpenCode 权限从完整 deny map 开始，随后按工具和 policy 逐项 allow。实现一个与生成 permission 对象共用规则的 evaluator 测试辅助器，逐项验证未声明权限拒绝、Orchestrator 只可 task、叶子 reviewer 不可 task/skill/write/network/question/external directory。
4. 移除 `READ_ONLY_GIT_BASH` 的乐观能力证明。允许的命令模式仍可服务运行，但 shell/git capability 在不能参数级证明只读前降级；`git branch*` 不进入 reviewer 白名单，`git diff*`、`node --test*`、`npm test*` 不再支撑 `enforced`。
5. capability 报告增加证据来源，并分离 `kind_primary`、`platform_default_primary`、`exclusive_entry`。Codex/Claude 的 exclusive entry 只能为 `instruction-only`/`unsupported`；OpenCode 仅在全局 default_agent 生效且无 shadow 时报告配置支持，不能夸大为不可绕过。
6. 将 status 基于 `planGeneration` 的 planned bytes 构建。只读取受管目标、marker/manifest 和平台定义同名 agent 所必需的结构字段；对比 bytes/digest，不打印内容。检测当前项目的 `.codex`、`.claude`、`.opencode` 同名 agent 和 OpenCode `agent.<role>` 等高优先级定义；残留旧同名定义按是否影响解析分类为 shadowed 或 drifted。
7. 修正两个 Environment Skill：文档化 role/platform/field merge 与 OpenCode options replace；generate 对单平台只调用一次对应 `generate --platform`；switch 只 list 后调用一次事务化 `env use`。

**完成条件：** 三平台恶意动态值 round-trip 等于输入；OpenCode 每个独立权限都有至少一个 deny 用例；capability 无无证据 `enforced`；篡改、缺失和 shadow fixture 分别得到稳定状态；status 输出扫描无 fixture secret；Environment Skill 命令序列与 CLI 一致。

**停止条件：** 生成 bytes 不能被标准 parser 接受；测试 parser 被迫成为真实安装的隐式生产依赖；未知 OpenCode 权限默认 allow；status 必须输出或散列 secret 才能判断；项目 shadow 优先级无法由受控 fixture 验证。

### 3. 统一 review manifest、Handoff 身份与 Git 路径协议

**依赖：** 阶段 1 的角色/治理编译稳定；阶段 2 的 capability 结果可供 reviewer 约束使用。

**文件：**

- `agent-build/config/routing.md`
- `agent-build/templates/{orchestrator,full-stack-coder,git-committer,code-reviewer,review-standards,review-spec}.md`
- `skills/git-commit/SKILL.md`
- `execution-runtime/handoff-result-schema.json`
- `skills/run-matt-spec-to-completion/completion-result-schema.json`
- `skills/run-matt-spec-to-completion/checkpoint-schema.json`
- `skills/run-matt-spec-to-completion/lib/{validation,completion-adapter,execution-orchestrator,checkpoint,git}.mjs`
- `test/agent-workflow.test.mjs`
- `skills/run-matt-spec-to-completion/test/{completion-adapter,execution-cli,execution-orchestrator,persistence-contract}.test.mjs`

**步骤：**

1. 定义共享 `PathChange` 数据：`record_type`、`index_status`、`worktree_status`、`path`，rename/copy 时必需 `source_path`。所有字段保存 Git 原始路径字符串；比较按结构字段逐值进行，不按展示文本、排序副作用或换行拆分。
2. 在 Git helper 中集中解析 `git status --porcelain=v2 -z --untracked-files=all`；Full Stack Coder handoff、plan artifact handoff、Git Committer 复核、Ticket completion 和 execution record commit 共用该 parser。暂存仍使用参数数组和 `--`，rename/copy 同时覆盖源/目标 pathspec。
3. 将 canonical completion payload 的 `tests` 收敛为 `checks`；envelope 与 payload 的 `status`、`summary`、`checks`、可选 `error` 必须完全相同。旧文本 `RESULT/COMMITS/TESTS` adapter 从正常执行路径和 canonical 文档中移除，不提供降级。
4. `claim` 接受调用者在委派前生成的 workflow `session_id` 和 `expected_role_id`，在 feature lock 内生成不可猜测 `claim_id` 并持久化到 in-progress Ticket。worker 收到三项身份并原样返回；`record-ticket` 对 claim、role、session、ticket、状态和 payload 一致性做一次性校验，成功或 blocked 后 claim 不可重放。
5. 定义不可变 `ReviewManifest`：完整 SHA、结构化 commit list、固定 diff command、显式 spec 状态/来源、标准来源、稳定 shard 清单和 digest。Code Reviewer 只根据 manifest 调度；Standards/Spec 输入持有相同 digest 和完整 manifest。`spec_status=absent` 仅 Standards，`present` 才双轴。
6. 将 coverage 与 findings summary 分离；checkpoint/review 输入记录完整 coverage 状态和 findings summary，不施加 400 字限制。任一 shard 未完成、manifest digest 不一致或叶子重算范围时阻塞。
7. 为 Git hook 失败添加行为：保留现场，重新解析 index/worktree 状态并结构化报告，不执行 reset；测试断言实际 staged 状态，不接受“未暂存”的固定文案。

**完成条件：** rename、copy、空格、换行、引号、反斜杠、前导连字符路径可完成集合比较和精确暂存；错误 role/session/claim、重复 Handoff、summary/checks/error 矛盾均零状态推进；有/无 spec 的 reviewer 数量正确；所有叶子收到同一 manifest digest；hook 失败报告与 Git 实际 index/worktree 一致。

**停止条件：** 任一路径集合仍依赖换行分割；claim 身份未持久化便委派；Handoff 可以由 Orchestrator 重写身份或摘要后通过；review leaf 可自行解析 HEAD/spec；失败处理需要 reset/clean/stash 才能继续。

### 4. 对齐 canonical runtime、review/fix/integration 与 Git mutation 特例

**依赖：** 阶段 3 的 claim/Handoff/review manifest schema 已冻结并通过单元测试。

**文件：**

- `execution-runtime/execution-cli.mjs`
- `execution-runtime/state-store.mjs`
- `execution-runtime/handoff-result-schema.json`
- `skills/run-matt-spec-to-completion/SKILL.md`
- `skills/run-matt-spec-to-completion/checkpoint-schema.json`
- `skills/run-matt-spec-to-completion/execution-plan-schema.json`
- `skills/run-matt-spec-to-completion/completion-result-schema.json`
- `skills/run-matt-spec-to-completion/lib/{execution-orchestrator,integration-lifecycle,pre-merge-stash,checkpoint,checkpoint-integrity,completion-adapter,git,paths,spec-intake,validation,worktree-lifecycle}.mjs`
- `skills/run-matt-spec-to-completion/references/{execution-architecture,completion-protocol,recovery-integrity,installation}.md`
- `skills/run-matt-spec-to-completion/test/{execution-cli,execution-orchestrator,integration-lifecycle,persistence-contract,completion-adapter,ticket-frontier}.test.mjs`

**步骤：**

1. 以 `execution-cli.mjs` 为唯一状态转换入口核对每条命令。Skill 示例统一使用绝对/规范化 `<repository>`、`<feature>`、`<worktree>` 参数，不再省略依赖上下文；stdout 保持单 JSON，stderr 只诊断。
2. `begin-review` 生成并返回统一 manifest；`record-review` 校验 manifest digest、coverage 和 findings；`review-decision` 只接受 `approve|fix`。fix 路径强制 Full Stack Coder 修改/验证后，由 Git Committer按阶段 3 路径协议创建晚于 `review_commit` 的追加提交，再调用 `complete-review-fix`。
3. Skill 固定命令顺序：全部 Ticket done -> `begin-review` -> Code Reviewer -> `record-review` -> `review-decision approve|fix`；approve 后 `integrate`，fix 后 Full Stack Coder -> Git Committer -> `complete-review-fix` -> `integrate`；若结果为 merged/cleanup 未完成，再 `cleanup`。每一步写明进入和完成状态。
4. 删除/更正 references 中不存在的 `execution-plan.mjs` module、`planId` 术语、每阶段重复 review 和文本 Completion canonical 描述。只保留当前 `execution-plan.json`、Checkpoint、JSON Handoff 和单次固定 manifest 审查。
5. 定义 runtime-owned Git allowlist：仅可创建/核验 `feat/<feature>` 与该 feature worktree、合并 checkpoint 固定的 `review_commit|fix_commit`、删除已验证的该 worktree，以及提交 `.scratch/<feature>/execution-plan.json`、`checkpoint.json` 和同目录 `issues/*.md` 的 execution records。禁止通配扩大到其他 `.scratch` feature 或用户文件。
6. execution record commit 消息由 runtime 固定为 `chore(ai-work-flow): record <feature> execution`（`<feature>` 已通过 slug 校验）；这是 canonical runtime 特例，不调用或冒充 Git Committer。普通实现、Ticket、plan 和 fix commit 仍必须经过 Git Committer 契约。
7. integration 检测无关 main 改动时，若本次 `integrate` 没有独立显式 `--allow-stash true`，在任何 stash/merge/checkpoint mutation 前阻塞。参数存在时先在 feature lock 内持久化 authorization，再执行现有 stash operation/reference/restore/drop 状态；恢复只消费已持久化授权，不能补推断。
8. 保持现有 feature lock、Checkpoint integrity、Git ancestry、worktree identity 与崩溃恢复约束；新命令或字段不能绕过 state store。旧 schema 数据明确拒绝，不迁移。

**完成条件：** 临时仓库完整走通 approve 和 fix 两条路径；fix 分支确有追加 Git Committer commit；integrate/cleanup 可恢复；无 stash flag 时 main 无关改动零 mutation 阻塞，有 flag 时按持久状态恢复；runtime commit 只含 allowlist 路径并使用固定消息。

**停止条件：** 任一 Checkpoint mutation 绕过 execution CLI/state store；runtime 需要提交实现代码或计划；stash 授权只能从自然语言/实施确认推断；merge 端点不等于 manifest 批准端点；execution record path 集合包含另一个 feature 或用户文件。

### 5. 端到端收敛与真实安装门禁

**依赖：** 阶段 1 至 4 的定向测试分别通过；每阶段差异仍在本计划文件白名单内。

**文件：**

- `test/agent-workflow.test.mjs`
- 全部 `skills/run-matt-spec-to-completion/test/*.test.mjs`
- 阶段 1 至 4 列出的生产资产、Skill、references、schemas 和 lib

**步骤：**

1. 将只检查关键句存在的测试降为少量生成 smoke test；行为测试直接调用 catalog、renderer、permission evaluator、status planner、Git parser、runtime CLI 和临时仓库流程。
2. 在独立临时 `HOME`、`XDG_CONFIG_HOME` 和 Git 仓库执行 plan artifact commit -> clean implementation -> implementation review commit -> manifest review；验证 plan commit 不在 implementation diff 中。
3. 运行 run-spec 的 approve 和 fix 路径，覆盖 `record-review`、`review-decision`、fix commit、`complete-review-fix`、integrate、cleanup、runtime execution record commit 和中断恢复。
4. 安装/生成三平台到临时目录，逐个 parser round-trip；篡改生成物、删除受管文件、创建项目同名 agent、创建用户残留同名配置，核对 status 及 secret 不泄漏。
5. 对 Handoff 执行 role/session/claim mismatch、envelope/payload 矛盾、重放和 stale claim；对 Git 执行 rename/copy/特殊字符路径、预暂存内容、hook 修改 index、hook 修改 worktree和 hook 非零退出。
6. 最后运行全量测试和差异检查；仅在源码验收完成后，把“由 generate Skill 更新真实安装”报告为后续受控操作，不在本计划实施/测试中执行。

**完成条件：** `npm test`、定向生成测试、全部 execution tests、`git diff --check` 通过；临时安装没有写入真实 HOME/XDG；所有需求都有至少一个行为断言；最终差异没有旧计划、真实安装文件或无关重构。

**停止条件：** 测试触碰真实全局目录；测试必须依赖当前用户已有 agent/config 才能通过；关键安全结论只能由字符串存在断言证明；全量测试失败；最终差异含计划外文件且无法直接追溯到本计划需求。

## 接口与数据约束

### PlanArtifactHandoff

```json
{
  "kind": "plan_artifact",
  "plan_id": "prompt-agent-constraint-hardening",
  "base_commit": "<full-sha>",
  "changed_paths": ["<PathChange>"],
  "checks": ["<non-empty check>"],
  "approved": true
}
```

- `changed_paths` 必须只有本计划路径；`approved` 只能来自用户在计划创建后的明确实施确认。
- 该 handoff 一次性消费，成功提交后不得转成 Full Stack Coder handoff；implementation baseline 取其提交 SHA。

### PathChange

```json
{
  "record_type": "1|2|u|?|!",
  "index_status": ".|M|T|A|D|R|C|U",
  "worktree_status": ".|M|T|A|D|R|C|U",
  "path": "<Git 原始路径>",
  "source_path": "<仅 rename/copy 必需>"
}
```

- canonical 输入是 porcelain v2 `-z` bytes；普通路径也不得走换行文本兼容分支。
- 数组输出按 UTF-8 byte/明确稳定比较规则排序仅用于可重复报告；集合相等以全部结构字段为准。展示层必须转义，不得把展示字符串反解析为 pathspec。
- Git 命令通过参数数组和 `--` 传路径；不得拼接 shell 字符串，不得用 `git add .`、`-A` 或通配符。

### ReviewManifest

```json
{
  "version": 1,
  "fixed_point": "<full-sha>",
  "review_commit": "<full-sha>",
  "commit_list": [{ "sha": "<full-sha>", "subject": "<subject>" }],
  "diff_command": ["git", "diff", "--no-ext-diff", "<fixed>...<review>"],
  "spec_status": "present|absent",
  "spec_source": { "path": "<repo-relative-path>", "revision": "<digest-or-sha>" },
  "standards_source": [{ "path": "<repo-relative-path>", "revision": "<digest-or-sha>" }],
  "shards": [{ "id": "<stable-id>", "paths": ["<Git path>"], "diff_command": ["<argv>"] }],
  "manifest_digest": "<sha256>"
}
```

- `spec_status=absent` 时 `spec_source` 必须显式为 `null`，且只创建 Standards 任务；`present` 时 source 必须存在并固定 revision。
- manifest digest 对规范化 JSON 计算；冻结后任何端点、列表、来源、shard 或命令变化都产生新 manifest，原审查停止。
- coverage 单独使用 `{manifest_digest, completed_shard_ids, incomplete_shard_ids}`；findings summary 不包含 coverage，也不受不存在平台证据的字符硬限。

### Claim 与 JSON Handoff

- `claim` 输入至少含 `expected_role_id`、workflow `session_id`；输出并持久化随机 `claim_id`。三者与 `ticket_id` 共同组成一次性 claim identity。
- Handoff envelope 必需字段为 `role_id`、`session_id`、`claim_id`、`status`、`summary`、`artifacts`、`checks`、`payload`，blocked 时 envelope/payload 都必须有同值 `error`，done 时两层都不得有 `error`。
- payload 至少含 `ticket_id`、`status`、`commits`、`checks`、`summary` 和结构化 `changed_paths`；两层 `status/summary/checks/error` 必须深相等。
- claim identity mismatch、已消费 claim、非 in-progress Ticket、commit 不存在/不在执行分支/不晚于 start commit 或 path schema 无效时，runtime 非零退出并保持 Checkpoint bytes 不变。

### Capability 与 status

- capability 结果使用 `{requested, level, evidence}`；`level` 只允许 `enforced|instruction-only|unsupported`。`evidence` 只能引用生成配置键和已命名负向测试类别，不得引用“prompt 中写了规则”作为 enforced 证据。
- primary 报告拆成 `{catalog_primary, platform_default_primary, exclusive_entry}`；三者不得折叠为单一 enforced 结论。
- status 每个角色输出 `{platform, role_id, state, reasons, planned_digest, installed_digest?}`。`installed_digest` 只对受管 agent bytes 计算；不对用户 options、环境变量、credential 文件或非受管正文计算 digest。
- `shadowed` 检测只报告非敏感定义位置类别和 role ID；解析配置时使用字段白名单，错误对象不得附带原始 source。

### Runtime Git mutation

- runtime-owned 操作只允许：feature worktree add/remove；对 checkpoint 固定 review/fix SHA 执行 merge/abort；在显式授权后对检测到的无关 main 路径执行事务化 stash；提交当前 feature 的 execution record allowlist。
- execution record commit 固定消息 `chore(ai-work-flow): record <feature> execution`；实现、Ticket、plan、review fix commit 不属于此特例。
- `integrate --allow-stash true` 是唯一一般入口的 stash 授权表达；无参数、false、旧 Checkpoint 无字段或仅有“实施确认”均视为未授权。授权一旦持久化只服务当前 execution 的既有 stash 恢复，不跨 feature 复用。

## 验证

### 分阶段命令

1. 资产、生成、权限、环境和临时安装：

   ```bash
   node --test test/agent-workflow.test.mjs
   ```

2. execution runtime 与 Skill：

   ```bash
   node --test skills/run-matt-spec-to-completion/test/persistence-contract.test.mjs
   node --test skills/run-matt-spec-to-completion/test/execution-cli.test.mjs
   node --test skills/run-matt-spec-to-completion/test/execution-orchestrator.test.mjs
   node --test skills/run-matt-spec-to-completion/test/integration-lifecycle.test.mjs
   node --test skills/run-matt-spec-to-completion/test/completion-adapter.test.mjs
   node --test skills/run-matt-spec-to-completion/test/ticket-frontier.test.mjs
   ```

3. 全量与差异：

   ```bash
   npm test
   git diff --check
   git diff --name-only <implementation-base-commit>...HEAD
   git status --porcelain=v2 -z --untracked-files=all
   ```

### 必测场景

| 类别 | 正向场景 | 负向/停止场景 |
| --- | --- | --- |
| 治理编译 | 三平台 body 含相同 routing section digest | body 手工副本、缺 section、重复 ID、错误引用、不可读 Orchestrator 缺核心规则 |
| Catalog | 唯一 primary、合法 reviewer delegate、工具与 policy 一致 | 多 primary、未知 kind/tool/delegate、重复工具、委派环、delegation none 含 Task |
| Parser | TOML/YAML/JSON round-trip 保留 model/options/body | 换行、引号、冒号、分隔符、控制字符造成注入或字面 `\\n` |
| OpenCode 权限 | 角色声明工具逐项可用 | glob/grep/task/skill/web/network/question/external_directory 越权；reviewer 分支 mutation/命令拼接 |
| Capability | 有配置和负向测试证据才 enforced | Codex/Claude exclusive entry 乐观声明；reviewer broad bash 被当成只读 enforced |
| Env status | clean install 为 in-sync | agent bytes 篡改/缺失为 drifted；项目同名为 shadowed；输出含 fixture secret |
| 配置/Skill | 字段级 overlay、options 整体替换；单平台生成 | switch 在 env use 后重复 validate/generate；单平台被无关平台字段阻塞 |
| Plan 流程 | 计划独立提交后 clean implementation | 计划与实现混合提交；计划外脏文件；plan commit 落入 implementation diff |
| Review | absent 仅 Standards；present 双轴；所有 shard 同 manifest | leaf 重算 HEAD、manifest digest 不同、漏 shard、400 字截断覆盖信息 |
| Handoff | 正确 role/session/claim 与两层一致值 | 身份不符、重放、stale claim、summary/checks/error/status 矛盾、错误 Ticket |
| 路径 | rename/copy/空格/换行/引号/前导连字符精确提交 | 换行 split、pathspec 注入、授权后路径集合变化、遗漏源路径 |
| Hook | 成功 hook 后 clean commit | hook 失败、hook 新增 staged/unstaged 内容时准确区分 index/worktree 且不 reset |
| run-spec approve | begin/record/approve/integrate/cleanup 完成 | 缺 repository/feature/worktree、空 diff、非法 ancestry、未记录 review |
| run-spec fix | coder 修复、Git Committer 追加提交、complete fix 后 integrate | 无 fix commit、fix commit 不晚于 review、工作树脏、checks 空、自动复审 |
| Runtime Git | allowlist worktree/merge/record commit | runtime 提交实现/plan、merge 非批准 SHA、execution record 越 feature 路径 |
| Stash | 显式 flag 后可崩溃恢复 | 无独立授权遇 main 改动零 mutation 阻塞；从实施确认推断授权 |
| 安装隔离 | 临时 HOME/XDG 三平台安装和生成 | 真实 HOME/XDG 任一目标 mtime/content 变化 |

### 总完成条件

- 阶段 0 至 5 按依赖顺序完成；每阶段定向测试在不依赖后续未提交改动的提交上通过。
- 本计划 25 项需求各能映射到实现差异和至少一个行为测试；只保留辅助性的关键句 smoke test。
- `agent-build/config/routing.md` 是共享治理正文唯一源；生成 body 可离线执行核心角色约束，且有可验证来源 digest。
- 三平台解析、权限、capability、status 与实际配置一致；没有未经负向测试支持的 `enforced`。
- plan artifact、implementation、review fix 和 runtime execution record 四类提交所有权及差异边界可在临时仓库复现。
- JSON Handoff、review manifest、PathChange 和 stash authorization 都经 schema/结构校验并 fail closed。
- 所有列出的定向测试、`npm test`、`git diff --check` 通过；最终 porcelain 状态为空。
- 未修改两份旧计划、真实全局安装或范围外文件。用户接受源码结果后，真实安装更新作为单独的 generate Skill 操作执行。

### 全局停止条件

- 当前代码事实、`CONTEXT.md` 与本计划冻结决策出现无法兼容的冲突，或必须改变 Checkpoint 当前格式“不迁移、不兼容、不降级”的领域约束。
- 实施前无法把本计划单独提交并恢复干净工作树，或任何阶段出现未识别所有者的变更。
- 平台权限无法证明 enforced 却有代码/文档继续声称 enforced；应先降级，若调用方拒绝降级则停止。
- parser、权限 evaluator、shadow 优先级或 Git 特殊路径只能通过模拟字符串断言，无法形成行为测试。
- Checkpoint integrity、claim identity、review manifest、Git ancestry、worktree identity、stash reference 或 transaction 状态无法验证。
- 任何操作可能写入真实用户全局目录、输出 secret、覆盖 user content、错误提交无关路径、重复委派或错误报告 integration 完成。
- 需要 push、amend、reset、clean、一般性自动 stash、分支重写、新平台/新角色、配置 v2、旧格式迁移或新增产品功能。

## 范围外

- 不修改 `.ai-work-flow/plans/ai-work-flow-hardening-remediation-plan.md`、`.ai-work-flow/plans/git-committer-authorized-scope.md` 或其他历史计划以消除文字冲突。
- 不直接修改、生成或清理 `~/.codex`、`~/.claude`、`~/.config/opencode`、真实 `~/.config/ai-work-flow` 及其用户配置；不读取凭据、token、环境变量值或用户 options 内容用于报告。
- 不新增平台、角色、review 轴、tracker、UI、浏览器自动化或网络功能。
- 不把 instruction-only 约束模拟成 sandbox，不承诺平台无法表达的唯一入口、只读 shell、网络或委派强制力。
- 不迁移、兼容或降级旧 Checkpoint、旧 Handoff、文本 Completion 或旧 execution plan 格式。
- 不允许并行 Ticket frontier、自动复审相同固定范围、自动修复 reviewer finding 或将修复 amend 到 review commit。
- 不扩大 runtime Git 特例到普通实现、Ticket、计划、review fix、任意分支管理、任意工作树清理或任意路径提交。
- 不授权一般性的 stash、push、amend、reset、clean、rebase、force 操作，也不从任务相关性推断文件范围。
- 不重构与本计划契约无关的事务、路径安全、安装布局、测试框架或业务代码。

## 假设

- 当前仓库事实以实施开始时的 `HEAD` 和测试为准；本计划编写时观察到的双重换行转义、OpenCode 权限漏项、乐观 capability、期望 digest、Skill 命令缺口和文本协议沉积仍需在阶段开始时用失败测试复核。
- `agent-build/config/routing.md` 可以增加机器可解析的 managed section 标记而不改变其作为人类可读治理文档的角色；section 引用元数据不构成第二份治理正文。
- OpenCode 支持以 permission map 表达 deny-by-default；若实际版本出现新权限键，默认行为是 catalog/测试失败或 capability 降级，而不是静默 allow。
- TOML/YAML 标准 parser 可作为根测试开发依赖锁定；已安装 workflow runtime 仍保持只依赖 Node 内置模块，生产生成路径不依赖测试 parser package。
- workflow `session_id` 是由调用者在委派前生成并传给 child 的执行会话标识，不要求暴露平台内部 secret/session token；平台原生 handle 可另作非持久诊断，但不是 claim identity 的替代。
- `spec_status=absent` 由调用者在固定 review 端点后显式声明并记录检查依据；没有规格时跳过 Review Spec 是冻结行为，不视为审查不完整。
- 临时 Git 仓库可以配置受控 hook、包含特殊路径并创建 project-level agent fixture；测试不会调用可见浏览器或真实网络。
- 用户确认实施意味着允许阶段 0 的单独 plan artifact 本地提交，以及计划提交完成后按正常流水线创建实现/review fix 本地提交；该确认不包含 stash，stash 必须由 `integrate --allow-stash true` 单独表达。
- runtime-owned execution record commit 是 canonical runtime 的窄特例，固定路径和消息足以审计；它不需要伪装调用 Git Committer，也不削弱其他提交必须走 Git Committer 的规则。
- 完成源码和临时安装验证后，是否更新真实安装仍由用户在后续操作中决定，并通过 `generate-ai-work-flow-agents` Skill 执行。
