# End-to-end test branch reference

Lazy-loaded branch of the `tdd-debug` skill. Load this only when the active
task is writing or fixing **end-to-end (E2E) tests** across layers.

## When E2E (not unit)

- The behaviour spans HTTP + service + persistence and the contract is the
  user-visible flow, not a single function.
- A unit test would mock so much that it no longer proves the behaviour.

## Red-Green-Refactor (E2E detail)

1. **Red** — drive the system from its real entry point (HTTP route, CLI
   command) and assert on the externally observable result.
2. **Green** — wire the thinnest real path that satisfies the flow.
3. **Refactor** — keep the E2E Green; push detail down into unit-tested units.

## Conventions

- Use real fakes at the edges (in-memory store, local fixture server) rather
  than deep mocks.
- Keep E2E count small; they are slow. Most coverage lives in unit tests.
- Cap output: return `file:line` pointers, never full request/response dumps.

## Protocol card

- [TDD Protocol](../../../docs/protocols/tdd-protocol.md) — shared contract.

_Grounding: [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)_
