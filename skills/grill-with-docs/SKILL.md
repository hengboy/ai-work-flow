---
name: grill-with-docs
description: 与用户进行访谈，将一个想法转化为清晰且有明确边界的业务需求，同时保持领域术语和决策的一致性。
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `.ai-work-flow/agents/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# 讨论需求

运行一次 `/grilling` 会话，并在整个过程中使用 `/domain-modeling`。每次只提出一个具体问题，直到预期的成果、约束条件、术语以及非目标内容都变得清晰为止。

使用项目既定的领域文档规范记录领域决策。在此阶段不要生成计划或任务；将讨论结果移交给 `/write-plan`。
