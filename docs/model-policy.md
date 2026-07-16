# Model / Budget Policy Routing (E8-4)

devmate routes each task to a model based on its **budget class**. The mapping
from budget class to model lives in a verifiable config file — never hardcoded in
code — so unverified model IDs can never silently drive committed behavior. The
same config carries an optional per-worker **roles** dimension (FO-7, see
[Role routes](#role-routes-fo-7)) under the identical verification discipline.

## Why config, not code

- External grounding recommends routing easy tasks to cheaper/smaller models and
  hard tasks to more capable ones.
- But model IDs change, get renamed, or are simply invented. An unverified ID
  baked into code makes the agent reference a nonexistent model.
- So model IDs live in `config/model-policy.json`, each gated by a `verifiedAt`
  date and a `source` URL pointing at official provider docs.

## Budget classes

| Class      | Intended work                                  |
| ---------- | ---------------------------------------------- |
| `tiny`     | Trivial, mechanical tasks                      |
| `standard` | Normal single-lane tasks                       |
| `large`    | Complex / multi-worker (fanout-eligible) tasks |

These match the `BudgetClass` type used across the codebase.

## Config format

`config/model-policy.json`:

```json
{
  "_comment": "Model IDs are [UNVERIFIED] placeholders. See docs/model-policy.md.",
  "schemaVersion": 1,
  "byBudgetClass": {
    "tiny":     { "modelId": "[UNVERIFIED — set after confirming with official docs]", "verifiedAt": null },
    "standard": { "modelId": "[UNVERIFIED — set after confirming with official docs]", "verifiedAt": null },
    "large":    { "modelId": "[UNVERIFIED — set after confirming with official docs]", "verifiedAt": null }
  },
  "roles": {
    "discoveryWorker": { "modelId": "[UNVERIFIED — set after confirming with official docs]", "verifiedAt": null, "rationale": "read-only search; cheapest capable model" }
  }
}
```

Each entry:

- `modelId` — the provider's model identifier string.
- `verifiedAt` — ISO date the ID was confirmed against official docs. `null` means
  unverified; the router refuses to use it as a production default.
- `source` — URL of the official documentation that confirms the ID. Required
  once `verifiedAt` is set.
- `notes` — optional free text.

Role entries follow exactly the same field rules, plus an optional `rationale`
(why this role routes separately). The `roles` block itself is optional — a
policy without it stays valid — and role names are rejected against the
`KNOWN_MODEL_ROLES` allowlist exported by `lib/routing/model-policy.mjs`
(today: `discoveryWorker`), so a typo fails validation loudly instead of
silently routing nothing.

## How to verify and register a model ID

1. **Confirm the ID** against the provider's official documentation. Copy the
   exact model identifier string.
2. **Set `modelId`** to that exact string (remove the `[UNVERIFIED …]`
   placeholder).
3. **Set `source`** to the official docs URL you confirmed it from.
4. **Set `verifiedAt`** to today's date in `YYYY-MM-DD`.
5. **Run the eval baseline** (see below) before this class's default is allowed to
   change.
6. **Run the guard:** `npm run validate:model-policy` — it must now exit `0`.

## Eval baseline requirement

A budget class's default model may not change until a measured baseline exists.
The guard `assertEvalBaselineExists(budgetClass, evalsDir)` checks for:

```
evals/model-routing/baseline-<class>.json
```

To produce one, run the E9-22 baseline harness in record mode; it re-runs the
fixed task set under `evals/model-routing/fixtures/` and rewrites the baseline
files with the task-set hash and metrics:

```bash
DEVMATE_EVAL_RECORD=1 node scripts/eval-model-routing.mjs
```

Only after the baseline file exists may the new default be committed. CI
validates the committed baselines on every build
(`node scripts/eval-model-routing.mjs`).

## Population process (before any real ID lands)

1. Confirm the model ID against the provider's official documentation and set
   `modelId`, `source` (the docs URL), and `verifiedAt` (see the steps above).
2. Record and commit the eval baseline for the class with the harness above.
3. Only then may the route be honored: at dispatch, `scripts/route-model.mjs`
   reads the persisted `token_budget_class`, routes it through the policy, and
   records a model_route trace event plus a dispatch hint at
   `.devmate/state/model-route.json`. While IDs remain `[UNVERIFIED]` the hint
   is **advisory only**; once an entry is verified, honoring the route requires
   the committed baseline (the run is blocked otherwise).

## Role routes (FO-7)

Read-only search workers are the textbook case for cheaper models: not every
agent requires the most capable model, and exploration-style subagents are
routinely pinned to low-cost models in comparable systems. The `roles` block
extends the class-route mechanism to a per-worker-role dimension — today the
single role `discoveryWorker`, covering the Phase-2 scoped `@discovery`
workers of the two-phase discovery fan-out — **without softening the
refuse-without-baseline discipline in any way**.

### How a role route resolves

- `routeWorkerModel(role, policy, opts?)` mirrors `routeModel` exactly: it
  returns `{ role, modelId, verified }` and throws on an unverified entry
  unless `opts.allowUnverified === true`.
- `assertRoleRouteAllowed(route, evalsDir)` mirrors `assertRouteAllowed`:
  advisory (unverified) role routes pass through as recommendations; a
  **verified** role route additionally requires the committed role baseline
  at `evals/model-routing/baseline-discovery-worker.json` and is refused
  otherwise. Unknown roles fail closed — they can never prove a baseline.
- At dispatch, `scripts/route-model.mjs` resolves every role the policy
  declares (always with `allowUnverified: true`, advisory-first) and records
  it in the hint file at `.devmate/state/model-route.json` under `roles`:

```json
{
  "budgetClass": "standard",
  "modelId": "[UNVERIFIED — set after confirming with official docs]",
  "verified": false,
  "mode": "advisory",
  "recommendedAt": "2026-07-10T00:00:00.000Z",
  "roles": {
    "discoveryWorker": { "modelId": "[UNVERIFIED — set after confirming with official docs]", "mode": "advisory" }
  }
}
```

  A verified role route without its baseline is recorded with role mode
  `blocked` and fails the run — exactly like a blocked class route. A policy
  without a `roles` block produces a hint file with no `roles` field.

- The discovery dispatch builder (`buildDiscoveryDispatch` in
  `lib/workflow/build-discovery-dispatch.mjs`) accepts an optional
  `modelHint` and renders it as a single advisory line in the worker prompt:
  "Preferred model for this worker: X (advisory)". The builder never
  enforces a model; the line is **prompt-only** guidance to the host.

### The path to enforcement (document, don't fake)

A role route becomes enforceable only when **both** hold:

1. A real model ID is verified against official provider docs (`modelId` +
   `source` + `verifiedAt`, same as a class entry).
2. A committed baseline exists at
   `evals/model-routing/baseline-discovery-worker.json` comparing
   **discovery-artifact quality** on the candidate model vs the session model
   over a fixture set. Coordinate the fixture format with the component-level
   discovery evals work — reuse its fixtures, don't fork a parallel format.

Until then everything role-related is advisory and the explicit
placeholder markers stay in the config. Choosing and verifying an actual
model ID is deliberately its own PR.

### Pinning a worker agent to the routed model (host capability)

VS Code custom agents (`*.agent.md`) support a per-agent `model` frontmatter
field: a single model name, or an array; when unset, the model currently
selected in the model picker is used. Verified 2026-07-10 against the official
custom agents reference:
<https://code.visualstudio.com/docs/copilot/customization/custom-agents>.

Two properties of that field are easy to get wrong, and both were (re-verified
2026-07-13 against the same reference plus
<https://docs.github.com/en/copilot/concepts/models/auto-model-selection>):

1. **The array is an availability fallback, not a priority/difficulty ladder.**
   *"When you specify an array, the system tries each model in order until an
   available one is found."* So `['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5
   (copilot)']` means "Sonnet 5 only if Opus is unavailable". Frontmatter
   **cannot** express "escalate to a frontier model when the task is hard".
2. **`Auto` is not a valid `model:` value.** It is a model-picker entry. The
   field resolves qualified model names (`Model Name (vendor)`) only, and GitHub's
   auto-model-selection doc lists its surfaces as Copilot Chat, CLI, the app, and
   the cloud agent — custom agents are not among them. `model: Auto (copilot)`
   therefore resolves to nothing and degrades silently to the picker. devmate
   shipped that value on four agents (`router`, `tech-design`, `security`,
   `ui-ux`); it was an inert layer, and `scripts/validate-agents.mjs` now rejects
   it by name.

The **only** documented route to Auto is to omit `model:` entirely and let the
agent inherit the picker. Auto is worth reaching for: it routes on task
complexity ("reserving higher-cost reasoning models for problems that truly need
it") and carries a **10% discount on model costs** for paid plans. Which agents
do this — and the model every other agent is pinned to — is recorded in
`config/model-catalog.json` and explained in [AGENTS.md](AGENTS.md#model-selection).

A consumer who wants `@discovery` pinned to the routed model can set `model` in
their own copy of the discovery agent's frontmatter to the model ID surfaced in
the hint file. devmate itself **never auto-edits agent frontmatter from
scripts** — the routed model reaches the worker only as the advisory payload line
and the hint file, so an unverified ID can never be silently enforced.

> **Note the split.** This file's `byBudgetClass` routing is *advisory* and, with
> placeholder IDs, currently routes nothing. The `model:` frontmatter is what
> actually selects a model at runtime. They are separate mechanisms; do not read
> a verified `model-policy.json` entry as evidence that an agent runs that model.

## CI guard

`scripts/validate-model-policy.mjs` (script: `npm run validate:model-policy`) is
intentionally strict:

- Exits non-zero if any entry commits a real-looking model ID without `verifiedAt`/`source` (an explicit `[UNVERIFIED]` placeholder with `verifiedAt: null` is the sanctioned shipping state and passes with a notice).
- Exits non-zero if any `modelId` still contains the `[UNVERIFIED` placeholder.
- Exits non-zero if an entry sets `verifiedAt` but provides no `source` URL.

This means the config ships explicit placeholders today and the guard passes
with a placeholder notice; it blocks the moment a real-looking ID lands without
verification — the desired gate.

## API surface

- `loadModelPolicy(opts?)` — read + parse + validate the config.
- `validateModelPolicy(policy)` — shape check (classes + optional roles);
  returns `{ ok, errors }`.
- `routeModel(budgetClass, policy, opts?)` — returns a `PolicyRoute`; throws on
  unverified entries unless `opts.allowUnverified === true`.
- `routeWorkerModel(role, policy, opts?)` — FO-7 role variant; returns a
  `RolePolicyRoute` with the same unverified-refusal behavior.
- `KNOWN_MODEL_ROLES` — the allowlist of role names a policy may declare.
- `assertEvalBaselineExists(budgetClass, evalsDir)` — throws if no baseline.
- `assertRouteAllowed(route, evalsDir)` — passes advisory routes through;
  requires a committed baseline before a verified route is honored (E9-11).
- `assertRoleEvalBaselineExists(role, evalsDir)` / `assertRoleRouteAllowed(route, evalsDir)`
  — FO-7 role variants; fail closed on unknown roles.

## References

- External grounding: route easy tasks to smaller/cheaper models — `ws3-external-grounding.md:265-273`.
- Model IDs in Version B are `[UNVERIFIED]` and must not drive committed behavior — `ws1-artifact-audit.md:171-176`, `ws1-artifact-audit.md:1070-1078`.
