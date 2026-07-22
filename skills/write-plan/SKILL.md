---
name: write-plan
description: 将当前对话和仓库上下文综合成目标项目中的一个持久化实施计划。
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# 编写计划

将当前对话和目标仓库的当前状态转化为一份实施计划。不要再次询问用户；将任何不确定性明确为假设。

## 目标项目

1. **File Explorer** 使用 `git rev-parse --show-toplevel` 确定目标项目的根目录；如果失败，则交接当前工作目录。
2. **Planning Writer** 对该路径以及包含本技能库的目录进行规范化处理。如果两者相同，则向 Coordinator 报告，需要其请求用户提供目标项目目录。
3. File Explorer 交接相关源代码、项目说明、领域文档和 ADR 的路径后，Planning Writer 在编写前阅读这些路径及直接依赖。

## 计划标识与位置

1. Planning Writer 根据需求意图生成一个由两到六个英文单词组成的 `planId`，全部小写并用连字符连接。
2. Planning Writer 使用 `<target-project>/.ai-work-flow/plans/<planId>/plan.md`。
3. 如果该目录已存在，Planning Writer 在文件名后添加 `-2`，然后是 `-3`，依此类推，直到找到一个未被占用的目录。切勿覆盖现有计划。

## 计划内容

Planning Writer 在 `plan.md` 中按以下部分编写：

- `# <计划标题>`
- `## 目标`
- `## 需求`
- `## 实施决策`
- `## 接口与数据约束`
- `## 验证`
- `## 范围外`
- `## 假设`

使用仓库的领域术语。描述受影响的行为、契约和测试接口，但不要将未经验证的细节当作事实。最终结果必须能够在新的实施会话中直接执行。

## 完成

报告确切的计划 ID 和路径。下一步是 `/to-tasks <planId 或计划路径>`。
