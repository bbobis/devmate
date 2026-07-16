# Pragmatic Programmer — Code Review Rules

> Load when: reviewing a diff, approving a PR, or auditing existing code.

## Broken Windows (Tip 5)
- **Never** add code that worsens existing technical debt without flagging it.
- If no time to fix it properly: add a `TODO` with the debt description and a comment explaining the trade-off.
- Flag immediately during review:
  - Misleading or inaccurate names
  - Swallowed exceptions (empty `catch` blocks)
  - Assertions disabled in production
  - Global state and singletons that introduce hidden coupling
  - Method chains that traverse too many object layers ("train wrecks")

## Tell, Don't Ask (Tip 45)
- Don't reach into an object to get data and then make decisions outside the object. Tell the object to do it.
- Avoid chains of more than one `.` when accessing state across object boundaries (Tip 46).
  - Exception: fluent builders and stable library APIs.

```java
// Bad — train wreck
customer.getOrders().find(orderId).getTotals().applyDiscount(discount);
// Good — delegate
customer.findOrder(orderId).applyDiscount(discount);
```

## Assertive Programming (Tip 39)
- Use assertions freely to document assumptions that should never be false.
- **Never turn off assertions in production.** If the code depends on them, behavior without them is undefined.

## Dead Programs Tell No Lies (Tip 38)
- When something impossible happens, **crash immediately and loudly**.
- Throw **meaningful exceptions with context**, not generic `RuntimeException`.
- **Fail fast at startup** if required configuration is missing.
- Never swallow exceptions silently.

## Design by Contract (Tip 37)
- Every function must document its **preconditions** (what the caller guarantees) and **postconditions** (what the function guarantees).
- In Java/Spring Boot: use `@NotNull`, `@Min`, `@Size` at all API boundaries.
- Use `Optional<T>` for potentially absent values — never return `null` from a public API.

## Don't Program by Coincidence (Tip 62)
- Know **why** code works, not just that it works.
- Don't leave in code that "seems to fix something" without understanding why.
- Test all boundary conditions explicitly.
- Don't rely on side effects or undocumented API behaviors.

## Pre-Output Checklist

The agent MUST pass all checks before emitting any code change:

- [ ] Does this code duplicate knowledge that already exists elsewhere? (DRY)
- [ ] If requirements change, how many modules must change? (ETC / Orthogonality)
- [ ] Is there a hidden dependency or coupling being created? (Decoupling)
- [ ] Are all external inputs sanitized? (Security)
- [ ] Are credentials or secrets hardcoded anywhere? (Security)
- [ ] Does the code crash early and loudly on impossible states? (Tip 38)
- [ ] Are exceptions meaningful — never swallowed silently? (Tip 38)
- [ ] Do names reveal intent and use domain vocabulary? (Tip 74)
- [ ] Is there a test before or alongside the implementation? (Tip 66)
- [ ] Is this a small, reversible step? (Tip 43)
