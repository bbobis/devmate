# PR Review — quality & security lens

Alignment tells you the diff matches the plan. This lens tells you the diff is
*good code*. Load the resource-skill refs lazily — only the ones a given diff
warrants (TCM-4/5). The three resource skills the context advertises are
`app-security-handbook`, `coding-best-practices`, and `pragmatic-programmer`.

## Quality (category: `quality`)

Judge the changed code against the review checklists these skills already own —
do not restate them here, read them:

- [`coding-best-practices` → code-review](../../coding-best-practices/refs/code-review.md)
  — deep modules, information hiding, KISS/YAGNI/DRY, coupling/cohesion,
  intent-revealing naming, error handling, immutability, fail-fast.
- [`pragmatic-programmer` → code-review](../../pragmatic-programmer/refs/code-review.md)
  — ETC (easier-to-change), orthogonality, design-by-contract, tell-don't-ask,
  crash-early, the broken-windows rule, the TDD test pyramid.

Common `quality` findings on a diff: a shallow wrapper that adds no abstraction,
a duplicated block that should be shared, a public name that hides intent, a
swallowed error, a missing test for a new branch, an over-broad change that
couples two concerns. Map each to a severity and point at the line range.

## Security (category: `security`) — the boundary

Apply [`app-security-handbook` → secure-coding](../../app-security-handbook/refs/secure-coding.md)
as a **shift-left lens only**: skim the diff for the obvious classes — unvalidated
input, string-built queries, a leaked secret, a disabled check, an unsafe
default, an over-broad permission — and raise them as `security` findings with
evidence pointers.

**Do not duplicate the `@security` agent.** Authoritative vulnerability scanning
and the security pass/fail verdict belong to the `@security` agent, whose typed
findings land in `security.json`. This skill:

- consumes `context.artifacts.security` **as-is** when present — fold its
  findings into your summary, keep its severities, never re-grade them;
- when it is absent, notes that the authoritative security pass has not run yet
  and raises only shallow, evidence-backed shift-left observations;
- never emits a security pass/fail gate verdict of its own — that is the
  `@security` agent's job.

In short: this skill is a reviewer with a security lens, not a scanner. If the
diff touches a sensitive surface and no `security.json` exists, the right
recommendation is often "route to `@security`", tagged `[UNVERIFIED]` if you
cannot confirm the exposure yourself.
