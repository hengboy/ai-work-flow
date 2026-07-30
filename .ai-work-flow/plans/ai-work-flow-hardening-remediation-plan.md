# AI Work Flow 加固整改与直接集成计划

## 计划元数据

- `planId`：`ai-work-flow-hardening-remediation-plan`
- 依据方案：`.ai-work-flow/plans/ai-work-flow-hardening-and-ux.md`
- 当前 Git 基线：`6bd830f0bd0ff3f30cc63cc1607da255cbea5690`（制定本计划时 `HEAD` 与 `main` merge-base 相同）
- 当前状态：已有跨模块未提交实现；这些改动是整改输入，不视为已验收结果
- 集成决策：每个阶段必须按本项目的 review-after-commit 治理完成一次固定提交双轴审查；审查发现由用户决定是否修复，获准修复后验证并直接进入下一阶段或集成，不自动复审
- 兼容决策：配置继续使用 `version: 1`；Checkpoint 只接受当前格式，旧格式不迁移、不兼容、不降级

## 目标

在不扩大产品功能范围的前提下，将当前方案及历次审查发现收敛为一组可验证、可恢复、可直接集成的提交，并消除跨切片契约不一致导致的反复审查。

完成后必须同时满足：

1. 配置、Environment、事务日志、生成目标和 worktree 路径均不能借助遍历、绝对路径、控制字符或符号链接逃逸受信根目录。
2. Environment 激活、平台生成物和受管平台清单在同一事务中提交；失败或崩溃后只允许恢复到完整旧状态或完整新状态。
3. 平台能力矩阵只报告实际可强制的能力；不能表达的能力明确标记为 `instruction-only` 或 `unsupported`。
4. Checkpoint 的所有持久化状态转换只有 canonical runtime 可以执行；Orchestrator 不能直接写 Checkpoint。
5. Ticket、review、fix、integration 和 recovery 状态机单向、互斥、可恢复；完整性无法验证时停止且不委派新 Ticket。
6. 每个阶段在实现和验证后先创建可审查提交，再基于实施前记录的固定 Git 基线完成一次 Standards 与 Spec 双轴独立审查；修复必须由用户决定，获准后以追加提交和完整验证收敛，不自动触发复审。
7. 每个阶段在前一阶段已完成审查决策的固定关卡上独立通过测试；最终全量测试、差异检查和安装后契约测试全部通过。

## 当前问题与归类

| ID | 尚未解决的风险 | 归属阶段 | 必须关闭的结果 |
| --- | --- | --- | --- |
| RISK-1 | 伪造事务日志可提供任意 `step.path` / `backup`，恢复过程可能删除或重命名受信根之外的路径 | 阶段 2：Environment 事务 | 恢复前验证日志 schema、事务身份、允许根目录和派生 backup；非法日志零目标写入并停止 |
| RISK-2 | worktree 目标的既有父目录可为符号链接，词法包含检查后仍可能在仓库外创建 worktree | 阶段 4：Execution runtime | 创建/恢复前逐级拒绝符号链接并校验 canonical parent；失败前不得调用 `git worktree add` |
| RISK-3 | `execution-orchestrator.mjs` 仍可通过导入或注入 writer 直接持久化 Checkpoint | 阶段 4：Execution runtime | Orchestrator 只调用 runtime 命令/端口；静态与行为测试证明其不能绕过 canonical writer |
| RISK-4 | `generate` 先提交平台生成物，再以第二个事务写受管平台清单，崩溃可产生不一致 | 阶段 2：Environment 事务 | 生成物与 `.managed-platforms.json` 合并为一个预计算计划和一次事务提交 |
| RISK-5 | Codex delegation 被报告为 `enforced`，但生成配置没有强制角色级 delegate allow/deny 集合 | 阶段 3：平台治理 | Codex delegation 降级为真实等级；矩阵、告警、状态输出和快照一致 |

已完成或部分完成的配置校验、frontmatter 安全序列化、稀疏 overlay、单 Ticket frontier、JSON Handoff、claim 排他、Checkpoint 完整性、review fix 直达 integration 等工作，不重新设计；它们作为本计划的不可回归验收项。

## 冻结的跨切片硬契约

以下契约在任何阶段实现前冻结。若实现证明其中任一条不可行，必须触发“契约变更停止条件”，先修订并重新确认本计划，不得在代码中静默改义。

### 1. Canonical runtime 状态写入边界

1. `execution-runtime/execution-cli.mjs` 及其 runtime-owned state store 是 Checkpoint 持久化状态转换的唯一入口。
2. 所有改变 Checkpoint 的动作，包括初始化、worktree relocation、claim、Ticket 完成/阻塞、review 开始/记录/决策、review fix 完成、stash 各阶段、merged 和 cleanup 完成，都必须在 runtime 的互斥锁内完成“读取完整性校验 -> 合法转换 -> 原子写入”。
3. `skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs` 和 integration lifecycle 只能请求 runtime transition；不得导入 `writeCheckpoint`，不得接收 `checkpointWriter` 注入，不得自行组合并落盘新 Checkpoint。
4. `status` 是只读接口；所有 mutating command 使用同一个按 repository + feature slug 定位的排他锁，而不是只锁 `claim`。
5. runtime stdout 每次只输出一个 JSON result，stderr 只输出诊断；JSON Handoff envelope 是 `record-ticket` 的 canonical 输入，文本 Completion 仅作为明确标注的兼容适配输入，不得成为 runtime 第二入口。
6. Checkpoint 写入采用同目录临时文件、文件 flush、原子 rename 和必要的目录 flush；读取不能观察到部分 JSON。
7. 锁冲突、状态冲突、schema 错误、commit 祖先关系错误或完整性无法验证时，命令以非零状态停止，并且不得委派、合并或写入下一状态。

