# Agent 模型成本与性能研究（2026-07-30）

## 摘要

本报告为本项目的角色路由提供“满足质量的最低成本”基线。官方资料将 OpenAI 的 Sol 定位为旗舰能力、Terra 定位为智能与成本平衡、Luna 定位为高吞吐低成本；Claude 则分别以 Opus、Sonnet、Haiku 覆盖复杂 agentic coding、速度/智能平衡和最快的简单任务。DeepSWE v1.1 为 Sol/Terra/Luna、Opus 5/Sonnet 5 提供了同一编码 harness 下的直接实测，但没有 Haiku 成绩，也没有运行本项目的原生 Codex、Claude 或 OpenCode agent。建议按角色选择最低足够模型与推理档位，并只在安全、权限、迁移、大 diff 或项目评测证明有收益时临时升级。

“官方事实”来自下列官方文档；“本项目建议”是结合角色职责（`agent-build/config/roles.json`、`agent-build/templates/*.md`）和现有配置（`agent-build/config/default-config.json`）作出的路由决策，不是供应商承诺。

## 能力与价格排序

### OpenAI

官方能力排序为 Sol > Terra > Luna：Sol 适合复杂开放工作，Terra 适合日常全能任务，Luna 适合清晰、重复、高吞吐任务（来源：[Latest models](https://developers.openai.com/api/docs/guides/latest-model.md)、[Codex models](https://developers.openai.com/codex/models)）。可用 reasoning 档位为 `low`、`medium`、`high`、`xhigh`；官方建议从 `medium` 作为平衡起点，只有评测显示收益时才升高档位，并使用满足质量的最低 reasoning（同上）。

标准短上下文 API 价格（每百万 token，输入/输出）从低到高为 Luna $1/$6、Terra $2.5/$15、Sol $5/$30（来源：[OpenAI pricing](https://developers.openai.com/api/docs/pricing)）。这是 OpenAI 直接 API 价格，不代表 baibai 的实际账单。

### Anthropic

官方能力排序为 Haiku 4.5（最快）< Sonnet 5（速度与智能平衡）< Opus 5（复杂 agentic coding）；Fable 5 更强但价格更高，默认性价比不取（来源：[Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview)）。标准输入/输出价格（每百万 token）为 Haiku $1/$5、Opus $5/$25、Fable $10/$50；Sonnet 5 在 2026-08-31 前的 introductory pricing 为 $2/$10，之后为 $3/$15（同上）。

Claude Code 中 `opus`、`sonnet`、`haiku` 是家族别名；Anthropic API 当前映射为 Opus 5、Sonnet 5，具体版本仍依 provider（来源：[Claude Code model config](https://code.claude.com/docs/en/model-config)）。effort 的官方含义是：`medium` 平衡成本与性能，`low` 适合简单子代理，`high` 适合复杂编码/agentic 任务；更高 effort 会增加 token 使用（来源：[Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)）。Haiku 4.5 不在当前 effort 支持模型列表中，因此配置中的 `low` 只能标作“配置意图”，必须验证 Claude Code/provider 的实际行为。

## 推理档位原则

- `low`：清晰、重复、窄范围任务；优先用于 Luna/Haiku 叶子角色。
- `medium`：默认平衡点；用于日常编码、研究、文档和审查。
- `high`：复杂编码、规划、任务拆分或高风险审查。
- `xhigh`：仅在超复杂规划且评测证明收益时使用；本项目默认不使用。

安全、权限、迁移或大 diff 的 review leaves 可临时升级至 Sol/high；简单单文件实现的 full-stack coder 可降至 Terra/medium。升级必须是任务级、临时且可回溯的决定。

## DeepSWE 真实评测校准

以下外部资料均访问于 **2026-07-30**。

### DeepSWE 到底指什么

当前与模型路由直接相关的 DeepSWE 是 DataCurve 于 2026-05-26 发布的软件工程 **benchmark**，不是模型、论文名称或 SWE-bench 官方榜单。其官方仓库把它定义为针对活跃开源仓库中原创、长时程软件工程任务的 frontier coding agent 基准；v1.1 保留同一批任务，更新了执行和评分隔离（来源：[DeepSWE repository](https://github.com/datacurve-ai/deep-swe)、[Introducing DeepSWE](https://deepswe.datacurve.ai/blog/deepswe)、[DeepSWE v1.1](https://deepswe.datacurve.ai/blog/deepswe-v1-1)）。截至 2026-07-25 生成的实时 artifact，v1.1 有 113 个任务、91 个仓库、5 种语言（TypeScript、Go、Python、JavaScript、Rust）（来源：[v1.1 leaderboard artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)、[provenance](https://github.com/datacurve-ai/deep-swe/blob/main/PROVENANCE.md)）。

另一个同名项目是 Agentica/Together AI 于 2025-07-02 发布的 **DeepSWE-Preview 模型**：基于 Qwen3-32B、用 R2E-Gym 和强化学习训练，并报告 SWE-bench Verified 42.2% Pass@1、Hybrid Best@8 57.9%、Hybrid Best@16 59%。这是“一个模型在 SWE-bench Verified 上的结果”，不能当成 DataCurve DeepSWE 榜单，也没有评测本项目候选模型（来源：[DeepSWE-Preview model card](https://huggingface.co/agentica-org/DeepSWE-Preview)、[Together AI technical post](https://www.together.ai/blog/deepswe)）。下文所称 DeepSWE 均指 DataCurve v1.1。

### v1.1 评测设置与可复现性

- **任务与指标**：113 个原创 enhancement/bug-fix 型任务，固定到不可变 base commit；每个任务含自然语言指令、Docker 环境、行为型 verifier 和参考解。`pass@1` 是纳入评分的 rollout attempt 通过率；`pass@4` 是至少一次通过的任务数除以尝试任务数。context-window failure 和 agent timeout 计失败，provider/verifier/network error 排除；因此 `pass@1` 不是一次确定性运行的单样本 resolve rate（来源：[README](https://github.com/datacurve-ai/deep-swe/blob/main/README.md)、[v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)）。
- **重复与置信区间**：每个列入下表的配置运行 4 次完整 113-task sweep；有效 attempt 因排除基础设施错误而为 444-452 个。误差条是完整 sweep 之间的 95% CI，即 `1.96 * std(runs) / sqrt(4)`，不是任务级 bootstrap（来源：[v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)）。
- **harness/scaffold 与工具**：所有榜单结果统一使用 `mini-swe-agent`，每轮只给同一 shared prompt 和 Bash，不使用 Codex 的 `apply_patch`、Claude 的编辑工具或供应商专用系统提示。Pier 在 Modal sandbox 中执行；v1.1 要求 agent 在隔离容器提交修改，只抽取 committed patch，在全新 verifier 容器应用并运行 CTRF 测试（来源：[methodology](https://deepswe.datacurve.ai/blog/deepswe#evaluation-harness)、[v1.1 changes](https://deepswe.datacurve.ai/blog/deepswe-v1-1)、[Pier](https://github.com/datacurve-ai/pier)）。
- **工具与预算**：`mini-swe-agent` 的公开默认配置只有 Bash action，`step_limit: 0`、`cost_limit: 0`，即没有独立的 step 或美元硬上限；任务的 Harbor 配置给 agent 90 分钟 timeout、verifier 30 分钟 timeout、无外网、2 CPU、8 GiB 内存和 20 GiB 存储。榜单没有披露统一的输出 token 上限，改为报告每个配置的实际 output token、peak context、步骤、成本和时长；因此不能把中位 token 或步骤误称为预算（来源：[mini-swe-agent default config](https://github.com/SWE-agent/mini-swe-agent/blob/main/src/minisweagent/config/default.yaml)、[example task config](https://github.com/datacurve-ai/deep-swe/blob/main/tasks/abs-module-cache-flags/task.toml)、[v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)）。
- **模型标识与日期**：artifact 内部使用 `gpt-5-6-sol` 等连字符 ID，网页显示为 `gpt-5.6-sol`；最近一批作业在 2026-07-25 完成，artifact 生成于 `2026-07-25T03:13:49Z`。这里按项目配置使用点号显示名，不把它改写成另一个模型（来源：[v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)）。

### 与当前候选模型直接相关的结果

下表均来自同一个 DeepSWE v1.1、`mini-swe-agent`、4-run 设置。成本是 artifact 报告的**每个 scored attempt 平均美元成本**；输出 token、步骤和时长取中位数。`Pass@1` 与成本/延迟分别报告，不合成为单一“性价比分”。

| 模型/effort | Pass@1 | Pass@4 | 平均成本 | 中位输出 token | 中位步骤 | 中位时长 |
|---|---:|---:|---:|---:|---:|---:|
| gpt-5.6-sol/medium | 61.06% | 80.53% | $1.86 | 17,645 | 26 | 355 秒 |
| gpt-5.6-sol/high | 69.40% | 86.73% | $3.47 | 27,700 | 32 | 517 秒 |
| gpt-5.6-terra/medium | 35.11% | 60.18% | $0.58 | 11,453 | 24 | 194 秒 |
| gpt-5.6-terra/high | 53.76% | 80.53% | $1.13 | 20,866 | 31 | 315 秒 |
| gpt-5.6-luna/medium | 11.28% | 27.43% | $0.22 | 7,919 | 22 | 152 秒 |
| gpt-5.6-luna/high | 44.25% | 75.22% | $0.78 | 24,818 | 44 | 394 秒 |
| gpt-5.6-luna/max | 67.19% | 90.27% | $3.03 | 70,253 | 92.5 | 983 秒 |
| claude-opus-5/medium | 68.90% | 89.38% | $3.29 | 33,436 | 43 | 587 秒 |
| claude-opus-5/high | 72.83% | 87.61% | $6.08 | 59,856 | 64 | 1,006 秒 |
| claude-sonnet-5/medium | 39.78% | 64.60% | $4.08 | 50,415 | 100.5 | 981 秒 |
| claude-sonnet-5/high | 48.23% | 79.65% | $7.43 | 77,993 | 138 | 1,539 秒 |

直接结果支持两个有限结论。第一，`gpt-5.6-sol/medium` 是成本优先的长时程实现基线，`high` 用约 1.86 倍平均成本换取 8.34 个百分点 Pass@1，可作为质量升级。第二，在该 harness 下，`claude-opus-5/medium` 同时超过 `claude-sonnet-5/high` 的 Pass@1（68.90% vs. 48.23%），且平均成本、步骤和时长更低；所以本项目实现角色不应仅因“Sonnet 通常更便宜”而默认 Sonnet。`gpt-5.6-luna/max` 的 67.19% 说明模型与 reasoning 必须成对比较，但它以 92.5 步和约 3 美元换来成绩，不能证明 Luna/low 适合编码。

DeepSWE v1.1 **没有 Claude Haiku 结果**。它也没有在本项目的 Coding 拓扑、原生 Codex/Claude/OpenCode harness 或 `baibai` provider 上运行；因此不能把上述数字当成本项目线上成功率或 baibai 账单预测。

### 污染、版本和跨基准风险

- DataCurve 声明任务与参考解从零编写、不复制或改编现有 PR/commit/public patch，且不回合并上游；v1.1 还删除 agent 可见的 future Git history，并在 2026-06-05 做过相似实现 sweep。这显著降低已知答案检索风险，但属于 benchmark 作者声明，不是对所有模型训练语料的独立证明。基准仓库和 `solution/` 现已公开，未来模型或后训练数据仍可能摄入；当前候选模型的训练截止日期也未由该 artifact 披露（来源：[methodology](https://deepswe.datacurve.ai/blog/deepswe)、[v1.1 report](https://deepswe.datacurve.ai/blog/deepswe-v1-1)、[public task tree](https://github.com/datacurve-ai/deep-swe/tree/main/tasks)）。
- v1.1 与 v1 是同一批任务的不同评分环境：v1.1 改为 committed patch + separate verifier container、修复 dependency drift 并移除 flaky tests；官方重评显示个别配置可变化数个百分点。因此只在同一 v1.1 artifact 内横比，不拼接 v1 数字（来源：[v1.1 report](https://deepswe.datacurve.ai/blog/deepswe-v1-1)）。
- DeepSWE、SWE-bench Verified、SWE-bench Pro 和 SWE-bench Multilingual 是不同数据集。Verified 是 500 个经人工筛选的 SWE-bench Python 实例；Multilingual 是来自 42 个仓库、9 种语言的 300 个任务；SWE-bench Pro Public 是 Scale 的 731-task public set，并用 fail-to-pass/pass-to-pass 定义 resolve rate；DeepSWE 则是 113 个原创任务。任务分布、难度、提示、verifier、harness、尝试次数和评分规则都不同，**不能把分数直接混排**（来源：[SWE-bench Verified](https://www.swebench.com/verified.html)、[SWE-bench Multilingual](https://www.swebench.com/multilingual-leaderboard.html)、[SWE-bench Pro](https://scale.com/leaderboard/swe_bench_pro_public)、[DeepSWE methodology](https://deepswe.datacurve.ai/blog/deepswe)）。
- `pass@1`、`pass@4`、SWE-bench 的 `% Resolved`、成本、token 和时长是不同维度。即使基准相同，只要 scaffold、模型 snapshot、effort、attempt 数、日期或错误排除规则不同，也不能宣称模型本身有精确排名。v1.1 已不在主页面报告 wall-clock，因为主机和 provider load 使其不稳定；本报告只保留 artifact 中的中位时长作为该批运行的观测值，不把它当供应商延迟保证（来源：[v1.1 report](https://deepswe.datacurve.ai/blog/deepswe-v1-1)、[v1.1 artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)）。

### 映射到本项目角色

DeepSWE 的“探索代码库、实现多文件修改、运行测试、提交 patch”与 `full-stack-coder` 的源码/测试/必要配置职责最同构，所以该角色可采用 A 级直接模型证据。行为 verifier 和回归检查能部分支持 `review-spec`、`review-standards` 对完整性与回归风险的判断，但 benchmark 没有让模型执行独立审查，故最多是 B 级相邻证据。`code-reviewer` 主要编排双轴审查；`coding` 主要路由与汇总；planning、任务拆分、文件发现、外部研究、文档维护和受控 Git 提交均不是 DeepSWE 隔离评测的任务形状，只能依据角色职责和官方模型定位，标为 C 级。

## 形成性价比优先的推荐矩阵

下表是本项目建议。证据等级：**A** = 同模型、同 DeepSWE v1.1 直接实测且职责高度同构；**B** = 相邻任务实测、同系列官方定位或 provider/harness 有差异；**C** = 仅按职责形状推断。等级评的是“这条路由建议的证据直接性”，不是模型质量。OpenCode 保持 `baibai/` provider 前缀；其实际价格必须以 baibai 计费为准，不能套用 OpenAI 或 DeepSWE 的 provider 成本。Claude 的 `low*` 表示上文所述的 provider 行为待验证。

| 角色 | Codex | Claude | OpenCode |
|---|---|---|---|
| coding | gpt-5.6-terra/medium [C] | sonnet/medium [C] | baibai/gpt-5.6-terra medium [C] |
| planning | gpt-5.6-sol/high [C] | opus/high [C] | baibai/gpt-5.6-sol high [C] |
| file-explorer | gpt-5.6-luna/low [C] | haiku/low* [C] | baibai/gpt-5.6-luna low [C] |
| git-committer | gpt-5.6-luna/medium [C] | haiku/low* [C] | baibai/gpt-5.6-luna medium [C] |
| researcher | gpt-5.6-terra/medium [C] | sonnet/medium [C] | baibai/gpt-5.6-terra medium [C] |
| document-maintainer | gpt-5.6-luna/low [C] | haiku/low* [C] | baibai/gpt-5.6-luna low [C] |
| planning-writer | gpt-5.6-sol/medium [C] | opus/high [C] | baibai/gpt-5.6-sol medium [C] |
| task-planner | gpt-5.6-sol/high [C] | opus/high [C] | baibai/gpt-5.6-sol high [C] |
| full-stack-coder | gpt-5.6-sol/medium [A] | opus/medium [A] | baibai/gpt-5.6-sol medium [B] |
| code-reviewer | gpt-5.6-sol/medium [C] | sonnet/high [C] | baibai/gpt-5.6-sol medium [C] |
| review-standards | gpt-5.6-sol/medium [B] | opus/medium [B] | baibai/gpt-5.6-sol medium [B] |
| review-spec | gpt-5.6-sol/medium [B] | opus/medium [B] | baibai/gpt-5.6-sol medium [B] |

## 相对当前配置的变化

当前值以 `agent-build/config/default-config.json` 为准，角色语义以 `agent-build/config/roles.json` 与对应 `agent-build/templates/*.md` 为准。

- `coding`：Sol/high → Terra/medium；日常路由先用平衡档，复杂任务按动态规则升级。
- `planning`：Sol/xhigh → Sol/high；保留旗舰模型，去掉默认过高 reasoning。
- `file-explorer`：Codex Luna/low 保持；Claude Haiku/low 保持但需验证 provider；OpenCode Luna/low 保持。
- `git-committer`：Codex/OpenCode Luna low → medium；Claude Haiku/low 保持并需验证。提交虽清晰重复，但 Git 状态和 hook 失败处理值得保留基本推理预算。
- `researcher`：Codex/OpenCode Luna/medium → Terra/medium；Claude Sonnet/medium 保持。研究任务需要长文档筛选、交叉核对和可靠引用，Terra/medium 是成本与稳定性之间更稳妥的折中；DeepSWE 不直接评测研究任务，因此标为 C 级职责判断。
- `document-maintainer`：Codex Luna/medium → Luna/low；OpenCode Luna/medium → Luna/low；Claude Haiku/low 保持。
- `planning-writer`：Codex/OpenCode Sol/xhigh → Sol/medium；Claude Opus/high 保持。保留旗舰模型处理跨模块计划和约束整合，同时将默认 reasoning 降到 medium 控制成本。
- `task-planner`：Sol/xhigh → Sol/high；任务依赖、scope 和验收仍属复杂规划，但默认不使用 xhigh。
- `full-stack-coder`：Codex/OpenCode Sol/medium 保持；Claude Sonnet/high → Opus/medium。DeepSWE v1.1 直接支持这两个成本优先基线；复杂、高风险或多模块实现可临时升 Sol/high 或 Opus/high。
- `code-reviewer`：Codex/OpenCode Sol/medium 保持；Claude Sonnet/high 保持。该角色负责审查编排、门禁和结果汇总，Sol/medium 为复杂分歧判断保留能力余量；编码 benchmark 不是直接证据。
- `review-standards`、`review-spec`：Codex/OpenCode Sol/medium 保持；Claude Sonnet/high → Opus/medium。DeepSWE 仅提供相邻证据，但其行为验证、回归检查和长 diff 任务形状支持保留较强模型；安全、权限、迁移或大 diff 可临时升 Sol/high 或 Opus/high。

## 限制与验证建议

1. 供应商页面的模型别名和版本会变化；发布前应记录实际解析到的模型 ID，而不是只记录 `opus`、`sonnet`、`haiku` 或 `terra` 等别名。
2. 价格只可用于方向性比较：官方价格按 token、上下文长度和缓存等条件计费，且 baibai 代理有独立账单；应以账单和调用日志校准成本。
3. Claude Haiku 4.5 与 `low` effort 的组合属于配置意图，需在 Claude Code/provider 中做一次真实请求验证，确认是否接受、降级或忽略该档位。
4. 对 12 个角色建立本项目 eval：按角色分别记录成功率、返工率、误报/漏报、延迟、输入/输出 token、provider 账单和失败类型。尤其要用相同任务分别跑原生 Codex、Claude 与 `baibai` OpenCode；只有质量显著提升才保留升级。DeepSWE 不能替代这组评测。
5. 变更默认配置前先做 dry-run 或配置解析检查，确认三种执行面（Codex、Claude、OpenCode）的模型字段和 reasoning/effort/variant 字段映射一致；不要把 OpenCode 的 `baibai` 标识替换成供应商直连名称。
6. DeepSWE 能直接比较候选模型的编码能力，但不能直接比较它们在本项目所有角色上的表现。除 `full-stack-coder` 和两个 review leaves 的有限外推外，仍以官方定位和职责形状为主要依据，不制造精确排序。

## 来源

### 官方来源

- OpenAI，模型能力与 reasoning：[Latest models](https://developers.openai.com/api/docs/guides/latest-model.md)。
- OpenAI，Codex 模型使用建议：[Codex models](https://developers.openai.com/codex/models)。
- OpenAI，直接 API 价格：[Pricing](https://developers.openai.com/api/docs/pricing)。
- Anthropic，模型能力与价格：[Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)。
- Anthropic，Claude Code 别名和映射：[Model config](https://code.claude.com/docs/en/model-config)。
- Anthropic，effort 档位：[Effort](https://platform.claude.com/docs/en/build-with-claude/effort)。
- DataCurve，DeepSWE 定义、方法、harness 与限制：[Introducing DeepSWE](https://deepswe.datacurve.ai/blog/deepswe)。
- DataCurve，v1.1 隔离评分和版本变化：[DeepSWE v1.1](https://deepswe.datacurve.ai/blog/deepswe-v1-1)。
- DataCurve，逐配置分数、成本、token、步骤、时长与 CI：[v1.1 live artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)。
- DataCurve，任务格式与复现入口：[DeepSWE repository](https://github.com/datacurve-ai/deep-swe)。
- SWE-bench，Verified 与 Multilingual 定义：[Verified](https://www.swebench.com/verified.html)、[Multilingual](https://www.swebench.com/multilingual-leaderboard.html)。
- Scale AI，SWE-bench Pro Public 定义和 resolve rate：[SWE-bench Pro](https://scale.com/leaderboard/swe_bench_pro_public)。
- Agentica/Together AI，同名 DeepSWE-Preview 模型及 SWE-bench Verified 设置：[Model card](https://huggingface.co/agentica-org/DeepSWE-Preview)、[technical post](https://www.together.ai/blog/deepswe)。

### 仓库来源

- 角色清单、职责和委派关系：`agent-build/config/roles.json`。
- 角色边界、审查门禁与任务语义：`agent-build/templates/*.md`（重点为 `coding.md`、`full-stack-coder.md`、`code-reviewer.md`、`document-maintainer.md`）。
- 当前三执行面默认模型配置：`agent-build/config/default-config.json`。
