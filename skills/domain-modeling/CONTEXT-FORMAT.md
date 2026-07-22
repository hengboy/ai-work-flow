# CONTEXT.md 格式

## 结构

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## 规则

- **坚持明确立场。** 当同一个概念有多个词汇时，选择最佳的一个，并将其他词汇列在 `_避免` 下。
- **定义要简洁。** 最多一到两句话。定义它是什么，而不是它做什么。
- **仅包含与本项目上下文相关的术语。** 即使项目广泛使用通用编程概念（如超时、错误类型、实用模式），这些也不应包含在内。添加术语前，请问：这是该上下文特有的概念，还是通用的编程概念？只有前者才应保留。
- **当出现自然分组时，将术语归类到子标题下。** 如果所有术语都属于一个统一的领域，直接列出即可。

## 单上下文与多上下文仓库

**单上下文（大多数仓库）:** 在仓库根目录下有一个 `CONTEXT.md` 文件。

**多上下文:** 在仓库根目录下有一个 `CONTEXT-MAP.md` 文件，列出各个上下文、它们的位置以及彼此之间的关系：

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

技能会推断适用的结构：

- 如果存在 `CONTEXT-MAP.md`，则读取它以找到各个上下文
- 如果仅存在根目录下的 `CONTEXT.md`，则为单上下文
- 如果两者都不存在，则在解析第一个术语时，懒加载创建根目录下的 `CONTEXT.md`

当存在多个上下文时，推断当前主题与哪个上下文相关。如果不清楚，请询问。