### 2. 路径与符号链接安全

1. 所有外部输入路径先做类型、控制字符、主机路径格式和词法包含校验，再检查现存路径链。
2. 从受信根到目标最近既存父目录的每一级均使用 `lstat` 检查；任何符号链接，包括 dangling symlink，均拒绝。
3. 对必须创建的目标，在实际写入或 `git worktree add` 前重新校验父链，并在创建后校验 canonical identity/containment；任一步失败立即停止。
4. Environment 文件只能是 `environments/` 的直接普通文件；marker 内容只能是已校验 Environment 名称。
5. Checkpoint 只持久化仓库相对、正斜杠、无 `.` / `..` segment 的路径；读取旧绝对路径时拒绝，不迁移。
6. worktree 必须属于同一 Git common-dir，分支必须匹配，并满足实现选定且测试固定的路径 containment 规则；仅分支名相同不构成身份。
7. 本地并发恶意替换目录的文件系统竞态不宣称完全防御；但每次安全敏感操作前后的双重校验及 fail-closed 行为是验收要求。

### 3. 事务、原子性与崩溃恢复

1. 事务日志是不可信恢复输入，不是路径授权来源。恢复前必须验证 `version`、`id`、`phase`、step 类型、唯一目标、允许根目录和 backup 派生关系。
2. backup 路径只能由 canonical step path、transaction id 和 step index 计算；不得直接信任日志中任意 backup 路径。
3. 事务文件、锁文件、目标和 backup 自身均不得是符号链接；非法或无法解析的日志必须零目标写入、保留诊断并停止，不得“尽力恢复”。
4. 同一 generation transaction 同时只能有一个 owner。活 owner 存在时其他命令停止；仅满足明确 stale 规则时允许接管恢复。
5. 写入顺序固定为：完整计划预计算和校验 -> 持久化 applying 日志 -> 逐步备份/写入并刷新日志 -> 持久化 committed -> 清理 backup -> 清理日志和锁。
6. 未 committed 的有效事务恢复到完整旧状态；已 committed 的有效事务保留完整新状态并仅清理 backup。恢复必须幂等。
7. Environment marker、目标平台生成物及 `.managed-platforms.json` 若属于同一命令，必须在同一计划、同一事务中提交；不宣称跨文件系统单指令原子性。
8. `--dry-run` 不创建目录、锁、日志、临时文件、backup、marker 或 manifest，只报告完整计划。

### 4. 平台能力矩阵

1. 能力矩阵按 `platform × role × capability × requested policy value` 计算，输出仅允许 `enforced`、`instruction-only`、`unsupported`。
2. `enforced` 必须能指向生成配置中的具体限制，并有负向测试证明越权动作被平台配置拒绝；仅出现在 prompt/routing 中的规则只能是 `instruction-only`。
3. 平台不支持或当前 adapter 无法表达的限制为 `unsupported`，必须告警；不得通过近似映射冒充强制执行。
4. Codex 当前未生成角色级 delegation allow/deny 约束，因此 delegation 不得报告为 `enforced`。只有后续 adapter 真实生成并测试该约束后才能升级。
5. Codex `filesystem: none` 降级为 `read-only` 时报告 `unsupported`；Claude Code 的细粒度 shell/network/git/write scope 维持真实的非强制等级。
6. Asset catalog、roles、policies、默认配置、body 模板和 adapter 支持表必须在任何平台写入前整体校验；未知 capability、policy value、role、字段或冲突映射导致全命令零写入失败。
7. `generate`、`env status`、安装输出及文档使用同一 matrix 计算结果，不保留手写的第二份真相。

### 5. 审查与状态机

1. AI Work Flow `code-review` 契约要求调用方提供 fixed point，并审查 `git diff <fixed-point>...HEAD`。因此 Code Reviewer 必须在每阶段实现和验证完成、该阶段代码已提交后，基于固定 Git 基线审查该提交；不得审查滚动工作区或未提交内容。
2. 每次审查并行或分别执行 Review Standards 与 Review Spec 两个独立轴，分别保留发现后再汇总；任一轴未完成都不算该次审查完成。
3. 审查发现先完整记录并报告用户。只有用户明确决定修复时，实施角色才可在当前 review commit 之后创建追加修复 commit，重跑完整阶段验证；不得 amend、rebase 或移动已审查提交来隐藏审查历史。
4. 用户获准的修复提交不自动触发 Code Reviewer，也不构成新的审查轮次；验证通过后直接固定该阶段关卡并进入下一阶段或 integration。只有用户明确要求新的独立审查，且提供新的审查范围和规格依据时，才可启动一次新的双轴审查。
5. 阶段关卡头依次记为 `G1` 至 `G5`。无修复时，关卡头为 review commit；有用户批准的修复时，关卡头为修复 commit，并保留其关联的 review commit、用户决定和验证记录。`G1` 至 `G5` 全部通过后直接 integration，不再对相同累计差异追加全局独立审查。
6. Ticket frontier 严格串行：同时最多一个 `in_progress`；claim 必须先持久化再委派；blocked、未知结果或完整性失败后不开放下一 Ticket。
7. 当前格式的 execution plan/Checkpoint 不自动修复、不猜测事实。恢复所需事实无法验证时，recovery 停止。

