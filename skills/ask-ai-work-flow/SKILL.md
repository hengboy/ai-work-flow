---
name: ask-ai-work-flow
description: 通过 AI 工作流技能路由请求。
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# AI 工作流

对于功能或产品变更，请遵循以下主要流程：

1. `/grill-with-docs` 明确意图、约束条件和领域术语。
2. `/write-plan` 将讨论结果整合为本地实施计划。
3. `/to-tasks <planId 或 path>` 将批准的计划转化为具有依赖关系的垂直切片。
4. `/implement` 完成未阻塞的任务，必要时使用 `/tdd`，并在交接前进行 `/code-review`。

将需求讨论、规划和任务分解保持在同一上下文窗口中。每个实施任务都应从新的上下文及其任务文件开始。

对于严重故障，请使用 `/diagnosing-bugs`；对于新提交的跟踪器任务，请使用 `/triage`；对于单次会话难以规划的工作，请使用 `/wayfinder`；对于需要可运行证据的问题，请使用 `/prototype`；对于基于资料的调查，请使用 `/research`；当上下文需要转移到另一个会话时，请使用 `/handoff`。

`/setup-ai-work-flow` 配置由面向跟踪器的技能使用的跟踪器和领域文档。`/write-plan` 和 `/to-tasks` 不需要该配置。

