---
name: implement
description: "根据规范或一组任务单实现一项工作。"
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

按照用户在规范或任务单中描述的内容实施工作。

在事先约定的接口处尽可能使用 /tdd 方法。

定期运行类型检查，定期运行单个测试文件，并在最后运行一次完整的测试套件。

完成后，使用 /code-review 对工作进行评审。

将您的工作提交到当前分支。

