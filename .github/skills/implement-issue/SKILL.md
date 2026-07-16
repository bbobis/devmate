---
name: implement-issue
description: Implement one GitHub issue for devmate-mjs end to end — read the issue, branch, build exactly what the issue specifies per CONTRIBUTING.md and docs/PATTERNS.md, keep all documentation current (create new docs for new concepts), run the CI-parity driver, open a PR that closes the issue, drive CI to green, and triage every Copilot PR review comment (apply the legit ones, dismiss the rest with a reason) before merge. Use when asked to implement, build, work on, or fix issue #N, to start an issue, or to verify/run everything CI runs before a push.
---

# Implement a devmate-mjs GitHub issue

This skill is the complete, self-contained protocol — it depends on no other
prompt file. All paths are relative to the repo root. All commands were run
and verified in a clean Linux container against the current codebase (2026-07).

Priority order when sources conflict:

1. **The issue body** — build exactly what it specifies, nothing else.
   (CONTRIBUTING.md wins over an issue only when the issue doesn't
   explicitly override it — see the header of CONTRIBUTING.md.)
2. **CONTRIBUTING.md** — the engineering conventions every issue assumes.
3. **docs/PATTERNS.md** — the TCM-1…12 and P1…22 patterns; each lists its
   enforcement mechanism, so you know which guard catches a violation.

## Where this skill works

This directory (`.github/skills/`) is a documented project-skill location
for BOTH GitHub Copilot and Claude Code, so there is one copy and no drift:

- **GitHub Copilot (VS Code, agent mode)** — auto-discovered; requires the
  **Chat: Use Agent Skills** setting (`chat.agent.skills`). For an explicit
  entry point type `/implement-issue <N>` in Copilot Chat — the prompt file
  `.github/prompts/implement-issue.prompt.md` routes here. (Copilot also
  reads `.github/skills/` and `.agents/skills/`; if your build doesn't pick
  this up, move this folder — do not copy it.)
- **Claude Code** — auto-discovered; also the `/implement-issue` command.
- **GitHub access** differs by host: use GitHub MCP tools where available
  (`issue_read`, `create_pull_request`, `pull_request_read`, `get_job_logs`),
  else the `gh` CLI.

## Prerequisites — Node 24 (containers usually have 22)

The repo requires Node 24+ and remote containers typically ship Node 22.
Check first; install if needed (verified in this container):

```bash
node -v   # need v24+
curl -fsSL -o /tmp/node24.tar.xz https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-x64.tar.xz
mkdir -p /opt/node24 && tar -xJf /tmp/node24.tar.xz -C /opt/node24 --strip-components=1
export PATH=/opt/node24/bin:$PATH
node -v   # v24.13.0
npm install
```

`export PATH=/opt/node24/bin:$PATH` must be repeated in every new shell.

## The CI-parity driver

`npm run verify` is necessary but NOT sufficient — the CI `verify` job
(.github/workflows/ci.yml) runs a superset of guards, and a second
`hooks-smoke` job runs four hook test files on three OSes. The driver runs
every step of both jobs locally, in CI order, with capped per-step output
(full logs go to a temp dir):

```bash
node .github/skills/implement-issue/ci-parity.mjs              # all 24 steps
node .github/skills/implement-issue/ci-parity.mjs lint test    # subset by id
node .github/skills/implement-issue/ci-parity.mjs --list       # step ids
```

Green looks like `[ci-parity] GREEN — 24 step(s) passed.` Exit code 0/1.

**Baseline before you code.** Run the driver on a clean checkout of `main`
BEFORE branching and note which steps already fail — only new failures are
yours. At the time of writing, `main` itself is red on two steps
(`memory-path-refs`: 3 hits in docs/conventions/multi-root-setup.md, and
`file-budgets`: agents/orchestrator.agent.md + agents/fullstack.agent.md
over budget). Do not chase pre-existing failures; note them in the PR under
"## Out of scope / follow-ups".

## Step 0 — Read and vet the issue

1. Read issue #N in full (owner `bbobis`, repo `devmate-mjs`). Confirm it
   is OPEN — if CLOSED, stop and say so.
2. Confirm it is a buildable story, not an umbrella tracker: skip and
   report if it carries an `epic` label or its body is a roadmap with no
   implementation/acceptance sections.
3. If the body contains a re-spec/overlay callout that SUPERSEDES the
   original spec, implement the overlay and treat the superseded parts as
   not-to-be-built.
4. Check dependencies: if a `Blocked by #M` issue is still open/unmerged,
   stop and report which one instead of guessing.
