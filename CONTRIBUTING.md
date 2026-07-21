# Contributing & Engineering Conventions — devmate

This document is the single source of truth for how every script and module in
`devmate` is built. **Every issue in this repo assumes these rules.** If an
issue and this document disagree, this document wins unless the issue explicitly
overrides it.

> **What this project is.** devmate is a GitHub Copilot plugin for VS Code
> that turns ad-hoc AI coding into a deterministic, gated, resumable workflow.
> The whole plugin — hooks, agents, skills, and the scripts behind them — is
> written in modern Node (`.mjs`). The product's core differentiator is
> **token & context management**; keep it central. See [README.md](./README.md)
> for what ships and [docs/README.md](./docs/README.md) for the design docs.

---

## 0. Getting started

```bash
git clone https://github.com/LP-GTM-Product-Engineering/devmate
cd devmate
npm install          # Node 24+ required (see §3)
npm run verify       # the local gate — run this before every push
```

`npm run verify` is the one command you must pass locally. CI runs the **same**
checks — fanned out across parallel jobs, plus extra guard/eval scripts (see §7) —
so a green `verify` is necessary but not sufficient; CI is a superset. Useful
sub-commands while iterating:

| Command | What it does |
| --- | --- |
| `npm test` | `node --test` — the full test suite |
| `npm run lint` | ESLint (Node-target + security rules, see §5) |
| `npm run typecheck` | `tsc -p jsconfig.json` — JSDoc type check (see §2) |
| `npm run check-contracts` | Agent/worker artifact contract checks |
| `npm run check-docs-drift` | Fails if docs assert facts not in verified ground truth |
| `npm run verify` | All of the above + `npm audit --audit-level=high` |

### Repository layout

| Path | What lives here |
| --- | --- |
| `lib/` | Library modules (grouped: `loop/`, `memory/`, `context/`, `workflow/`, `orchestrator/`, `routing/`, …). Pure, testable logic. |
| `scripts/` | Executable entrypoints and CI guards — every one exports `main(args)` (see §6). Documented in [docs/SCRIPTS.md](./docs/SCRIPTS.md). |
| `hooks/` | Copilot hook handlers wired via `hooks/hooks.json`. |
| `agents/` | Agent definitions (`*.agent.md`) — the orchestrator and its specialists. |
| `skills/` | Skills as trigger stubs (`skills/<id>/SKILL.md`) plus lazy `refs/`. |
| `config/` | Runtime policy (e.g. `model-policy.json`). |
| `test/` | `*.test.mjs` suites, mirroring source paths (see §4). |
| `docs/` | Design reference + generated docs. `docs/README.md` is the index. |
| `evals/` | Quality evals (e.g. `issue-quality`). |
| `.devmate/` | Per-repo devmate config, memory, and session state. |
| `.github/` | CI workflow, issue template, hooks, and instruction files. |

---

## 1. Language & module format

- **All scripts are `.mjs`** (native ES modules). No CommonJS (`require`), no
  `.ps1`, no transpiled `.ts` sources.
- Use `import` / `export`. Prefer named exports for utilities; a `main()`
  entrypoint pattern for executable scripts (see §6).
- Node-native APIs first (`node:fs`, `node:path`, `node:crypto`,
  `node:process`, `node:child_process`, `node:test`). Add a third-party
  dependency only when a Node built-in cannot do the job, and justify it in the
  PR. Runtime dependencies stay at zero by design — the only packages in
  `package.json` are dev tooling (ESLint, TypeScript, `@types/node`).

## 2. Types via JSDoc (no TypeScript build step)

- **Types are expressed with JSDoc**, not TypeScript syntax. There is no compile
  step; `.mjs` runs directly on Node.
- Every `.mjs` file starts with `// @ts-check` on the first line so editors and
  CI type-check it with the TypeScript language service.
- Use `@typedef`, `@param`, `@returns`, `@template` as needed. Shared types live
  in `lib/types.mjs` (typedef-only module) and are imported with
  `/** @import { TaskState } from './types.mjs' */` or `@typedef {import('./types.mjs').TaskState} TaskState`.
- CI runs the type check via `npm run typecheck` (`tsc -p jsconfig.json`, which
  sets `checkJs: true`, `noEmit: true`, `strict: true`). Type errors fail CI.

Example:

```js
// @ts-check

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} passed
 * @property {string} digest      Short summary of output.
 * @property {string} fullOutputPath  Path to the capped full-output artifact.
 */

/**
 * Run a verification command and capture capped output.
 * @param {string[]} argv  Command as an argv array (never a shell string).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<VerifyResult>}
 */
export async function verifyStep(argv, opts = {}) {
  // ...
}
```

### 2.1 Cross-issue contracts (inline, with provenance)

When a generated issue or backlog item depends on another issue (`Blocked by
#N`), the implementing agent cannot be trusted to remember or paraphrase the
upstream type/contract. Paraphrase is how drift and hallucination start (e.g.
rewriting a camelCase `@typedef` into snake_case fields).

