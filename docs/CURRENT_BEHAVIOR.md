# Current Behavior (devmate)

<!-- generated:current-behavior — DO NOT EDIT BY HAND. Run scripts/generate-current-behavior.mjs -->

This file is generated from the capability registry, the hooks manifest,
and the test suite. It lists ONLY verified behavior. Do not add unverified
claims here — add them to `CHANGELOG.md` with a historical marker instead.

### Verified Hook Events

- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- `SubagentStart`
- `SubagentStop`

### Verified Config Keys

_No verified config schema present yet._

### Registered Scripts

- 7 scripts registered.

- `scripts/validate-hooks.mjs` — Validates hooks/hooks.json against official VS Code event names; the live manifest contract is enforced in CI by the hooks-smoke test job.
- `scripts/check-artifact-allowlist.mjs` — CI script that verifies every repo file is listed in the artifact allowlist.
- `scripts/generate-docs.mjs` — Regenerates all sentinel-delimited capability sections in README and docs from the registry.
- `scripts/check-generated-docs.mjs` — CI lint step that exits 1 when any sentinel-delimited generated block is stale.
- `scripts/check-file-budgets.mjs` — CI script that enforces per-file line and token budgets for agent and skill files.
- `scripts/generate-current-behavior.mjs` — CI script that generates docs/CURRENT_BEHAVIOR.md from the registry, hooks manifest, and test summary.
- `scripts/check-docs-drift.mjs` — CI lint step that exits 1 when docs assert hook events, config keys, or state names not in verified ground truth.

### Test Pass/Fail Summary

_No machine-readable test summary available at generation time._

<!-- /generated:current-behavior -->
