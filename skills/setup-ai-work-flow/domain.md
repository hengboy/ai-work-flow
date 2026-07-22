# 领域文档

当探索代码库时，工程技能应如何使用本仓库的领域文档。

## 探索之前，请先阅读以下内容

- 仓库根目录下的 **`CONTEXT.md`**，或者  
- 如果存在的话，仓库根目录下的 **`CONTEXT-MAP.md`** —— 它会指向每个上下文对应的 `CONTEXT.md` 文件。请阅读与当前主题相关的每一份文件。  
- **`docs/adr/`** —— 阅读那些涉及你即将处理的领域的 ADR。在多上下文的仓库中，还应查看 `src/<context>/docs/adr/`，以了解该上下文范围内的决策。

如果这些文件中任何一份不存在，**请照常继续**。不要标记其缺失，也不要建议提前创建它们。`/domain-modeling` 技能（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 获得）会在术语或决策真正被明确时再按需创建这些文件。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录下存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表中的词汇

当你的输出需要命名某个领域概念时（例如在议题标题、重构提案、假设或测试名称中），请使用 `CONTEXT.md` 中定义的术语。不要随意改用术语表中明确避免的同义词。

如果你需要的概念尚未收录于术语表，这可能是一个信号：要么你正在引入项目未使用的术语（请重新考虑），要么确实存在一个空白点（请记录下来，提交给 `/domain-modeling`）。  

## 标记 ADR 冲突

如果你的输出与现有 ADR 存在冲突，请明确指出，而不是悄悄覆盖：

> _与 ADR-0007（事件溯源订单）相矛盾 —— 但值得重新讨论，因为…_

