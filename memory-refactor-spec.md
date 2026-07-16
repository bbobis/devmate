# Memory System Refactor — End-to-End Fix

> **Background:** Consumer agents reported that `.devmate/MEMORY.md` is always empty and never populated. A full audit confirmed the pipeline is broken at multiple layers. This issue tracks the complete refactor, test plan, and documentation changes required to make the memory system work reliably.

---

## Root Cause Summary

The memory pipeline has **8 bugs** that together cause silent, complete failure:

| # | Bug | Location |
|---|---|---|
| 1 | **Path mismatch** — hook writes to `state/facts.jsonl`, complete-task reads from `memory/tasks/<taskId>.jsonl` | `hooks/post-tool-use.mjs` ↔ `scripts/complete-task.mjs` |
| 2 | **No renderer** — nothing converts `repo.jsonl` into `.devmate/MEMORY.md` | *(missing module)* |
| 3 | **`memory/tasks/` not in layout** — directory never created at init | `lib/init/layout.mjs` |
| 4 | **No task-scoped ledger writer** — `writeFact()` receives global path, not task path | `hooks/post-tool-use.mjs` |
| 5 | **No `.devmate/MEMORY.md` renderer** — even if promoted, nothing renders markdown | *(missing module)* |
| 6 | **PreCompact blind spot** — `renderMemory()` only reads `repo.jsonl`; mid-task facts not promoted yet | `scripts/compact-session.mjs` |
| 7 | **Conflict identity too coarse** — conflicts keyed by `source` only; two facts for same file stale each other | `lib/memory/promote.mjs` |
| 8 | **No `taskId` validation** — malformed `taskId` silently constructs wrong filesystem path | `hooks/post-tool-use.mjs` |

The pipeline silently succeeds while doing nothing. No errors are thrown. `.devmate/MEMORY.md` is never written.

---

## Corrected Pipeline Design

```
┌──────────────────────────────────────────────────────────────────┐
│  PostToolUse hook fires on every EDIT_CLASS_TOOL call            │
│  hooks/post-tool-use.mjs                                         │
│                                                                   │
│  → validateTaskId(taskId)         ← NEW: slug guard             │
│  → taskLedgerPath(repoRoot, taskId) ← NEW: central path helper  │
│  → writeFact(payload, taskLedgerPath, { workspaceRoot })         │
└─────────────────────────────┬────────────────────────────────────┘
                              │  per-task staging ledger
                              ▼
                    .devmate/memory/tasks/<taskId>.jsonl

┌──────────────────────────────────────────────────────────────────┐
│  scripts/complete-task.mjs  (called at task completion)          │
│                                                                   │
│  → promoteLedger(taskLedgerPath, repoLedgerPath, { taskId })     │
│  → renderMemory(repoLedgerPath, MEMORY_PATH)   ← NEW STEP        │
└─────────────────────────────┬────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  scripts/compact-session.mjs  (PreCompact hook)                  │
│                                                                   │
│  [AMENDED] → promoteLedger(taskLedgerPath, repoLedgerPath)       │
│             → renderMemory(repoLedgerPath, MEMORY_PATH)          │
└─────────────────────────────┬────────────────────────────────────┘
                              │  rendered output
                              ▼
                    .devmate/MEMORY.md  ← committed by consumer
```

---

## Work Items

### WI-0 — Build `lib/memory/paths.mjs` — Central Path Registry

**Why:** The entire refactor exists because paths drifted apart across multiple files. A single path helper eliminates this class of bug permanently.

**New file:** `lib/memory/paths.mjs`

```js
export const TASK_LEDGER_DIR = '.devmate/memory/tasks';
export const REPO_LEDGER_REL = '.devmate/state/repo/repo.jsonl';
export const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateTaskId(taskId) { /* throws TypeError on invalid */ }
export function taskLedgerPath(repoRoot, taskId) { /* validates + constructs */ }
export function repoLedgerPath(repoRoot) { /* constructs */ }
export function memoryMdPath(repoRoot) { /* constructs */ }
```

- `taskLedgerPath()` calls `validateTaskId()` before constructing the path — throws `TypeError` on invalid input (fail-closed, P3)
- Every other WI imports from this module; **no other file constructs memory paths directly**

---

### WI-1 — `validateTaskId()` in `lib/memory/paths.mjs`

**Why:** `TaskState.taskId` is typed as a plain `string` with no format constraint. A malformed `taskId` (containing `/`, `..`, spaces, shell-unsafe chars) silently builds a wrong path or allows path traversal.

**Spec:**

