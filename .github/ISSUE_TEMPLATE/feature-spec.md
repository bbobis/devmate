---
name: Feature spec (autonomous-ready)
about: Detailed, implementation-ready spec for a devmate change — the format used for v0.3.0 issues.
title: "Exx-y: <short imperative title>"
labels: ["research"]
---

> **Read first:** [CONTRIBUTING.md](https://github.com/LP-GTM-Product-Engineering/devmate/blob/main/CONTRIBUTING.md) — all code is `.mjs` + `// @ts-check` + JSDoc types; Node 24+ via `engines` + `assertNodeVersion()`; cap tool output; `node:test`.

## Context
<!-- What is the current state, and why does it need to change? Reference real file paths and issue numbers. Doc-grounded only: every Copilot/VS Code claim needs an official URL (docs.github.com / code.visualstudio.com / github.blog/changelog). Anything unverifiable → mark [UNVERIFIED] and keep it out of the recommendation. -->

## Goal
<!-- One paragraph: the smallest change that delivers the value. State the outcome, not the steps. -->

## Files to create / change
<!-- Bullet each file with a one-line purpose. New modules: list the exported function names.
     SCOPE: this list is [EXHAUSTIVE — touch only these files] / [REPRESENTATIVE — fix all occurrences of the pattern across the repo].
     Delete the inapplicable option. If REPRESENTATIVE, name the grep/search pattern the implementer should use to find all instances.
     (If omitted, the implementer must treat the list as EXHAUSTIVE and document any out-of-scope hits in the PR.) -->
- `path/to/file.mjs` — <purpose; exported fns if new>
- `test/.../file.test.mjs` — <what it covers>
- `docs/....md` — <doc to update> (if touching CHANGELOG.md or docs/hooks.md, keep type/function names OUT of backticks — `check-docs-drift`)

## Reference instances (already correct — do not modify)
<!-- If this issue corrects an inconsistency, list one or two files that already have the correct form.
     The implementer uses these as the canonical pattern to match against. Leave blank if this is purely new code. -->

## Module contract (JSDoc)
```js
// @ts-check

/**
 * <what it does>
 * @param {<type>} name  <desc>
 * @returns {<type>}
 */
export function fnName(name) {}
```

## Placeholder values (calibrate later)
<!-- List any numeric thresholds, timeouts, config values, or score cutoffs in this issue that are provisional.
     Format: `identifier` — current placeholder value — calibrate after: <phase/event/milestone>
     Implementers must add a `// TODO: calibrate after <phase> — current value is a provisional placeholder` comment at each site.
     Leave blank if all values are final. -->

## Implementation steps
<!-- Numbered, ordered, concrete. Each step should be small enough to implement and test on its own. -->
1.
2.
3.

## Acceptance criteria
<!-- Observable, testable outcomes. What is true when this is done correctly? -->
-
-

## Test requirements (node:test)
<!-- Specific cases using node:test + temp dirs (never write to the repo tree). -->
-
-

## Definition of Done
- [ ] All new/changed `.mjs` files include `// @ts-check` and JSDoc `@param` on helpers.
- [ ] Entry-point scripts keep the `assertNodeVersion(24)` guard and guarded entrypoint.
- [ ] Docs updated without triggering `check-docs-drift` (CHANGELOG.md + docs/hooks.md only).
- [ ] `npm run verify` passes locally; CI green on the PR.
- [ ] Squash-merged via PR (never direct-to-main).
- [ ] Deferred decisions documented in PR body under "## Out of scope / follow-ups" with: (a) what was left, (b) why, (c) future upgrade path if the stance changes.

## Dependencies
<!-- Blocking issues, reused modules/constants, suggested milestone + labels.
     Also list cross-cutting references: identifiers changed by this issue that appear in docs/, agents/, skills/,
     dispatch contracts, or tests outside "Files to create / change" that must stay aligned with the change.
     If a referenced entity (file, agent, schema) does not yet exist in the repo, note which issue will create it
     and confirm merge order. -->
- Blocks / blocked by: <#nn or none>
- Reuses: <module/constant paths>
- Milestone: <vX.Y.Z> · Labels: `research`, `epic:Ex-...`
- Cross-cutting refs: <identifier> appears in <locations> — must stay aligned (or "none")
- Planned-but-nonexistent entities: <file/agent/schema> — will be created by <#nn> (or "none")

## Background & evidence
**Repo files (live):**
- `path` — <what it shows>

**Official docs (doc-grounded):**
- <Claim> — [VS Code / GitHub docs](https://...)

> [UNVERIFIED] items (excluded from recommendation): <list or "none">
