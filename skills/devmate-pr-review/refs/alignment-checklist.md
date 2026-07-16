# PR Review — alignment checklist

Alignment asks one question: **does the diff do what the plan said, no more and
no less?** The CLI precomputes the set differences into
`context.alignmentSignals` so you judge, not recompute. Keys off `context.lane`.

## All lanes

- **Out-of-scope files** — `alignmentSignals.outOfScopeFiles` (bug/chore) lists
  every changed file that `scope.md` forbids. Any entry is at least a `high`
  `alignment` finding; a change that edits files the task never claimed is a
  scope breach, not a nicety.
- **Test files** — `alignmentSignals.testFilesChanged` and
  `regressionTestPresent` report whether the diff touched tests.
- **Security artifact** — if `artifacts.security.found`, fold its findings in as
  described in [best-practices.md](best-practices.md); do not re-scan.

## feature

Read `artifacts.spec` (acceptance criteria, planned files, out-of-scope) and
`artifacts.plan` (tasks, assumptions, open risks). Then:

1. **Unlisted files** — `alignmentSignals.unlistedFiles` are changed paths not
   in the plan's file set. A few (tests, docs, config) are usually fine; a
   product-source file nobody planned is a `medium`+ `alignment` finding — flag
   it and ask whether the plan or the scope is wrong.
2. **Planned-but-unchanged** — `alignmentSignals.plannedButUnchanged` are files
   the plan named but the diff never touched. Often benign, but a planned file
   with no change can mean an acceptance criterion is unimplemented — cross-check
   against `spec.acceptanceCriteria`.
3. **Acceptance criteria** — for each `spec.acceptanceCriteria` entry, confirm
   the diff plausibly satisfies it. An AC with no supporting change is a `high`
   `alignment` finding.
4. **Out-of-scope section** — nothing in `spec.outOfScope` should appear in the
   diff.

## bug

Read `artifacts.diagnosis` (`bugScope`, `suspectedLayer`, `reproCommand`). Then:

1. **Regression test first** — `regressionTestPresent` MUST be true. A bug fix
   with no failing-then-passing regression test is a `blocker` `alignment`
   finding: the diagnose-before-fix discipline requires the test to exist.
2. **Fix stays in the suspected layer** — changes far outside `suspectedLayer`
   deserve scrutiny; note them.
3. **No scope creep** — `outOfScopeFiles` must be empty.

## chore

Read `artifacts.scope`. A chore is mechanical and bounded:

1. `outOfScopeFiles` must be empty — a chore that wandered outside `scope.md`
   should have escalated to the feature lane, not widened silently.
2. No new behavior — a chore that adds product logic (not a mechanical edit) is
   a `high` `alignment` finding recommending escalation.
