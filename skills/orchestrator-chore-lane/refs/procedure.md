# Chore Lane — Full Procedure

## Steps (must be followed in order)

**0. Lane classification** — handled by common step 0 in the orchestrator.

**1. Classify.** Record `budgetClass` from the router output contract.

> **Recall first.** Consult the devmate-memory recall block injected at session
> start (it already contains the facts recalled for the paths in scope) before
> re-deriving known facts. Treat recalled facts as
> hints — verify each against current code before relying on it.

> **Fast-path (`budgetClass: tiny`).** For a self-contained single-file change,
> keep the safety rails but drop the ceremony: still write a minimal `scope.md`
> (step 2, one file — this is what gate-guard enforces edits against) and still
> run the architectural off-limits guard (step 4), then go **straight to one
> `@fullstack` dispatch (step 6) and a single verify (step 7)**. Fold any obvious
> leftover polish into that one dispatch; do not chain a second dispatch for
> trivial nits, and do not re-read the file or re-run the tests by hand after a
> passing verify (see the orchestrator's "Verify once" rule).

**2. Scope.** Derive a bounded `proposedFiles` set from the chore description and write
`.devmate/session/{taskId}/scope.md` listing the allowed files for this change slice.

**3. [INTERNAL GATE] `scope-written`** — advance automatically once `scope.md` is on disk.

**4. Architectural guard.** Apply the `editor` persona's `offLimitsGlobs` from
`.devmate/devmate.config.json`. If `proposedFiles` intersects any `offLimitsGlob`,
escalate to the feature lane (call `escalateChoreToFeature()`), continuing at feature lane
step 4 with the **same `taskId`**. Do not reset or restart the task.

**5. [HUMAN GATE] Advance gate to `impl-started`.** Present the scoped change.
Classify the reply per the orchestrator's "Human gates — input handling" protocol; only explicit approval advances.
Ask the human to reply **`approve plan`**. The `approval-listener` hook advances
`plan-approved → impl-started` on that exact phrase — you have no terminal and
cannot advance it yourself. If the human approves in other words, ask for the exact
phrase; then Read `.devmate/state/task.json` and confirm `workflowGate` is
`impl-started` before dispatching.

Gate-guard Rule 3 blocks source changes while the gate remains `plan-approved`, and
an un-advanced gate is never a licence to make the edit yourself.

**6. Edit.** Dispatch `@fullstack` with `persona: 'editor'`, passing `scopePath` and
`choreDescription`.

> **Codebase alignment — lighter documented rule (not validator-enforced).** The chore
> lane does **not** carry the feature lane's fail-closed `alignment[]` contract (#238):
> there is no planner task here, `LANE_DISPATCH_REQUIREMENTS.chore` is `[]`,
> `LANE_IMPL_REQUIREMENTS.chore` requires only `scope`, and `buildDispatchPayload`
> re-asserts alignment only when `lane === 'feature'` — so a chore dispatch never fails
> closed on a missing decision. Instead, carry this one-line directive in the dispatch:
> **"If this chore touches executable code, name the single existing pattern/file you
> are mirroring in your summary; pure docs/config chores may omit it."** It is enforced
> only by this card and the human `pr-ready` gate (step 8) — a proportionate rail for
> mechanical edits that avoids over-burdening a trivial docs/config chore with the full
> alignment contract (#241).

**7. Verify.** You have no terminal: verification is the passing test run reported
in the `@fullstack` result (its TDD cycle ran the suite). On success, advance
`impl-started → verification-passed`. Classify any human response at this verification
gate per the orchestrator's "Human gates — input handling" protocol before acting on it.

**8. [HUMAN GATE] `pr-ready`** — the human reviews the change. Classify the reply per the
orchestrator's "Human gates — input handling" protocol: only explicit approval completes
the lane; any requested change — regardless of phrasing — is revision feedback (stay at
the gate, re-present); questions are answered without advancing.
