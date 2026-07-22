---
name: resolving-merge-conflicts
description: 通过保留预期行为并验证集成结果来解决 Git 合并冲突。
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `.ai-work-flow/agents/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# 解决合并冲突

1. 在编辑之前，检查 `git status`、冲突标记、合并基础以及冲突的双方内容。
2. 明确每一方的行为意图，并确保在解决冲突时保留所有兼容的更改。当无法安全推断意图时，请询问用户。
3. 只移除冲突标记以及因解决冲突而变得过时或不可达的导入或代码。
4. 运行最相关的格式化工具、类型检查和测试。检查最终的差异，确保不再存在任何冲突标记。
5. 报告已解决的文件、所做的选择以及执行的验证步骤。除非用户明确要求，否则不要创建提交。

