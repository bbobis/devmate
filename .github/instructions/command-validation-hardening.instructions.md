---
description: "Use when editing command parsing or hook command validation in mjs files. Enforces deterministic tokenized validation and forbids dynamic regex command parsing."
name: "Command Validation Hardening"
applyTo: "lib/hooks/registry.mjs, scripts/**/*.mjs"
---
# Command Validation Hardening

These are hard constraints for command parsing and command validation code.

- Validate command shape with explicit token parsing and branch checks.
- Avoid dynamic regex construction for runtime command validation.
- Prefer command splitting plus explicit checks for runtime, quoting, extension, and path structure.
- Keep platform-specific checks explicit and deterministic.
- Use clear acceptance criteria in code paths, including reject reasons.

## Required Patterns

- Parse command tokens once and validate each required invariant directly.
- For quoted script paths, validate opening and closing quote positions explicitly.
- For extension checks, use endsWith against an allowlist.

## Disallowed Patterns

- new RegExp for command-shape validation from runtime values.
- Broad parser regex patterns for command tokenization where deterministic parsing is practical.

## Verification Requirement

- Run eslint on touched command-validation files before finalizing.
- Fix security lint findings with refactors, not severity changes.
