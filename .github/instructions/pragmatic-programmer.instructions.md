---
name: "Pragmatic Programmer Coding Bible"
description: "Apply when writing, editing, or reviewing any code in this repository. Enforces ETC, DRY, Orthogonality, Tracer Bullets, Broken Windows, Tell-Don't-Ask, Design by Contract, Crash Early, Naming, Security, TDD, and small-steps process rules from The Pragmatic Programmer (20th ed)."
applyTo: "**"
---

# Pragmatic Programmer — Coding Bible

> Source: *The Pragmatic Programmer, 20th Anniversary Edition* — David Thomas & Andrew Hunt.
> These are **hard behavioral rules** for all code written in this repository.

## Core Law

> *"Good design is easier to change than bad design."* — ETC (Tip 14)

Every rule below is a specialization of ETC. When rules conflict: pick the option that makes the system easier to change.

## Applicable Rules by Task

- **Writing or generating code** — follow [skills/pragmatic-programmer/refs/code-generation.md](../../skills/pragmatic-programmer/refs/code-generation.md)
- **Reviewing a diff or PR** — follow [skills/pragmatic-programmer/refs/code-review.md](../../skills/pragmatic-programmer/refs/code-review.md)
- **Touching auth, input handling, config, credentials** — follow [skills/pragmatic-programmer/refs/security.md](../../skills/pragmatic-programmer/refs/security.md)
- **Making structural or architectural decisions** — follow [skills/pragmatic-programmer/refs/architecture.md](../../skills/pragmatic-programmer/refs/architecture.md)
- **Writing or updating tests** — follow [skills/pragmatic-programmer/refs/testing.md](../../skills/pragmatic-programmer/refs/testing.md)
- **Planning implementation approach or scope** — follow [skills/pragmatic-programmer/refs/process.md](../../skills/pragmatic-programmer/refs/process.md)

## Pre-Output Checklist

Before emitting any code change, verify:

- [ ] No knowledge duplicated that already exists elsewhere (DRY)
- [ ] If requirements change, only one module needs to change (ETC / Orthogonality)
- [ ] No hidden dependency or coupling introduced (Decoupling)
- [ ] All external inputs sanitized (Security)
- [ ] No credentials or secrets hardcoded (Security)
- [ ] Code crashes early and loudly on impossible states (Tip 38)
- [ ] No exceptions swallowed silently (Tip 38)
- [ ] Names reveal intent using domain vocabulary (Tip 74)
- [ ] Test exists before or alongside the implementation (Tip 66)
- [ ] This is a small, reversible step (Tip 43)