```js
export const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0)
    throw new TypeError(`taskId must be a non-empty string; got ${JSON.stringify(taskId)}`);
  if (!TASK_ID_RE.test(taskId))
    throw new TypeError(`taskId must match ${TASK_ID_RE}; got ${JSON.stringify(taskId)}`);
}
```

**Decision:** Invalid `taskId` is a **hard error (exit 1)**, not a silent skip. An agent running with no valid `taskId` **while a task.json exists** is misbehavior, not an expected edge case (P3 fail-closed). A *missing* `.devmate/state/task.json` is different (HITL-3): that is the legitimate pre-task window (chat, help, the discovery→grill→planning analysis phase, before `scripts/init-task-state.mjs` runs), so the hook skips quietly — one memory.skip / pre_task stderr line, exit 0. The fail-closed safety for ungoverned work no longer depends on this hook being loud: an implementation dispatch with no task.json is DENIED structurally by the dispatch gate (HITL-1, `lib/workflow/dispatch-gate.mjs`).

---

### WI-2 — Fix `hooks/post-tool-use.mjs`: Task-Scoped Ledger Path

**Why:** The hook hardcodes `DEFAULT_LEDGER_REL = '.devmate/state/facts.jsonl'` and never reads `taskId` from `TaskState`. This is Bug 1 + Bug 4.

**Changes:**
1. Remove `DEFAULT_LEDGER_REL` constant entirely
2. In `runWithIO()`, read `TaskState` via `readTaskState()` to get `taskId`
3. If `readTaskState()` returns `ok: false`, discriminate (HITL-3, same not-found prefix check as `hooks/subagent-budget-guard.mjs`): file **missing** → structured skip `{ event: 'memory.skip', reason: 'pre_task' }` to stderr, **exit 0** (legitimate pre-task window); file exists but is **unreadable** (malformed JSON / schema-invalid) → structured error `{ event: 'memory.error', reason: 'state_unreadable' }` to stderr, **exit 1**
4. Call `validateTaskId(taskId)` (from WI-1)
5. Resolve ledger path via `taskLedgerPath(workspaceRoot, taskId)` (from WI-0)
6. Pass resolved path to `writeFact(payload, resolvedPath, { workspaceRoot })`
7. Repoint `loadFilesChangedFromLedger()` to use the task-scoped path instead of the old global path

**Pattern compliance:** P3 (fail-closed), TCM-9 (structured stderr only)

---

### WI-3 — Add `key` Field to `FactEntry` and Fix Conflict Identity in `promote.mjs`

**Why:** `promote.mjs` resolves conflicts keyed by `source` (file path) only. Two unrelated facts about the same file (e.g. "uses JWT RS256" and "refresh token in HttpOnly cookie" for `auth.mjs`) cause the second to stale the first — silent data loss. This is Bug 7.

**Changes to `lib/types.mjs`:**

Add to `FactEntry` typedef:
```js
* @property {string} key  Stable per-fact identity: `source + ':' + contentDigest.slice(0,8)`.
*                         Two facts with different keys for the same source are independent.
```

**Changes to `lib/memory/fact-writer.mjs`:**

Derive `key` when building the fact entry:
```js
key: digest ? `${canon}:${digest.slice(0, 8)}` : `${canon}:${ts}`,
```

**Changes to `lib/memory/promote.mjs`:**

- Replace `Map<source, FactEntry>` with `Map<key, FactEntry>` for conflict lookup
- Rename `factSource()` → `factKey()` that reads `fact.key` with fallback to `fact.source` for legacy ledger entries

---

### WI-4 — Add `memory/tasks/` to Layout and Gitignore

**Why:** `.devmate/memory/tasks/` is not created at init time and is not gitignored. This is Bug 3.

**Changes to `lib/init/layout.mjs`:**
- Add `.devmate/memory/tasks` to `STATE_DIRS`

**Changes to `.devmate/.gitignore`:**
```gitignore
state/
session/
memory/tasks/

# Files to track:
!.devmate/MEMORY.md
!devmate.config.json
```

Keep the existing `!.devmate/MEMORY.md` allowlist entry in `devmate-init.mjs` as-is.

**Pattern compliance:** P2 — layout is the single source of truth for directory structure.

---

### WI-5 — Fix `scripts/complete-task.mjs`: Use `lib/memory/paths.mjs`

**Why:** `complete-task.mjs` passes wrong paths to `promoteLedger()`. This is Bug 1.

**Changes:**
- Import `taskLedgerPath`, `repoLedgerPath` from `lib/memory/paths.mjs`
- Read `taskId` from `TaskState`
- If task ledger does not exist → skip promotion, log `memory.promote.skipped` reason: `no_task_ledger`

