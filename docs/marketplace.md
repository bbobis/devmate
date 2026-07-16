# devmate — Marketplace

Capability summary generated from `docs/capability-registry.json`. Do not edit the generated section — run `node scripts/generate-docs.mjs` to regenerate.

<!-- generated:capability-summary -->
| ID | Type | Name | Description | Invocation |
|---|---|---|---|---|
| session-start-hook | hook | Session Start Hook | Runs on Copilot SessionStart to initialise the session budget and context. | auto-registered |
| post-tool-use-hook | hook | Post Tool Use Hook | Runs on Copilot PostToolUse to audit and record tool calls. | auto-registered |
| check-session-budget-hook | hook | Session Budget Hook | Runs on Copilot PostToolUse to measure session context size and warn when the token budget is approached or exceeded. | auto-registered |
| compact-session-hook | hook | Compact Session Hook | Runs on Copilot PreCompact to write a typed, high-recall compaction artifact a fresh session can resume from. | auto-registered |
| session-stop-hook | hook | Session Stop Hook | Runs on Copilot Stop to persist session state and emit a digest. | auto-registered |
| validate-hooks | script | Validate Hooks | Validates hooks/hooks.json against official VS Code event names; the live manifest contract is enforced in CI by the hooks-smoke test job. | agent-invoked |
| check-artifact-allowlist | script | Check Artifact Allowlist | CI script that verifies every repo file is listed in the artifact allowlist. | agent-invoked |
| generate-docs | script | Generate Docs | Regenerates all sentinel-delimited capability sections in README and docs from the registry. | agent-invoked |
| check-generated-docs | script | Check Generated Docs | CI lint step that exits 1 when any sentinel-delimited generated block is stale. | agent-invoked |
| check-file-budgets | script | Check File Budgets | CI script that enforces per-file line and token budgets for agent and skill files. | agent-invoked |
| generate-current-behavior | script | Generate Current Behavior | CI script that generates docs/CURRENT_BEHAVIOR.md from the registry, hooks manifest, and test summary. | agent-invoked |
| check-docs-drift | script | Check Docs Drift | CI lint step that exits 1 when docs assert hook events, config keys, or state names not in verified ground truth. | agent-invoked |
| orchestrator-agent | agent | Orchestrator | Stage-gated workflow coordinator for feature, bug, and chore lanes. | user-invoked |
| fullstack-agent | agent | Full-stack | Generic language/tool-agnostic implementation agent dispatched N times with a persona from devmate.config.json. | agent-invoked |
| diagnose-agent | agent | Diagnose | Bug-lane diagnosis agent that reproduces the bug and hands off to the full-stack fixer with the diagnosed persona. | agent-invoked |
| rubber-duck-agent | agent | Rubber-Duck | Adversarial reasoning agent dispatched in grill (pre-plan) and critique (post-plan) modes. Read-only. | agent-invoked |
| spec-writer-agent | agent | Spec-Writer | Writes deterministic .devmate/session/spec.md output from planner artifacts and records task-state metadata. | agent-invoked |
| backend-agent | agent | Backend | Backend specialist persona wrapper. Dispatches fullstack with persona=backend. Scope: editableGlobs/offLimitsGlobs for backend persona in devmate.config.json. | agent-invoked |
| frontend-agent | agent | Frontend | Frontend specialist persona wrapper. Dispatches fullstack with persona=frontend. Scope: editableGlobs/offLimitsGlobs for frontend persona in devmate.config.json. | agent-invoked |
| editor-agent | agent | Editor | Non-source editor persona wrapper. Dispatches fullstack with persona=editor. Scope: docs, configs, CI, migrations, chore files only. | agent-invoked |
| ui-ux-agent | agent | UI-UX | Design-only feature-lane agent that produces a UI brief artifact with screens, interactions, error states, components, and unverified items. | agent-invoked |
| security-agent | agent | Security | Pre-PR security review agent that reports typed findings with evidence pointers. | agent-invoked |
| tdd-debug-skill | skill | TDD & Debug | Activates the Red-Green-Refactor cycle and debug hypothesis loop for implementation agents. | agent-invoked |
| init-skill | skill | Devmate Init | User-invocable skill exposed as the /devmate:devmate-init slash command. After running the command, reads .devmate/state/init-proposal.json for the proposed devmate.config.json. | user-invoked |
| map-skill | skill | Devmate Map | User-invocable skill exposed as the /devmate:devmate-map slash command. Generates a DRAFT business-domain map + context-file stubs under .devmate/session/ from repo structure, then applies to devmate.config.json only after explicit user confirmation (generate, review, apply). | user-invoked |
| pr-review-skill | skill | PR Review | User-invocable skill exposed as the /devmate:devmate-pr-review slash command. Gathers a capped diff-vs-plan review context at .devmate/state/pr-review-context.json (branch diff, planning artifacts as pointers, precomputed alignment signals), then emits a typed PrReviewArtifact verdict to .devmate/state/pr-review-result.json. Defers authoritative security scanning to the security agent. | user-invoked |
<!-- /generated:capability-summary -->
