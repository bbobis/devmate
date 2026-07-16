---
name: pragmatic-programmer
description: >-
  Coding-bible rules from The Pragmatic Programmer (20th ed) for any code-touching
  task. Use when writing, generating, editing, refactoring, or reviewing code, or
  when touching auth, input handling, config, or credentials. Enforces ETC (Easier
  To Change), DRY, orthogonality, tracer bullets, design by contract, the
  broken-windows rule, tell-don't-ask, crash-early, intent-revealing naming, the TDD
  test pyramid, and security basics. Complements the coding-best-practices skill;
  where they overlap, the stricter rule wins.
---

# Pragmatic Programmer — Coding Bible

> Hard behavioral rules from *The Pragmatic Programmer* (20th ed). Not suggestions.
> Core law: **ETC — Easier To Change** (Tip 14). When rules conflict, pick the option that makes the system easier to change.

## Common path

1. Before writing code — load [refs/code-generation.md](refs/code-generation.md)
2. Before reviewing code — load [refs/code-review.md](refs/code-review.md)
3. Touching auth, input, config, credentials — load [refs/security.md](refs/security.md)

## On-demand refs

- Architecture (decoupling, events, concurrency): [refs/architecture.md](refs/architecture.md)
- Testing (TDD pyramid, Find Bugs Once): [refs/testing.md](refs/testing.md)
- Process (small steps, automation, agility): [refs/process.md](refs/process.md)

## Pre-output gate

Before emitting any code change, pass the checklist in [refs/code-review.md](refs/code-review.md#pre-output-checklist).