---

### WI-6 — Build `lib/memory/render-memory.mjs` (New Module)

**Why:** There is no module that converts the JSONL ledger into `.devmate/MEMORY.md`. This is Bug 2 + Bug 5.

**New file:** `lib/memory/render-memory.mjs`

```js
/**
 * @param {string} repoLedgerPath   Path to .devmate/state/repo/repo.jsonl
 * @param {string} memoryPath       Absolute path to .devmate/MEMORY.md
 * @returns {Promise<RenderResult>}
 */
export async function renderMemory(repoLedgerPath, memoryPath)
```

**Behavior:**
1. Read all entries from `repo.jsonl`. Skip staled facts using `collectActiveFacts()` (same logic as `promote.mjs`)
2. Group active facts by `source` (file path)
3. Render each group as a markdown section:
   ```markdown
   ## src/lib/auth.mjs
   - Uses JWT with RS256. Added 2026-06-15. (task: feat-auth-revamp)
   - Refresh token stored in HttpOnly cookie only.
   ```
4. Read existing `.devmate/MEMORY.md`. Preserve the header stub (everything up to and including the first blank line after the `>` blockquote). Replace everything below with freshly rendered sections
5. Write atomically (`.devmate/MEMORY.md.tmp` → rename, same pattern as `promote.mjs`)
6. Return `{ ok: true, factsRendered: N, memoryPath }` or `{ ok: false, error: string }`

**Pattern compliance:** TCM-8 (pointers not history), TCM-12 (generated from live source), P2 (atomic write)

---

### WI-7 — Wire `renderMemory` into `complete-task.mjs`

After `promoteLedger()` returns `{ ok: true }`:

```js
import { renderMemory } from '../lib/memory/render-memory.mjs';
import { memoryMdPath } from '../lib/memory/paths.mjs';

const renderResult = await renderMemory(repoLedgerPath(repoRoot), memoryMdPath(repoRoot));
if (!renderResult.ok) {
  process.stderr.write(`memory render failed: ${renderResult.error}\n`);
  // non-fatal: facts are safely in repo.jsonl
}
```

Emit trace event `memory.rendered` with `{ factsRendered, memoryPath }` on success.

**Pattern compliance:** TCM-11 (budget observable), P4 (render failure non-fatal — facts preserved in repo.jsonl)

---

### WI-8 — Fix `scripts/compact-session.mjs`: Promote Before Render

**Why:** The PreCompact hook must promote mid-task facts before rendering. Without this, any facts written during a long-running task are invisible to `renderMemory()` because they haven't been promoted yet — they only exist in `.devmate/memory/tasks/<taskId>.jsonl`. This is Bug 6.

**Changes to `scripts/compact-session.mjs`:**

```js
// Step 1: Promote active task ledger (if any) so facts land in repo.jsonl
const taskId = readActiveTaskId(); // from TaskState
if (taskId) {
  const promoted = await promoteLedger(
    taskLedgerPath(repoRoot, taskId),
    repoLedgerPath(repoRoot),
    { taskId, conflictPolicy: 'keep-incoming' }
  );
  if (!promoted.ok) {
    process.stderr.write(`compact: promote failed (non-fatal): ${promoted.error}\n`);
    // non-fatal: render proceeds with current repo.jsonl
  }
}

// Step 2: Render from complete repo ledger (now includes mid-task facts)
const renderResult = await renderMemory(repoLedgerPath(repoRoot), memoryMdPath(repoRoot));
```

**Pattern compliance:** TCM-7 (compaction preserves recall), P2 (explicit staged transitions)

---

## Test Plan

All tests follow the existing Vitest pattern (`test/*.test.mjs`, `test/lib/*.test.mjs`).

### Suite 1 — `test/lib/memory-paths.test.mjs` *(new)*

| Test | Assertion |
|---|---|
| `taskLedgerPath(root, 'feat-auth')` | Returns `<root>/.devmate/memory/tasks/feat-auth.jsonl` |
| `repoLedgerPath(root)` | Returns `<root>/.devmate/state/repo/repo.jsonl` |
| `memoryMdPath(root)` | Returns `<root>/.devmate/MEMORY.md` |
| `validateTaskId('feat-auth-revamp')` | Does not throw |
| `validateTaskId('')` | Throws `TypeError` |
| `validateTaskId('../escape')` | Throws `TypeError` |
| `validateTaskId('Feat Auth')` | Throws `TypeError` (uppercase + space) |
| `validateTaskId('feat/nested')` | Throws `TypeError` (slash) |

