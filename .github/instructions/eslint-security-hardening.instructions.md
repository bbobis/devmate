---
description: "Use when writing or refactoring mjs files that parse text, match paths/globs, or validate command strings. Enforces hard security rules for regex safety, unsafe regex construction, and xpath-injection lint compliance."
name: "ESLint Security Hardening Rules"
applyTo: "**/*.mjs"
---
# ESLint Security Hardening Rules

These are hard constraints for all mjs code in this repository.

- Keep secure-coding/no-redos-vulnerable-regex, secure-coding/no-unsafe-regex-construction, and secure-coding/no-xpath-injection compliant by default.
- Never introduce dynamic regular expressions from variable input, string interpolation, or new RegExp with concatenated runtime values.
- Avoid regex-first parsing for structured text when deterministic string parsing is practical.
- Prefer explicit tokenization and boundary-aware string checks over broad or nested regex expressions.
- If wildcard matching is needed, use existing deterministic glob logic from lib/gate-guard-core.mjs instead of building regex patterns.
- Do not create parser logic that depends on greedy or nested quantifiers for YAML/frontmatter/table parsing.
- Keep command validation deterministic: split tokens and validate runtime, quoting, extension, and path shape explicitly.
- For path/reference scanning, use explicit boundary checks with character classification instead of dynamic regex assembly.
- For artifact spec parsing, use delimiter/index-based parsing; do not model delimiter parsing as query/xpath-like expression logic.

## Required Patterns

- Reuse existing safe helpers when available, especially matchGlob from lib/gate-guard-core.mjs.
- Prefer simple loops plus indexOf, startsWith, endsWith, slice, split, and trim for parser-style code.
- Keep matching logic auditable and branch-based; make acceptance criteria obvious in code.

## Disallowed Patterns

- new RegExp with interpolated strings or escaped user/config values.
- Regex patterns that combine overlapping quantifiers, nested quantifiers, or broad wildcard sections for parser workflows.
- String matchers that rely on regex where equivalent deterministic token logic is straightforward.

## Verification Requirement

- After touching parser, matcher, or command-validation code, run eslint on changed files before finalizing.
- If a security lint rule flags a pattern, prefer code refactor over severity downgrade.
