---
name: project-code-navigation
description: 使用项目索引只读定位业务入口，或在已授权实现导致入口、文件或职责变化时维护导航索引。
---

# 结果目标

以最小读取范围提供准确入口，或让导航与本轮实现后的真实结构一致。

# 必要前置条件

- 首先选择一个分支：只读定位直接执行 Skill；随实现维护只在主代理委派的 `coding.implement` 内执行。
- 根 `MEMORY.md` 或索引缺失时先使用 `$init-ai-work-flow`。

# 步骤

1. 按所选分支读取一级 reference：`references/read-only-location.md` 或 `references/implementation-maintenance.md`。完成标准：不混用角色权限。
2. 执行 reference 的定位或维护步骤。完成标准：入口、直接依赖和模块边界均由真实文件验证。
3. 维护分支运行 `node skills/project-code-navigation/scripts/validate-navigation.mjs <project-root>`。完成标准：所有索引路径有效且职责变化已同步。

# 条件分支

- 索引命中：禁止扩大为全仓库搜索。
- 索引缺失、无目标功能或路径失效：执行聚焦搜索并在维护授权存在时修复索引。

# 最终验收

只读分支未写文件；维护分支只改必要索引/MEMORY，验证脚本通过。
