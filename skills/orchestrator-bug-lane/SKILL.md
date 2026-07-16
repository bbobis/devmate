---
name: orchestrator-bug-lane
description: Bug lane procedure for the orchestrator. Diagnosis-first workflow through PR-ready gate.
triggers: ['bug', 'fix bug', 'there is a bug', 'broken', 'regression', 'crash', 'error in', 'not working', 'failing', 'broken behavior', 'unexpected behavior', 'wrong output']
tags: ['orchestrator', 'bug', 'workflow', 'diagnosis', 'fix']
negative_triggers: ['feature', 'chore', 'new feature', 'add feature', 'unit test', 'tdd', 'write test']
---

# Orchestrator Bug Lane

## Activation

Loaded when router returns `lane: 'bug'`. `@diagnose` must dispatch before any `@fullstack`.
Load the hard-rules ref before dispatching the first subagent.

## Common path

1. Classify lane; record `budgetClass` from router.
2. Dispatch `@diagnose` → produces `DiagnosisResult` + `scope.md`. Gate `diagnosis-done`.
3. Dispatch `@rubber-duck` (grill). Gate `grill-done`.
4. The gate reaches `plan-approved` on its own once the grill result is on disk;
   the human then types `approve plan`. You cannot advance a gate — do not try.
5. Dispatch `@fullstack` with `persona` from `diagnosis.bugScope`. Gate `verification-passed`.
6. Security review if required. Gate `pr-ready` — human review.

## Branch references

- Full 9-step procedure: [refs/procedure.md](refs/procedure.md)
- Gate CLI commands + hard rules: [refs/hard-rules.md](refs/hard-rules.md)
