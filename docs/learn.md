# Learn: Help vs Pattern Authoring (E5-6)

`/devmate-learn` used to mean two contradictory things: a read-only help mode
AND a path that writes recognized patterns. Writing needs edit rights; a
read-only agent silently failed. E5-6 splits them.

## Two routes

| Route | What it does | Writes files? |
|---|---|---|
| `help` | Explains how devmate works (gates, lanes, commands) | No |
| `pattern-authoring` | Stages, approves, and writes a pattern to `.devmate/patterns/` | Yes — gated |

Routing is a simple, NLP-free substring check (`routeLearnCommand`):

- Routes to `pattern-authoring` if the input contains any of:
  `author pattern`, `create pattern`, `add pattern`, `write pattern`,
  `update pattern`, `approve pattern` (case-insensitive).
- Everything else → `help`.

The `scripts/learn-router.mjs` entrypoint prints `{ route }` only. It never
writes files — the calling agent uses the route to pick the right sub-agent.

## Pattern authoring flow (stage → approve → write)

A write can NEVER happen without a prior approval. Three steps:

1. **Stage** — the pattern-author agent writes a pending pattern JSON to a
   pending directory (`<patternId>.pending.json`).
2. **Approve** — the user says `approve pattern: <id>`. `approvePattern()`
   validates the phrase prefix, confirms the pending file exists, and appends
   the approval to a sidecar `<patternId>.approvals.json`.
3. **Write** — `writePattern(pattern, approvals)`:
   - Verifies `filePath` resolves **under `.devmate/patterns/`** — throws
     `Pattern path must be under .devmate/patterns/` otherwise.
   - Calls `validatePatternApproval` — throws if no matching approval.
   - Writes atomically (tmp + rename).

## Safety guarantees

- Help mode never triggers a file write.
- `writePattern` throws on any path outside `.devmate/patterns/` (path-escape safe).
- `writePattern` throws when no approval with `approvedBy` starting
  `approve pattern:` matches the pattern ID.

## Anti-hallucination note

The spec referenced a read-only `agents/devmate-learn.agent.md`. That
file does not exist in this codebase, so no agent was "fixed" — instead the
read/write split is enforced in code (routing + a gated writer). Custom agent
files, when added, must live at `agents/*.agent.md` per the
[VS Code custom agents docs](https://code.visualstudio.com/docs/copilot/customization/custom-agents).

## Source

- `lib/workflow/learn.mjs` — `routeLearnCommand`, `isPatternAuthoringRequest`, `validatePatternApproval`, `PATTERN_APPROVAL_PREFIX`.
- `lib/workflow/pattern-author.mjs` — `writePattern`, `approvePattern`, `listPendingPatterns`, `PATTERNS_DIR`.
- `scripts/learn-router.mjs` — routing entrypoint.
- `lib/types.mjs` — `LearnRoute`, `Pattern`, `PatternApproval` typedefs.
