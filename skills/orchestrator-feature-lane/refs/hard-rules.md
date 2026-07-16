# Feature Lane — Hard Rules

- **Grill before plan.** `grill-done` must advance before `@planner` dispatches.
- **Critique before spec.** `plan-done` must advance before `@spec-writer` dispatches.
- **Critique cap is 2.** After two `REQUEST_REVISION` verdicts, fold open items into
  `SpecContent.risks` with a risk flag and proceed to step 9.
- **Blocking questions do not block the lane.** Fold them into `SpecContent.assumptions`
  for the human to resolve at `spec-draft` review.
- **Internal gates auto-advance.** `discovery-done`, `grill-done`, `plan-done` advance
  without human input. Only `spec-draft → spec-approved` and `pr-ready` require approval.
- **After every dispatch, the hook validates for you.** The PostToolUse hook persists
  each subagent result to `.devmate/state/worker-returns/` and reports
  `subagent.empty_result` / `subagent.malformed_result` on a bad return. You have no
  terminal — do not try to run a validation script. No gate may advance on an empty,
  null, or malformed result; halt and re-dispatch instead.
- **Before every `@fullstack` dispatch, the gate is checked for you.** The PreToolUse
  gate-guard and the SubagentStart budget guard deny a skipped-gate implementation
  dispatch structurally, so there is nothing for you to pre-check.
- **Escalate on `status: escalated`.** Surface to the human; do not retry.
- **Security review halts on missing agent.** If security policy returns `required: true`
  and `agents/security.agent.md` is absent, halt with an error.