## 执行基线与提交规则

### 执行前快照

实施开始时先执行并保存结果，不修改文件：

```bash
git status --short
git diff --name-only
git diff --check
git rev-parse HEAD
git merge-base HEAD main
git branch --show-current
```

执行基线记为 `B0`。若 `HEAD` 仍为本计划记录的 SHA，则 `B0=6bd830f0bd0ff3f30cc63cc1607da255cbea5690`；否则以实施开始时记录的 SHA 为准，并先确认新增差异没有改变本计划事实。另记录当前 tracked binary diff、完整 untracked 清单及每个 untracked 文件的内容摘要为 `W0`，用于恢复，不把现有脏改动误认成阶段成果。

现有脏工作区作为只读整改输入：不得在其中切换、重置、贮藏、删除或提交。先从 `B0` 创建干净 remediation worktree 和验证 worktree；每个阶段只能按经确认的文件/补丁白名单从输入 worktree 移植或重建改动，untracked 输入必须同时核对来源路径和 `W0` 内容摘要。`W0` 快照与输入 worktree 共同保留至集成结束，且不写入目标仓库。开始任一阶段前 remediation worktree 必须干净；源输入或 `W0` 无法核对、或任一阶段需要未列入白名单的内容时停止。共享文件可以跨阶段修改，但每个阶段关卡固定后必须在仅含已提交历史的干净验证 worktree 中通过本阶段矩阵，不能借助后续未提交文件通过。

### 阶段提交与固定基线

- 阶段 1 到阶段 5 的关卡头依次记为 `G1` 至 `G5`，其中 `G0=B0`。每阶段实施前，以当时 parent commit 记录不可变 `F_n`：`F_n=$(git rev-parse G(n-1))`；除非触发重新规划，不得在该阶段内更换 fixed point。
- 每阶段先完成实现和验证，再创建唯一的 review commit `H_n`，且其 parent 必须是 `F_n`。`H_n` 必须是 `F_n` 的后代，工作区必须干净，且提交中不得含隔离的无关修改。若用户批准审查修复，只能在 `H_n` 后追加一个或多个修复 commit；修复后 head 仍是 `F_n` 的后代。
- Code Reviewer 每次开始前固定并核对两个完整 SHA，至少保存以下命令的结果；审查对象只允许是 committed range，不读取或评价未提交差异：

```bash
git rev-parse <fixed-point>
git rev-parse <review-commit>
git diff <fixed-point>...<review-commit>
git log <fixed-point>..<review-commit> --oneline
```

- 固定审查范围为 `F_n...H_n`；Review Standards 与 Review Spec 基于完全相同的两个 SHA 独立审查。开始审查后不得 amend、rebase、强制移动或替换这两个端点。
- 若任一审查轴有 finding，先结束并记录审查结果，再等待用户决定。用户批准修复时，实施角色创建追加 commit 并重跑完整阶段验证，不自动启动下一轮 Code Reviewer；用户拒绝必须修复的 finding 或验证失败时停止。不得把工作区修补直接展示给 reviewer。
- `H_n` 无 finding 时固定为 `G_n`；用户批准且验证通过的修复后，修复 head 固定为 `G_n`。固定后的 `G_n` 不得 amend、rebase 或强制移动。若用户明确要求新审查，必须先记录新的完整 SHA、fixed point 和规格依据；它是新的用户发起操作，而非流程自动续轮。
- 提交顺序“实现与验证 -> review commit -> Code Reviewer”直接满足 AI Work Flow 的 fixed point、Git 范围证据和 Standards/Spec 双轴方法；不依赖不存在的“review before final commit”默认规则。
- 提交信息遵循仓库 Gitmoji + 既有中文风格；Git Committer 仍须遵守完整状态清单和一次性白名单授权，不从任务相关性推断可提交文件。

## 阶段 1：配置安全

### 范围

- 固化 Environment 名称、marker、配置文件和 frontmatter 动态值的输入边界。
- 固化 `version: 1` 完整默认配置与稀疏 overlay 合并规则。
- 保证未知字段、未知角色/平台、控制字符、非有限值及不安全路径在任何写入前失败。
- 将现有安全实现整理为可单独验收的配置层，不在此阶段处理事务恢复。

### 非目标

- 不改变 Environment 激活事务协议。
- 不调整平台能力等级。
- 不改变 execution plan 或 Checkpoint schema。
- 不引入配置 v2 或自动重写现有 Environment 文件。

### 依赖

- 仅依赖 `G0` 和本计划冻结的路径契约。

### 涉及模块

- `agent-build/runtime/config.mjs`
- `agent-build/runtime/workflow.mjs` 中配置加载、validate/generate 预检入口
- `agent-build/runtime/shared.mjs`（仅在现有结构无法提供统一错误/JSON 校验时最小修改）
- `test/agent-workflow.test.mjs`

### 验收不变量

1. Environment 名称只接受 1–64 位允许字符，拒绝 `.`, `..`、分隔符、绝对路径、反斜杠、控制字符和空值。
2. Environment 根目录、文件、marker 的既存路径链含任意符号链接时，命令失败且不触碰链接目标。
3. 默认配置必须完整；非默认配置允许稀疏覆盖；`opencode.options` 整体替换；显式 `null` 保持既定覆盖语义。
4. `validate` 校验全部平台；`generate --platform` 只要求目标平台最终配置可生成，但仍检查全局结构、未知角色和未知字段。
5. model、variant、effort、reasoning 和 options 中的控制字符不能注入 TOML/YAML/frontmatter。
6. 所有配置错误发生在全局文件、agent 文件、marker 或 manifest 写入前。