Rules:

- **Inline the contract verbatim.** Copy the exact upstream `@typedef` /
  constant / function signature into the issue body under a section titled
  exactly `## Upstream contracts (inlined)`, inside a fenced ` ```js ` block.
- **Cite provenance.** Directly below the block, add a line of the form
  `Source of truth: #N` (optionally `— do not diverge`) naming the issue (and
  file) the contract comes from.
- **Never reword.** Do not rename fields, change casing, or summarize. Paste it
  as-is so the value is the single source of truth.
- If an issue lists no upstream dependency (`Dependencies: None`), the section is
  optional.

The `evals/issue-quality` scorer enforces this in CI: any issue whose
`Dependencies` reference a `#N` must carry an inlined js block
(`contractsInlined`), and any inlined block must carry a `Source of truth: #N`
line (`externalClaimsSourced`). Both are required for a 7/7 quality score.

## 3. Node version policy (Node 24+)

Two layers, both required:

1. **`package.json` `engines`** — declares the supported range so `npm`/`pnpm`
   warns on install, and ESLint's `n/no-unsupported-features/*` rules read it to
   flag any API newer than the target (see §5):

   ```json
   {
     "type": "module",
     "engines": { "node": ">=24.0.0" }
   }
   ```

2. **Runtime guard** — a shared util `lib/env-guard.mjs` exporting
   `assertNodeVersion(min = 24)`. Every executable entrypoint calls it before
   doing work. It reads `process.versions.node`, compares the major version, and
   on failure prints a clear, actionable message and exits non-zero:

   ```
   devmate requires Node 24 or newer. You are running Node 22.11.0.
   Please upgrade: https://nodejs.org/en/download  (or use nvm: `nvm install 24 && nvm use 24`)
   ```

   The guard suggests at least Node 24. It must not throw a raw stack trace at
   the user.

```js
// @ts-check
/**
 * Assert the running Node.js major version is at least `min`.
 * Prints a friendly message and exits(1) if not satisfied.
 * @param {number} [min=24]
 * @returns {void}
 */
export function assertNodeVersion(min = 24) {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < min) {
    process.stderr.write(
      `devmate requires Node ${min} or newer. ` +
      `You are running Node ${process.versions.node}.\n` +
      `Please upgrade: https://nodejs.org/en/download ` +
      `(or use nvm: \`nvm install ${min} && nvm use ${min}\`).\n`
    );
    process.exit(1);
  }
}
```

Hooks and scripts must also stay **cross-platform** (Linux, macOS, Windows). CI
runs a `hooks-smoke` job on all three OSes — never assume POSIX-only paths,
shells, or path separators.

## 4. Token & context discipline (the secret sauce)

These rules apply to anything that returns data to an agent/orchestrator:

- **Cap tool output at the boundary.** Return `{ digest, fullOutputPath }` by
  default; never return full logs unless an explicit `--include-full-output`
  flag is set. The canonical implementation of this rule (TCM-9) is
  `lib/loop/output-cap.mjs`, which exports `capOutput`, `redactSecrets`, and
  `buildLoopOutput`. Every command-running boundary **must** use
  `buildLoopOutput` (or equivalent logic) and **must not** expose `output_full`
  in the default return shape. See also: `LoopOutput` / `LoopOutputFull` in
  `lib/types.mjs`.
- **Pointers, not payloads.** Pass file paths + line ranges, not pasted file
  contents.
- **Typed contracts.** Workers/scripts return small JSDoc-typed result objects,
  not transcripts. These are enforced by `npm run check-contracts` and
  `npm run worker-contract-check` in CI.
- **Deterministic.** Same input → same output; no hidden global state. In
  particular, avoid `Date.now()` / `Math.random()` inside logic that gets
  snapshotted or replayed — inject them instead.

The full set of context-management rules (the "12 TCM rules") lives in
[docs/PATTERNS.md](./docs/PATTERNS.md).

## 5. Testing & linting

**Tests**

- Use the built-in **`node:test`** runner and **`node:assert/strict`**. No
  external test framework unless an issue says otherwise.
- Test files: `*.test.mjs`, colocated under `test/` mirroring source paths.
- Tests must not write into the repo tree — use `node:fs`'s temp-dir helpers so
  runs are isolated and deterministic.
- Every issue lists explicit test cases in its "Test requirements" section; all
  must pass. Cover happy path, edge cases, and the specific failure modes the
  issue calls out (concurrency, malformed input, timeouts, quoting, etc.).

**Linting**

- `npm run lint` runs ESLint's flat config (`eslint.config.mjs`). It layers the
  core recommended rules, `eslint-plugin-n` (Node-target aware — anything newer
  than the `engines` range fails), and three security plugins
  (`eslint-plugin-security`, `eslint-plugin-secure-coding`,
  `eslint-plugin-node-security`). Lint failures fail CI.
- Prefix an intentionally-unused binding with `_` (e.g. an entrypoint that
  ignores its `argv`); real dead code still fails.

## 6. Script entrypoint pattern

Executable scripts follow this shape so they are testable and guarded — import
them in tests without side effects; they only run when executed directly:

```js
// @ts-check
import { assertNodeVersion, isMainModule } from '../lib/env-guard.mjs';

