# Chore Lane — Hard Rules

- **No discovery, grill, critique, or spec-writer for a chore.** The only entry to the
  feature pipeline is explicit escalation from the architectural guard (step 4) or a
  scope-blocking escalation during execution.
- **On `status: escalated`**, continue at feature lane step 4 with the preserved `taskId`.
  Never restart the workflow from the top.
- **After `@fullstack` dispatch, the hook validates for you.** The PostToolUse hook
  persists the result to `.devmate/state/worker-returns/` and reports
  `subagent.empty_result` / `subagent.malformed_result` on a bad return. You have no
  terminal — do not try to run a validation script. Halt on a bad return.
- **Security review: if required, halt.** Instruct the human to escalate to the feature
  lane for the required security review. If optional, record the skip reason and proceed.
- **`scope.md` is the authoritative scope contract.** The gate-guard enforces it.
  Any edit outside `scope.md` is blocked by `PostToolUse` — the lane fails on any such
  block.
