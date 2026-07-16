# Testing Rules

> Cross-reference: also apply Pragmatic Programmer testing rules from [skills/pragmatic-programmer/refs/testing.md](../../pragmatic-programmer/refs/testing.md)

## Test Behavior at Boundaries, Not Internals 🟡 SOFT

```js
// ❌ Brittle — tests internal private step
expect(service.calculateInternalDiscountStep1()).toEqual(10)

// ✅ Tests observable behavior
result = checkout.calculateTotal(cart)
expect(result.total).toEqual(90)
expect(result.discountApplied).toEqual('LOYALTY_DISCOUNT')
```

## Test Pyramid 🟡 SOFT

| Level | Volume | Purpose |
|---|---|---|
| Unit tests | Many | Fast, isolated, domain logic |
| Integration tests | Some | Service + DB/API contracts |
| E2E tests | Few | Critical user journeys only |

Keep the pyramid in shape. A top-heavy pyramid (many E2E, few unit) is slow and fragile.

## TDD 🟡 SOFT

1. Write the failing test first
2. Write the minimum code to pass
3. Refactor

This guarantees testability by design and surfaces API awkwardness before implementation is locked in.

## Optimization Order 🟢 MINDSET

1. Make it **work** (correctness)
2. Make it **right** (clean design)
3. Make it **fast** — only after profiling proves a bottleneck

## AI-Generated Code Rule 🟡 SOFT

All AI-generated behavior must have tests. Unverified behavior is untested behavior.