5. Announce one line before building — `Building issue #N: "<title>".` —
   so a human can veto a wrong target before any code is written.

**Issue vocabulary.** Newer issues (e.g. the FO-series) use `## Problem` /
`## Design` / `## Implementation steps` / `## Acceptance criteria` /
`## Out of scope`; older generated issues use `Files to create / change`,
`Module contract (JSDoc)`, `Upstream contracts (inlined)`,
`Test requirements (node:test)`, `Definition of Done`. Either way the rules
are the same: implement the named files, contracts, and tests **verbatim** —
never rename fields, change casing, or paraphrase an inlined contract (a
block followed by `Source of truth: #M` is copy-exact). Values marked
provisional/placeholder get implemented as given plus a
`// TODO: calibrate — provisional placeholder` annotation. Anything under
`## Out of scope` is not-to-be-built.

## Step 1 — Pre-code checks (before writing any code)

- **Reach scan.** Grep the repo for each key identifier the issue names
  (config keys, agent names, schema names, path patterns, string literals)
  and compare hits against the issue's file list. If the issue declares
  `SCOPE: REPRESENTATIVE`, fix all pattern matches; otherwise (EXHAUSTIVE
  or unstated) touch only listed files and note unlisted hits in the PR
  under "## Out of scope / follow-ups".
- **Entity existence check.** For each file/agent/schema/config entity the
  issue REFERENCES but does not create, verify it exists on `main` right
  now. If one is missing it may belong to an unmerged dependency — stop and
  report; never create it speculatively.
- **Style consistency.** When the issue's literal wording (naming, casing,
  link/path format) conflicts with the established pattern in the target
  file, prefer the file's pattern — unless standardizing is the issue's
  explicit goal. Note deviations in the PR.

## Step 2 — Branch

```bash
git checkout main && git pull --ff-only
git checkout -b issue-N-<short-kebab-slug>
```

Reuse the existing toolchain — do NOT edit package.json, jsconfig.json,
eslint.config.mjs, or .github/workflows/ci.yml unless THIS issue says to.

## Step 3 — Implement

Follow the issue's implementation steps in order; small logical commits
with Conventional Commit messages (`type(scope): summary`). House rules
that bite most often:

- `// @ts-check` first line + full JSDoc types on every `.mjs`; shared
  typedefs live in lib/types.mjs. No TypeScript sources, no CommonJS,
  no new runtime dependency (dev tooling only, justified in the PR).
- Executable entrypoints: guarded `main(args)` pattern +
  `assertNodeVersion(24)` from lib/env-guard.mjs, cross-platform entry
  guard (`isMainModule(import.meta.url)` from lib/env-guard.mjs).
- Command-running boundaries cap output — reuse lib/loop/run-command.mjs
  (safe no-shell spawn) + lib/loop/output-cap.mjs (`buildLoopOutput`,
  digest + full-output path, never raw logs). The driver in this skill
  directory is a working example.
- Tests: `node:test` + `node:assert/strict`, `*.test.mjs` under test/
  mirroring the source path, temp dirs only — never write into the repo
  tree. Cover happy path, edge cases, and the failure modes the issue
  names.
- Result objects over throws across module boundaries; fail closed.
- All imports static at the top of the file — no `await import(...)` in
  function bodies; `await` only inside callbacks explicitly declared
  `async`; sync Node APIs are never awaited.
- Cross-platform always: path.resolve()/fileURLToPath(), never
  string-built paths or POSIX-only shells.

## Step 4 — Documentation currency (same PR as the code)

Docs are enforced by CI drift guards, not by convention — a code change
with stale docs fails the build. In the same PR:

- **CHANGELOG.md** — add an entry under `[Unreleased]`. Keep unverified
  identifiers OUT of backticks: `check-docs-drift` scans backticked names
  in CHANGELOG.md and docs/hooks.md against verified ground truth.
- **Never hand-edit generated blocks.** Capability tables in README.md,
  docs/plugin-help.md, docs/marketplace.md come from
  docs/capability-registry.json — edit the registry, then run
  `node scripts/generate-docs.mjs`. Behavior ground truth is
  docs/CURRENT_BEHAVIOR.md — run
  `node scripts/generate-current-behavior.mjs` and commit the diff.
- **Update the owning mechanism doc.** docs/README.md is the index of
  which doc is authoritative for what (gates.md, hooks.md, memory.md,
  config.md, skill-matching.md, …). If your change alters a documented
  mechanism, update that doc. New scripts get a docs/SCRIPTS.md entry;
  agent file changes must keep frontmatter/body consistent
  (validate-agents).
