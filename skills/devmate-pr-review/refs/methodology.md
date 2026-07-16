# PR Review — methodology

The review is a deterministic gather + a judged verdict. The CLI does the
gathering; you do the judging. Never dump the raw diff back to the user, and
never approve on prose alone — every finding points at evidence.

## 1. Gather the context

Run the backing CLI:

```
node "${PLUGIN_ROOT}/scripts/pr-review.mjs" [--state-file <path>] [--base <ref>] [--include-full-output]
```

It resolves the active task, gathers the branch diff (capped at the boundary),
records the lane's planning artifacts as pointers, precomputes alignment
signals, and writes `.devmate/state/pr-review-context.json`. Read that file —
it is the single source of truth for the review. Its shape is documented in
[output-format.md](output-format.md) and `docs/pr-review.md`.

If `git.available` is `false`, there is no diff (not a git work tree). Say so
plainly and review from the artifacts only; do not fabricate a diff.

## 2. Read the capped diff, not the raw one

`git.diffCapped` is a bounded, secret-redacted preview. Use it first. Only when
the preview is truncated AND you need more to judge a specific hunk, open the
full log at `git.diffFullPath` (already on disk) — or re-run with
`--include-full-output` to embed `git.diffFull`. This is the TCM-9 discipline:
the capped preview is the default; the full diff is a deliberate, pointer-gated
escalation.

## 3. Load only the lenses you need

`context.resourceSkills` lists the resource skills to consult. Load their refs
lazily — only the ones a given diff warrants:

- alignment questions → [alignment-checklist.md](alignment-checklist.md)
- quality / design / naming / tests → [best-practices.md](best-practices.md)
- security-sensitive surface (auth, input, secrets, data) → the security lens in
  [best-practices.md](best-practices.md)

Do not read a ref you will not use — progressive disclosure keeps the review
cheap (TCM-4/5).

## 4. Map issues to severity + category

Each issue becomes one `PrReviewFinding` with:

- **category** — `alignment` (diff vs plan/scope), `quality` (design, naming,
  tests, complexity), or `security` (shift-left lens; see the boundary note in
  best-practices.md).
- **severity** — `blocker` > `high` > `medium` > `low` > `info`.
- **evidence** — a `{ path, lineRange? }` pointer into the changed code. Never
  paste the hunk; point at it.
- **finding** + **recommendation** — one sentence each.

Anything you cannot confirm from an artifact or the diff is tagged and pushed
to `unverified[]` with a leading `[UNVERIFIED]` marker — never asserted.

## 5. Decide the verdict

- **REQUEST_CHANGES:<reason>** if there is any `blocker` or `high` finding, or a
  non-empty `alignmentSignals.outOfScopeFiles`, or (bug lane)
  `regressionTestPresent === false`. The reason names the top blocker.
- **APPROVE** otherwise. `medium`/`low`/`info` findings may remain as advisory
  notes on an APPROVE.

## 6. Emit

Write the `PrReviewArtifact` to `.devmate/state/pr-review-result.json` and print
the short human summary. Exact schema, verdict rules, and the summary template
are in [output-format.md](output-format.md).
