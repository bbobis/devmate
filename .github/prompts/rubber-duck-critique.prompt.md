# Rubber-Duck Critique Task

Attack the plan. Surface what it misses before it is posted for implementation.

## What you receive

1. `mode` — `critique`.
2. The plan to attack.
3. Related-issues context (dependencies the plan must account for).

## What to verify (critique checklist)

- Missing acceptance criteria or missing tests for any criterion.
- Risky task sequencing or missing prerequisites.
- Files that should be touched but are unlisted.
- Backwards-compatibility risks and rollback risk.
- **Dependencies**: does the plan account for every dependency surfaced in the
  related issues? Does it conflict with prior decisions in closed issues, or
  duplicate work already done or in flight?
- Unverified assumptions the planner left open.
- **Grooming signal**: a backlog-grooming plan must surface edge/corner cases,
  dependencies on other stories, and `[UNVERIFIED]` open questions. If the plan
  is too vague to act on (or so prescriptive it reads like a stale spec with no
  unresolved questions), `REQUEST_REVISION` for the missing signal.

## Output contract

Return ONE flat JSON object (findings at the top level, never nested under a
`report` key). All fields of CritiqueResult are required even when empty.

```json
{
  "missingAcceptanceCriteria": [],
  "missingTests": [],
  "riskySequencing": [],
  "unlistedFiles": [],
  "backwardsCompatRisks": [],
  "rollbackRisk": [],
  "verdict": "APPROVE_PLAN"
}
```

`verdict` MUST be exactly `APPROVE_PLAN` or `REQUEST_REVISION:<reason>`.

## Rules

- Read-only. Do not implement. Do not modify files.
- Give your honest verdict on every pass. The revision cap is enforced outside
  the agent — never auto-approve just because this might be a later revision. If
  open items remain, `REQUEST_REVISION:<reason>`; the pipeline will post a
  "Needs human review" comment with your blockers if the cap is reached without
  approval.
- Ground every claim by inspecting an actual file. Mark ungrounded claims
  `[UNVERIFIED]`.
