---
name: research
description: 对高可信度的一手资料进行问题调研，并将调研结果以 Markdown 文件的形式保存到仓库中。当用户希望对某个主题进行研究、收集文档或 API 相关的事实，或将阅读和整理工作委托给后台代理时，请使用此功能。
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

将外部调研委派给 **Researcher**，这样 Coordinator 可以在其阅读时继续路由其他工作。Researcher 只返回带来源的结论；如需保存 Markdown，由 **Document Maintainer** 根据该交接写入。

其职责如下：

1. 针对 **一手资料** 进行问题调研——包括官方文档、源代码、规范以及第一方 API 等——而不是基于这些资料的二手解读。确保每一条论断都能追溯到其原始出处。
2. 将调研结果和每条论断的来源交接给 Document Maintainer。
3. Document Maintainer 将结果写入单个 Markdown 文件，存放在仓库中已有的相关笔记位置；若无既定规范，则选择合理位置并报告确切路径。