- **New concepts get a new doc.** If the issue introduces a mechanism no
  existing doc owns, create `docs/<concept>.md` following the mechanism-
  reference style (what / why / how, with file:line evidence pointers),
  and:
  - add it to the docs/README.md index;
  - add the file to docs/artifact-allowlist.json — the allowlist guard
    fails CI on any unlisted new file under `.devmate/`, `docs/`, or
    `hooks/`;
  - if it establishes a new design pattern, add an entry to
    docs/PATTERNS.md with an honest enforcement label
    (`structural | ci-enforced | hook-runtime | prompt-only | aspirational`
    plus a file:line evidence pointer). When an issue wires enforcement
    for an existing pattern, flip that pattern's Enforcement value in the
    same PR.
- **Budgets and metadata.** New agent/skill/protocol files may need a
  docs/file-budgets.json entry; new capabilities belong in
  docs/capability-registry.json (then regenerate, see above).

The driver polices all of this: `check-docs-drift`, `generated-docs`,
`gen-current-behavior` + `current-behavior-diff`, `artifact-allowlist`,
`file-budgets`, `validate-agents`.

## Step 5 — Verify

1. Driver fully green except the baselined pre-existing failures.
2. Walk the issue's acceptance criteria (and Definition of Done, if
   present) item by item; for each, state PASS with evidence — the test
   name that covers it or the file:line that satisfies it. Any FAIL: fix
   and re-run from the top. Do not open a PR until every criterion passes.

## Step 6 — Open the PR

Push the branch (`git push -u origin issue-N-<slug>`) and open a PR into
`main`. One issue per PR. The body contains, in order:

1. `Closes #N` — the issue closes automatically on merge; never close it
   by hand.
2. `## What changed` — 2–5 bullets.
3. `## Acceptance criteria` — each criterion from the issue as a checked
   box with one line of evidence.
4. `## Out of scope / follow-ups` — every deferred item, unlisted
   reach-scan hit, style deviation, and pre-existing baseline failure,
   each with a reason. Write "none" only if truly empty.

## Step 7 — Drive CI to green

You own the PR until every required check is green and it is squash-merged.

- Poll the PR's checks until all reach a terminal state — there are TWO
  required jobs: `verify` and the `hooks-smoke` matrix (ubuntu, windows,
  macos).
- **Red check: read the failed job's LOG, not the check name.** Reproduce
  locally with the matching driver step, fix the root cause, re-run the
  driver, push a targeted fix commit. Never disable, skip, or
  `continue-on-error` a check.
- A windows/macos-only hooks-smoke failure is usually a path-separator or
  `file://` bug — fix with resolve()/fileURLToPath().
- Anti-flake: a transient (ECONNRESET, registry 503, runner shutdown)
  while the driver is green locally → re-run the failed job once (max 2
  reruns per check), not counted as a fix iteration.
- Hard caps: 5 fix iterations or ~2 hours — then stop and report exactly
  which checks are red, with the last log excerpt.
- Green: squash-merge (`Closes #N` in the merge body). If merge is blocked
  by policy (review required, merge queue), arm auto-merge and report;
  never force, never push to main.

## Step 8 — Triage Copilot PR review comments

Copilot's code-review bot posts review comments on PRs; they are **advisory
suggestions, not authoritative findings**. Before merge, always fetch and
triage every one — never blindly apply, never blindly ignore.

1. **Fetch every Copilot review comment on the PR** — GitHub MCP
   (`pull_request_read` with `method: "get_review_comments"`) where
   available, else `gh pr view <N> --json reviews,comments` and
   `gh api /repos/{owner}/{repo}/pulls/<N>/comments`. Include both PR-level
   review summaries and inline line comments authored by `copilot-pull-request-reviewer[bot]`
   (or the equivalent Copilot bot account for the host).
2. **Assess each comment's legitimacy against the same priority order the
   rest of this skill uses.** A comment is LEGIT only if it satisfies all
   of these:
   - It identifies a real defect, security issue, contract violation, or
     drift from CONTRIBUTING.md / docs/PATTERNS.md — not a stylistic
     preference or speculative refactor.
   - It is within the scope of THIS issue (does not demand work the issue
     defers or lists under "## Out of scope").
   - It does not contradict the issue body, an inlined contract marked
     `Source of truth: #M`, or an existing established pattern in the
     target file.
   - The claim is factually correct about the code — verify by reading the
     cited file:line, not by trusting the comment's paraphrase. Copilot
     hallucinates method names, misreads types, and misattributes behavior.
   - Applying it does not require loosening a guard, disabling a rule,
     adding a runtime dependency, or hand-editing a generated block.
