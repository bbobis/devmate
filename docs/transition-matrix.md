# Transition matrix — the model-based exhaustive gate × event × lane net

## What

`test/e2e/transition-matrix.e2e.test.mjs` generates every (gate × event ×
lane) combination from the canonical legality tables and drives each cell
through the real subprocess callers, asserting that legal transitions succeed
exactly as the tables specify and every illegal combination is refused
without a crash. The model half lives in `test/e2e/matrix-generator.mjs`
(pure — cells, seed knowledge, per-cell oracle); the suite is the subject
half (real hooks, real `gatectl`, real workspaces).

- Model source of truth: `lib/gate-transitions.mjs` (lane tables + steering),
  `lib/workflow/gate-advance.mjs` (lane chains), `lib/gatectl.mjs` (the
  flattened human-gate projection). The oracle derives from these directly —
  the only file the oracle and the runtime share is the table file itself, so
  any divergence between table-said and hook-did is a bug by definition.
- Event classes: the approval phrases, `revise spec:`, a status question,
  every steering edge (via `gatectl workflow set`), a compliant subagent
  return per agent type, a malformed (contract-less) return, and a hand-tamper
  of `workflowGate` followed by the next prompt.
- Divergence report: every failed cell prints
  `table-said=… hook-did={gate:…→…, statuses:[…]}` plus the raw hook output.

## Why

The field failures were all "combinations nobody wrote a test for": approvals
at the wrong gate, hand-set gates, steering from unexpected states.
Hand-authored journey suites always lag the combination space; the matrix is
the systematic net underneath them (issue #9).

## How the budget is split

| Run | Mode | Cells |
| --- | --- | --- |
| Per-commit (`npm test`) | `smoke` (default) | Hand-pinned golden cells + any cell whose gate/steering-event name appears in the working diff of `lib/`, `hooks/`, `scripts/` |
| Branch/PR runs on a clean checkout | `smoke` + `DEVMATE_MATRIX_BASE=<ref>` (e.g. `origin/main`) | Additionally unions the merge-base diff `<ref>...HEAD` of the runtime dirs, so committed runtime changes select their cells even with a clean working tree. Opt-in: unset keeps default runs golden-only-fast |
| Nightly (`.github/workflows/eval-nightly.yml`, job `transition-matrix`) | `DEVMATE_MATRIX=full` | Every cell |

## Guardrails against a broken generator

- **Golden cells** (`GOLDEN_CELLS` in the generator) carry hard-coded
  expectations that are never derived; the suite fails before spawning
  anything if the derived oracle disagrees with them.
- **Seeding fidelity**: every seed gate is reached by replaying compliant
  agent returns through the registered hooks (the journey recipes), so
  fabricated evidence passes the same validators real evidence does. Seeds
  are built once, cached, and copied per cell.
- **No silent gaps**: rows excluded from the matrix (unreachable or transient
  gates such as `spec-invalidated`, or the chore lane's pass-through
  `lane-set`) are listed in `EXCLUDED_ROWS` with reasons and asserted
  non-empty by the suite.

## Findings the matrix pins deliberately

- `approve pr` at `parked` advances to `pr-ready` on every lane: the resume
  fan-out makes `pr-ready` a flattened successor of `parked`, and the
  human-gate path checks the flattened (lane-agnostic) projection. The matrix
  pins this table-backed behavior; tightening it is a product decision, not a
  test fix.
