---
description: Implement one devmate-mjs GitHub issue end to end — read the issue, branch, build exactly what it specifies, run the CI-parity driver, open a PR that closes it, drive CI green, and triage every Copilot PR review comment before merge.
---

Implement the GitHub issue I name after `/implement-issue` (a number like
`396`, or `#396`). If I did not include an issue number, ask me for one
before doing anything else.

Read `.github/skills/implement-issue/SKILL.md` first and follow it exactly —
it is the source of truth for this workflow. In short, it will have you:

1. Read issue #N in full (GitHub MCP `issue_read`, or `gh issue view N
   --repo bbobis/devmate-mjs --json state,title,labels,body` in the
   terminal). Stop if it is CLOSED, an `epic`-labeled tracker, or blocked by
   an unmerged dependency.
2. Announce `Building issue #N: "<title>".` before writing any code.
3. Branch off latest `main` as `issue-N-<short-slug>`.
4. Baseline `node .github/skills/implement-issue/ci-parity.mjs` (Node 24+)
   BEFORE coding, so pre-existing failures on main are not chased.
5. Build exactly what the issue specifies — its files, contracts, and tests
   verbatim; `## Out of scope` means not-to-be-built — per CONTRIBUTING.md
   and docs/PATTERNS.md.
6. Keep documentation current in the same PR: CHANGELOG entry, regenerate
   (never hand-edit) generated blocks, update the owning doc under `docs/`,
   and create a new doc — indexed and allowlisted — for any new concept.
7. Re-run the driver until green (minus the baselined failures), walk the
   issue's acceptance criteria with evidence, then open a PR whose body
   starts with `Closes #N`, and drive CI to green.
8. Before merge, fetch every Copilot PR review comment, assess each for
   legitimacy against the issue scope + CONTRIBUTING.md + docs/PATTERNS.md
   + the actual code at the cited file:line, apply the legit ones in
   targeted `fix(review): …` commits, and dismiss the rest with a one-line
   evidence-grounded reason. **On every single thread — legit or not —
   post a reply saying what was done (or why it wasn't) and mark the
   thread resolved.** Merge invariant: zero open Copilot threads, and
   every one has a devmate reply. Record the triage under `## Copilot
   review triage` in the PR body.

Work only on that single issue. Do not start or touch other issues.
