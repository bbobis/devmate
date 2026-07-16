---
name: coding-best-practices
description: >-
  Language-agnostic coding best practices for writing, reviewing, designing, and
  refactoring code. Use whenever you write, generate, edit, review, or refactor
  code; design a module or service structure; name things; handle errors; or write
  tests. Enforces the Complexity North Star, deep modules, information hiding,
  KISS/YAGNI/DRY, SOLID, coupling/cohesion, DDD, intent-revealing naming, robust
  error handling, immutability, fail-fast, and observability. Complements the
  pragmatic-programmer skill; where they overlap, the stricter rule wins.
---

# Coding Best Practices

> Core law: **Design Against Complexity** — every rule fights one root enemy: complexity.
> When rules conflict: choose the option that reduces cognitive load and makes the system easier to change.
> Complements `pragmatic-programmer`. Where they overlap, the stricter rule wins.

## Common Path by Task

| Task | Load |
|---|---|
| Writing / generating code | [refs/code-generation.md](refs/code-generation.md) |
| Reviewing a diff or PR | [refs/code-review.md](refs/code-review.md) |
| Designing module/service structure | [refs/architecture.md](refs/architecture.md) |
| Naming anything | [refs/naming.md](refs/naming.md) |
| Handling errors | [refs/error-handling.md](refs/error-handling.md) |
| Writing tests | [refs/testing.md](refs/testing.md) |

## Pre-output gate

Before emitting any code change, pass the checklist in [refs/code-review.md](refs/code-review.md#pre-output-checklist).
