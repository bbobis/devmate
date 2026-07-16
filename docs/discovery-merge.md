# Discovery Artifact Merge (Fan-In) — Documentation

`mergeDiscoveryArtifacts` (`lib/workflow/agents/discovery.mjs`) is the fan-in
half of the fan-out/fan-in discovery design (FO-4): it merges the typed
discovery artifacts K parallel `@discovery` workers each return
(`{ agentName: 'discovery', claims: [...], unverified: [...] }`,
`lib/workflow/agents/discovery.mjs`) into the single artifact downstream
consumers — `@tech-design`, `@rubber-duck`, the planner — actually see. The
fan-out stays invisible to the rest of the lane.

See [discovery-scan.md](./discovery-scan.md) for FO-3, the candidate-file
scan that produces the file list a `@discovery` worker investigates, and
[parallel-dispatch.md](./parallel-dispatch.md) for the fan-out/fan-in
mechanism (`lib/orchestrator/fanout.mjs`) both build on.

## Why

"Distribute is easy, merge is hard" — running K discovery workers in
parallel is the easy half; the aggregator is the part that has to decide
which claims are duplicates, which corroborate each other, which genuinely
conflict, and what to do when there are more claims than the downstream
budget can afford. No merge utility existed in the repo before FO-4.

## The merge rules, in order

`mergeDiscoveryArtifacts(artifacts, opts)` is pure — no I/O, no randomness,
no timestamps, and input artifacts are never mutated. `opts.maxClaims` is
required (a missing or invalid value throws — a programmer error, mirroring
`fanout`'s config-error stance); `opts.nearDupThreshold` defaults to `0.8`;
`opts.workerIds` optionally labels each artifact's `sources` entry with a
worker id instead of its array index — a display label only. Corroboration
identity (the count that drives rule 4's upgrade and rule 6's ranking) is
always the artifact's own index, never this label, so a duplicate or empty
`workerIds` entry can never collapse two distinct artifacts into one
corroboration count.

1. **Path normalization.** Each claim's `path` (a repository-relative
   pointer, optionally with a line anchor — `agents/discovery.agent.md`)
   splits into `{ filePath, anchor }`. The dedup key is `filePath` plus
   *overlapping* anchors: two anchorless claims on the same file share a key;
   two anchored claims share a key only if their line ranges overlap; an
   anchored/anchorless pair on the same file shares a key only when the
   facts are near-dup (rule 3) — anchor presence alone never forces a merge.
2. **Exact dedup.** Same dedup key, and normalized facts (case-folded,
   whitespace-collapsed, trailing punctuation stripped) are identical → one
   claim. `corroboration` counts *distinct source artifacts*, not duplicate
   claims within a single artifact; the highest confidence and the union of
   sources win.
3. **Near-dup (lexical only).** Same dedup key, and the token-set Jaccard
   similarity of the normalized facts is `>= nearDupThreshold` → merge,
   keeping the **longer** fact (and its own path) as canonical. No
   embeddings — deliberately zero-dependency.
4. **Corroboration upgrades confidence.** A merged claim with
   `corroboration >= 2` and `confidence: 'low'` upgrades to `'high'` — legal
   because every claim already carries an evidence path (the existing
   validator's invariant). Never downgrades.
5. **Conflicts are surfaced, never resolved.** After rules 2-3, if a
   `filePath` still owns two or more distinct (unmerged) claims, each gets
   `needsReview: true`. No semantic contradiction detection is attempted —
   adjudicating a genuine conflict is `@rubber-duck`'s job downstream.
6. **Rank before cap.** Sort by `corroboration` desc, then confidence
   (`high` > `low`), then stable first-seen input order. Take
   `opts.maxClaims`; every overflow claim becomes an `unverified` entry
   (`"[UNVERIFIED] — dropped by merge cap: <fact> (<path>)"` — the tag stays
   the literal `[UNVERIFIED]` the existing validator requires, with the drop
   reason appended after it) and is counted in `stats.dropped`. No claim is
   ever silently discarded.
7. **Unverified union.** All inputs' `unverified` arrays concatenate,
   exact-string-deduped, preserving first-appearance order. Not capped (it
   is cheap text, not evidence-pack pointers).
8. **Never re-reads files.** The merge operates on claims exactly as given;
   pointer *resolution* stays the contract-validator hook's job at the
   artifact write boundary.

## Stats

Every merge returns `{ merged, stats }`. `stats` makes every cap and drop
visible: `inputClaims`, `mergedClaims` (post-cap), `exactDups`, `nearDups`,
`corroborated`, `needsReview` (counted per conflicting file, not per claim),
`dropped`, and `invalidInputs` (input artifacts that failed the existing
`validateDiscoveryArtifact` — skipped, never thrown, so one bad worker
cannot sink the merge).

## The CLI wrapper (FO-5)

`scripts/merge-discovery.mjs` wires I/O around the pure function: it reads
every discovery worker-return artifact (filter `agentName === 'discovery'`)
from `.devmate/state/worker-returns/`, merges with `maxClaims` taken from the
persisted output contract in `.devmate/state/task.json`
(`outputContract.max_context_sources`, fallback 10), writes
`.devmate/state/discovery-merged.json` atomically, appends a
`discovery_merge` trace event (`{inputs, merged, dropped, conflicts}`), and
prints a ≤10-line digest. The merged artifact is validated live by the
contract-validator hook (`hooks/contract-validator.mjs`), and the
`discovery-done` gate advances on it — see
[parallel-dispatch.md](./parallel-dispatch.md) for the full two-phase flow.

## Out of scope (deferred)

- **LLM-synthesis of merged claims into narrative** — reserved for
  `large`-class tasks, not part of this function.
- **Caching** (FO-6).

---

_Built in FO-4 (#21). See [PATTERNS.md#p24](./PATTERNS.md)._
