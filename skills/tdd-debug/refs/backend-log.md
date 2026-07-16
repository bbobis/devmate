# Backend-log debugging branch reference

Lazy-loaded branch of the `tdd-debug` skill. Load this only when debugging a
**backend issue using logs / traces**.

## Debug hypothesis loop

1. **Hypothesise** — state the suspected cause in one sentence before touching
   code.
2. **Diagnose** — gather only the evidence that confirms or kills the
   hypothesis. Read the smallest log slice that matters.
3. **Fix** — apply the minimal change.
4. **Verify** — re-run the failing path; confirm the symptom is gone.

Loop diagnose -> fix -> verify. Retry limit: 3 attempts per step, then escalate
to the orchestrator with a `file:line` summary.

## Log handling (token discipline)

- Never embed full logs in a result. Extract the offending lines and return
  `file:line` pointers plus a one-line cause.
- Prefer structured fields over raw text when the backend emits JSON logs.

## Protocol cards

- [Debug Protocol](../../../docs/protocols/debug-protocol.md) — hypothesis loop,
  pre-mortem checklist.
- [Loop Protocol](../../../docs/protocols/loop-protocol.md) — retry/escalation
  contract.

_Grounding: [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)_
