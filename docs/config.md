# devmate.config.json

`devmate.config.json` declares the personas devmate recognizes and the file
globs each persona may edit or must not touch. The gate-guard fail-safe blocks
work when this file is missing or invalid, so every consumer needs one.

## Shape

```json
{
  "schemaVersion": 1,
  "verification": {
    "checks": [
      { "id": "unit-test", "command": "npm run test:unit", "category": "unit-test", "source": "package.json#scripts.test:unit" },
      { "id": "type-check", "command": "npm run typecheck", "category": "type-check", "source": "package.json#scripts.typecheck" },
      { "id": "lint", "command": "npm run lint", "category": "lint", "source": "package.json#scripts.lint" },
      { "id": "e2e", "command": "npm run test:e2e", "category": "e2e", "optional": true, "source": "package.json#scripts.test:e2e" }
    ]
  },
  "personas": [
    {
      "persona": "frontend",
      "editableGlobs": ["src/**/*.{ts,tsx,js,jsx,css}", "public/**"],
      "offLimitsGlobs": ["src/main/java/**", "src/test/java/**"],
      "testGlobs": ["**/*.spec.ts", "**/*.test.ts"]
    }
  ]
}
```

- `schemaVersion` — integer schema version. `1` = single-repo config authored by `devmate init`; `2` = merged multi-root config written by monoroot. A config numbered above the highest version this build knows is rejected with an upgrade pointer; `mode` (not the number) decides single- vs multi-root structure.
- `contractVersion` — optional, multi-root only, producer-stamped: the version of the shared config contract (vendored schema + fixtures corpus) the merged config was written against. Additive — validation tolerates its absence and never fails on its value. When the stamp is a number that differs from this build's pinned contract version, the multi-root init path emits a non-blocking skew nudge naming both versions and the Re-sync repair verb (fail-open: an unstamped config from an older producer never nudges).
- `verification` — optional block declaring how this codebase verifies work. Its canonical shape is a variable-length `checks` list, **fit to the repo rather than a fixed triplet** — devmate never hardcodes which checks a codebase runs. Each check has:
  - `id` — stable kebab-case identifier, unique within `checks` (e.g. `unit-test`, `lint`, `build`).
  - `command` — the command to run. Treated as **opaque text**: it is rendered into dispatch payloads, never auto-executed by the loop.
  - `category` — an **open** label (conventional values: `unit-test`, `type-check`, `e2e`, `lint`, `format`, `build`, `audit`, `contract`, `integration`, …) — not an enum, so you can name a category the tools don't anticipate. The check with category `unit-test` drives the TDD gate.
  - `optional` — optional boolean; `true` marks the check advisory/non-blocking.
  - `source` — optional grounding pointer to where the command was found (e.g. `package.json#scripts.test`); `[UNVERIFIED]` marks a proposal not grounded in scanned evidence.
  - **Legacy shape (deprecated):** the flat `verification.unitTest` / `verification.typeCheck` / `verification.e2e` string keys are still accepted and normalized into equivalent checks on load, so existing configs keep working. `devmate init` no longer generates them.
- `personas` — non-empty array. Each entry has:
  - `persona` — non-empty name (e.g. `frontend`, `backend`).
  - `editableGlobs` — globs this persona may edit.
  - `offLimitsGlobs` — optional globs this persona must NOT edit.
  - `testGlobs` — optional globs used by the PostToolUse TDD completion tripwire.
  - `source`, `synthesized` — multi-root only, producer-stamped. `source` is `repo` (authored in a sub-repo's config) or `fallback` (synthesized by the util for an un-init'd repo); `synthesized` is `true` on those fallbacks. Validated when present; absent on single-repo configs. See `docs/devmate-config.schema.json` for the full contract.
