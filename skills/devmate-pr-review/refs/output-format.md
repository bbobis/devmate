# PR Review — output format

Two outputs: the machine artifact (`pr-review-result.json`) and the human
summary printed to chat. The artifact is the contract; the summary is the story.

## The context you read (input)

`.devmate/state/pr-review-context.json` is a `PrReviewContext`:

```jsonc
{
  "schemaVersion": 1,
  "taskId": "…", "lane": "feature|bug|chore", "workflowGate": "…",
  "generatedAt": "ISO-8601",
  "git": {
    "available": true,
    "baseRef": "origin/main", "base": "<sha>", "head": "<sha>",
    "changedFiles": [{ "status": "M", "path": "lib/x.mjs" }],
    "untrackedFiles": ["…"],
    "diffDigest": "<sha256-64hex>",
    "diffCapped": "<bounded, redacted diff preview>",
    "diffFullPath": "<abs path to full diff log>",
    "diffFull": "<present only with --include-full-output>",
    "truncated": false,
    "note": ""
  },
  "artifacts": { "spec": {…}, "plan": {…}, "scope": {…}, "diagnosis": {…}, "security": {…} },
  "alignmentSignals": {
    "outOfScopeFiles": [], "unlistedFiles": [], "plannedButUnchanged": [],
    "testFilesChanged": [], "regressionTestPresent": false
  },
  "resourceSkills": ["app-security-handbook", "coding-best-practices", "pragmatic-programmer"]
}
```

## The artifact you write (output)

Write a `PrReviewArtifact` to `.devmate/state/pr-review-result.json`. It is
checked by `check-contracts` (validatePrReviewResult):

```jsonc
{
  "taskId": "<from context>",
  "lane": "feature|bug|chore",
  "schemaVersion": 1,
  "returnedAt": "<ISO-8601>",
  "contextDigest": "<context.git.diffDigest — binds this verdict to that diff>",
  "verdict": "APPROVE" | "REQUEST_CHANGES:<non-empty reason>",
  "findings": [
    {
      "severity": "blocker|high|medium|low|info",
      "category": "alignment|security|quality",
      "evidence": { "path": "lib/x.mjs", "lineRange": "40-58" },
      "finding": "One sentence: what is wrong.",
      "recommendation": "One sentence: the fix.",
      "source": "coding-best-practices"    // optional
    }
  ],
  "alignment": {
    "ok": true,
    "outOfScopeFiles": [],                  // echo context.alignmentSignals
    "unlistedFiles": [],
    "missingRegressionTest": false          // bug lane: !regressionTestPresent
  },
  "unverified": ["[UNVERIFIED] …"]          // every entry starts with [UNVERIFIED]
}
```

### Contract rules (fail the review if violated)

- `schemaVersion` must equal `1`.
- `contextDigest` must be a non-empty string (use `git.diffDigest`).
- `verdict` is exactly `APPROVE`, or `REQUEST_CHANGES:` followed by a non-empty
  reason.
- Every finding: `severity` in-enum, `category` in-enum, non-empty
  `evidence.path`, non-empty `finding` and `recommendation`.
- Every `unverified[]` entry begins with `[UNVERIFIED]`.

### Verdict rules

- **REQUEST_CHANGES** when any finding is `blocker`/`high`, OR
  `alignment.outOfScopeFiles` is non-empty, OR (bug lane)
  `alignment.missingRegressionTest` is true. Set `alignment.ok = false`.
- **APPROVE** otherwise. `alignment.ok = true`; residual `medium`/`low`/`info`
  findings stay as advisory notes.

## The human summary (printed to chat)

```md
## PR review — <taskId> (<lane>)

**Verdict: <APPROVE | REQUEST_CHANGES>** — <one-line reason>

Diff: <N> changed file(s) vs <baseRef> · tests changed: <yes/no>

### Findings
- [blocker] (alignment) lib/x.mjs:40-58 — <finding> → <recommendation>
- [medium] (quality) lib/y.mjs — <finding> → <recommendation>

### Alignment
- Out of scope: <none | list>
- Unlisted vs plan: <none | list>
- Regression test present (bug): <yes/no/n-a>

### Unverified
- [UNVERIFIED] <claim you could not confirm>
```

Keep it scannable. The findings list is the review; the artifact is its record.