### 验证矩阵

```bash
node --test test/agent-workflow.test.mjs
git diff --check G0..HEAD
```

测试至少覆盖：路径遍历、POSIX/Windows 绝对路径、反斜杠、控制字符、dangling symlink、符号链接父目录、恶意 marker、未知字段/角色、稀疏合并、`options` 整体替换、显式 `null`、单平台生成预检和 frontmatter 换行注入。

### 提交与基线

- 提交意图：`:lock: 加固配置与环境输入边界`
- 关卡头：`G1`
- 固定审查范围：`G0...H1`
- 阶段关闭条件：干净验证 worktree 中上述矩阵通过，且阶段范围之外文件未进入提交。

## 阶段 2：Environment 事务

### 范围

- 关闭 RISK-1“伪造事务路径”和 RISK-4“generate 与平台清单非原子”。
- 将 Environment use/delete、平台生成、marker 和受管平台 manifest 统一接入受信、串行、可恢复的事务协议。
- 补齐事务日志原子写入、持久化顺序、崩溃注入和幂等恢复。

### 非目标

- 不改变角色 Policy 或能力等级。
- 不把技能/runtime 目录复制纳入同一个跨文件系统事务；安装复制继续由安装生命周期负责，但必须在所有 catalog/config/platform plan 预检通过后开始。
- 不承诺抵御具有同用户权限、持续并发替换目录的攻击者。
- 不改变 execution Checkpoint 的状态事务。

### 依赖

- `G1`。
- 使用阶段 1 的安全路径和配置加载结果作为事务计划输入。

### 涉及模块

- `agent-build/runtime/transaction.mjs`
- `agent-build/runtime/paths.mjs`
- `agent-build/runtime/workflow.mjs`
- `agent-build/runtime/platform-adapter.mjs` 的 plan/apply 边界
- `test/agent-workflow.test.mjs`

### 实施要求

1. 为事务定义严格 schema 和调用方提供的 allowed roots/targets；恢复时先完整验证日志，验证完成前不执行 `rm`、`rename`、`mkdir` 或写入。
2. 不再信任持久化的任意 backup；由 canonical path + transaction id + index 重算并比对。
3. 对 transaction/lock/target/backup 做符号链接和普通文件类型检查；非法日志保留现场并报告人工恢复条件。
4. 所有 mutating generation/env 命令在同一 generation lock 下先恢复有效中断事务，再开始新事务；live owner 时失败，不抢占。
5. `generate` 在内存中计算“现有受管平台 ∪ 本次平台”，将 manifest write 与全部平台 generation steps 合并后只调用一次 `applyTransaction`。
6. `install` 将本次受管平台清单与 generation steps 同批提交；`env use` 将 generation steps 与 marker 同批提交；`env delete` 将 marker 与环境文件删除同批提交。
7. 事务日志及目标临时文件使用同目录原子写，按冻结契约 flush；恢复对同一日志重复执行结果一致。

### 验收不变量

1. 伪造的外部 `step.path`、外部/错名 backup、重复 step、未知 phase/type、非法 id 或符号链接事务文件均导致零目标写入失败。
2. 对每个持久化边界注入失败或进程中断，重启后只能得到完整旧状态或完整新状态。
3. generation 成功但 manifest 旧、manifest 新但 generation 旧的状态不可由受支持命令产生。
4. rollback 恢复每个预存文件的原字节内容；删除操作也可恢复；backup 不覆盖用户文件。
5. `--dry-run` 报告 generation、marker、manifest 的完整联合计划且零写入。
6. 两个并发 generate/env 命令至多一个持有事务；另一个不恢复 live 事务、不交叉写入。

### 验证矩阵

```bash
node --test test/agent-workflow.test.mjs
git diff --check G1..HEAD
```

新增/保留测试矩阵：

| 维度 | 用例 |
| --- | --- |
| 日志伪造 | 外部目标、外部 backup、backup 命名不匹配、重复路径、未知字段/phase/type、非法 JSON、symlink 日志 |
| 写入中断 | record 前后、backup 前后、target 写后、committed 日志前后、backup 清理中、日志清理中 |
| 命令 | install generation、generate 单/多平台、env use default/custom、env delete active/inactive、dry-run |
| 并发 | live owner、stale owner、恢复竞争、重复恢复 |
| 一致性 | agents + marker + manifest 的旧/新状态组合不得混合 |

### 提交与基线

- 提交意图：`:lock: 加固环境生成事务与崩溃恢复`
- 关卡头：`G2`
- 固定审查范围：`G1...H2`
- 阶段关闭条件：RISK-1 日志伪造与 RISK-4 原子性风险均有失败前零写入测试和崩溃恢复测试。

## 阶段 3：平台治理

### 范围

- 关闭 RISK-5“Codex delegation 误报”。
- 统一 Policy catalog、adapter 实际映射、能力矩阵、告警与状态输出。
- 保证平台生成仅修改 managed content，并在生成前验证完整资产目录。

### 非目标

