# 何时进行 Mock

仅在**系统边界**处进行 Mock：

- 外部 API（支付、邮件等）
- 数据库（有时 - 更推荐使用测试数据库）
- 时间/随机性
- 文件系统（有时）

不要 Mock：

- 自己的类/模块
- 内部协作对象
- 任何你能够控制的部分

## 针对可 Mock 性的设计

在系统边界处，设计易于 Mock 的接口：

**1. 使用依赖注入**

将外部依赖作为参数传入，而不是在内部直接创建它们：

```typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
```

**2. 优先选择 SDK 风格的接口，而非通用的 fetch 函数**

为每个外部操作创建专门的函数，而不是使用一个带有条件逻辑的通用函数：

```typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(`/users/${id}`),
  getOrders: (userId) => fetch(`/users/${userId}/orders`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
```

SDK 方式意味着：
- 每个 Mock 都返回一种特定的结构
- 测试设置中无需条件逻辑
- 更容易看出测试覆盖了哪些端点
- 每个端点都有类型安全性


