---
name: to-tasks
description: 将已批准的本地实施计划拆分为具有依赖关系感知的垂直切片任务文件。
disable-model-invocation: true
---

## 专职代理路由

本技能由 **Coordinator** 路由。Coordinator 只与用户交互、调度、等待和汇总，不直接访问工作区、运行 Shell、编辑文件或实施。将全库枚举、`glob`、`grep` 和代码地图交给 **File Explorer**；外部一手资料交给 **Researcher**；普通文档交给 **Document Maintainer**；计划、任务、ADR、交接和跟踪器文本交给 **Planning Writer**；源码、测试、配置、调试和提交交给 **Full-Stack Coder**；稳定差异的双轴评审交给 **Code Reviewer**。除 File Explorer 外，所有本地角色只读取其交接的路径及直接依赖；写入角色串行执行。生成工作流后，以 `~/.config/ai-work-flow/routing.md` 为最终规则。下文的每个命令和第二人称指代均由相应受委派角色执行，绝不由 Coordinator 执行。

# 到任务

将一个现有的本地计划拆分为可追踪的垂直切片。任务是本地规划的产物，而非问题跟踪记录。

## 定位计划

1. 使用 `git rev-parse --show-toplevel` 确定目标项目根目录；如果不可用，则使用当前工作目录。
2. 如果其规范路径为本技能库，则拒绝写入，并要求提供目标项目目录。
3. 接受显式指定的计划 ID 或计划路径。对于 ID，请在 `<target-project>/.ai-work-flow/plans/<planId>/plan.md` 中查找。
4. 当未提供显式引用时，在 `<target-project>/.ai-work-flow/plans/` 下枚举所有计划。如果有多个候选计划，应请用户选择，不得自行猜测。
5. 读取所选计划的全部内容及相关的仓库上下文。

## 拟定分解方案

创建完整且可独立验证的垂直切片。每个任务必须覆盖所有必需的层次，适合一次新的实施会话，并仅列出真正的阻塞依赖项。对于大规模的机械性重构，应先扩展、在 CI 绿色批次中迁移，最后再收缩。

展示一份编号的拟议分解方案，列出每个任务的标题、阻塞依赖以及端到端交付内容。询问粒度和依赖关系是否合理，以及是否需要合并或拆分某些任务。反复迭代，直至用户明确批准。

## 写入已批准的任务

仅在获得批准后，才在 `<target-project>/.ai-work-flow/plans/<planId>/tasks/` 目录下创建任务文件。不得覆盖现有任务文件；如果任务文件已存在，则停止并请求指示。

按依赖顺序编写名为 `NN-<task-slug>.md` 的文件，从 `01` 开始。每个文件必须包含以下内容：

```markdown
# NN - <Task title>

## Goal

<end-to-end behavior this task delivers>

## Dependencies

<task numbers and titles, or "None - can start immediately">

## Status

ready-for-agent

## Acceptance Criteria

- [ ] <observable criterion>

## Verification

<commands or checks that prove the acceptance criteria>
```

报告任务目录及未阻塞的前沿。使用 `/implement` 处理一个未阻塞的任务。