### Suite 2 — `test/lib/fact-writer.test.mjs` *(new)*

| Test | Assertion |
|---|---|
| `writeFact` with task-scoped path | Creates file at given path with one JSON line |
| `writeFact` called twice | Appends second line; first line preserved |
| `writeFact` with non-existent parent dir | Parent dir created automatically |
| Written entry shape | Has `event: 'fact'`, `key: string`, `ts: number`, `tool: string`, `source: string` |
| `key` field format | Matches `<source>:<first 8 chars of digest>` when digest present |
| Two different facts same source, different digest | Both have distinct `key` values |
| Written entry has NO `content` field | Raw content is never stored (TCM-8) |

### Suite 3 — `test/lib/render-memory.test.mjs` *(new)*

| Test | Assertion |
|---|---|
| Empty `repo.jsonl` | `.devmate/MEMORY.md` retains seed header; no content sections appended |
| Two facts for same source | Renders as one section with two bullets |
| Facts for two different sources | Renders two `##` sections |
| Two facts same source, different `key` | Both bullets appear — no staling between them |
| Staled fact excluded | Staled entry not present in rendered output |
| Existing header preserved | Text above first blank line after the `>` stub is untouched |
| Atomic write | Uses `.tmp` + rename; no partial writes |
| `renderResult.factsRendered` | Equals number of active (non-staled) facts rendered |
| Idempotent: call twice with same ledger | `.devmate/MEMORY.md` content identical both times |

### Suite 4 — `test/scripts/complete-task-memory.test.mjs` *(new)*

| Test | Assertion |
|---|---|
| Full happy path | After `complete-task.mjs`, `.devmate/MEMORY.md` contains the fact written by `writeFact` |
| No task ledger | Exits 0, logs `memory.promote.skipped`, `.devmate/MEMORY.md` unchanged |
| Promotion fails (lock timeout) | Exits non-zero, `.devmate/MEMORY.md` not written, facts still in task ledger |
| Render fails after promotion | Exits 0 (non-fatal), stderr contains render error, facts are in `repo.jsonl` |
| Two tasks in sequence, different sources | Both tasks' facts appear in final `.devmate/MEMORY.md` |
| Two tasks, same source, different keys | Both facts for that source survive in final `.devmate/MEMORY.md` |
| Task ledger deleted after successful promotion | `.devmate/memory/tasks/<taskId>.jsonl` absent after exit 0 |

### Suite 5 — `test/scripts/compact-session-memory.test.mjs` *(new)*

| Test | Assertion |
|---|---|
| Mid-task facts visible after compact | Facts written during active task are in `.devmate/MEMORY.md` after `compact-session.mjs` |
| Promote step runs before render | Task ledger empty + `repo.jsonl` contains facts after compact |
| Promote fails — compact continues | Exits 0, stderr logs promote error, render runs on current `repo.jsonl` |
| No active task — promote skipped | Exits 0, no promote attempted, render runs normally |

### Suite 6 — `test/lib/layout.test.mjs` *(extend or new)*

| Test | Assertion |
|---|---|
| `STATE_DIRS` includes `.devmate/memory/tasks` | Array contains the new entry |
| `ensureDevmateLayout()` creates `memory/tasks/` | Directory exists on disk after call |
| `.devmate/.gitignore` includes `memory/tasks/` | File content contains the entry |

### Suite 7 — `test/regression/memory-pipeline.test.mjs` *(new)*

Static grep-based regression guard (same style as `test/docs-sync.test.mjs`). Runs in CI with zero runtime state.

| Test | Assertion |
|---|---|
| `DEFAULT_LEDGER_REL` absent from `post-tool-use.mjs` | Grep for `DEFAULT_LEDGER_REL` or `facts.jsonl` — must not match |
| `post-tool-use.mjs` imports from `lib/memory/paths.mjs` | Source contains `memory/paths.mjs` import |
| `complete-task.mjs` imports from `lib/memory/paths.mjs` | Source contains `memory/paths.mjs` import |
| `compact-session.mjs` imports `promoteLedger` | Source contains `promoteLedger` import |
| `compact-session.mjs` calls `renderMemory` after `promoteLedger` | Both present; `renderMemory` appears after `promoteLedger` |
| `FactEntry` typedef has `key` field | `lib/types.mjs` source contains `@property {string} key` |
| `promote.mjs` maps by `key` not `source` | Source contains `factKey` or `fact.key` usage |

---

## Documentation Changes

### `docs/ARCHITECTURE.md`

Add a new `## Memory System` section after `## Artifact and State Model`:

