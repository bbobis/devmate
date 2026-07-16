# Debug Protocol

> Shared protocol card. Reference this file instead of embedding debug prose in agent files.

## Purpose

Defines the structured hypothesis loop used by the `diagnose` agent.

## Steps

1. **Gather evidence** — read failing test output, error messages, and relevant source slices.
   Never load full files; use line-range pointers.
2. **Form hypotheses** — list 2-4 candidate root causes ranked by likelihood.
3. **Test the top hypothesis** — find the minimal evidence that confirms or refutes it.
4. **Confirm or eliminate** — if confirmed, produce a diagnosis report;
   if refuted, move to the next hypothesis.
5. **Diagnosis report** — `{ root_cause, affected_files, fix_hint, confidence }`.
   Hand off to the correct fixer agent via `handoffs`.

## Rules

- `diagnose` never implements fixes — it only writes the diagnosis report.
- Maximum 4 hypothesis iterations before escalating to the orchestrator.
- All evidence must cite `file:line` pointers, never inline code dumps.

## Pre-mortem checklist

- Could the fix break any other behaviour? List blast-radius files.
- Are there concurrent callers that could re-trigger the bug?
- Does the fix require a data migration or config change?

---

_Source: extracted from diagnose agent and backend agent files (E0-4)._
_See also: [Loop Protocol](loop-protocol.md), [TDD Protocol](tdd-protocol.md)_