- `maxConcurrentAgents` — optional positive integer. Caps how many sub-agents the orchestrator may run in parallel during dispatch. The subagent-budget-guard hook denies any SubagentStart that would push the active count past this cap. Default `3` when absent. The default is restored when the field is omitted, so existing consumers without it are unaffected. Consumers raise the cap for higher-parallelism hardware (e.g. `6`) or lower it to `1` when they want strict serial dispatch.
- `sessionArtifactPaths` — optional globs of session artifacts no agent may hand-edit. Default `[".devmate/state/**", ".devmate/session/**"]` — the gate itself, the human-approved `spec.md`, and the evidence chain. Every one of them is written by a devmate hook, and a hook is not a tool call, so protecting them costs the workflow nothing and closes the forged-approval hole (an agent writing `"workflowGate": "impl-started"` into `task.json` fakes the human approval the dispatch guard checks for). The default is protective: omit the key and the artifacts are protected. See [Gate Guard → Session-Artifact Protection](./gate-guard.md#session-artifact-protection).
- `sessionArtifactWriters` — optional per-artifact exceptions to the above: a list of `{ "glob": "…", "agents": ["…"] }` naming the agents permitted to write the paths a glob matches. Default `[{ "glob": ".devmate/session/**/spec.md", "agents": ["spec-writer"] }]` — `spec.md` is the one artifact an agent, not a hook, produces. The permitted agent is identified from the roster the SubagentStart hook stamps onto task state from the host's `agent_type`; when several *different* sub-agents are in flight the caller cannot be attributed and the write is denied.
- `delegationFloor` — optional delegation-floor mode: `off` (default), `warn`, or `block`. When active, devmate checks that the orchestrator delegated the lane's read-heavy analysis to sub-agents before implementation starts. Off by default, so existing consumers are unaffected. See [Delegation floor](#delegation-floor-optional) below. The legacy boolean `enforceDelegationFloor: true` is still honored and maps to `block`.
- `delegationFloorRequirements` — optional per-lane override of which specialists the floor requires: a map of lane → array of any-of groups, e.g. `{ "feature": [["discovery"], ["planner"]] }`. Lanes you do not name keep the built-in defaults; an empty list removes a lane's floor. Only consulted when `delegationFloor` is `warn` or `block`.
- `personaScope` — optional persona-scope enforcement mode: `off`, `warn` (**default**), or `block`. At the completion of each `@fullstack` dispatch, devmate verifies the files that dispatch changed stay inside its persona's territory — a file owned by a *different* declared persona, or matching this persona's `offLimitsGlobs`, is a violation (files owned by no persona are left to `scope.md`). `warn` records the violation (a `persona-scope` `contract_violation` trace event) and surfaces it without halting; `block` halts the dispatch; `off` disables the check. Because per-edit attribution is infeasible under parallel dispatch, this is a completion-time check on the dispatch's self-reported `changedFiles`. See [Gate Guard → Completion-time persona-scope verification](./gate-guard.md#completion-time-persona-scope-verification).
- `staleTaskHours` — optional idle threshold in hours past which an in-flight task is treated as stale. Default `48`. When the current task has been idle longer than this (measured from the gitignored state file's last write), the state anchor flags it, session start recommends starting fresh, and the orchestrator auto-parks it on an unrelated new request instead of interrogating park/abandon. A non-positive or non-numeric value falls back to the default.
- `domains` — optional business-domain ownership map (DN-1). See [Business domains](#business-domains-optional) below.
- `acCoverageGate` — optional AC-coverage gate mode: `off` (default), `warn`, or `block`. When active, devmate checks that every parsed `## Acceptance criteria` item has a recorded `impl-AC{n}` completion before the `verification-passed` / `pr-ready` gates. Off by default, so existing consumers are unaffected. See [AC-coverage gate](#ac-coverage-gate-optional) below.
- `prReviewGate` — optional PR-review gate mode: `off` (default), `warn`, or `block`. When active, devmate refuses to enter the `pr-ready` gate (feature + bug lanes) unless the `/devmate-pr-review` skill has written a valid PR-review verdict of `APPROVE` for this task. Off by default, so existing consumers are unaffected. See [PR-review gate](#pr-review-gate-optional) below.

If no unit-test command resolves (no `verification.checks` entry has category `unit-test`, and the legacy `verification.unitTest` is unset), session start prints:

`[devmate] WARNING: no unit-test verification check set in .devmate/devmate.config.json (add a verification.checks[] entry with category 'unit-test', or the legacy verification.unitTest) — TDD gate disabled`

## Two ways to create it

### 1. Static starter (`devmate init`)

```bash
node scripts/init.mjs
```

Alias:

```bash
node scripts/devmate-init.mjs
```

Writes a generic two-persona starter (frontend + backend). You then edit the
globs by hand to match your stack. Refuses to overwrite an existing config
unless you pass `--force`.

### 2. Guided inference (`/devmate:devmate-init`)

The `/devmate:devmate-init` slash command proposes a config from your repo's
actual structure, makes it codebase-specific with an enrichment pass, and lets
you review before anything is written. It follows a strict
**generate → enrich → review → write** flow.

> The command ships inside the plugin, so VS Code prefixes it with the plugin
> name and a colon — `/devmate:devmate-init`, one token, no space
> ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)).
> As a local/workspace skill, use the bare `/devmate-init`.

How it works:

1. **Generate (deterministic floor).** The command runs the backing script in
   proposal mode:

   ```bash
   node scripts/init.mjs --infer
   ```

   This scans a bounded set of repo signals (top-level directories, marker files,
   the real `src/` layout) **and grounded verification evidence** — `package.json`
   scripts, `Makefile` targets, CI `run:` steps, and language-marker conventions
   (pytest / cargo / go / maven / gradle). It writes two drafts under
   `.devmate/state/` — `init-proposal.json` (the config floor: personas with
   layout-grounded globs + a `verification.checks` list built from the real
   commands it found) and `init-evidence.json` (every candidate it saw, each with
   a `source`) — and prints a digest. It writes no real config. The floor is
   **deterministic**: the same repo always yields the same proposal.

2. **Enrich (LLM, grounded).** Using the evidence, the agent makes the proposal
   codebase-specific: it selects and labels verification checks from the scanned
   candidates, renames personas to your codebase's vocabulary, and tightens globs
   to the observed layout. It only ever *selects and labels evidence* — it never
   invents a command or glob. Anything not grounded in the evidence is tagged
   `source: "[UNVERIFIED]"` for you to confirm.

3. **Review.** The agent shows you the enriched proposal and invites edits —
   especially the `offLimitsGlobs` (what each persona must not touch) and the
   verification checks. Proposed globs are heuristics, not verified boundaries.

4. **Write.** Only after you confirm:

   ```bash
   node scripts/init.mjs --infer --write
   ```

   This **applies the reviewed proposal** on disk (honoring your edits and the
   enrichment), re-validating it before writing. Same safety as the static path:
   it refuses to overwrite an existing config unless you pass `--force`, and never
   writes a config that fails schema validation. (With no proposal on disk it
   falls back to writing a fresh deterministic floor.)

## Signal → persona mapping

The inference rules are deterministic — the same repo always yields the same
proposal:

| Signal detected | Proposed persona |
|---|---|
| A package manifest (`package.json`), optionally with `tsconfig.json` or a UI-ish `src/` subdir | `frontend` |
| A Java build file (`pom.xml` / `build.gradle`) or a `src/main/java` layout | `backend` |
| Both of the above | both personas |
| No recognizable stack | the static starter personas (always at least one) |

Because the globs are proposals, the command never silently activates guessed
off-limits boundaries — you always review and confirm first.

## Verification examples

The `checks` list is variable-length — declare exactly the checks your codebase
runs, no more and no fewer. `category` is a free label; `id` is any unique
kebab-case string.

### TypeScript + Vitest

```json
{
  "verification": {
    "checks": [
      { "id": "unit-test", "command": "npm run test:unit", "category": "unit-test" },
      { "id": "type-check", "command": "npm run typecheck", "category": "type-check" },
      { "id": "lint", "command": "npm run lint", "category": "lint" },
      { "id": "e2e", "command": "npm run test:e2e", "category": "e2e", "optional": true }
    ]
  },
  "personas": [
    {
      "persona": "frontend",
      "editableGlobs": ["src/**/*.{ts,tsx}"],
      "testGlobs": ["**/*.spec.ts", "**/*.test.ts"]
    }
  ]
}
```

### Java + Maven

```json
{
  "verification": {
    "checks": [
      { "id": "unit-test", "command": "mvn test", "category": "unit-test" },
      { "id": "type-check", "command": "mvn -q -DskipTests compile", "category": "type-check" }
    ]
  },
  "personas": [
    {
      "persona": "backend",
      "editableGlobs": ["src/main/**", "src/test/**"],
      "testGlobs": ["src/test/**/*.java", "**/*Test.java"]
    }
  ]
}
```

### Python + pytest

```json
{
  "verification": {
    "checks": [
      { "id": "unit-test", "command": "pytest -q", "category": "unit-test" },
      { "id": "type-check", "command": "python -m mypy src", "category": "type-check" },
      { "id": "lint", "command": "ruff check .", "category": "lint" }
    ]
  },
  "personas": [
    {
      "persona": "backend",
      "editableGlobs": ["src/**/*.py", "tests/**/*.py"],
      "testGlobs": ["tests/**/*.py", "**/test_*.py"]
    }
  ]
}
```

## Delegation floor (optional)

devmate's core value is **token/context management**: the orchestrator should
**delegate** read-heavy analysis (discovery, design, grilling, planning,
diagnosis) to sub-agents so that work runs in a sub-agent's own context window
instead of filling the orchestrator's. The **delegation floor** lets you enforce
that — the workflow will not start implementation until the lane's analysis was
actually delegated. It is **off by default**.

Enable it with `delegationFloor`:

```json
{
  "schemaVersion": 1,
  "delegationFloor": "warn",
  "personas": [{ "persona": "backend", "editableGlobs": ["src/**"] }]
}
```

| Mode | Behavior |
|---|---|
| `off` (default) | No enforcement — nothing changes. |
| `warn` | Records a `delegation-floor` violation (surfaced by the delegation report) but **allows** the task to proceed. Start here to see how often the floor would fire. |
| `block` | **Refuses** to start implementation until the lane's analysis was delegated. |

> The legacy boolean `enforceDelegationFloor: true` still works and is equivalent to `"delegationFloor": "block"`.

**What each lane must delegate (built-in defaults):**

| Lane | Required (any-of groups) |
|---|---|
| feature | (discovery **or** tech-design) + rubber-duck + planner |
| bug | diagnose + rubber-duck |
| chore | none (no analysis phase) |

Override per lane with `delegationFloorRequirements` — lanes you do not name keep
the defaults; an empty list removes a lane's floor:

```json
{
  "schemaVersion": 1,
  "delegationFloor": "block",
  "delegationFloorRequirements": {
    "feature": [["discovery"], ["planner"]]
  },
  "personas": [{ "persona": "backend", "editableGlobs": ["src/**"] }]
}
```

**Observe delegation** with the report (it reads a task's trace under `.devmate/state/`):

```bash
node scripts/delegation-report.mjs --task <taskId>   # one task
node scripts/delegation-report.mjs --all             # every task, as a dashboard
```

It prints a GREEN / YELLOW / RED verdict for how much of the work was delegated
versus likely done inline; in `warn` mode it also lists the recorded floor
violations. Pass `--strict` to make a RED verdict exit non-zero (useful in CI). A
`Stop`-hook advisory additionally auto-flags a session that ended at
implementation with no sub-agent dispatch.

## Business domains (optional)

`personas` already give devmate *stack-level* ownership (which files a persona
may edit). `domains` add an orthogonal, optional *business-domain* ownership
map — a task's business vocabulary ("billing", "invoice", "refund") mapped to
the file clusters and invariants of that domain. This is the first
implementation issue of the domain-aware-navigation epic; later issues in that
epic (routing, gate-guard integration, inference) build on this schema.
Absent `domains` key ⇒ exactly today's behavior (fail-open no-op).

```json
{
  "schemaVersion": 1,
  "personas": [ ... unchanged ... ],
  "domains": [
    {
      "domain": "billing",
      "keywords": ["invoice", "payment", "refund", "charge"],
      "globs": ["packages/billing/src/**"],
      "contextFile": ".devmate/contexts/billing.md",
      "relatedDomains": ["orders"],
      "entryPoints": ["packages/billing/src/index.ts"]
    }
  ]
}
```

Each entry:

- `domain` — unique id, kebab-case (e.g. `billing`). Required.
- `keywords` — business vocabulary for lexical matching (lowercase). Required (may be empty).
- `globs` — repo-relative globs owning this domain's files. Required (may be empty, but the doctor warns when it is).
- `contextFile` — optional repo-relative path to the domain's context markdown. Normalized to `null` when omitted.
- `relatedDomains` — optional ids of adjacent domains (cross-domain contracts). Normalized to `[]` when omitted.
- `entryPoints` — optional repo-relative **file** paths that anchor the domain (not symbols — no compiler/AST dependency, keeping devmate's zero-runtime-dep rule intact). Normalized to `[]` when omitted.

An entry with any other key, a missing/duplicate `domain` id, or a non-array
`keywords`/`globs` fails config loading closed (`loadDevmateConfig` returns
`{ ok: false, error }` naming the domain id and field) — it never half-loads.

`node scripts/devmate-doctor.mjs` additionally warns (never hard-fails) when:

- a declared `contextFile` does not exist on disk;
- a `relatedDomains` id does not resolve to another declared domain;
- an `entryPoints` path does not exist on disk;
- `globs` is empty;
- a `domain` id is declared more than once.

These are warnings, not errors, because a config can predate a rename — the
doctor surfaces drift without blocking the command's exit code.

## AC-coverage gate (optional)

The **AC-coverage gate** (AC-2 of the deterministic AC coverage harness) checks
that every acceptance criterion parsed from the approved `spec.md` has a
recorded `impl-AC{n}` `step_complete` trace event — an agent's claim that "all
ACs are done" is never trusted on its own. It is **off by default**.

Enable it with `acCoverageGate`:

```json
{
  "schemaVersion": 1,
  "acCoverageGate": "warn",
  "personas": [{ "persona": "backend", "editableGlobs": ["src/**"] }]
}
```

| Mode | Behavior |
|---|---|
| `off` (default) | No enforcement — no spec/trace read, no block, no trace churn. |
| `warn` | Records an `ac-coverage` `contract_violation` trace event but **allows** the transition. Start here to see how often the gate would fire. |
| `block` | **Refuses** the transition until every parsed AC is complete. |

The check fires on entry to two gates:

- **`verification-passed`** (primary) — checked while the lane is still at
  `impl-started`, so re-dispatching the missing ACs to a sub-agent is still
  legal. Its `missing` list is merged with the existing verify-evidence
  checks (each fires and reports independently).
- **`pr-ready`** (backstop) — a cheap final check; by this point re-dispatch
  is already illegal, so this entry can only block, never remediate.

A **feature**-lane spec that parses to zero acceptance criteria (e.g. a
malformed `## Acceptance criteria` heading) is treated as a coverage failure,
never a vacuous pass — the same fail-closed rule
`scripts/assert-ac-coverage.mjs` (AC-1) applies. Chore/bug specs with zero
parsed ACs pass trivially (no analysis-coverage expectation for those lanes).

## PR-review gate (optional)

The **PR-review gate** (PRR-3) turns the standalone `/devmate-pr-review` skill
into an automated workflow step: the state machine refuses the
`verification-passed → pr-ready` transition (feature + bug lanes) unless a valid
PR-review verdict of `APPROVE` for the current task and lane already exists at
`.devmate/state/pr-review-result.json`. It is **off by default**.

Enable it with `prReviewGate`:

```json
{
  "schemaVersion": 1,
  "prReviewGate": "warn",
  "personas": [{ "persona": "backend", "editableGlobs": ["src/**"] }]
}
```

| Mode | Behavior |
|---|---|
| `off` (default) | No enforcement — no read, no block, no trace churn. |
| `warn` | Records a `pr-review` `contract_violation` trace event but **allows** the transition. Start here to see how often the gate would fire. |
| `block` | **Refuses** entry to `pr-ready` until a valid `APPROVE` verdict exists for this task. |

A verdict fails the gate when the artifact is missing/unparseable, fails its
structural contract (`validatePrReviewResult`), belongs to a different task or
lane, or carries a non-`APPROVE` verdict (i.e. `REQUEST_CHANGES:<reason>`). On a
`REQUEST_CHANGES` verdict, address the findings while the lane is still at
`verification-passed` (re-dispatch is legal there), then re-run the review. The
**chore** lane never enters `pr-ready`, so it is unaffected regardless of mode.

## Anti-hallucination note

Inference reads only a small, bounded set of signals (it does not read the whole
repo). Proposed globs are grounded in the repo's real top-level layout, and
verification checks are grounded in real commands the scan found (`package.json`
scripts, `Makefile` targets, CI steps, language markers) — each carries a
`source` pointer back to where it came from. The enrichment pass may only
*select and label* that scanned evidence; anything it proposes without grounding
is tagged `[UNVERIFIED]`. The flow treats everything as a suggestion: it
proposes, you review and edit, then the deterministic Node script re-validates
and writes the file. The agent never writes a guessed config directly.