- 不为平台实现其本身不支持的权限机制。
- 不通过提示词声称获得 sandbox 强制力。
- 不新增角色，不改变用户已确认的角色职责、四档风险路由或浏览器授权策略。
- 不改变 Environment 事务协议或 execution 状态机。

### 依赖

- `G2`，能力输出和平台文件必须通过阶段 2 的联合事务写入。

### 涉及模块

- `agent-build/config/policies.json`
- `agent-build/config/roles.json`
- `agent-build/runtime/asset-catalog.mjs`
- `agent-build/runtime/platform-adapter.mjs`
- `agent-build/runtime/workflow.mjs` 的 capability/status 输出
- `agent-build/templates/*.md`（仅能力边界需要同步时）
- `test/agent-workflow.test.mjs`

### 验收不变量

1. 每个 role 引用一个存在且字段完整的 policy；未知 capability/value、缺 role/default/body 或孤儿 body 在任何写入前失败。
2. matrix 由 policy 值和 adapter 的实际强制机制共同计算，不使用仅按平台写死、与 role/policy 无关的乐观等级。
3. Codex delegation 在没有角色级 allow/deny 生成约束时不为 `enforced`；输出、warning 和快照一致。
4. 对 OpenCode、Claude Code 的 delegation/filesystem/shell/network/browser/git/write scope 同样逐项核对；只有负向平台配置测试支持的项可为 `enforced`。
5. Codex `filesystem: none` 的 read-only 降级明确为 `unsupported` 并告警。
6. `generate`、`env status` 和安装输出对同一 platform/role/policy 返回同一 matrix。
7. 用户维护的全局配置、非受管 agents 和 managed marker 外用户内容字节级保留。
8. 任何请求能力与 adapter 映射冲突时整个多平台 generation 零写入失败。

### 验证矩阵

```bash
node --test test/agent-workflow.test.mjs
git diff --check G2..HEAD
```

能力测试按三平台、全部角色、七项 capability 展开，至少包含：policy `none/read/write/allowed/review-only` 的正向渲染、负向越权约束、所有非 `enforced` 告警、Codex delegation 回归、OpenCode reviewer task 边界、Claude 指令级能力，以及 asset catalog 失配时零写入。

### 提交与基线

- 提交意图：`:bug: 修正平台能力治理与 delegation 声明`
- 关卡头：`G3`
- 固定审查范围：`G2...H3`
- 阶段关闭条件：RISK-5 被测试关闭，且不存在“prompt 中写了规则所以报告 enforced”的路径。

## 阶段 4：Execution runtime

### 范围

- 关闭 RISK-2“符号链接 worktree 父目录”和 RISK-3“Orchestrator 直写 Checkpoint”。
- 将所有 Checkpoint mutation 收敛到 canonical runtime state store 和统一 feature lock。
- 完成 prepare、claim、record、review、fix、integrate、cleanup、status 的状态机与崩溃恢复闭环。
- 保持 JSON Handoff、Completion result、Ticket frontier、commit ancestry 和 Checkpoint integrity 的现有正确行为。

### 非目标

- 不迁移或兼容旧 Checkpoint 格式。
- 不恢复无法证明完整性的 execution。
- 不引入第二套文本 runtime API。
- 不允许并行 Ticket frontier。
- 不改变业务 Ticket 内容、issue tracker 类型或 Git 提交授权规则。

### 依赖

- `G3`。
- 使用冻结的路径安全契约；execution Checkpoint 锁独立于 generation transaction 锁。

### 涉及模块

- `execution-runtime/execution-cli.mjs`
- `execution-runtime/handoff-result-schema.json`
- 可新增 `execution-runtime/state-store.mjs` / lock helper，作为 runtime-owned persistence boundary
- `skills/run-matt-spec-to-completion/checkpoint-schema.json`
- `skills/run-matt-spec-to-completion/lib/checkpoint.mjs`
- `skills/run-matt-spec-to-completion/lib/checkpoint-integrity.mjs`
- `skills/run-matt-spec-to-completion/lib/execution-orchestrator.mjs`
- `skills/run-matt-spec-to-completion/lib/integration-lifecycle.mjs`
- `skills/run-matt-spec-to-completion/lib/worktree-lifecycle.mjs`
- `skills/run-matt-spec-to-completion/lib/spec-intake.mjs`
- `skills/run-matt-spec-to-completion/lib/validation.mjs`
- `skills/run-matt-spec-to-completion/lib/completion-adapter.mjs`
- `skills/run-matt-spec-to-completion/lib/paths.mjs`
- execution runtime 相关测试文件

### 实施要求

1. 将纯 transition 函数与持久化 writer 分离；writer 只由 runtime-owned state store 调用。
2. Orchestrator 删除 `writeCheckpoint`/writer injection 以及直接 mutation + persist 路径，只通过 canonical command adapter 请求 transition。
3. integration lifecycle 的 stash operation、stash ref、restore applying/restored/dropped、merged、cleanup 等中间状态逐一通过 runtime transition 持久化，保留既有恢复顺序。
4. 所有 mutating command 共用 feature lock；在锁内重新读取并验证 execution plan/Checkpoint，原子写新 Checkpoint后释放。status 可无锁读取原子文件，但必须运行完整性检查。
5. prepare 初始化和 resume relocation 也受同一 writer 边界约束；不存在“初始化例外”或“integration 例外”。
6. `record-ticket` 只从 stdin 接受 schema 校验的 JSON Handoff envelope，envelope 与 payload 状态一致；done commit 必须存在、位于 execution branch、晚于 start commit。
7. worktree 创建前对 repository root 至目标 parent 的现存链逐级 `lstat`，拒绝 symlink/dangling symlink；创建后核对 root、branch、common-dir 和 containment，再写 Checkpoint。
8. recovery 先校验当前格式、spec revision、Ticket 集合/顺序/依赖、commit、branch、worktree identity 和 integration 事实；任一失败时不创建 worktree、不委派、不写 recovery 状态。

