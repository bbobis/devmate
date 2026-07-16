# Bug Lane — Full Procedure

## Steps (must be followed in order)

**0. Lane classification** — handled by common step 0 in the orchestrator.

**1. Ingest and classify.** Record `budgetClass` from the router output contract.

> **Recall first.** Consult the devmate-memory recall block injected at session
> start (it already contains the facts recalled for the paths in scope) before
> re-deriving known facts. Treat recalled facts as
> hints — verify each against current code before relying on it.

**2. Diagnosis.** Dispatch `@diagnose` to reproduce the bug, identify root cause, and produce
a `DiagnosisResult` + `.devmate/session/{taskId}/scope.md`.

**3. [INTERNAL GATE] `diagnosis-done`** — advance automatically once `DiagnosisResult` passes
validation. Validation errors halt the lane with a user-visible schema error message.

**4. Grill.** Dispatch `@rubber-duck` with `mode: 'grill'` to challenge diagnosis assumptions
and edge cases. The result is a `GrillResult`.

**5. [INTERNAL GATE] `grill-done`** — advance automatically.

**6. [HUMAN GATE] Advance gate to `impl-started`.** Present the diagnosis and the fix plan.
Classify the reply per the orchestrator's "Human gates — input handling" protocol; only explicit approval advances.
Ask the human to reply **`approve plan`**. The `approval-listener`
hook advances `plan-approved → impl-started` on that exact phrase — you have no
terminal and cannot advance it yourself. If the human approves in other words, ask
for the exact phrase; then Read `.devmate/state/task.json` and confirm
`workflowGate` is `impl-started` before dispatching.

Do not dispatch `@fullstack` while the gate is still `plan-approved` — the
PreToolUse gate-guard and the SubagentStart budget guard deny it anyway. **And an
un-advanced gate is never a licence to make the fix yourself.**

Opening the gate does not weaken diagnose-before-fix: the SubagentStart guard still
refuses an implementation dispatch without a valid `diagnosis.json` and a
`scope.md`.

**7. Fix.** Dispatch `@fullstack` with `persona` from `diagnosis.bugScope`. TDD constraint:
write the failing regression test first (using `diagnosis.reproCommand`), then fix, then green.
The gate-guard's `PostToolUse` hook enforces `scope.md` — edits outside scope are blocked.

**8. Verify.** You have no terminal: verification is the passing test run reported
in the `@fullstack` result (its TDD cycle ran the suite). If the regression test
passes there, the bug is fixed. Re-dispatch only if verification is missing or failed.

**9. [INTERNAL GATE] `verification-passed`** — advance automatically on pass. If verification
fails, remain in `impl-started` and escalate to the human.

**10. Security.** Evaluate security requirements. If required and `agents/security.agent.md`
exists, dispatch `@security`. If optional, record the skip reason.

**11. [HUMAN GATE] `pr-ready`** — the human reviews the fix and PR. Classify the reply per
the orchestrator's "Human gates — input handling" protocol: only explicit approval
completes the lane; any requested change — regardless of phrasing — is revision feedback
(stay at the gate, re-present); questions are answered without advancing.
