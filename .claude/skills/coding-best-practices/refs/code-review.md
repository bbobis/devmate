# Code Review Rules

> When reviewing any diff, PR, or AI-generated change, apply all rules below.
> Also apply Pragmatic Programmer review rules: [skills/pragmatic-programmer/refs/code-review.md](../../pragmatic-programmer/refs/code-review.md)

## Pre-Output Checklist

Before approving or emitting any code change, verify:

- [ ] 🟢 Does this decrease cognitive load for the reader?
- [ ] 🟢 If this requirement changes, does only one module change?
- [ ] 🔴 Is business logic in the correct layer (not in controller, not scattered)?
- [ ] 🔴 Are internal implementation details leaking through the public interface?
- [ ] 🟡 Can names be understood without reading the function body?
- [ ] 🔴 Are all failure paths handled, logged, and safe — not swallowed?
- [ ] 🟡 Could an on-call engineer debug this in production with current logs?
- [ ] 🔴 Is all external input validated at the trust boundary before use?
- [ ] 🟡 Can this be rolled back or disabled without a redeployment?
- [ ] 🟡 Does this follow established patterns in the codebase (no reinvented utilities)?
- [ ] 🔴 Are domain invariants protected inside the domain object — not scattered?
- [ ] 🟡 Is shared mutable state avoided? Are transformations returning new objects?

## Code Smell Quick Reference

| You See This | Anti-Pattern | Tag | Fix |
|---|---|---|---|
| Class with 20+ methods across unrelated topics | God Object | 🔴 | Decompose into SRP services |
| Hardcoded `42`, `"admin"`, `true` in logic | Magic Numbers/Strings | 🔴 | Named constants or enums |
| Identical logic in 3+ places | DRY violation | 🔴 | Extract shared function (check knowledge duplication first) |
| 4+ levels of nested `if` | Arrow Code | 🟡 | Guard clauses + early return |
| `catch(e) {}` empty catch | Exception Swallowing | 🔴 | Log + rethrow or handle specifically |
| `catch (Exception e)` catches everything | Over-Catching | 🔴 | Catch specific expected error types |
| Tiny class that just delegates | Shallow Module | 🟡 | Merge or give it real responsibility |
| Mutable object passed across services | Shared Mutable State | 🔴 | Return new objects from transformations |
| Business rule duplicated in 4 places | Scattered Invariant | 🔴 | Enforce rule inside the domain object |
| Logs with no context, no trace ID | Useless Logs | 🟡 | Structured logs with context and trace ID |
| AI-generated utility that already exists | Reinvented Shared Logic | 🟡 | Check existing codebase first |
| `order.getCustomer().getAddress().getCity()` | Law of Demeter | 🟡 | `order.shippingCity()` |
| `git commit -m "stuff"` | WIP Dump Commit | 🟡 | Atomic commits with Conventional format |
