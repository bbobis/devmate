# TDD Protocol

## The Protocol

For each acceptance criterion in spec.md:

### Step 1 — RED
Write the test first. Do NOT write implementation yet.
Run: <smallest test command for this AC>
Expected result: FAIL (if it passes, the test is wrong — stop and fix it)
Record result in trace.

### Step 2 — GREEN
Write the minimum implementation to make the test pass.
Run: <same test command>
Expected result: PASS
If it fails: diagnose using the Pocock loop before changing more code.

### Step 3 — REFACTOR
Clean up implementation without changing behavior.
Run: full test suite for affected module
Expected result: all pass

### Step 4 — NEXT criterion
Do not move to the next AC until current AC is GREEN and REFACTORED.

## Hard Rules
- NEVER write implementation before a failing test exists for that AC
- NEVER mark an AC complete without a passing test
- NEVER skip RED phase — trivially green tests mean the test is wrong
- NEVER run the full test suite as substitute for the targeted test in RED phase
- If stuck on RED for > 3 attempts: stop, add to spec.md risks, escalate to orchestrator

## Unexpected RED (regression)
If a previously passing test now fails:
1. Do not fix it by commenting it out
2. Read the failing test and the changed file
3. Form a hypothesis (Pocock loop)
4. Fix the implementation — not the test
5. Re-run full suite to confirm no further regressions

## Unexpected GREEN (trivially passes)
If a new test passes before any implementation is written:
1. Stop immediately
2. The test is testing the wrong thing or a pre-existing behavior
3. Revise the test to target the correct missing behavior
4. Confirm RED before proceeding
