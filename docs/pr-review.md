# PR Review (`/devmate:devmate-pr-review`)

`devmate-pr-review` is a user-invocable skill that reviews the **current task's
branch diff** against its **planning artifact** (alignment) plus **security and
quality best practices**, then emits a typed verdict. It is the standalone,
human-invoked review; automated gate wiring is a separate concern and this skill
touches no gate state.

It replaces the removed `docs/pr-ready.md`: PR *readiness* (the `pr-ready` gate)
is owned by the gate model; PR *review* (alignment + quality + security of the
diff) is what this skill does.

## Shape

Two moving parts, split along the deterministic/generative line devmate uses
everywhere:

1. **`scripts/pr-review.mjs` (deterministic gather).** A thin CLI over the pure
   `gatherReviewContext` in `lib/workflow/pr-review.mjs`. It reads the active
   `TaskState`, resolves the base ref, captures the branch diff **capped at the
   boundary** (TCM-9 — never the raw diff), records the lane's planning
   artifacts as pointers, precomputes cheap alignment signals, and writes the
   context digest. The clock and the subprocess runner are injected, so the
   context is reproducible.
2. **The skill (judged verdict).** Reads the context digest, loads only the
   resource-skill refs a given diff warrants, maps issues to severity/category
   with evidence pointers, and writes a typed `PrReviewArtifact`.

## Artifacts

### Context digest — `.devmate/state/pr-review-context.json` (`PrReviewContext`)

Written by the CLI. Key fields:

- `git` — `available`, `baseRef`, `base`/`head` shas, `changedFiles`
  (name-status, capped), `untrackedFiles`, and the capped diff:
  `diffCapped` (bounded, secret-redacted preview), `diffDigest` (SHA-256 of the
  full diff), and `diffFullPath` (pointer to the full log on disk). `diffFull`
  appears only with `--include-full-output`. When cwd is not a git work tree,
  `available` is `false` and `note` explains why.
- `artifacts` — `{ found, path, … }` for `spec`, `plan`, `scope`, `diagnosis`,
  and `security`, read per lane (feature: spec + plan; bug: diagnosis + scope;
  chore: scope; all: security, best-effort).
- `alignmentSignals` — `outOfScopeFiles` (bug/chore), `unlistedFiles` /
  `plannedButUnchanged` (feature), `testFilesChanged`, `regressionTestPresent`.
- `resourceSkills` — the resource skills the reviewer consults.

All list fields are capped (200 entries) with a `truncated` flag so the digest
stays bounded.

### Verdict — `.devmate/state/pr-review-result.json` (`PrReviewArtifact`)

Written by the skill and validated by `check-contracts`
(`validatePrReviewResult`):

- `verdict` — `APPROVE` or `REQUEST_CHANGES:<reason>`.
- `findings[]` — each with `severity` (blocker/high/medium/low/info),
  `category` (alignment/security/quality), an `evidence.path` pointer, a
  `finding`, and a `recommendation`.
- `alignment` — `{ ok, outOfScopeFiles, unlistedFiles, missingRegressionTest }`.
- `contextDigest` — echoes `git.diffDigest`, binding the verdict to a diff.
- `unverified[]` — claims the reviewer could not confirm, each `[UNVERIFIED]`.

Both typedefs live in `lib/types.mjs`; the full schema, verdict rules, and the
human summary template are in the skill's `refs/output-format.md`.

## Security boundary

The skill applies the secure-coding checklist as a **shift-left lens** and
consumes `security.json` **as-is** when present, but it defers **authoritative
vulnerability scanning and the security pass/fail verdict to the `@security`
agent** — it never re-scans and never emits a security gate verdict of its own.
If the diff touches a sensitive surface and no `security.json` exists, the
right recommendation is usually "route to `@security`".

## Usage

```
/devmate:devmate-pr-review
/devmate:devmate-pr-review --base origin/main
/devmate:devmate-pr-review --state-file .devmate/state/task.json --include-full-output
```

Installed as a local/workspace skill instead of via the plugin? Drop the
prefix: `/devmate-pr-review`.
