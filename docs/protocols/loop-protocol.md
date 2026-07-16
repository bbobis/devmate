# Loop / Retry Protocol

> Shared protocol card. Reference this file instead of embedding loop prose in agent files.

## Purpose

Defines the standard loop-and-retry contract used by all implementation agents.

## Loop steps

1. **Plan** — read the task context; confirm scope before touching files.
2. **Implement** — make the smallest change that satisfies the current step.
3. **Verify** — run the relevant check (tests, lint, type-check) and capture results.
4. **Assess** — if the check passes, advance to the next step; otherwise retry.
5. **Retry limit** — after 3 consecutive failures on the same step, escalate:
   write a concise failure report and hand off to the orchestrator.

## Output contract

- Return `{ step, status, artifact_written, next_recommended_step }` — never a raw transcript.
- On escalation, include `{ step, status: 'escalated', failure_summary, attempts }` in the report.

## Rules

- Never skip the Verify step.
- Never silently swallow a failing check — surface it in the result object.
- Each iteration is idempotent: running the same step twice must not corrupt state.

---

_Source: extracted from orchestrator, backend, and frontend agent files (E0-4)._
_See also: [TDD Protocol](tdd-protocol.md), [Debug Protocol](debug-protocol.md)_
