# Rollback (E5-7)

Rollback is destructive: it runs `git reset --hard` and `git stash pop`. To make
it safe, devmate ships a single scripted, confirmation-gated entry point.

## The one rule

`scripts/rollback.mjs` is the ONLY way to roll back. Never paste
`git reset --hard` / `git stash pop` into agent prose — prose has no
confirmation, no dry-run, and no dirty-tree check.

## How it works

1. **Build the plan** (`buildRollbackPlan`) — read-only. Reads
   `state.preImplStash` (the stash ref), validates the stash, checks for a dirty
   tree, and resolves the reset target commit. Runs no mutating git.
2. **Show the dry summary** — the script always prints the plan first.
3. **Confirm** — a live run requires `--confirm`. Without it, the script exits 1
   with an actionable message and changes nothing.
4. **Apply** (`applyRollback`) — only with `confirmed: true`. Aborts before any
   mutation if the tree is dirty or the stash is missing, returning recovery
   hints instead of throwing.

## Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print the plan; run no git mutations. Wins over `--confirm`. |
| `--confirm` | Required for a live, destructive run. |
| `--state-file <path>` | TaskState JSON (defaults to the standard state path). |

## Safety guarantees (tested)

- No destructive git runs without `confirmed: true`.
- `--dry-run` runs zero git mutations.
- Dirty working tree aborts before any mutation; recovery hints returned.
- Missing stash returns a failure with hints — never an unhandled exception.
- All git calls use `spawn` with argv arrays (via the shared `runCommand`), never a shell string.

## Anti-hallucination note

The live `TaskState.preImplStash` is a single nullable string (the stash ref),
not a `{ref, commit}` pair. The reset target is derived deterministically as the
stash's base commit (`git rev-parse <stashRef>^1`) at plan-build time. No new
state fields were invented.

## Example

```
# See the plan, change nothing:
node scripts/rollback.mjs --dry-run

# Actually roll back:
node scripts/rollback.mjs --confirm
```

## Source

- `lib/workflow/rollback.mjs` — `buildRollbackPlan`, `validateStash`, `checkDirtyState`, `applyRollback`, `RECOVERY_HINTS`.
- `scripts/rollback.mjs` — CLI entrypoint.
- `lib/types.mjs` — `RollbackPlan`, `RollbackResult` typedefs.
