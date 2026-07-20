# State management — versioned, atomic task-state mutations

Authoritative for **how `task.json` is mutated safely**. Companion to
[gates.md](./gates.md) (which owns gate *names* and legal transitions); this doc
owns the *persistence mechanics* underneath a transition.

## What

Devmate keeps one mutable workflow state per task in
`.devmate/state/task.json` ([lib/task-state.mjs](../lib/task-state.mjs), typedef
`TaskState` in [lib/types.mjs](../lib/types.mjs)). Multiple hooks fire on a
single tool call, and VS Code runs forked/parallel sessions, so two writers can
race on that one file. Three mechanisms keep the state consistent:

1. **`stateVersion`** — a monotonic optimistic-concurrency token on `TaskState`.
   Absent on legacy/bootstrap state (read as `0`); bumped by exactly `+1` on
   every write committed through the mutation API.
2. **The canonical mutation API** — `mutateTaskStateUnderLock` (and the
   snapshot-CAS wrapper `mutateTaskStateWithRetry`). All read-modify-writes go
   through it; direct `writeTaskState` is reserved for blind bootstrap and
   single-writer computed transitions.
3. **The transition log** — an append-only per-task audit trail
   (`.devmate/state/transitions/<taskId>.jsonl`,
   [lib/state-transition-log.mjs](../lib/state-transition-log.mjs)) recording the
   `fromVersion → toVersion` and `fromGate → toGate` of every committed write.

## Why

