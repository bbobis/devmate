---
name: "Language-Agnostic Coding Best Practices"
description: "Apply when reading, designing, writing, or reviewing any code in this repository. Enforces the Complexity North Star, Deep Modules, Information Hiding, KISS/YAGNI/DRY, SOLID, Coupling/Cohesion, DDD, Naming, Error Handling, Immutability, Fail Fast, Observability, and AI-coding rules from the Language-Agnostic Coding Best Practices Complete Edition v3."
applyTo: "**"
---

# Language-Agnostic Coding Best Practices

> Source: *Language-Agnostic Coding Best Practices — Complete Edition (v3)*
> These are **hard behavioral rules** for all code read, designed, or written in this repository.

## Core Law

> *"Complexity is anything related to the structure of a software system that makes it hard to understand and modify."*
> — John Ousterhout, *A Philosophy of Software Design*

Every rule below is a tactic for fighting one root enemy: **complexity**.
When rules conflict: choose the option that reduces cognitive load and makes the system easier to change.

## Applicable Rules by Task

- **Writing or generating code** — follow [skills/coding-best-practices/refs/code-generation.md](../../skills/coding-best-practices/refs/code-generation.md)
- **Reviewing a diff or PR** — follow [skills/coding-best-practices/refs/code-review.md](../../skills/coding-best-practices/refs/code-review.md)
- **Designing module/service structure** — follow [skills/coding-best-practices/refs/architecture.md](../../skills/coding-best-practices/refs/architecture.md)
- **Naming anything** — follow [skills/coding-best-practices/refs/naming.md](../../skills/coding-best-practices/refs/naming.md)
- **Handling errors** — follow [skills/coding-best-practices/refs/error-handling.md](../../skills/coding-best-practices/refs/error-handling.md)
- **Writing or updating tests** — follow [skills/coding-best-practices/refs/testing.md](../../skills/coding-best-practices/refs/testing.md)

## Pre-Output Checklist

Before emitting any code change, verify:

- [ ] Cognitive load is reduced for the next reader
- [ ] If this requirement changes, only one module changes
- [ ] Business logic is in the correct layer
- [ ] No internal implementation details leaking through the interface (🔴 HARD)
- [ ] All names are understandable without reading the function body
- [ ] All failure paths are handled, logged, and safe — not swallowed (🔴 HARD)
- [ ] An on-call engineer can debug this in production with current logs
- [ ] All external input is validated at the trust boundary (🔴 HARD)
- [ ] Domain invariants are enforced inside domain objects, not scattered (🔴 HARD)
- [ ] No shared mutable state passed between services (🔴 HARD)
- [ ] This follows the established patterns in the codebase

## Relationship to Pragmatic Programmer Skill

This skill **extends** — not replaces — the Pragmatic Programmer skill.
Apply both together. Where they overlap (DRY, naming, error handling), the stricter rule wins.
- For ETC / orthogonality / tracer bullets / process rules → see [skills/pragmatic-programmer/SKILL.md](../../skills/pragmatic-programmer/SKILL.md)
- For deep modules / DDD / immutability / observability / AI rules → see [skills/coding-best-practices/SKILL.md](../../skills/coding-best-practices/SKILL.md)