/** @param {string[]} args CLI args (without node/script). @returns {Promise<number>} exit code */
export async function main(args) {
  // ... real work, returns an exit code
  return 0;
}

// Only run when executed directly, not when imported by tests.
// isMainModule normalizes both sides through the filesystem path space, so
// Windows backslash argv paths and POSIX file:// URLs compare equal. Never
// compare import.meta.url against a hand-built file:// string — that guard
// is always false on Windows and main() silently never runs.
if (isMainModule(import.meta.url)) {
  assertNodeVersion(24);
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
```

## 7. Continuous integration

CI (`.github/workflows/ci.yml`) runs the same checks as `npm run verify`, but fanned
out across **parallel jobs** so wall-clock is `max(job)` rather than one long serial
chain. All jobs share setup via the `./.github/actions/setup` composite action
(checkout is per-job; then Node 24 + npm cache + install). A `concurrency` block
cancels a PR's own superseded run on re-push (never a `main` run). The jobs:

- **`lint`** / **`typecheck`** / **`test`** (Ubuntu, Node 24) — `npm run lint`,
  `npm run typecheck`, and the full `node --test` suite, each on its own runner.
- **`guards`** (Ubuntu, Node 24) — the drift/consistency guards and `npm audit`:
  `check-contracts` / `worker-contract-check` (artifact/worker return shapes),
  `check-artifact-graph` / `check-artifact-allowlist`, `check-docs-drift` (docs may
  not assert hook events, config keys, or state names outside verified ground truth),
  `check-script-refs`, `check-file-budgets`, `check-entrypoint-guard`,
  `check-contract-drift`, `check-state-writers`, `check-memory-path-refs` (no
  hardcoded non-canonical memory paths), `generate-current-behavior` +
  `git diff --exit-code` (`docs/CURRENT_BEHAVIOR.md` must match the generated
  metadata), `validate-agents` (every `*.agent.md` frontmatter must match its body),
  `check-backend-ready`, `check-generated-docs`, `check-settings-keys`,
  `validate-model-policy`, `validate-skill-split`.
- **`evals`** (Ubuntu, Node 24) — `eval-model-routing`, the issue-quality evals, and
  the regression suites; uploads the two result artifacts.
- **`hooks-smoke`** (Ubuntu **+ Windows + macOS**, Node 24) runs the hook
  registration and spawn smoke tests so hooks work cross-platform.

### Generated docs & drift

Several docs contain sentinel-delimited generated blocks (e.g. the capability
table in `README.md`, and all of `docs/CURRENT_BEHAVIOR.md`). **Do not hand-edit
generated blocks** — edit the source registry and run `node scripts/generate-docs.mjs`
/ `node scripts/generate-current-behavior.mjs` to regenerate.

`check-docs-drift` is strict about identifiers. When editing `CHANGELOG.md` or
`docs/hooks.md`, keep type/function names **out of backticks** unless they are
verified ground truth — an unrecognized backticked identifier fails the drift
check.

## 8. Commits & pull requests

- **One issue per PR.** Branch off `main`, implement, verify, open a PR whose
  body contains `Closes #<N>`. Don't start an issue whose dependencies aren't
  merged yet.
- **Conventional Commits.** Use `type(scope): summary` — e.g.
  `feat(orchestrator): …`, `fix(skills): …`, `docs: …`, `refactor: …`. Reference
  the issue number in the title or body.
- **Squash-merge** into `main` (never direct-to-main). When the PR merges, the
  linked issue closes automatically and the branch is deleted.
- **Update docs & metadata** in the same PR as the code that changes them —
  CHANGELOG entry, capability registry, budgets, etc. — so the drift guards stay
  green.

## 9. Definition of Done (applies to every issue)

- [ ] Code is `.mjs` with `// @ts-check` and complete JSDoc types.
- [ ] `npm run verify` passes locally (lint + typecheck + tests + contracts +
      docs-drift + audit), and CI is green on the PR.
- [ ] Executable entrypoints call `assertNodeVersion(24)` and guard direct
      execution with `isMainModule(import.meta.url)` from `lib/env-guard.mjs`
      (§6).
- [ ] Tool/worker output is capped per §4.
- [ ] No `.ps1` introduced; no CommonJS; no new runtime dependency without
      justification.
- [ ] Tests cover happy path, edge cases, and the failure modes the issue calls
      out; they write only to temp dirs.
- [ ] Docs/metadata updated where the issue requires it; generated blocks
      regenerated, not hand-edited.
- [ ] Acceptance criteria in the issue are all satisfied, and deferred decisions
      are documented in the PR under "## Out of scope / follow-ups".

---

_These conventions exist so an autonomous agent can implement any single issue
without external context. Each issue body is self-contained but defers global
rules to this file._