### 验收不变量

1. 除 runtime-owned state store 外，生产模块不存在 Checkpoint 持久化调用；静态边界测试阻止 Orchestrator/integration lifecycle 回归直写。
2. 同一 feature 的任意两个 mutating command 不能丢失更新或并发通过非法状态；stale lock 恢复不削弱 live lock。
3. claim 先持久化 `in_progress` 再返回 Ticket；中断后 recovery 不重复委派。
4. 符号链接 worktree parent、外部 repository 同名分支、错误 common-dir、错误 branch、旧绝对路径均在 Git/Checkpoint 写入前失败。
5. Ticket 全 done 后只进入一次 review；`awaiting_user -> fix -> fixing -> complete-review-fix -> integrating` 不回到 review。
6. stash/merge/cleanup 每个崩溃点可恢复；无法定位已记录 stash 或无法验证 merged commit 时停止，不错误报告完成。
7. stdout/stderr、退出码和 JSON schema 契约稳定；canonical 与兼容适配路径不会产生两个状态写入口。

### 验证矩阵

```bash
node --test skills/run-matt-spec-to-completion/test/persistence-contract.test.mjs
node --test skills/run-matt-spec-to-completion/test/execution-cli.test.mjs
node --test skills/run-matt-spec-to-completion/test/execution-orchestrator.test.mjs
node --test skills/run-matt-spec-to-completion/test/integration-lifecycle.test.mjs
node --test skills/run-matt-spec-to-completion/test/completion-adapter.test.mjs
node --test skills/run-matt-spec-to-completion/test/ticket-frontier.test.mjs
git diff --check G3..HEAD
```

测试矩阵必须包含：

| 维度 | 用例 |
| --- | --- |
| writer 边界 | Orchestrator 无 writer import/injection；所有 mutation 经 runtime；初始化/integration 无例外 |
| 并发 | claim/claim、claim/record、record/record、review/integrate、live/stale lock |
| worktree | 正常路径、既存 symlink parent、dangling parent、目标已存在、外部 repo 同名分支、relocation |
| Ticket | 错 ID、非 claimed、blocked、空/伪造 commit、start=end、非祖先、重复恢复 |
| review | awaiting_user、approve、fix、complete-review-fix、禁止自动复审、非法转换 |
| integration | stash 各持久化边界、merge 成功/失败、记录提交失败、cleanup 中断、stash 不可用 |
| 兼容 | legacy orchestrator execution plan 仍走 claim/record；旧 Checkpoint 格式明确拒绝 |

### 提交与基线

- 提交意图：`:lock: 收紧 execution 状态写入与 worktree 边界`
- 关卡头：`G4`
- 固定审查范围：`G3...H4`
- 阶段关闭条件：RISK-2、RISK-3 均由负向测试关闭，且全套 execution tests 在干净 `G4` 上通过。

## 阶段 5：治理与文档

### 范围

- 使 routing、角色正文、Skill、领域术语、README、execution architecture 和代码导航与 G1–G4 的实际契约一致。
- 固化“阶段实现验证后提交、固定基线单次双轴审查、用户决定修复后直接前进、全部阶段通过后直接集成”的项目级治理覆盖。
- 删除相互冲突或重复维护的规则文本，保留一个生成来源。

### 非目标

- 不新增功能、不修改已验收 runtime 行为。
- 不借文档阶段修复源码问题；若文档暴露源码与冻结契约不一致，回到对应阶段处理并重新验收。
- 不在阶段审查通过后对相同累计差异追加重复的最终 Code Reviewer，不将测试等同于独立审查。
- 不创建计划以外的报告或 HTML 工件。

### 依赖

- `G4`；文档只能描述已通过测试的行为。

### 涉及模块

- `agent-build/config/routing.md`
- `agent-build/templates/orchestrator.md`
- 其他受影响的 `agent-build/templates/*.md`
- `skills/run-matt-spec-to-completion/SKILL.md`
- `skills/run-matt-spec-to-completion/references/execution-architecture.md`
- `README.md`
- `CONTEXT.md`
- `.ai-work-flow/index/feature-navigation.md`
- `test/agent-workflow.test.mjs` 的生成/安装契约测试

### 验收不变量

1. routing 是角色共用治理规则的唯一 managed source；角色正文只保留职责、边界和回复格式，不复制易漂移流程。
2. 文档明确 canonical runtime writer、当前 Checkpoint 格式、事务不可信输入、符号链接策略、能力等级含义和 direct integration 规则。
3. Orchestrator 只协调，不访问工作区、不写 Checkpoint；平台不能强制时按 matrix 真实告警。
4. 审查规则明确：每阶段在 review commit 后基于 fixed point 执行一次双轴审查；修复须用户决定，修复提交验证后不自动复审；不得审查未提交内容。
5. 安装后的 routing、agent body、Skill、runtime 和 schema 引用可解析，不依赖源仓库相对路径。
6. 功能导航列出真实入口和模块边界；不记录计划性、尚未实现的文件。

### 验证矩阵

