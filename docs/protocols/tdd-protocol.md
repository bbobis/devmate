# TDD Protocol

> Shared protocol card. Reference this file instead of embedding TDD prose in agent or skill files.

## Purpose

Defines the Red-Green-Refactor cycle followed by all implementation agents.

## Cycle steps

1. **Red** — write or confirm a failing test that captures the requirement.
   Commit message prefix: `test:` (failing).
2. **Green** — write the minimum production code to make the test pass.
   Commit message prefix: `feat:` or `fix:`.
3. **Refactor** — clean up without changing observable behaviour; re-run tests.
   Commit message prefix: `refactor:`.
4. **Repeat** — move to the next requirement and repeat from Red.

## Rules

- Never write production code before a failing test exists.
- A test that always passes (even before the code) is not a valid Red test.
- Refactor only when tests are Green.
- Keep each cycle small (one behaviour at a time).

## Output contract

- After each Green, emit `{ step: 'green', test_file, source_file, tests_passing }` in the result.
- After Refactor, emit `{ step: 'refactor', changed_files, tests_passing }`.

---

_Source: extracted from tdd-debug/SKILL.md and frontend/backend agent files (E0-4)._
_See also: [Loop Protocol](loop-protocol.md), [Debug Protocol](debug-protocol.md)_
