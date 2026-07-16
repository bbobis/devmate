# Discovery Scan — Documentation

`lib/discovery/scan.mjs` + `scripts/discovery-scan.mjs` implement Phase 1 of
the fan-out/fan-in discovery design: a deterministic, multi-strategy
candidate-file scan that runs in **parallel** via `lib/orchestrator/fanout.mjs`
(see [docs/parallel-dispatch.md](./parallel-dispatch.md) for the fan-out/fan-in
mechanism) and emits a ranked, pointer-only candidate list at **zero LLM
token cost** (FO-3, #22 — the first product wiring of `fanout.mjs`).

---

## Why

Code lookup is the long pole of implementation sessions, and most of the
latency is not comprehension — it is **candidate generation**: an agent
serially trying search strings turn by turn. Candidate generation does not
need a model. It is four independent, mechanical strategies that a computer
can run in parallel in seconds.

## The four strategies

Each strategy is a `FanoutWorker` thunk — `(signal) => Promise<WorkerReturn>`
— dispatched together via `fanout()`:

| `workerId`             | What it does                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `scan-by-name`          | Case-insensitive substring + kebab/camel-flattened match of `seedTerms` against file basenames.        |
| `scan-by-content`       | `git grep -nI --max-count=50` per chunked term set; falls back to a pure-Node line scan (skipping binary/oversized files) when `repoRoot` is not a usable git worktree. |
| `scan-by-imports`       | Depth-1 ESM import-graph neighbors: parses `import … from '…'`/`export … from '…'`/`import('…')` specifiers from the seed files (forward edges) and greps other files for imports of the seed's basename (reverse edges). |
| `scan-by-test-mirror`   | Applies the repo convention "tests mirror source paths" bidirectionally (`lib/x/y.mjs` ↔ `test/lib/x/y.test.mjs`), keeping only mirrors that exist on disk. |

Every worker returns a contract-compliant `WorkerReturn`
([`lib/context/worker-contract.mjs`](../lib/context/worker-contract.mjs)):
`workerId` is the literal strategy name, `tokenNotes` is always
`'deterministic scan — 0 LLM tokens'`, `artifactWritten` is always `null`
(only the CLI script writes the merged artifact), and `debugMode`/
`rawTranscriptPath` are always `false`/`null`. The actual candidate arrays
never travel through `finding` (capped at 500 chars, TCM-10) — each worker
pushes its raw candidates into a `Map<workerId, RawCandidate[]>` side channel
owned by the `lib` layer's closure; `runDiscoveryScan` reads that map only
for workers `fanout()` reports as succeeded, so a timed-out or
contract-violating worker's partial candidates are never merged.

## Merge scoring

`mergeCandidates(perStrategyCandidates, { maxSources, repoRoot, seedFiles })`
is pure and exported. It:

1. Normalizes every candidate path to a repo-relative POSIX-style path via a
   manual, OS-independent path resolver (handles literal `\` separators
   regardless of host OS) and drops any path that would escape `repoRoot`
   (fail-closed, mirroring the worker-contract's own traversal guard) —
   **silently, never as a false positive**, but always counted in `dropped`.
2. Unions candidates by normalized path across strategies.
3. Scores each: `strategies.length * 10 + min(hits, 20) + (seedProximity ? 5 : 0)`,
   where `seedProximity` is true when the candidate shares a directory with
   any `seedFile`. This is a documented heuristic, not an ML/embedding
   ranking (the fan-out/fan-in design is explicitly zero-dep).
4. Sorts by score descending, then path ascending (stable, reviewable order).
5. Caps at `maxSources`, reporting `dropped` — **no silent caps**.

## Running it

```bash
node scripts/discovery-scan.mjs --terms "gate,guard" \
  [--seed-files "lib/a.mjs,lib/b.mjs"] [--budget-class standard] \
  [--max-sources 10] [--min-success-rate 0.5] \
  [--out .devmate/state/discovery-candidates.json] \
  [--repo-root .]
```

`--max-sources` defaults to the budget-class cap (`tiny`=3, `standard`=10,
`large`=999 — unbounded, a `ContextReducer` is required upstream for
`large`; see [`lib/context/output-contract.mjs`](../lib/context/output-contract.mjs))
and must be a non-negative integer — an invalid value is a config error
(exit 1), never silently coerced. `--min-success-rate` (default `0.5` — at
least 2 of 4 strategies must land) is forwarded to `fanout()` and must be a
number between 0 and 1. Per-strategy `timeoutMs` (library-only, not yet a
CLI flag) defaults to `10_000` (scan workers are cheap; this is not the 30s
LLM default) and must be positive when set programmatically.

The script writes the merged artifact **atomically** (tmp + rename,
mirroring `persistBudget` in `lib/context/output-contract.mjs`):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-10T21:23:14.737Z",
  "seedTerms": ["gate", "guard"],
  "candidates": [
    { "path": "lib/gate-guard-core.mjs", "score": 50, "strategies": ["scan-by-content", "scan-by-name"], "hits": 41, "why": "name match: gate-guard-core.mjs" }
  ],
  "dropped": 341,
  "insufficient": false,
  "violations": []
}
```

Stdout is a ≤10-line digest (counts, top 5 candidates, artifact path). Exit
`0` on a completed scan — **including `insufficient: true`**: the caller
branches on the artifact's fields, not on this process's exit code. Exit `1`
only on config/IO errors (missing `--terms`, unwritable `--out`), with a
one-line stderr reason.

## Kill-resistance

Each worker races against the shared `timeoutMs` inside `fanout()`
independently; a hung `scan-by-content` invocation (e.g. a slow `git grep` on
a huge repo) is aborted via the per-worker `AbortSignal` passed straight
through to `execFile(..., { signal })`, so the OS-level process is actually
killed. The other three strategies still complete and the batch as a whole
returns — see `runDiscoveryScan › a hung strategy is aborted at timeoutMs and
the batch still completes` in
[`test/lib/discovery/scan.test.mjs`](../test/lib/discovery/scan.test.mjs).

## Consumption (FO-5)

Since FO-5, Feature Lane Step 2 invokes this scan as Phase 1 of the two-phase
discovery fan-out: the orchestrator branches on the artifact's
`insufficient`/candidate-count fields, partitions the candidates with
`partitionCandidates` (`lib/discovery/partition.mjs`), and dispatches scoped
`@discovery` workers whose artifacts `scripts/merge-discovery.mjs` fans back
in — see [parallel-dispatch.md](./parallel-dispatch.md) and
[discovery-merge.md](./discovery-merge.md).

## Out of scope (deferred)

- **Caching/memory** (FO-6).
- **Import-graph depth > 1** and **semantic/embedding ranking** (the fan-out/
  fan-in design is explicitly zero-dependency).

---

_Built in FO-3 (#22), wiring `lib/orchestrator/fanout.mjs` (FO-2) into the
product for the first time. See [PATTERNS.md#p23](./PATTERNS.md) and
[parallel-dispatch.md](./parallel-dispatch.md)._
