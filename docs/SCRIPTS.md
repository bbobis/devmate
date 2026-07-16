# Scripts Documentation

Detailed reference for every script in `/scripts`. All scripts require **Node.js 24+** and export a `main(args)` function, so they can be imported and tested without side effects. They only run directly when executed as `node scripts/<name>.mjs`.

---

## Table of Contents

| Script | Category | Purpose |
|---|---|---|
| [apply-domain-map.mjs](#apply-domain-mapmjs) | Init | Applies a reviewed domain-map draft to devmate.config.json (human gate, DN-4) |
| [assert-ac-coverage.mjs](#assert-ac-coveragemjs) | Workflow | Deterministic read of acceptance-criteria coverage from spec.md + trace |
| [check-artifact-allowlist.mjs](#check-artifact-allowlistmjs) | CI Guard | Validates artifact paths against the allowlist |
| [check-backend-ready.mjs](#check-backend-readymjs) | CI Guard | Checks backend readiness before proceeding |
| [check-contract-drift.mjs](#check-contract-driftmjs) | CI Guard | Guards the shared devmate ⇄ monoroot contract files (hash pin + sibling diff) |
| [check-artifact-graph.mjs](#check-artifact-graphmjs) | CI Guard | Fails the build when a gate requires an artifact nothing can produce |
| [check-contracts.mjs](#check-contractsmjs) | CI Guard | Validates output contracts between components |
| [check-docs-drift.mjs](#check-docs-driftmjs) | CI Guard | Detects drift between code and generated docs |
| [check-entrypoint-guard.mjs](#check-entrypoint-guardmjs) | CI Guard | Rejects the Windows-broken entry-guard comparison in any .mjs, and any hooks.json command that cannot execute |
| [check-file-budgets.mjs](#check-file-budgetsmjs) | CI Guard | Enforces per-file line-count budgets |
| [check-generated-docs.mjs](#check-generated-docsmjs) | CI Guard | Verifies generated docs are up to date |
| [check-memory-path-refs.mjs](#check-memory-path-refsmjs) | CI Guard | Validates memory path references in code |
| [check-session-budget.mjs](#check-session-budgetmjs) | Hook | Runtime PostToolUse hook that checks agent session token budget usage (not run in CI) |
| [check-settings-keys.mjs](#check-settings-keysmjs) | CI Guard | Validates VS Code settings keys in config |
| [chore-continue.mjs](#chore-continuemjs) | Workflow | Continues a paused chore task |
| [compact-ledger.mjs](#compact-ledgermjs) | Memory | Compacts the repo memory ledger |
| [compact-session.mjs](#compact-sessionmjs) | Memory | Compacts a session memory file |
| [complete-ac.mjs](#complete-acmjs) | Workflow | Records a completed acceptance criterion and checks off its spec checkbox |
| [complete-step.mjs](#complete-stepmjs) | Workflow | Marks a task step as complete |
| [complete-task.mjs](#complete-taskmjs) | Workflow | Marks an entire task as complete |
| [create-handoff.mjs](#create-handoffmjs) | Workflow | Creates a handoff artifact for task resumption |
| [devmate-doctor.mjs](#devmate-doctormjs) | Memory | Health-checks the memory pipeline |
| [devmate-init.mjs](#devmate-initmjs) | Init | Thin wrapper around `init.mjs` |
| [diagnose-handoff.mjs](#diagnose-handoffmjs) | Diagnostics | Diagnoses issues with a handoff artifact |
| [discovery-scan.mjs](#discovery-scanmjs) | Discovery | Deterministic, zero-LLM-cost fan-out candidate-file scan (FO-3) |
| [escalate-chore.mjs](#escalate-choremjs) | Workflow | Escalates a chore to a higher-priority lane |
| [eval-judge.mjs](#eval-judgemjs) | Evals | Opt-in LLM-judge tier for claim truth + AC testability (nightly, non-blocking) |
| [eval-model-routing.mjs](#eval-model-routingmjs) | Evals | Records/validates model-routing baselines per budget class |
| [fanout-report.mjs](#fanout-reportmjs) | Diagnostics | Fan-out parallelism/speedup/dedup/cost report from trace + telemetry (FO-8) |
| [gate-guard.mjs](#gate-guardmjs) | Hook / Guard | Pre-tool hook that enforces workflow gate rules |
| [gatectl.mjs](#gatectlmjs) | CLI | Controls workflow and dependency gates |
| [generate-current-behavior.mjs](#generate-current-behaviormjs) | Doc Generation | Generates `docs/CURRENT_BEHAVIOR.md` |
| [generate-docs.mjs](#generate-docsmjs) | Doc Generation | Injects capability tables into docs from registry |
| [generate-domain-map.mjs](#generate-domain-mapmjs) | Init | Infers a DRAFT business-domain map + context stubs from repo structure (DN-4) |
| [generate-loop-schema.mjs](#generate-loop-schemamjs) | Doc Generation | Generates the loop trace JSON schema artifact |
| [init-task-state.mjs](#init-task-statemjs) | Init | Initialises a new task state JSON file |
| [init.mjs](#initmjs) | Init | Scaffolds `devmate.config.json` and layout |
| [learn-router.mjs](#learn-routermjs) | Routing | Routes a `learn` command to the right sub-agent |
| [match-skill.mjs](#match-skillmjs) | Routing | Semantically matches a query to a skill |
| [merge-discovery.mjs](#merge-discoverymjs) | Discovery | Fan-in: merges discovery worker returns into one artifact (FO-5) |
| [migrate-memory-path.mjs](#migrate-memory-pathmjs) | Migration | Migrates memory files to the canonical path |
| [post-tool-use.mjs](#post-tool-usemjs) | Hook | PostToolUse hook handler (stub) |
| [posttool-regex-guard.mjs](#posttool-regex-guardmjs) | Hook / Guard | Blocks dynamic RegExp construction in edits |
| [pr-review.mjs](#pr-reviewmjs) | Workflow | Gathers a capped diff-vs-plan review context for the pr-review skill |
| [query-memory.mjs](#query-memorymjs) | Memory | Queries the repo memory ledger |
| [reduce-context.mjs](#reduce-contextmjs) | Context | Reduces an EvidencePack via MapReduce |
| [resume-status.mjs](#resume-statusmjs) | Workflow | Reports the resume status of a task trace |
| [resume.mjs](#resumemjs) | Workflow | Canonical entry point to resume a task |
| [rollback.mjs](#rollbackmjs) | Workflow | Safely rolls back a task's changes |
| [route-model.mjs](#route-modelmjs) | Routing | Emits the budget-class model recommendation at dispatch |
| [run-ac-coverage-evals.mjs](#run-ac-coverage-evalsmjs) | Evals | Runs the deterministic AC-coverage eval suite and writes a coverage report |
| [run-fanout-demo.mjs](#run-fanout-demomjs) | Demo | Smoke test for orchestrator-workers fanout |
| [run-issue-quality-evals.mjs](#run-issue-quality-evalsmjs) | Evals | Runs issue quality evaluations |
| [run-regressions.mjs](#run-regressionsmjs) | Evals | Runs every regression suite via the index and emits a summary artifact |
| [session-start.mjs](#session-startmjs) | Hook | SessionStart hook — seeds layout on session open |
| [session-stop.mjs](#session-stopmjs) | Hook | Stop hook handler — captures memory on session end |
| [validate-agents.mjs](#validate-agentsmjs) | CI Guard | Validates all `*.agent.md` files |
| [validate-hooks.mjs](#validate-hooksmjs) | CI Guard | Validates `hooks/hooks.json` manifest (enforced in CI via the hooks-smoke test job) |
| [validate-model-policy.mjs](#validate-model-policymjs) | CI Guard | Validates the model policy config |
| [validate-skill-split.mjs](#validate-skill-splitmjs) | CI Guard | Checks skill trigger stubs are within line budget |
| [verify-step.mjs](#verify-stepmjs) | Workflow | Runs a verification command for a task step |
| [verify-test-files.mjs](#verify-test-filesmjs) | Workflow | Verifies that declared test files exist on disk |
| [view-trace.mjs](#view-tracemjs) | Diagnostics | Prints a readable summary of a task trace file |
| [worker-contract-check.mjs](#worker-contract-checkmjs) | CI Guard | Validates `*.worker-return.json` artifacts |
| [worktree-exec.mjs](#worktree-execmjs) | Workflow | Creates and tears down an isolated git worktree |

---

## apply-domain-map.mjs

**Category:** Init

DN-4, the human-gate side of the domain-map flow. Refuses to run when the draft written by `generate-domain-map.mjs` is absent (fail closed); validates the MERGED config through the same validation the loader uses, so an invalid draft is rejected naming the bad field and nothing is written; merges the draft's domains into `.devmate/devmate.config.json` (existing ids updated, new ids appended, never duplicated, unrelated keys preserved); copies the reviewed stubs to `.devmate/contexts/`. Re-applying the same draft is idempotent. Prints a digest only.

**Usage:**
```
node scripts/apply-domain-map.mjs [--root <dir>]
```

**Flags:**
- `--root <dir>` — repo root (default: resolved from cwd)

**Exit codes:**
- `0` — merge + copy applied
- `1` — missing/malformed draft, missing config, or validation rejection (always fail closed)

---

## assert-ac-coverage.mjs

**Category:** Workflow

Deterministic AC coverage read (AC-1 of the deterministic AC coverage harness, epic #416). Resolves the active task's spec.md and trace, parses the `## Acceptance criteria` section, and computes which approved criteria have no recorded `impl-AC{n}` `step_complete` trace event — an agent's self-reported completion does not count, only a real trace event does. In the feature lane, a spec that parses to zero acceptance criteria (e.g. a malformed heading) is treated as a coverage failure rather than a vacuous pass; other lanes with zero criteria pass. Writes `.devmate/state/assert-ac-coverage-result.json` and prints the same JSON on one stdout line. No enforcement wiring — that is a follow-up issue.

**Usage:**
```
node scripts/assert-ac-coverage.mjs [--task <id>]
```

**Flags:**
- `--task <id>` — optional; defaults to the `taskId` in `.devmate/state/task.json`
- `--repo-root`/`--state-path`/`--spec-path`/`--trace-dir` — optional overrides (tests)

**Exit codes:**
- `0` — every parsed acceptance criterion has a recorded completion (or zero criteria in a non-feature lane)
- `1` — one or more criteria are missing, the feature lane parsed zero criteria, or the task id is unresolved

---

## check-artifact-allowlist.mjs

**Category:** CI Guard

Validates that artifact paths produced by the agent are on the allowed list. Prevents agents from writing to unexpected locations outside what the config permits.

**Usage:**
```
node scripts/check-artifact-allowlist.mjs
```

**Exit codes:**
- `0` — all artifact paths are within the allowlist
- `1` — one or more paths violate the allowlist

---

## check-artifact-graph.mjs

**Category:** CI Guard

Fails the build when a gate requires an artifact nothing can produce.

Walks the declaration graph — `gate --requires--> artifact --produced by--> agent contract --written by--> projector` — and reports any broken edge. It reads `gateRequiredArtifacts()` ([lib/gate-preconditions.mjs](../lib/gate-preconditions.mjs)), `AGENT_CONTRACTS` ([lib/workflow/agent-contracts.mjs](../lib/workflow/agent-contracts.mjs)) and `PROJECTED_ARTIFACTS` ([lib/workflow/gate-advance.mjs](../lib/workflow/gate-advance.mjs)); it needs no session, no fixture, and no artifact on disk.

That last point is why it exists. `check-contracts.mjs` validates `grill-result.json` **only if it finds one** — so when the sole writer of that file could never fire, there was nothing to validate, CI stayed green, and the bug lane was a dead end at `grill-done` (#105). Existence-checking a file cannot detect a file that can never exist. Pair it with [test/conformance/agent-contract-roundtrip.test.mjs](../test/conformance/agent-contract-roundtrip.test.mjs), which proves the final edge *works* for a payload a real agent sends: this proves the edges exist, that proves they carry traffic.

**Usage:**
```
node scripts/check-artifact-graph.mjs
```

**Exit codes:**
- `0` — every gate's evidence is producible, and every declared contract has a writer
- `1` — an unreachable artifact (the offending gate/contract is named on stderr)

---

## check-backend-ready.mjs

**Category:** CI Guard

Checks that the backend (e.g. a required service or process) is ready before the agent proceeds. Used as a pre-condition guard in CI or before starting an implementation step.

**Usage:**
```
node scripts/check-backend-ready.mjs
```

**Exit codes:**
- `0` — backend is ready
- `1` — backend is not ready

---

## check-contract-drift.mjs

**Category:** CI Guard

Guards the two shared devmate ⇄ monoroot contracts — the config contract (`docs/devmate-config.schema.json` + `test/fixtures/config-contract`, pinned by the corpus manifest's contractVersion) and the session handshake (`docs/session-handshake.schema.json` + `test/fixtures/session-handshake`, pinned by handshakeVersion). Two layers: (1) an **in-repo hash** — the EOL-normalized SHA-256 of each contract's files must match a checked-in expected hash, so even a one-byte edit fails until the hash is deliberately bumped alongside the contract version; (2) a **cross-repo diff** — when a monoroot checkout is reachable (default `../monoroot`, overridable via the `DEVMATE_MONOROOT_PATH` environment variable) every shared file is compared EOL-normalized against the sibling copy, failing on any divergence, and **self-skipping with a notice when the sibling is absent** (blind CI needs no token). Runs inside `npm run verify`.

**Usage:**
```
node scripts/check-contract-drift.mjs
```

**Environment:**
- `DEVMATE_MONOROOT_PATH` — optional; path to the monoroot checkout (default: `../monoroot` next to this repo)

**Exit codes:**
- `0` — every contract hash matches and (when the sibling is present) every shared file agrees
- `1` — in-repo hash mismatch or cross-repo divergence (the offending files are listed)

---

## check-contracts.mjs

**Category:** CI Guard

Validates output contracts between components — checks that the shape of data flowing between modules matches their declared types and schemas. Useful for catching breaking contract changes in CI.

**Usage:**
```
node scripts/check-contracts.mjs
```

**Exit codes:**
- `0` — all contracts valid
- `1` — one or more contract violations found

---

## check-docs-drift.mjs

**Category:** CI Guard

Detects drift between the codebase and generated documentation. Compares the current generated docs against the source of truth (registry, schemas, etc.) and fails if they are out of sync.

**Usage:**
```
node scripts/check-docs-drift.mjs
```

**Exit codes:**
- `0` — docs are in sync
- `1` — docs are out of date (run the relevant generator to fix)

---

## check-entrypoint-guard.mjs

**Category:** CI Guard

Scans every `.mjs` in the tree (excluding `node_modules`, `.git`, `coverage`, and stale `.claude/worktrees` copies) for the Windows-broken entry-guard comparison — `import.meta.url` matched against a hand-built `file://` template string. That comparison is always false on Windows, so `main()` silently never runs (hooks fail open, CI guards false-green). The correct guard is `isMainModule(import.meta.url)` from `lib/env-guard.mjs`; pure logic lives in `lib/entry-guard-lint.mjs`.

**Usage:**
```
node scripts/check-entrypoint-guard.mjs
```

**Exit codes:**
- `0` — every entry guard is cross-platform
- `1` — a broken entry guard was found (table names each file:line and the fix)

---

## check-file-budgets.mjs

**Category:** CI Guard

Enforces per-file line-count budgets defined in the project config. Fails CI if any source file exceeds its declared budget. Helps keep files small and focused.

**Usage:**
```
node scripts/check-file-budgets.mjs
```

**Exit codes:**
- `0` — all files within budget
- `1` — one or more files exceed their line budget

---

## check-generated-docs.mjs

**Category:** CI Guard

Verifies that the generated documentation sections (sentinel-wrapped blocks) in README and `docs/` are current and match what would be produced by the generators. A CI-only check — does not write anything.

**Usage:**
```
node scripts/check-generated-docs.mjs
```

**Exit codes:**
- `0` — all generated sections are up to date
- `1` — one or more generated sections are stale

---

## check-memory-path-refs.mjs

**Category:** CI Guard

Scans source files for hardcoded memory path strings and verifies they match the canonical `MEMORY_PATH` constant. Prevents bugs caused by path references getting out of sync with the canonical path definition.

**Usage:**
```
node scripts/check-memory-path-refs.mjs
```

**Exit codes:**
- `0` — all memory path references are canonical
- `1` — stale or non-canonical path references found

---

## check-session-budget.mjs

**Category:** Hook

Runtime budget check invoked from the PostToolUse hook path: measures the agent session's token budget usage against the declared budget limit and emits a warning or fails when the session is at risk of running over budget. It is not wired as a CI step — it only has meaning inside a live session.

**Usage:**
```
node scripts/check-session-budget.mjs
```

**Exit codes:**
- `0` — within budget
- `1` — over budget or budget unreadable

---

## check-settings-keys.mjs

**Category:** CI Guard

Validates that all keys declared in `devmate.config.json` (or the VS Code settings schema) are recognised. Catches typos or removed keys before they silently become no-ops at runtime.

**Usage:**
```
node scripts/check-settings-keys.mjs
```

**Exit codes:**
- `0` — all keys valid
- `1` — unknown or invalid keys found

---

## chore-continue.mjs

**Category:** Workflow

Continues a previously paused chore task. Reads the current task state and picks up from the last completed step. Designed to be called by the agent after a manual review or interruption.

**Usage:**
```
node scripts/chore-continue.mjs --taskId <id>
```

**Flags:**
- `--taskId <id>` — required; the task to continue

**Exit codes:**
- `0` — task continued successfully
- `1` — error (missing taskId, unreadable state)

---

## compact-ledger.mjs

**Category:** Memory

Compacts the repo memory ledger (`.devmate/state/repo/memory.jsonl`) by removing expired entries and deduplicating facts. Keeps the ledger lean so queries stay fast.

**Usage:**
```
node scripts/compact-ledger.mjs [--ledger <path>] [--dry-run]
```

**Flags:**
- `--ledger <path>` — optional; override the ledger path
- `--dry-run` — print what would be removed without writing

**Exit codes:**
- `0` — compaction succeeded (or nothing to compact)
- `1` — I/O error

---

## compact-session.mjs

**Category:** Memory

Compacts a session memory file by summarising older entries into a shorter rolling summary. Reduces context size when a session grows too large to fit in the agent's context window.

**Usage:**
```
node scripts/compact-session.mjs [--session <path>] [--dry-run]
```

**Flags:**
- `--session <path>` — optional; path to the session file
- `--dry-run` — print the compaction plan without writing

**Exit codes:**
- `0` — success
- `1` — error

---

## complete-ac.mjs

**Category:** Workflow

Records per-acceptance-criterion implementation progress. For each given criterion id it appends a canonical `impl-AC{n}` `step_complete` event to the per-task trace (the same trace the resume plan reads), then checks off `- [ ] AC{n}` → `- [x] AC{n}` in `.devmate/session/spec.md` and refreshes `artifactHashes.specDigest` in `task.json` so the spec-integrity guard stays consistent. Idempotent — a criterion already recorded complete is skipped. Runs during implementation (workflow gate `impl-started`); it never advances the workflow gate.

**Usage:**
```
node scripts/complete-ac.mjs [--task <id>] --ac <n> [--ac <n> ...] [--artifact <path> ...]
```

**Flags:**
- `--task <id>` — optional; defaults to the `taskId` in `.devmate/state/task.json`
- `--ac <n>` — the 1-based acceptance-criterion id (repeatable)
- `--artifact <path>` — optional; a changed file recorded as an artifact pointer (repeatable)
- `--repo-root`/`--state-path`/`--spec-path`/`--trace-dir` — optional overrides (tests)

**Exit codes:**
- `0` — criteria recorded (or already complete)
- `1` — unresolved task id, no `--ac` given, or a trace-append error

---

## complete-step.mjs

**Category:** Workflow

Appends a `step_complete` event to the task trace and advances the task's `currentStep` counter. Every agent implementation step must call this when the step's work is done.

**Usage:**
```
node scripts/complete-step.mjs --task-id <id> --attempt-id <id> --trace-file <path>
```

**Flags:**
- `--task-id <id>` — required
- `--attempt-id <id>` — required; unique ID for this attempt
- `--trace-file <path>` — required; path to the JSONL trace file
- `--label <text>` — optional; human-readable step label
- `--artifact-paths <json>` — optional; JSON array of written artifact paths

**Exit codes:**
- `0` — step recorded
- `1` — missing required flags or I/O error

---

## complete-task.mjs

**Category:** Workflow

Finalises a task's memory: promotes the task's fact ledger into the shared repo ledger, re-renders `.devmate/MEMORY.md`, and records a compact `task_complete` entry. On the write-first gates it first enforces the TDD guard (a test file must be touched, or an override granted). It does **not** itself transition the workflow gate — the `complete` gate transition is issued separately via `gatectl`.

**Usage:**
```
node scripts/complete-task.mjs [--task-id <id>] [--root <dir>] [--conflict-policy <policy>]
```

**Flags:**
- `--task-id <id>` — optional; overrides `TaskState.taskId` (recovery/test harnesses)
- `--root <dir>` — optional; repo root (default: cwd)
- `--conflict-policy <keep-existing|keep-incoming|keep-both>` — optional promotion conflict policy

**Exit codes:**
- `0` — facts promoted and `.devmate/MEMORY.md` rendered (or nothing to promote)
- `1` — error (unreadable state, promotion failure)
- `2` — invalid `--task-id`

---

## create-handoff.mjs

**Category:** Workflow

Creates a handoff artifact (`.devmate/handoff/<taskId>.json`) that captures enough context for a new agent session to resume the task. Includes the last completed step, open questions, and artifact pointers.

**Usage:**
```
node scripts/create-handoff.mjs --task-id <id> [--trace-file <path>]
```

**Flags:**
- `--task-id <id>` — required
- `--trace-file <path>` — optional; override trace file location

**Exit codes:**
- `0` — handoff artifact created
- `1` — error

---

## devmate-doctor.mjs

**Category:** Memory

Health-checks the three-stage memory pipeline — task ledgers (`.devmate/memory/tasks/*.jsonl`) → repo ledger (`.devmate/state/repo/repo.jsonl`) → `.devmate/MEMORY.md` — and reports the first stage that looks broken (the `/memory`-style diagnostic). Also runs a **gate-evidence consistency** stage (`lib/gate-consistency.mjs`): it proves the persisted `workflowGate` is backed by the artifacts and audit events it legally requires, and classifies any divergence (gate ahead of evidence, gate behind the trace, a human-audit gate reached with no audited transition, or a corrupt trace) under `gateConsistency` in the JSON summary. A divergence left unreconciled makes this command exit 1 and prints the recovery command on stderr. Also runs DN-1 business-domain doctor checks (declared-but-missing `contextFile`, dangling `relatedDomains` id, missing `entryPoints` path, empty `globs`, duplicate domain id) when `.devmate/devmate.config.json` declares a `domains` array — warnings only, reported under `domainWarnings` in the JSON summary and never affecting this command's exit code. Prints a compact JSON summary to stdout and human-readable findings to stderr; writes the full diagnosis (plus `domainWarnings`, `gateConsistency`, `gateFixed`) to `.devmate/state/memory-doctor-result.json` for `read_file` access. The memory and domain stages never mutate; the gate stage only mutates under the opt-in `--fix` flag.

**Usage:**
```
node scripts/devmate-doctor.mjs [--root <dir>] [--fix]
```

**Flags:**
- `--root <dir>` — repo root (default: cwd)
- `--fix` — reconcile a desynced `workflowGate` to the last evidence-backed gate under the state lock, stamping an audited `gate_transition` that records the reconcile. Off by default; detection alone is always non-destructive.

**Exit codes:**
- `0` — pipeline looks healthy and the gate is evidence-backed (or was reconciled by `--fix`); domain warnings, if any, do not affect this
- `1` — a memory stage looks broken (see `firstBrokenStage`) or the gate is desynced and left unreconciled (see `gateConsistency` in the output)

---

## devmate-init.mjs

**Category:** Init

Thin wrapper that delegates directly to `scripts/init.mjs`. Exists as a stable entry point for the `devmate-init` npm bin alias so the bin name never changes even if the implementation moves.

**Usage:**
```
node scripts/devmate-init.mjs [--force] [--infer] [--write] [--path <file>]
```

See [`init.mjs`](#initmjs) for full flag documentation.

---

## diagnose-handoff.mjs

**Category:** Diagnostics

Diagnoses a handoff artifact by reading it and reporting whether it is valid, stale, or missing required fields. Helps the agent decide whether to trust a handoff or start fresh.

**Usage:**
```
node scripts/diagnose-handoff.mjs --task-id <id> [--handoff-dir <dir>]
```

**Flags:**
- `--task-id <id>` — required
- `--handoff-dir <dir>` — optional; override handoff directory

**Exit codes:**
- `0` — handoff is valid and usable
- `1` — handoff is missing, stale, or malformed

---

## discovery-scan.mjs

**Category:** Discovery

Deterministic, zero-LLM-cost candidate-file scan (FO-3). Runs four independent strategies — by-name, by-content (git-grep or pure-Node fallback), by-imports (depth-1), and by-test-mirror — in parallel via `lib/orchestrator/fanout.mjs`, merges the results into a ranked, capped candidate list, and writes it atomically to a JSON artifact. See [discovery-scan.md](./discovery-scan.md).

**Usage:**
```
node scripts/discovery-scan.mjs --terms <csv> [--seed-files <csv>] [--budget-class <class>] [--max-sources <n>] [--min-success-rate <0-1>] [--out <path>] [--repo-root <path>]
```

**Flags:**
- `--terms <csv>` — required; comma-separated seed search terms
- `--seed-files <csv>` — optional; comma-separated repo-relative seed file paths (used for import-graph and test-mirror strategies, and the seed-proximity scoring bonus)
- `--budget-class <class>` — optional; `tiny` | `standard` | `large`; sets the default `--max-sources` cap when not explicitly given
- `--max-sources <n>` — optional; overrides the budget-class default cap; must be a non-negative integer (invalid values fail closed with exit 1, never silently coerced)
- `--min-success-rate <0-1>` — optional; forwarded to `fanout()`'s success-rate floor (default `0.5`); must be a number between 0 and 1
- `--out <path>` — optional; artifact output path (default `.devmate/state/discovery-candidates.json`); must resolve inside `--repo-root` (a path that escapes it fails closed with exit 1)
- `--repo-root <path>` — optional; repo root to scan (default `process.cwd()`)

**Exit codes:**
- `0` — scan completed and the artifact was written (including when `insufficient: true` — callers branch on the artifact's fields, not this exit code)
- `1` — config or I/O error (e.g. missing `--terms`, invalid `--max-sources`/`--min-success-rate`, `--out` resolving outside `--repo-root`, unwritable `--out`)

---

## escalate-chore.mjs

**Category:** Workflow

Escalates a chore-lane task to a higher-priority lane (e.g. `bug` or `feature`) when it has grown beyond a simple chore. Updates the task state's `lane` field and logs the escalation.

**Usage:**
```
node scripts/escalate-chore.mjs --task-id <id> --lane <lane>
```

**Flags:**
- `--task-id <id>` — required
- `--lane <lane>` — required; target lane (`feature` | `bug`)

**Exit codes:**
- `0` — escalated successfully
- `1` — error

---

## eval-judge.mjs

**Category:** Evals

Opt-in LLM-judge eval tier (E9-25). Judges the two issue-quality dimensions the structural code grader cannot verify — whether cited claims are actually true and whether acceptance criteria are genuinely testable — over the issue-quality positive cases, writing `evals/issue-quality/judge-latest.json`. **Opt-in and non-blocking:** without `DEVMATE_JUDGE=1` it exits 0 doing nothing, it never joins the required CI workflow (a separate non-required nightly workflow, `.github/workflows/eval-nightly.yml`, runs it), and it complements — never replaces — the seven code-checked dimensions. The judge model is resolved from `config/model-policy.json` (large class, verified entries only; never hardcoded); while entries are placeholders, or until an API client is wired, verdicts are honest nulls ("Unknown") with the reason in the rationale.

**Usage:**
```
DEVMATE_JUDGE=1 node scripts/eval-judge.mjs [resultsPath]
```

**Arguments:**
- `resultsPath` — optional override for the results output path (default `evals/issue-quality/judge-latest.json`)

**Environment:**
- `DEVMATE_JUDGE=1` — required to run; unset means no-op
- `DEVMATE_JUDGE_API_KEY` — reserved for the future judge API client (passed by the nightly workflow)

**Stdout:** `[eval-judge] judged N issue(s) — F failed, U unknown; results at <path>` (or the skip notice)

**Exit codes:**
- `0` — skipped (opt-out), or no verdict explicitly false
- `1` — at least one verdict explicitly false (nightly-only signal; never a required check)

---

## eval-model-routing.mjs

**Category:** Evals

Model-routing baseline harness (E9-22). Default mode validates the committed `evals/model-routing/baseline-<class>.json` files (existence, schema, task-set hash) and exits 1 on any problem; record mode (`DEVMATE_EVAL_RECORD=1`) re-runs the fixed task set under `evals/model-routing/fixtures/` and rewrites the baselines. CI runs the validate mode on every build.

**Usage:**
```
node scripts/eval-model-routing.mjs                 # validate
DEVMATE_EVAL_RECORD=1 node scripts/eval-model-routing.mjs   # record
```

**Exit codes:**
- `0` — baselines valid (or recorded)
- `1` — missing/malformed/stale baseline or unreadable fixtures

---

## fanout-report.mjs

**Category:** Diagnostics

FO-8 fan-out observability: joins a task's trace (subagent start/complete windows, the discovery-merge counts) with the worker-telemetry ledger (`evals/telemetry/workers.jsonl`) and reports the parallelism the fan-out actually achieved — K used, max overlap depth, wall-clock window vs serial-equivalent speedup — plus per-strategy scan latency/violation rates, merge dedup quality, and completion-token cost. The ledger carries no task ids, so telemetry entries are attributed by the task's trace time window. Verdicts (GREEN/YELLOW/RED) are advisory heuristics feeding the "Calibrating the ceilings" procedure in [parallel-dispatch.md](parallel-dispatch.md) — pure observability, never a gate.

**Usage:**
```
node scripts/fanout-report.mjs --trace <path.jsonl> [--telemetry <path.jsonl>] [--json]
node scripts/fanout-report.mjs --task <taskId> [--root <dir>] [--telemetry <path.jsonl>] [--json]
node scripts/fanout-report.mjs --all [--root <dir>] [--telemetry <path.jsonl>] [--json]
```

**Flags:**
- `--trace <path>` — explicit trace JSONL path (wins over `--task`)
- `--task <taskId>` — resolve the trace at `.devmate/state/trace/<taskId>.jsonl` under `--root`
- `--root <dir>` — repo root for `--task`/`--all` resolution (default `.`)
- `--telemetry <path>` — worker-telemetry ledger path (default: the repo ledger)
- `--all` — report every task trace under the root; prints a fleet dashboard + verdict tally
- `--json` — machine-readable output (includes malformed-line counts)

**Stdout:** ≤20-line digest per task (fleet dashboard with `--all`); malformed JSONL lines are skipped and counted, never a crash

**Exit codes:**
- `0` — report printed (verdicts never fail the run — there is deliberately no strict mode)
- `2` — usage error (neither `--trace`, `--task`, nor `--all` given)

---

## gate-guard.mjs

**Category:** Hook / Guard

The primary pre-tool hook that enforces workflow gate rules. Reads the hook payload from stdin and blocks tool calls that are not allowed at the current workflow gate. Also enforces config validity — a missing or invalid `devmate.config.json` causes a hard block.

This is a **critical safety script**: it runs before every agent tool call.

**Usage:** Invoked automatically via the hooks manifest. Not called manually.

**Stdin:** Claude hook payload JSON.

**Stdout:** `{ "decision": "continue" }` or `{ "decision": "block", "systemMessage": "..." }`

**Exit codes:**
- `0` — decision written to stdout
- `1` — fatal error reading the hook payload

---

## gatectl.mjs

**Category:** CLI

The main CLI for controlling workflow gates and dependency gates. Supports advancing the workflow gate by event name, and reading/writing named dependency gates.

**Usage:**
```
gatectl workflow set <event>
gatectl dependency set <name> <status> [--force]
gatectl dependency get <name>
gatectl dependency list
```

**Workflow gate events:** `approve-plan` | `start-impl` | `pass-verification` | `mark-pr-ready` | `complete`

**Dependency gate statuses:** `pending` | `pass` | `fail` | `skipped`

**Flags:**
- `--force` — bypass prerequisite order check; violation is logged to `gate-violations.jsonl`

**Deprecated aliases (still work, emit a warning):**
- `gatectl set-workflow-gate <event>`
- `gatectl set-dependency-gate <name> <status>`

**Exit codes:**
- `0` — success
- `1` — error (invalid event, unreadable state, etc.)

---

## generate-current-behavior.mjs

**Category:** Doc Generation

Generates `docs/CURRENT_BEHAVIOR.md` from verified metadata only — the capability registry, the hooks manifest, the config schema, and the test summary. Never includes unverified claims. The file is wrapped in sentinel comments so it is never edited by hand.

**Usage:**
```
node scripts/generate-current-behavior.mjs
```

**Output file:** `docs/CURRENT_BEHAVIOR.md`

**Exit codes:**
- `0` — file written
- `1` — registry validation failed

---

## generate-docs.mjs

**Category:** Doc Generation

Reads the capability registry (`docs/capability-registry.json`) and injects sentinel-wrapped capability tables into `README.md`, `docs/plugin-help.md`, and `docs/marketplace.md`. Preserves all manual content outside the sentinel markers.

**Usage:**
```
node scripts/generate-docs.mjs
```

**Output files:**
- `README.md` — full capability table
- `docs/plugin-help.md` — full, hook, and script capability tables
- `docs/marketplace.md` — capability summary table

**Exit codes:**
- `0` — files updated (or already up to date)
- `1` — registry validation failed

---

## generate-domain-map.mjs

**Category:** Init

DN-4, the proposal side of the domain-map flow (`/devmate-map`). Walks the repo (skipping node_modules, .git, .devmate, dist, build, coverage), reads the optional FO-3 candidates artifact when present, and calls the pure `inferDomains` (`lib/init/infer-domains.mjs`) to draft business domains deterministically — workspace packages, populated src subdirectories, and candidate clusters. Writes `.devmate/session/domain-map-draft.json` plus one context-file stub per domain under `.devmate/session/domain-contexts-draft/`; never touches `devmate.config.json` or `.devmate/contexts/`. Prints a digest only (domain count, ids, output paths).

**Usage:**
```
node scripts/generate-domain-map.mjs [--root <dir>]
```

**Flags:**
- `--root <dir>` — repo root (default: resolved from cwd)

**Exit codes:**
- `0` — draft + stubs written
- `1` — walk or write failure

---

## generate-loop-schema.mjs

**Category:** Doc Generation

Generates (or validates) the loop trace JSON schema artifact at `docs/loop-trace-schema.json`. In `--check` mode, it compares the file on disk to the freshly generated schema and fails if they differ.

**Usage:**
```
node scripts/generate-loop-schema.mjs [--check]
```

**Flags:**
- `--check` — compare existing file against generated schema; fail if different

**Output file:** `docs/loop-trace-schema.json`

**Exit codes:**
- `0` — schema written (or up to date in check mode)
- `1` — schema is out of date (check mode only)

---

## init-task-state.mjs

**Category:** Init

Initialises a new task state JSON file (`.devmate/state/task.json`). Sets the initial workflow gate to `plan-approved` and writes the task ID, lane, and step budget. The orchestrator calls this at the start of every new task.

**Usage:**
```
node scripts/init-task-state.mjs --taskId <id> [--lane <lane>] [--budget <n>]
```

**Flags:**
- `--taskId <id>` — required
- `--lane <lane>` — optional; `feature` (default) | `bug` | `chore`
- `--budget <n>` — optional; max steps (default `10`)

**Stdout:** `{ "ok": true, "plan_stored_at": "...", "handoff_dir": "..." }`

**Exit codes:**
- `0` — state file created
- `1` — missing required flags or invalid values

---

## init.mjs

**Category:** Init

The `devmate init` entrypoint. Scaffolds a starter `devmate.config.json` declaring stack personas and their editable/off-limits globs. Also seeds the `.devmate/` layout and `.gitignore` after a successful write.

**Usage:**
```
node scripts/init.mjs [--infer] [--write] [--force] [--path <file>]
```

**Flags:**
- `--infer` — infer personas from the repo structure (proposal mode by default — prints JSON, writes nothing)
- `--write` — with `--infer`, write the inferred config to disk
- `--force` — overwrite an existing config
- `--path <file>` — target config path (default: `devmate.config.json`)

**Multi-root behaviour:** If a multi-root workspace is detected, the single-root init flow is skipped entirely. The script validates the multi-root config and exits. On success it reports the authoritative primary (from the `.devmate/session.json` handshake) and nudges about any repo on fallback scoping; on a validation failure it prints an actionable pointer — the problem plus the "Re-sync devmate" repair command — instead of a bare error dump.

**Exit codes:**
- `0` — config written or multi-root validation passed
- `1` — error (file exists without `--force`, validation failure, etc.)

---

## learn-router.mjs

**Category:** Routing

Classifies a `learn` command invocation as either read-only `help` or gated `pattern-authoring`, and prints the route as a JSON line. Performs no file writes — the calling agent uses the route to pick the correct sub-agent.

**Usage:**
```
node scripts/learn-router.mjs --input "<text>"
```

**Flags:**
- `--input <text>` — the user's learn invocation text

**Stdout:** `{ "route": "help" }` or `{ "route": "pattern-authoring" }`

**Exit codes:**
- `0` — always (empty/missing input defaults to `help`)

---

## match-skill.mjs

**Category:** Routing

Loads all `SkillManifest` files under the skills root, scores them against the query, and prints ranked matches with confidence scores and reasons. No match is a valid result (exit 0). The same matcher runs in the prompt path: the UserPromptSubmit hook (hooks/approval-listener.mjs) invokes it on every prompt and persists the ranked top matches to .devmate/state/skill-matches.json for the orchestrator to consult before loading heavy skills (E9-20).

**Usage:**
```
node scripts/match-skill.mjs "<query>" [skillsRoot]
```

**Arguments:**
- `query` — required; the natural-language query to match against
- `skillsRoot` — optional; path to skills directory (default: `./skills`)

**Stdout:** Lines of `[confidence] skillId — reason` (sorted by confidence descending)

**Exit codes:**
- `0` — success (including no matches)
- `1` — query is missing or blank

---

## merge-discovery.mjs

**Category:** Discovery

Fan-in of the two-phase discovery fan-out (FO-5). Reads every discovery worker-return artifact (filter: `agentName === 'discovery'`, sorted-filename order as worker ids) from `.devmate/state/worker-returns/`, merges them via `mergeDiscoveryArtifacts` (FO-4) with `maxClaims` from the persisted output contract in `.devmate/state/task.json` (`outputContract.max_context_sources`, fallback 10), writes `.devmate/state/discovery-merged.json` atomically, appends a `discovery_merge` trace event (`{inputs, merged, dropped, conflicts}`), and prints a ≤10-line digest (claims kept, dups collapsed, conflicts flagged, dropped, invalid inputs, unreadable files, facts written). All-workers-invalid is a degradation, not an error: an empty merged artifact is written and the orchestrator falls back to a single `@discovery` dispatch per the feature-lane procedure. After a completed merge the claims are persisted as recallable discovery facts in the task ledger via `writeDiscoveryFacts` (FO-6) with one `fact_write` trace event per non-empty batch; the fact write degrades softly (reported in the digest, exit stays `0`) — memory is an enhancement, never a gate. See [discovery-merge.md](./discovery-merge.md), [memory.md](./memory.md), and [parallel-dispatch.md](./parallel-dispatch.md).

**Usage:**
```
node scripts/merge-discovery.mjs [--repo-root <path>]
```

**Flags:**
- `--repo-root <path>` — optional; repo root holding `.devmate/state/` (default `process.cwd()`)

**Stdout:** ≤10-line digest ending with the artifact path

**Exit codes:**
- `0` — merge completed and the artifact was written (including zero valid inputs — callers branch on the digest/artifact, not this exit code)
- `1` — IO/config error (missing worker-returns directory, unreadable returns, unwritable artifact, failed trace append)

---

## migrate-memory-path.mjs

**Category:** Migration

Migrates memory files from legacy paths to the canonical `MEMORY_PATH`. In `--dry-run` mode, reports what would be moved without making changes.

**Usage:**
```
node scripts/migrate-memory-path.mjs [--dry-run]
```

**Flags:**
- `--dry-run` — print migration plan without moving any files

**Stdout:** Summary showing moved, skipped, and errored file counts.

**Exit codes:**
- `0` — migration complete (or dry run)
- `1` — one or more migration errors

---

## post-tool-use.mjs

**Category:** Hook

The `PostToolUse` hook handler. Reads the hook payload from stdin and processes it. Filters internally on `hook_event_name` / `tool_name` — does not rely on external matchers.

> **Note:** Currently a stub. Real implementation will be added in a future issue.

**Usage:** Invoked automatically via the hooks manifest.

**Exit codes:**
- `0` — always (stub)

---

## posttool-regex-guard.mjs

**Category:** Hook / Guard

A `PostToolUse` guard that detects dynamic `new RegExp(variable)` construction in any `.mjs` file that was just written or edited. Blocks the edit if a dynamic RegExp is found, requiring the developer to refactor to a static pattern or deterministic parsing.

**Usage:** Invoked automatically via the hooks manifest after file-edit tools.

**Stdin:** Claude hook payload JSON.

**Stdout:** `{ "decision": "continue" }` or `{ "decision": "block", "systemMessage": "..." }`

**Exit codes:**
- `0` — allowed
- `2` — blocked (dynamic RegExp detected)

---

## pr-review.mjs

**Category:** Workflow

Backing entrypoint for the `/devmate:devmate-pr-review` skill. Deterministically gathers the review context for the active task — the branch diff (captured through `buildLoopOutput` and capped at the boundary, TCM-9), the lane's planning artifacts as pointers, and cheap precomputed alignment signals — and writes it to `.devmate/state/pr-review-context.json`. Resolves the base ref from `--base`, else `origin/HEAD`, else `main`/`master`, then diffs against `git merge-base HEAD <base>`. Prints the bounded context JSON to stdout; never prints the raw diff (the reviewing agent reads the full log from the recorded `diffFullPath`). When cwd is not a git work tree it records `git.available: false` with a note instead of failing. The clock and subprocess runner are injected in the pure `gatherReviewContext`, so the context replays deterministically. Emitting the typed verdict is the skill's job, not this script's.

**Usage:**
```
node scripts/pr-review.mjs [--state-file <path>] [--base <ref>] [--include-full-output]
```

**Flags:**
- `--state-file <path>` — optional; override the TaskState path
- `--base <ref>` — optional; base ref to diff against (wins over auto-detection)
- `--include-full-output` — embed the full redacted diff in the context (escape hatch)

**Exit codes:**
- `0` — context gathered and written
- `2` — invalid input (missing/malformed TaskState)

---

## query-memory.mjs

**Category:** Memory

Queries the repo memory ledger and returns at most `topN` compact pointer+summary matches as a single JSON line. Never pastes raw ledger contents. Also writes the result to `.devmate/state/query-memory-result.json` for agent `read_file` access. Discovery facts (FO-6) come back visibly typed — `kind: "discovery"` plus a `[discovery]` summary prefix — and `--stale-check` annotates each one with `stale` by recomputing the referenced file's content digest (mismatch or missing file → `stale: true`; annotated, never dropped).

**Usage:**
```
node scripts/query-memory.mjs [--ledger <path>] [--lane <lane>] [--path-prefix <pfx>] [--tag <tag>] [--text <hint>] [--top-n <n>] [--limit <n>] [--include-expired] [--verify] [--stale-check] [--root <dir>]
```

**Flags:**
- `--ledger <path>` — ledger path (default: `.devmate/state/repo/repo.jsonl`, the canonical repo ledger that promotion writes)
- `--lane <lane>` — filter to a workflow lane
- `--path-prefix <pfx>` — filter/boost facts whose source starts with this prefix
- `--tag <tag>` — boost facts matching this tag (repeatable)
- `--text <hint>` — free-text keyword scoring hint
- `--top-n <n>` — max matches to return (default: `10`)
- `--limit <n>` — alias of `--top-n` (the later flag wins)
- `--include-expired` — include stale facts (audit mode)
- `--verify` — drop facts whose source no longer resolves to live code (verify-before-use)
- `--stale-check` — annotate discovery facts with `stale` via a fresh content digest (opt-in — costs IO, bounded by the output cap)
- `--root <dir>` — repo root for `--verify` / `--stale-check` (default: cwd)

**Exit codes:**
- `0` — always (empty results are valid)
- `1` — I/O error

---

## reduce-context.mjs

**Category:** Context

Reads an `EvidencePack` JSON file, runs a MapReduce reduction to shrink it within its `maxSources` budget, and writes a `ReducedPack` JSON artifact. If the pack is already within budget, reports that and exits cleanly.

**Usage:**
```
node scripts/reduce-context.mjs <input.json> [output.json]
```

**Arguments:**
- `input.json` — required; path to the EvidencePack JSON
- `output.json` — optional; output path (default: `<input>-reduced.json`)

**Stdout:** Summary line: `Reduced N pointers → M chunks`

**Exit codes:**
- `0` — success (or no reduction needed)
- `1` — I/O error or invalid pack

---

## resume-status.mjs

**Category:** Workflow

Reads a task's trace and prints a compact `ResumeSummary` — last completed step, currently blocked step, next legal action, and malformed line count. Also writes a structured JSON result to `.devmate/state/resume-status-result.json`.

**Usage:**
```
node scripts/resume-status.mjs --task <taskId> [--trace-dir <dir>]
```

**Flags:**
- `--task <taskId>` — required
- `--trace-dir <dir>` — optional; override trace directory

**Exit codes:**
- `0` — trace is clean and no blocked step
- `1` — malformed lines found OR a blocked step is present

---

## resume.mjs

**Category:** Workflow

The single canonical entry point to resume a task. Builds a `ResumePlan` from the task trace plus the optional handoff and compaction artifacts, prints a compact plan, and enforces no-repeat-work semantics. Writes the plan summary to `.devmate/state/resume-plan.json`.

**Usage:**
```
node scripts/resume.mjs --task <taskId> [--trace-dir <dir>] [--handoff-dir <dir>] [--compaction-dir <dir>] [--confirm] [--strategy-change] [--dry-run]
```

**Flags:**
- `--task <taskId>` — required
- `--trace-dir <dir>` — optional
- `--handoff-dir <dir>` — optional
- `--compaction-dir <dir>` — optional; directory holding compaction artifacts (default `.devmate/state/compaction`)
- `--confirm` — proceed past a `confirm_needed` (malformed-line) plan
- `--strategy-change` — unblock a halted step by appending a strategy-change marker
- `--dry-run` — print the plan without writing any state

**Exit codes:**
- `0` — proceed or already complete
- `1` — error (missing taskId, unreadable trace)
- `2` — blocked (requires a human decision)

---

## rollback.mjs

**Category:** Workflow

The only safe way to run a rollback — no destructive git command may be pasted into agent prose. Builds a rollback plan, shows it first (dry-run), and requires explicit `--confirm` for a live destructive run. Writes the result to `.devmate/state/rollback-result.json`.

**Usage:**
```
node scripts/rollback.mjs [--state-file <path>] [--dry-run] [--confirm]
```

**Flags:**
- `--state-file <path>` — optional; override TaskState path
- `--dry-run` — print the plan; make no git mutations (wins over `--confirm`)
- `--confirm` — required for a live, destructive rollback

**Exit codes:**
- `0` — rollback succeeded or dry-run complete
- `1` — failure, error reading state, or missing `--confirm`

---

## route-model.mjs

**Category:** Routing

Reads the persisted budget class from the task's OutputContract, routes it through `config/model-policy.json`, and records the recommendation as a model_route trace event plus a dispatch hint at `.devmate/state/model-route.json`. When the policy declares a `roles` block (FO-7) the hint also carries one entry per known worker role under `roles` (today: discoveryWorker). Advisory while model IDs remain unverified; a verified ID — class or role — is honored only with a committed eval baseline (blocked with exit 1 otherwise).

**Usage:**
```
node scripts/route-model.mjs [taskStatePath]
```

**Exit codes:**
- `0` — advisory recommendation, or enforced route with a committed baseline
- `1` — verified route (class or role) without a baseline, or unreadable policy

---

## run-ac-coverage-evals.mjs

**Category:** Evals

Runs the deterministic AC-coverage eval suite (AC-6, epic #416). For each fixture scenario in evals/ac-coverage/fixtures/scenarios.json it materializes a real `.devmate/` root and drives the AC-1 coverage read (`computeAcCoverage`) plus the AC-2 `pr-ready` gate (`checkGatePrecondition`) under every `acCoverageGate` mode (off / warn / block), then grades observed-vs-expected with the pure scorer. Writes a small git-ignored coverage report to `evals/ac-coverage/results-latest.json` (block-mode detection, off-mode baseline, and known limitations) so the AC miss rate is trackable across runs. No LLM calls — fully deterministic from fixtures.

**Usage:**
```
node scripts/run-ac-coverage-evals.mjs [--no-write]
```

**Flags:**
- `--no-write` — skip writing the results JSON (useful in tests)

**Stdout:** `[ac-coverage] PASS/FAIL — N scenario(s), block-mode detection X/Y (Z%), off-mode baseline 0/Y, K known limitation(s)`

**Exit codes:**
- `0` — every scenario's observed verdict matched its expected verdict
- `1` — one or more scenarios diverged

---

## run-fanout-demo.mjs

**Category:** Demo

A manual smoke test for the orchestrator-workers fanout. Runs three trivial synthetic workers under a `large` budget and prints the aggregate result. Used to verify the fanout mechanism works end-to-end without real workers.

**Usage:**
```
node scripts/run-fanout-demo.mjs
```

**Stdout:** `[fanout-demo] N valid, M violation(s)`

**Exit codes:**
- `0` — always

---

## run-issue-quality-evals.mjs

**Category:** Evals

Runs the issue quality eval suite (positive + negative cases) against the `scoreIssueQuality` scorer and writes `evals/issue-quality/results-latest.json`. Fails CI if any positive case scores below 7/7, or if any negative case's intended defect is not caught.

**Usage:**
```
node scripts/run-issue-quality-evals.mjs [--no-write]
```

**Flags:**
- `--no-write` — skip writing the results JSON (useful in tests)

**Stdout:** `[issue-quality] PASS/FAIL — positive accuracy N%, M defect(s) missed`

**Exit codes:**
- `0` — all evals passed
- `1` — one or more eval failures

---

## run-regressions.mjs

**Category:** Evals

Runs every regression suite enumerated by `evals/regression-index.mjs` (via `runRegressionSuite`, which spawns `node --test` per suite) and writes `evals/regression-summary.json`. Fail-closed: a suite counts as passing only with zero failures and at least one passing test, so an unparseable suite can never produce a green summary. CI uploads the summary as a build artifact.

**Usage:**
```
node scripts/run-regressions.mjs [summaryPath]
```

**Arguments:**
- `summaryPath` — optional override for the summary output path (default `evals/regression-summary.json`)

**Stdout:** `[run-regressions] <suite>: PASS/FAIL (N passed, M failed)` per suite, then `[run-regressions] PASS/FAIL — N suite(s); summary at <path>`

**Exit codes:**
- `0` — every suite ran clean
- `1` — at least one suite failed or reported no tests

---

## session-start.mjs

**Category:** Hook

The `SessionStart` hook handler. Reads the hook payload from stdin, resolves the repo root from the payload `cwd`, asserts startup readiness invariants (valid config + gate-guard registered), and idempotently seeds the `.devmate/` layout. In multi-root mode, pre-loads per-repo memory files into a map.

**Usage:** Invoked automatically via the hooks manifest on session open.

**Stdin:** Claude `SessionStart` hook payload JSON.

**Stdout:** JSON status lines (`{ ok, repoRoot, created?, warning?, repoMemories? }`)

**Exit codes:**
- `0` — session started (or init errors silently suppressed)
- `1` — startup invariants failed (degraded environment)

---

## session-stop.mjs

**Category:** Hook

The `Stop` hook handler. On a normal session end it (1) captures memory — promotes the active task's fact ledger into the repo ledger and re-renders `.devmate/MEMORY.md` via the shared `captureMemory` helper — and (2) writes a resume handoff for an in-progress task via `captureHandoff`, so a fresh session can pick up where this one left off. Both persist even when no PreCompact fired and `complete-task` was never run. Best-effort — any failure warns to stderr and never blocks shutdown.

**Usage:** Invoked automatically via the hooks manifest on session close.

**Exit codes:**
- `0` — always (best-effort capture; warnings go to stderr)

---

## validate-agents.mjs

**Category:** CI Guard

Scans for all `*.agent.md` files under a root directory, validates each against the agent frontmatter schema, and cross-checks `agents:` frontmatter references against existing agent files. Prints a compact per-file pass/fail report.

**Usage:**
```
node scripts/validate-agents.mjs [--dir <path>]
```

**Flags:**
- `--dir <path>` — optional; restrict scan to this root (default: current directory)

**Exit codes:**
- `0` — all agents valid (or none found)
- `1` — one or more agents have violations

---

## validate-hooks.mjs

**Category:** CI Guard

Loads `hooks/hooks.json`, validates it against the hook manifest schema, and prints a pass/fail summary. Use this in CI to catch malformed hook registrations before deployment.

**Usage:**
```
node scripts/validate-hooks.mjs
```

**Exit codes:**
- `0` — manifest is valid
- `1` — manifest has errors or could not be loaded

---

## validate-model-policy.mjs

**Category:** CI Guard

Strictly validates the model policy config (`config/model-policy.json`), including the optional per-worker `roles` block (FO-7, same field rules as class entries; unknown role names are rejected). Fails if any entry commits a real-looking model ID without `verifiedAt`, mixes a placeholder with a `verifiedAt` date, or is verified with no `source` URL; explicit placeholders with `verifiedAt: null` pass with a notice. Designed to block unverified model IDs from silently becoming committed defaults.

**Usage:**
```
node scripts/validate-model-policy.mjs [path-to-policy.json]
```

**Arguments:**
- `path-to-policy.json` — optional; override policy path

**Exit codes:**
- `0` — all entries verified (clean policy)
- `1` — malformed policy or unverified/placeholder entries

---

## validate-skill-split.mjs

**Category:** CI Guard

Loads all skill manifests under the skills root and checks that every trigger stub is within the line budget (`TRIGGER_LINE_BUDGET`). Prints a per-skill pass/fail summary. Use this in CI to enforce the skill-split contract.

**Usage:**
```
node scripts/validate-skill-split.mjs [skillsRoot]
```

**Arguments:**
- `skillsRoot` — optional; path to skills directory (default: `./skills`)

**Exit codes:**
- `0` — all skills within budget (or none found)
- `1` — one or more skills over budget

---

## verify-step.mjs

**Category:** Workflow

Runs a verification command for a task step, enforces the output boundary (capped + redacted), and prints a `LoopOutput` JSON line. Also writes the result to `.devmate/state/verify-step-result.json`. Supports flake detection via an optional rerun.

**Usage:**
```
node scripts/verify-step.mjs --trace-file <path> --task-id <id> --attempt-id <id> [--argv <json>] [-- <command>] [--timeout-ms <n>] [--tier <n>] [--output-dir <dir>] [--include-full-output]
```

**Flags:**
- `--trace-file <path>` — required
- `--task-id <id>` — required
- `--attempt-id <id>` — required
- `--argv <json>` — command as a JSON array string
- `--` — alternative: pass command after `--`
- `--timeout-ms <n>` — optional timeout in milliseconds
- `--tier <n>` — optional tier number (1, 2, or 3)
- `--output-dir <dir>` — optional output directory (default: `.devmate/output`)
- `--include-full-output` — include `output_full` in the result (default: omitted)

**Exit codes:** Mirrors the verification command's own exit code.

---

## verify-test-files.mjs

**Category:** Workflow

Reads `testPlan` from the task state JSON and verifies that every declared `testFile` exists on disk. Fails closed: exits `1` when `testPlan` is empty, any file is missing, or state cannot be read. Never executes any test command.

**Usage:**
```
node scripts/verify-test-files.mjs
```

Runs from the current working directory (repo root).

**Output file:** `.devmate/state/test-files-result.json`

**Exit codes:**
- `0` — all test files exist
- `1` — one or more test files missing, path violation, or empty testPlan

---

## view-trace.mjs

**Category:** Diagnostics

Reads a task's trace file (`.devmate/state/trace/<taskId>.jsonl`), validates each line, and prints a compact summary: counts by event type, last N events, and special sections for rubber-duck stages (`grill_complete`, `critique_complete`, `plan_revised`). Flags any `loop_halt` or `budget_warning` events.

**Usage:**
```
node scripts/view-trace.mjs --task <taskId> [--last <n>] [--root <dir>]
```

**Flags:**
- `--task <taskId>` — required
- `--last <n>` — number of trailing events to print (default: `20`)
- `--root <dir>` — base directory (default: `.`)

**Exit codes:**
- `0` — trace is clean
- `1` — malformed ratio > 5% OR any `loop_halt` event present

---

## worker-contract-check.mjs

**Category:** CI Guard

Recursively finds all `*.worker-return.json` artifacts under a root directory and validates each against the `WorkerReturn` contract schema. Prints a per-file pass/fail summary.

**Usage:**
```
node scripts/worker-contract-check.mjs [root]
```

**Arguments:**
- `root` — optional; root directory to scan (default: current directory)

**Exit codes:**
- `0` — all artifacts pass (or none found)
- `1` — one or more artifacts are invalid

---

## worktree-exec.mjs

**Category:** Workflow

Creates a throwaway git worktree, signals readiness, awaits the agent's completion sentinel, extracts a diff artifact, records telemetry, and tears down the worktree. On any error the worktree is still torn down — orphaned worktrees are never left behind.

**Usage:**
```
node scripts/worktree-exec.mjs --branch <name> --worktree-path <abs-path> [--base-ref <ref>] [--timeout <ms>]
```

**Flags:**
- `--branch <name>` — required; name for the new worktree branch
- `--worktree-path <abs-path>` — required; absolute path for the worktree
- `--base-ref <ref>` — optional; base git ref (default: `HEAD`)
- `--timeout <ms>` — optional; completion signal timeout in ms (default: `60000`)

**Exit codes:**
- `0` — success
- `1` — error (missing flags, git failure)
- `2` — timed out waiting for completion signal
