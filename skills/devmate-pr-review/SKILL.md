---
name: devmate-pr-review
description: Review the active task's branch diff against its planning artifact (alignment) plus security and quality best practices, then emit a typed verdict. Use before opening a PR to confirm the change matches the plan.
triggers: ['pr review', 'review the diff', 'review against plan', 'alignment review', 'review my changes']
tags: ['devmate', 'pr', 'review', 'workflow', 'alignment']
negative_triggers: ['pr ready', 'open pr', 'ready to merge', 'implement', 'fix', 'debug', 'injection', 'vulnerability', 'owasp']
argument-hint: "[--state-file <path>] [--base <ref>] [--include-full-output]"
priority: 5
---

# devmate PR Review

Review the branch diff for the active task against its plan (alignment) and
security/quality best practices, then emit a typed verdict — never a raw diff dump.

## Common path

1. **Gather** — run `node "${PLUGIN_ROOT}/scripts/pr-review.mjs"`; it writes a
   capped context to `.devmate/state/pr-review-context.json`. Read that file.
2. **Review** — follow [refs/methodology.md](refs/methodology.md): load only the
   relevant resource-skill refs; judge alignment, quality, and security.
3. **Emit** — write the verdict and print the summary per
   [refs/output-format.md](refs/output-format.md).

Alignment rules: [refs/alignment-checklist.md](refs/alignment-checklist.md).
Best-practices lens: [refs/best-practices.md](refs/best-practices.md).
