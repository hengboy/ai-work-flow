# 好的测试与坏的测试

## 好的测试

**集成式测试**：通过真实接口进行测试，而不是对内部组件的模拟。

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

特点：

- 测试用户或调用者关心的行为
- 仅使用公共 API
- 在内部重构时仍能保持稳定
- 描述的是“是什么”，而非“如何做”
- 每个测试只包含一个逻辑断言

## 坏的测试

**实现细节测试**：与内部结构紧密耦合。

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

危险信号：

- 模拟内部协作对象
- 测试私有方法
- 对调用次数或顺序进行断言
- 当代码在不改变行为的情况下被重构时，测试会失败
- 测试名称描述的是“如何做”，而非“是什么”
- 未通过接口验证，而是通过外部手段进行验证

```typescript
// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
```

**同义反复测试**：预期值只是对实现方式的重复，因此测试只是因为代码本身而通过。

```typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```