3. **For each LEGIT comment:** apply the fix in a targeted commit
   (`fix(review): <summary>`), re-run the CI-parity driver, push, then
   **post a reply on that exact thread** naming what was done and the fix
   commit SHA (e.g. `Applied in <sha>: switched to parameterized query,
   see lib/foo.mjs:42.`) and **mark the thread resolved**. A pushed fix
   without a reply and resolution does not count as addressed.
4. **For each NOT-LEGIT comment:** **post a reply on that exact thread**
   with a one-line reason grounded in evidence — the issue section that
   scopes it out, the CONTRIBUTING/PATTERNS rule that contradicts it, the
   file:line showing the comment misread the code, or the pattern the file
   already follows (e.g. `Declined: out of scope per issue #N "## Out of
   scope"; see also docs/PATTERNS.md TCM-4.`) — then **mark the thread
   resolved**. Do not apply the change. Do not argue past one reply.
5. **Every comment gets a reply AND a resolution — no exceptions.**
   The invariant at merge time is: zero open Copilot threads, and every
   closed thread has a devmate reply explaining what was done or why it
   wasn't. Do not request re-review to hide unresolved threads, do not
   resolve without a reply, do not mark "Outdated" as a substitute for
   triage, do not batch a single generic reply across many threads.
6. **Verify the invariant before merging.** Re-fetch the PR's review
   threads (GitHub MCP `pull_request_read` `get_review_comments`, or
   `gh api /repos/{owner}/{repo}/pulls/<N>/comments` +
   `gh api graphql` for thread resolution state) and confirm each Copilot
   thread is `isResolved: true` with a devmate reply after the Copilot
   comment. Any thread failing this check blocks merge until fixed.
7. **Record the triage in the PR body.** Under a new
   `## Copilot review triage` section list each comment as
   `applied: <sha> — <one line>` or `declined — <one line reason>`, each
   line matching what was actually posted on the thread. If Copilot posted
   no comments, write "none". This is the same evidence discipline as the
   acceptance-criteria checklist in Step 6.
8. **Pattern signal.** If you decline three or more comments of the same
   category on one PR (e.g. speculative null-guards, invented API
   suggestions), note it under "## Out of scope / follow-ups" — repeated
   noise from the same rule is a tuning signal, not a per-PR problem.

Only after Step 7 is green AND Step 8 is complete does the PR go to
squash-merge.

## Gotchas (all hit in a real container run)

- **jsconfig.json only typechecks `lib/`, `scripts/`, `hooks/`, `test/`** —
  but eslint lints every `.mjs` in the repo (only node_modules/coverage
  ignored), with security plugins at `--max-warnings 0`. New `.mjs` files
  outside the four typechecked dirs still must be lint-clean.
- **The memory-path guard scans every `.md`/`.mjs`/`.json` outside `test/`**
  (lib/memory/paths.mjs → SCAN_EXCLUDED_DIRS). Mentioning a memory file by
  its bare name in ANY doc or comment fails CI — always write the
  canonical `.devmate/` path.
- **`gen-current-behavior` mutates the working tree** — by design: if
  `current-behavior-diff` then fails, commit the regenerated
  docs/CURRENT_BEHAVIOR.md (never hand-edit it).
- **npm 12 rewrites package-lock.json on `npm install`** (lockfile format
  churn, ~24 lines). If you didn't change dependencies, restore it before
  committing: `git checkout -- package-lock.json`.
- **Windows/macOS run hooks-smoke in CI but not here.** Path-separator or
  `file://` bugs pass the local driver and fail CI.
- **Lint/type fixes that are acceptable:** remove dead imports/variables
  (or prefix intentionally-unused args with `_`); narrow
  possibly-null values with a guard — never loosen strict mode, never
  disable a rule.

## Troubleshooting (errors actually hit)

- **4 tests fail with `1 !== 0` in test/hooks/approval-listener.anchor.test.mjs,
  and ~51 tests report skipped** → you are on Node < 24. The real cause
  hides in the captured stderr: `devmate-mjs requires Node 24 or newer.` —
  spawned hook entrypoints exit(1) at `assertNodeVersion(24)` before
  emitting their JSON. Install Node 24 (Prerequisites) and re-run;
  expected on Node 24: 2253+ pass / 0 fail / 1 skipped.
- **`memory-path-refs` or `file-budgets` step fails and you didn't touch
  those files** → pre-existing red on `main` (see Baseline). Not yours to
  fix unless the issue says so.

## Test

The plain test suite alone (fast iteration): `node --test` — ~20s, 2253
pass. One file: `node --test test/lib/orchestrator/fanout.test.mjs`.