- **Purpose:** `.devmate/MEMORY.md` is the cross-task committed fact ledger. It is the only memory artifact consumers commit.
- **Lifecycle:** Three-stage pipeline — fact collection (PostToolUse) → promotion (complete-task) → render (`.devmate/MEMORY.md`)
- **Transient files:** Task ledger (`.devmate/memory/tasks/<taskId>.jsonl`) and repo ledger (`.devmate/state/repo/repo.jsonl`) are gitignored. Only `.devmate/MEMORY.md` is committed.
- **Conflict policy:** `keep-incoming` by default. Conflicts now keyed by `fact.key` (`source + ':' + digest prefix`), not `source` alone.
- **Compaction:** PreCompact hook promotes task ledger first, then renders (TCM-7).
- **Pattern references:** TCM-7, TCM-8, TCM-12, P2, P3, P6

Update the `.devmate/` directory tree to:
```
.devmate/
├── .devmate/MEMORY.md                 # committed; rendered from repo.jsonl
├── devmate.config.json
├── .gitignore                         # ignores state/, session/, memory/tasks/
├── state/
│   └── repo/
│       └── repo.jsonl                 # transient; promoted facts
└── memory/
    └── tasks/
        └── <taskId>.jsonl             # transient; per-task staging ledger
```

### `docs/memory.md`

Extend with:
- How `.devmate/MEMORY.md` gets populated — plain-language pipeline description
- What a fact entry looks like (sample JSON line with all fields labeled, including the new `key` field)
- What a rendered `.devmate/MEMORY.md` section looks like (example block)
- When it is written — task completion + PreCompact hook
- What is never written — raw chat history, full file contents, test output (TCM-8)
- Stale invalidation — how a later task replaces a fact for the same `key`

### `.devmate/.gitignore`

```gitignore
# Auto-generated by devmate ensureDevmateLayout.
state/
session/
memory/tasks/

# Files to track:
!.devmate/MEMORY.md
!devmate.config.json
```

---

## Delivery Order

```
WI-0 (lib/memory/paths.mjs — central registry)
  ├─► WI-1 (validateTaskId — included in WI-0)
  ├─► WI-3 (FactEntry key field + promote.mjs conflict key)
  ├─► WI-4 (layout + gitignore)
  └─► WI-2 (post-tool-use.mjs — uses paths.mjs)
        └─► WI-5 (complete-task.mjs — uses paths.mjs)
              └─► WI-6 (render-memory.mjs — new module)
                    └─► WI-7 (wire render into complete-task)
                          └─► WI-8 (compact-session: promote + render)

Tests:
  WI-0 + WI-1 → Suite 1
  WI-2 + WI-3 → Suite 2
  WI-6        → Suite 3
  WI-5 + WI-7 → Suite 4
  WI-8        → Suite 5
  WI-4        → Suite 6
  All WIs     → Suite 7 (regression guard)

Docs:
  WI-6 complete → ARCHITECTURE.md + memory.md
  WI-4 complete → .gitignore
```

---

## Pattern Compliance Gate

All work items must pass this checklist before merge:

| Pattern | Requirement | Verified by |
|---|---|---|
| **TCM-8** — pointers not history | Fact entries have `key`, `source`, `tool`, `ts`, `summary` — never raw content | Suite 2 entry shape test |
| **TCM-12** — generated docs | `.devmate/MEMORY.md` rendered from `repo.jsonl` — not manually edited | Suite 3 idempotency test |
| **TCM-9** — tool output cap | Hook emits only structured events to stderr; no raw output | Suite 7 static assertion |
| **TCM-7** — compaction preserves recall | PreCompact promotes task ledger *then* renders before context drop | WI-8 + Suite 5 |
| **TCM-11** — budget observable | `memory.rendered` trace event emitted with `factsRendered` count | Suite 4 integration test |
| **P2** — explicit state | Atomic writes, lock-guarded promotion, per-task scope, single path registry | Suite 3 atomic write test |
| **P3** — fail-closed | No `taskId` = hard error (exit 1), not silent anonymous write | Suite 4 no-task-ledger test |
| **P7** — evals as regression tests | Suite 7 static grep guards prevent path drift from returning | CI enforcement |
| **Path safety** | All paths via `lib/memory/paths.mjs` only — no local path construction | Suite 1 + Suite 7 |
| **Conflict identity** | Conflict map keyed by `fact.key`, not `source` alone | Suite 4 two-facts-same-source test |
| **taskId validation** | `validateTaskId()` called before any path construction; invalid IDs are loud errors | Suite 1 validation tests |
