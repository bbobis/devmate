---
name: tdd-debug
description: TDD and debug skill for implementation agents. Red-Green-Refactor cycle and debug hypothesis loop.
triggers: ['implement', 'fix', 'debug', 'test', 'failing test', 'unit test', 'write test', 'red green refactor']
tags: ['tdd', 'debug', 'testing', 'unit']
negative_triggers: ['research', 'plan', 'design doc']
priority: 3
---

# TDD Debug Skill

## Activation

Loaded automatically by fullstack agent during implementation stages.
Do NOT skip this skill — mandatory for all feature and bug-fix work.
Orchestrator: embed this skill in each `runSubagent` payload; frontmatter `skills` do not auto-inject into subagent contexts.

## Common path

1. **Red** — write the failing test first → [refs/protocol.md](refs/protocol.md)
2. **Green** — minimum code to pass
3. **Refactor** — clean up with tests still Green
4. Unit tests: [refs/unit.md](refs/unit.md) | E2E: [refs/e2e.md](refs/e2e.md) | Debug: [refs/backend-log.md](refs/backend-log.md)
