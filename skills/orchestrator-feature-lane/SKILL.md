---
name: orchestrator-feature-lane
description: Feature lane procedure for the orchestrator. Router classification through PR-ready gate.
triggers: ['feature', 'new feature', 'add feature', 'implement feature', 'build feature', 'create feature', 'user story', 'requirement', 'new functionality', 'new endpoint', 'new page', 'new component']
tags: ['orchestrator', 'feature', 'workflow', 'implementation', 'planning']
negative_triggers: ['bug', 'chore', 'fix bug', 'cleanup', 'maintenance']
---

# Orchestrator Feature Lane

## Activation

Loaded when router returns `lane: 'feature'`. Follow steps in order; no skipping.
Load the hard-rules ref before dispatching the first subagent.

## Common path

1. Classify lane; record `budgetClass` from router.
2. Dispatch `@discovery` + `@tech-design` in parallel. Gate `discovery-done`.
3. Dispatch `@rubber-duck` (grill). Gate `grill-done`.
4. Dispatch `@planner` + `@ui-ux` in parallel. Gate `plan-done`.
5. Dispatch `@rubber-duck` (critique, max 2 iterations). Gate `plan-approved`.
6. Dispatch `@spec-writer`. Gate `spec-draft` — classify the human reply per the orchestrator's "Human gates — input handling" protocol; non-approval input is revision feedback (see refs/procedure.md).
7. On explicit approval: dispatch `@fullstack` per persona; security if required. Gate `pr-ready` — same input-handling protocol applies.

## Branch references

- Full 13-step procedure: [refs/procedure.md](refs/procedure.md)
- Gate CLI commands + hard rules: [refs/hard-rules.md](refs/hard-rules.md)
