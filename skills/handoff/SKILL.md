---
name: handoff
description: 将当前对话精简为一份交接文档，供另一位代理接手。
argument-hint: "下一次会话将用于什么目的？"
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `.ai-work-flow/agents/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

编写一份手交文档，总结当前对话内容，以便新代理能够继续工作。将其保存到用户操作系统的临时目录中，而不是当前工作区。

在文档中包含一个“建议技能”部分，列出该代理应调用的技能。

不要重复其他工件（规格、计划、ADR、问题、提交、差异）中已记录的内容，而是通过路径或 URL 进行引用。

删除任何敏感信息，例如 API 密钥、密码或个人身份信息。

如果用户提供了参数，请将其视为下一次会话的重点描述，并据此调整文档内容。
