---
name: orchestrator-chore-lane
description: Chore lane procedure for the orchestrator. Scope-driven single-dispatch workflow.
triggers: ['chore', 'cleanup', 'housekeeping', 'maintenance', 'update dependency', 'upgrade package', 'rename', 'reorganize', 'tidy', 'lint fix', 'format', 'remove unused', 'dead code']
tags: ['orchestrator', 'chore', 'workflow', 'maintenance', 'cleanup']
negative_triggers: ['feature', 'bug', 'new feature', 'fix bug']
---

# Orchestrator Chore Lane

## Activation

Loaded when router returns `lane: 'chore'`. No discovery, grill, critique, or spec-writer.
Load the hard-rules ref before dispatching.

## Common path

1. Classify lane; record `budgetClass` from router.
2. Derive `proposedFiles` and write `scope.md`. Gate `scope-written`.
3. Apply architectural guard — escalate to feature lane if scope hits `offLimitsGlobs`.
4. The gate reaches `impl-started` on its own once the router result is on disk —
   the chore lane is mechanical and has no human gate. You have no terminal and
   cannot advance a gate — do not try.
5. Dispatch `@fullstack` (`persona: 'editor'`). Verify via `verify-step.mjs`. Gate `pr-ready`.

## Branch references

- Full procedure: [refs/procedure.md](refs/procedure.md)
- Gate CLI commands + hard rules: [refs/hard-rules.md](refs/hard-rules.md)
