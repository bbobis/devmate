# Bug Lane — Hard Rules

- **Diagnose before fix.** Do not dispatch `@fullstack` without a validated `DiagnosisResult`
  from `@diagnose`.
- **`scope.md` is mandatory.** No `@fullstack` dispatch until
  `.devmate/session/{taskId}/scope.md` is present and non-empty.
- **Internal gates auto-advance.** `diagnosis-done`, `grill-done`, and `verification-passed`
  advance without human input. Only `pr-ready` requires explicit approval.
- **After every dispatch, the hook validates for you.** The PostToolUse hook persists
  each subagent result to `.devmate/state/worker-returns/` and reports
  `subagent.empty_result` / `subagent.malformed_result` on a bad return. You have no
  terminal — do not try to run a validation script. Halt on a bad return, and never
  fall through to `@fullstack` on one.
- **Before `@fullstack` dispatch, the gate is checked for you.** The PreToolUse
  gate-guard and the SubagentStart budget guard deny a skipped-gate implementation
  dispatch structurally, so there is nothing for you to pre-check.
- **Edit-scope enforcement is hard.** The gate-guard's `PostToolUse` hook blocks any edit
  outside `scope.md`. If blocked, the lane stays in failed state; no retry or escalation
  bypasses scope.
- **Security review halts on missing agent.** If security policy returns `required: true`
  and `agents/security.agent.md` is absent, halt with an error.