The pre-existing failure was a **lost update**: `readTaskState` took no lock, a
writer computed a new state from that snapshot, and `writeTaskState` locked only
the final rename. Two hooks could read the same state and silently overwrite one
another — a gate advance erasing another hook's counter, hash, or guard update.
`mutateTaskStateUnderLock` (#175) closed the window for callers that use it by
reading the fresh state *inside* the lock; #112 adds the version token, the
deterministic stale-write refusal, the audit trail, and a CI guard that keeps new
writers on the API.

## How

### `mutateTaskStateUnderLock(mutate, statePath?, opts?)`

Serializes read → mutate → write under one lock. The `mutate` callback receives
the **fresh in-lock state** and returns the next state, or `null` to skip the
write. On commit, the version is stamped here (`fresh + 1`) — a mutator cannot
set or forget it — and a transition record is appended (best-effort; a log
failure never fails the write). Non-throwing: a missing/corrupt state, an invalid
mutator result, a stale-version conflict, or a lock failure is reported in the
returned `MutateResult`, never thrown.

Pin `opts.expectedVersion` for a compare-and-set: if the fresh in-lock version
differs, the call returns `{ ok: false, conflict: true, currentVersion,
expectedVersion }` and writes nothing — a stale writer cannot clobber newer
state. Because the mutator already reads fresh, the pin is only needed when the
candidate was computed from a snapshot taken *before* the lock.

### `mutateTaskStateWithRetry(produce, statePath?, opts?)`

The snapshot-CAS loop for that last case: read a snapshot + version, run
`produce(state, version)` to build a candidate *outside* the lock, then commit it
only if the version is unchanged. On a conflict `produce` re-runs against the
fresher snapshot, bounded by `opts.attempts` (default 3) — after which the last
conflict is returned rather than looping forever.

### The writer guard

`mutateTaskStateUnderLock` is the canonical way to change `task.json`. Every
direct `writeTaskState(` caller under `lib/`, `scripts/`, `hooks/` must be a
justified exception in [docs/state-writer-allowlist.json](./state-writer-allowlist.json).
`scripts/check-state-writers.mjs` (in `npm run verify`) fails on any **new
unlisted** caller and on any **stale** entry that no longer calls it — so the
registry shrinks as writers migrate to the API.

The allowlist is now hooks-free: it records only genuine
bootstrap/computed-transition single-writers (which never do a snapshot-merge).
Every read-modify-write hook goes through the versioned API — the interleaved
hooks in #189, and the two async-transition writers (gate-advance's lane walk,
approval-listener's APPROVE_PLAN) in #198 via a bounded compare-and-set loop
(read snapshot + version → compute the async transition → commit with
`expectedVersion`, retrying on conflict) since their write follows an async
projection that cannot run in the sync mutator.

### The lock underneath (stale-lock reclamation)

All of the above runs under one exclusive file lock ([lib/file-lock.mjs](../lib/file-lock.mjs), O_EXCL create). #114: a lock left behind by a process that died mid-hold no longer wedges every future write. While waiting, a held lock is reclaimed only when BOTH hold — its recorded owner is dead (a `process.kill(pid, 0)` liveness probe; a non-PID owner is treated as alive) AND it is older than `staleReclaimMs` (default 30s). A live owner's lock is never reclaimed, and a timeout names the owner and the manual-recovery action.

#193 hardens the liveness probe against **PID recycling**. `process.kill(pid, 0)` only tests that *some* process holds that PID — if the original owner died and the OS reassigned its PID to an unrelated live process, the probe falsely reports "alive" and the orphan never reclaims (re-wedging exactly as before #114). Each lock therefore also records a **boot-session token** — the host boot epoch derived from `os.uptime()` (cross-platform; injectable via `startTokenOf`). At reclaim, an owner the probe calls alive but whose boot token differs from the current one (beyond a small jitter tolerance) is a different boot's process that recycled the PID, so the orphan is reclaimed. Every uncertain case — a non-PID owner, a legacy lock with no token, or tokens within tolerance — is treated as the same boot and left untouched (**fail-closed**: PID recycling only ever causes a false *alive*, never a false *dead*, so a genuinely-held lock is never wrongly stolen).

#206 makes the token **suspend-stable** where possible. The `os.uptime()`-derived epoch shifts across a suspend/resume or a large NTP step with no reboot, which the #193 review noted could in theory false-reclaim a lock held past the age bound. The token is now **scheme-tagged** and prefers the Linux per-boot UUID (`/proc/sys/kernel/random/boot_id`, stable across suspend): `bootid:<uuid>` compares by exact equality (a different UUID means a real reboot), while `epoch:<seconds>` remains the macOS/Windows/unreadable-`boot_id` fallback with the jitter tolerance. Tokens are only ever compared **like-with-like** — a scheme mismatch is fail-closed — and a bare `<seconds>` token written by #193 is still read as an epoch, so old locks keep working.

### Corrupt-state recovery (`reset task`)

A `task.json` that is malformed or hand-edited into an illegal (lane, gate) pair is **corrupt**. The default (#171) is to SURFACE it, untouched: the `<devmate-state>` anchor renders `state: unreadable` with the validation diagnostic verbatim, because a hand-edit is often recoverable and devmate must not silently discard a task. It is never auto-quarantined.

#191 adds the explicit opt-in recovery the anchor now names: the human replies `reset task`, and `recoverCorruptState` ([lib/workflow/bootstrap-task-state.mjs](../lib/workflow/bootstrap-task-state.mjs)) moves the corrupt file aside to a `task.json.corrupt-<ts>` sidecar (preserved for diagnosis, never deleted) and bootstraps a fresh `no-lane` task in its place. It fires ONLY on genuine corruption (`isStateCorrupt` in [lib/task-state.mjs](../lib/task-state.mjs)); a valid, absent, or merely-**unreadable** (EACCES/EISDIR — might be live) state is refused untouched, so `reset task` can never discard a healthy task. `bootstrapTaskState` itself is unchanged — the surface-vs-quarantine split lives entirely in the explicit phrase.

## Evidence

- Version + CAS + transition emission: [lib/task-state.mjs](../lib/task-state.mjs) (`mutateTaskStateUnderLock`, `mutateTaskStateWithRetry`, `stateVersionOf`).
- Transition record shape: `StateTransitionRecord` in [lib/types.mjs](../lib/types.mjs).
- Guard: [scripts/check-state-writers.mjs](../scripts/check-state-writers.mjs) + [lib/state-writer-lint.mjs](../lib/state-writer-lint.mjs).
