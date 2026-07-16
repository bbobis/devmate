# Chore Escalation & Scoped Exceptions (E5-3)

The chore lane is for low-risk, non-logic work (renames, docs, config, deps).
When a chore turns out to need real application-logic changes, you have two
deterministic, gated paths instead of silently editing source code.

## When this applies

- You are in the **chore** lane.
- A change would touch source-code logic (a `checkChoreExceptionGuard` block).

## Path 1 — Escalate to feature

Use when the work is genuinely bigger than a chore.

- **Phrase:** `escalate chore to feature`
- **Script:** `node scripts/escalate-chore.mjs --reason "<why>"`
- **Effect:** lane `chore -> feature`, gate set to `plan-approved`, `taskId` preserved.
- **Trace:** appends a `lane_transition` event to `transitions.jsonl`.

> Anti-hallucination note: the spec named the target gate `tech-design`, which
> is **not** a real `WorkflowGate`. The feature lane re-enters at the real
> `plan-approved` gate — a fresh plan must be approved for the wider scope.

## Path 2 — Grant a narrow exception

Use when only one small, well-understood logic fix is needed and a full
feature escalation is overkill.

- **Phrase:** `approved exception: <description> for <path>`
- **API:** `approveChoreException(state, exception, opts)`
- **Effect:** appends a `ChoreException` to `state.approvedExceptions`.
- **Trace:** appends an `exception_granted` event.

Validation rules:

- `path` must be a non-empty string.
- `approvedBy` must start with the prefix `approved exception:`
  (`EXCEPTION_APPROVAL_PREFIX`).

## The guard

`checkChoreExceptionGuard(state, editPath)`:

- Returns `null` (allow) when the lane is **not** chore.
- Returns `null` when `editPath` exactly matches, or is nested under, an
  approved exception path.
- Otherwise returns a **block message** telling the user to escalate or grant
  an exception.

## Example

1. Chore: "bump the retry config".
2. Guard blocks an edit to `src/app/logic.mjs` (logic change).
3. Either:
   - `node scripts/escalate-chore.mjs --reason "retry needs a real fix"` — go full feature, or
   - `approved exception: fix off-by-one in retry counter for src/app/logic.mjs` — narrow fix.

## Source

- `lib/workflow/lanes/chore.mjs` — `escalateChoreToFeature`, `approveChoreException`, `checkChoreExceptionGuard`.
- `scripts/escalate-chore.mjs` — CLI entrypoint.
- `lib/types.mjs` — `ChoreException` typedef, `TaskState.approvedExceptions`.