```bash
node --test test/agent-workflow.test.mjs
npm test
git diff --check G4..HEAD
```

另做静态一致性检查：术语表与 schema 状态一致；README 命令与 CLI usage 一致；安装到临时 XDG/HOME 后 runtime 可解析依赖；生成的三平台 routing 内容一致；仓库中不存在宣称 Codex delegation 为 `enforced` 的过期文本。

### 提交与基线

- 提交意图：`:memo: 固化加固契约与直接集成治理`
- 关卡头：`G5`
- 固定审查范围：`G4...H5`
- 阶段关闭条件：文档只描述已验收事实，全量 `npm test` 在干净 `G5` 上通过。

## 后续发现处理规则

实施、测试或用户检查中出现新问题时，只允许按下表处理，防止范围漂移和无限审查循环。

| 分类 | 判断标准 | 处理 |
| --- | --- | --- |
| A：本计划缺陷 | 直接违反冻结契约、阶段验收不变量或五项风险关闭条件 | 当前阶段尚未固定 `G_n` 时，补最小回归测试和修复后继续；已固定 `G_n` 时立即停止，保留现场并提出新的计划版本。经用户确认后，以新的基线和新的关卡序列重建受影响阶段；不得在旧 `G1...G5` 链上追加返工提交 |
| B：必要前置缺陷 | 不修复就无法证明本计划契约，但不是独立产品功能 | 停止当前阶段；记录因果、最小范围和验证；仅做解除阻塞所需改动；若跨越既定模块边界，先更新计划并取得确认 |
| C：无关改进 | 重构、性能、美化、命名清理、额外兼容或新功能，不影响本计划关闭 | 不修改；记录为后续事项，不进入任何阶段提交 |
| D：契约冲突 | 发现冻结契约互相矛盾、平台无法实现或会改变用户确认的行为 | 全局停止，不选择“最方便”的解释；修订计划并等待用户决定 |
| E：完整性/破坏性风险 | 可能丢文件、写出受信根、错误合并、重复委派或无法确认旧 agent/事务是否仍活跃 | 启动停止锁；禁止新写入、委派、恢复和集成；保留现场并报告人工恢复条件 |

补充规则：

1. review commit 创建前的测试失败是实施反馈；修复后重跑受影响矩阵，不提前触发 Code Reviewer。review commit 创建后的 reviewer finding 必须先由用户决定，获准的追加修复 commit 只需重跑本阶段验证。
2. 同一对 `<fixed-point>, <review-commit>` 只进行一次 Standards/Spec 双轴审查。修复 commit 不自动复审；只有用户明确请求新的独立审查并指定新的审查范围时，才可开始新的双轴审查。
3. 修复只清理自身产生的未使用代码/工件，不顺手重构相邻模块。
4. 任何新增生产依赖、配置版本变化、旧 Checkpoint 迁移、跨文件系统原子性承诺或角色/平台新增都属于范围变更，必须停止并重新确认。
5. 用户要求对修复后的新 head 再审查，且发现表明冻结契约、阶段边界或模块所有权需要调整时，不继续在既有关卡链上打补丁；按 D 类处理，回到硬契约并重新规划。

## 执行顺序与门禁

严格顺序：

```text
B0/W0 快照
  -> 阶段 1 配置安全（记录 F1 -> 实现/验证 -> H1 提交 -> 单次双轴审查 -> 用户决定修复 -> G1）
  -> 阶段 2 Environment 事务（记录 F2 -> 实现/验证 -> H2 提交 -> 单次双轴审查 -> 用户决定修复 -> G2）
  -> 阶段 3 平台治理（记录 F3 -> 实现/验证 -> H3 提交 -> 单次双轴审查 -> 用户决定修复 -> G3）
  -> 阶段 4 Execution runtime（记录 F4 -> 实现/验证 -> H4 提交 -> 单次双轴审查 -> 用户决定修复 -> G4）
  -> 阶段 5 治理与文档（记录 F5 -> 实现/验证 -> H5 提交 -> 单次双轴审查 -> 用户决定修复 -> G5）
  -> 最终全量验证
  -> 直接集成
```

每个箭头的进入条件：前一阶段已在干净验证 worktree 中通过、关卡头已固定为 `G_n`、一次 Standards 与一次 Spec 均已完成并有用户决定记录、`git diff --check` 通过、没有未分类 finding、没有活跃写入者/事务/runtime mutation。不得并行执行阶段，不得用后续阶段代码帮助前一阶段通过。

## 停止条件

出现任一情况立即停止，不进入下一阶段或 integration：

1. 当前工作区状态与 `W0` 不一致且无法判定变更所有者，或出现未授权文件。
2. 冻结硬契约需要改变，或现有平台无法满足计划标为必须 `enforced` 的能力。
3. 事务日志/锁、Checkpoint/锁、worktree identity、stash 或 Git ancestry 无法验证。
4. 任一阶段的负向安全测试、崩溃恢复测试、干净阶段测试或最终 `npm test` 失败。
5. 测试只能在含后续未提交改动的工作区通过，在阶段提交的干净 worktree 中失败。
6. 发现可能写出受信根、覆盖 user content、丢失未提交改动、重复委派 Ticket 或错误报告 integration 完成。
7. main 在执行期间从 `B0` 分叉，导致无法直接 fast-forward/按既定策略集成。
8. 用户撤销“修复后直接集成”决定或要求新的独立审查。
9. 已固定 `G_n` 的阶段发现本计划缺陷，或 fixed point/review commit 任一端点无法解析、被改写或 ancestry 不成立。
10. Code Reviewer 启动时工作区不干净、存在未隔离的无关修改，或审查输入包含未提交内容。

