# Unit-test branch reference

Lazy-loaded branch of the `tdd-debug` skill. Load this only when the active
task is writing or fixing **unit tests**.

## Red-Green-Refactor (unit detail)

1. **Red** — write one failing test that names the behaviour, not the
   implementation. Assert on observable output, not internal calls.
2. **Green** — write the smallest change that makes the test pass. Do not add
   untested branches.
3. **Refactor** — remove duplication while tests stay Green.

## Conventions

- One behaviour per test; name tests `subject / does X when Y`.
- Use `node:test` with `node --test`. Each file runs in its own process.
- Prefer pure functions and dependency injection over module mocks.
- Cap tool/log output: return result objects with `file:line` pointers, never
  full dumps.

## Protocol card

- [TDD Protocol](../../../docs/protocols/tdd-protocol.md) — full Red-Green-Refactor
  contract and output shape.

## Output shape

```
{ step, status, artifact_written?, tests_passing, next_recommended_step }
```

_Grounding: [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)_
