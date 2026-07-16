# AGENTS.md — rules for coding agents working on this repo

Always-on context for any AI coding agent (Copilot, Claude Code, Codex, Gemini
CLI, ...) contributing to devmate. This file stays small by design — depth
lives in the linked docs. The source of truth for engineering conventions is
[CONTRIBUTING.md](./CONTRIBUTING.md); if the two disagree, CONTRIBUTING.md wins.

## What this project is

devmate is a VS Code GitHub Copilot / Claude plugin that turns ad-hoc AI
coding into a deterministic, stage-gated, resumable workflow. The core
differentiator is **token & context management** — keep it central to every change.

## Stack

- Node 24+, ESM `.mjs` only. No CommonJS, no TypeScript sources, no `.ps1`.
- Types via `// @ts-check` + JSDoc on every file; shared typedefs in `lib/types.mjs`.
- Zero runtime dependencies by design — Node built-ins first; dev tooling only.
- Tests: `node:test` + `node:assert/strict` under `test/`, mirroring source paths.

## Hard rules

1. `npm run verify` must pass before every push — it is exactly what CI runs.
2. Pure logic lives in `lib/`; `scripts/` and `hooks/` are thin I/O wrappers.
   Executable scripts use the guarded entrypoint pattern and assert Node 24.
3. Cap tool output at the boundary — return a digest plus a path to the full
   output, never full logs.
4. Pointers, not payloads — pass file paths and line ranges, not pasted contents.
5. Fail closed — guards deny on uncertainty; prefer result objects over throwing
   across module boundaries.
6. Tests write only to temp dirs, never into the repo tree.
7. Never hand-edit generated doc blocks — edit the source registry and
   regenerate via the generator scripts in `scripts/`.
8. Cross-platform always (Linux, macOS, Windows) — no POSIX-only paths or shells.
9. In CHANGELOG.md, keep unverified identifiers out of backticks — the
   docs-drift guard scans backticked identifiers against ground truth.

## Workflow

- One issue per PR; branch off main; Conventional Commits
  (`type(scope): summary`); squash-merge — never direct-to-main.
- Update docs, CHANGELOG, and metadata (capability registry, file budgets) in
  the same PR as the code — CI drift guards enforce that docs match runtime.

## Where the depth lives

- [CONTRIBUTING.md](./CONTRIBUTING.md) — full engineering conventions (source of truth)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — component architecture
- [docs/AGENTS.md](./docs/AGENTS.md) — the *runtime* agent roster (a different file than this one)
- [docs/PATTERNS.md](./docs/PATTERNS.md) — the token/context-management rules and
  workflow patterns, each with an honest enforcement label
- [docs/SYSTEM_OVERVIEW.md](./docs/SYSTEM_OVERVIEW.md) — how the pieces work together