## 回滚与恢复策略

### Git/工作区

- `W0` 与只读输入 worktree 是用户现有变更的恢复依据；不得在输入 worktree 使用 `git reset --hard`、`git checkout --`、贮藏或删除 untracked 文件。集成前后均核对输入 worktree 与 `W0`，不一致即停止。
- 尚未集成的阶段失败时，保留 remediation branch、验证 worktree 和失败现场；当前未固定阶段可通过新提交修复，已固定 `G_n` 的阶段只能建立经用户确认的新计划版本，不改写既有 `G_n`。
- 已直接集成后发现必须回滚时，使用可审计的 revert 提交按 `G5` 向前回退；不重写 main 历史。
- 任一回滚都必须先确认用户原有未提交改动和 stash 状态，不能把平台创建的 stash 与用户 stash 混淆。

### Environment generation

- 有效且未 committed 的事务由下一次 mutating 命令在独占锁内恢复旧状态；有效且 committed 的事务只完成清理。
- 非法、伪造或身份不明的日志不自动恢复、不删除，命令停止并输出日志路径、失败字段和人工处置条件。
- 恢复完成后先运行 `env status`/计划对比确认 agents、marker、manifest 一致，再允许新 generation。

### Execution

- runtime mutation 中断后，下一命令先取得 feature lock并验证当前 Checkpoint；原子写保证只看到旧或新 Checkpoint。
- `in_progress` Ticket 不自动重新委派；需按已有恢复/人工决策协议处理。
- integration 根据已持久化的 stash、merge 和 cleanup 中间状态恢复；事实缺失时停止，不猜测、不创建替代 stash、不报告成功。
- 旧格式或完整性失败 Checkpoint 只报告阻塞，不迁移、不降级。

## 最终验证与直接集成

在干净 `G5` 验证 worktree 中执行：

```bash
git status --short
git diff --check B0..G5
npm test
```

并逐项核对：

1. 五项风险 RISK-1–RISK-5 各有至少一个失败前零写入/零状态推进的负向测试，并有对应正向测试。
2. `git diff --name-only B0..G5` 只包含本计划列出的模块、测试、配置资产、治理文档和代码导航；额外文件必须按后续发现规则分类。
3. 每个 `G_n` 的阶段验证记录完整，且在不包含后续提交的干净 worktree 中通过。
4. 安装到临时 HOME/XDG 后，三平台 agent、routing、skills、runtime、schema 和 manifest 可解析且幂等。
5. generation crash matrix、runtime crash/recovery matrix、并发锁矩阵和符号链接负向矩阵通过。
6. `G1` 至 `G5` 均有 fixed point、review commit、双轴发现、用户决定和验证记录；修复提交不会自动触发复审。

全部满足后，不再对 `B0...G5` 追加一次与阶段审查重复的 Code Reviewer；按用户已确认的决定直接 integration。集成前仍执行 Git 授权白名单检查。若 main 仍位于 `B0`，优先使用可审计的 fast-forward；若 main 已前进，停止并重新验证 merge-base、冲突和全量测试，不自行改变集成策略。

## 成功定义

本计划仅在以下条件全部成立时关闭：

- RISK-1–RISK-5 均由实现、负向测试和恢复测试关闭。
- 五个阶段均有实施前 fixed point、已提交 review head、Standards/Spec 双轴记录、用户决定和固定范围，且可独立验收。
- canonical runtime writer、路径/符号链接、事务恢复、能力矩阵、审查状态机五类硬契约在源码、测试、生成资产和文档中一致。
- 全量 `npm test`、`git diff --check B0..G5` 和临时安装验证通过。
- 没有未分类 finding、非法恢复现场、活跃事务/feature lock 或未知 writer。
- 直接 integration 完成，execution records 可提交且 Checkpoint 最终为 `complete`；若当前任务不经 execution runtime，则等价的 Git 集成结果和验证记录完整。
- 用户原有内容、非受管 agents、全局配置和执行前工作区事实未丢失。

## 范围外

- 配置 v2、旧 Checkpoint 迁移或兼容层。
- 并行 Ticket frontier、并行 writer 或跨 worktree 自动合并调度。
- 新平台、新角色、新 tracker、新 UI 或浏览器自动化。
- 平台原生不支持权限的模拟 sandbox。
- 跨文件系统单指令原子性、对抗同用户持续恶意文件系统竞态。
- 与本计划无关的重构、性能优化、文案整理和测试框架替换。

## 假设

- Node ESM 和现有 AJV runtime 保持可用，不新增生产依赖即可完成整改。
- 当前未提交实现仅作为整改输入；只有经 `W0` 核对且列入阶段白名单的内容才能进入 remediation worktree 和阶段提交，其余内容一律保留在输入 worktree。
- 本计划记录的 `B0` 仅是制定时事实；实施开始时必须重新记录，不盲目信任过期 SHA。
- 所有测试可在临时 HOME/XDG 和临时 Git 仓库运行，不触碰用户真实全局配置。
- “修复后直接集成”表示每阶段对提交范围执行一次强制双轴审查后，用户批准的修复提交经验证即直接前进，不自动复审；它不表示跳过测试、Git 白名单、状态完整性或集成前停止条件。
