---
description: "Use when editing test or eval mjs files. Enforces deterministic assertions and parser checks so regex security lint rules remain error-clean."
name: "ESLint Security Test Rules"
applyTo: "test/**/*.mjs, evals/**/*.mjs"
---
# ESLint Security Test Rules

These are hard constraints for test and eval mjs files.

- Keep secure-coding/no-redos-vulnerable-regex and secure-coding/no-unsafe-regex-construction compliant in tests.
- Avoid regex-heavy assertions when string or token checks are sufficient.
- Prefer deterministic assertions using includes, startsWith, endsWith, split, and trim over broad regex patterns.
- Do not use dynamic regex construction in tests from variables or template interpolation.
- For numbered-step or list checks, use direct prefix checks over generated regex expressions.
- For parser fixtures and command-output checks, use explicit token and boundary checks.

## Required Patterns

- Use exact string checks for known phrases and error markers.
- Use line-by-line scans for structural validation in markdown and frontmatter fixtures.
- Keep test matching logic simple, explicit, and auditable.

## Verification Requirement

- Run eslint on touched test or eval files before finalizing.
- If lint flags regex safety, refactor logic rather than lowering severity.
