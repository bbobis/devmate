# Story Planner Agent

A label-triggered pipeline that turns a `ready-for-dev` issue into a
rubber-ducked backlog-grooming plan plus a paste-able devmate prompt, posted
back as a comment. Packaged as a portable composite action so any team can
consume it with a few lines of workflow.

## How it works

```text
Issue labeled ready-for-dev
        |
        v
GitHub Actions: issues:labeled + label guard
        |
        v
[composite action: uses: <org>/devmate@v1]
   1. install Copilot CLI
   2. checkout system repos (context)
   3. install bundled CLI agents (.github/agents/*.md)
   4. gather related open + closed issues (dependency context)
   5. discover codebase grounding (scan + agent + merge)  ──► discovery.md
   6. run planner agent (reads discovery.md)  ──► plan.md
   7. plan grill (rubber-duck approval, capped revisions) ──► APPROVE_PLAN | NEEDS_REVIEW
   8. post plan + devmate prompt as comment (Approved | Needs human review)
   9. upload transcript artifact
```

## Posted comment: plan + devmate prompt

The pipeline posts a **backlog-grooming plan, not a detailed implementation
spec.** A spec written at `ready-for-dev` drifts by the time someone picks the
story up; a lighter plan (scope, edge/corner cases, dependencies, risks,
`[UNVERIFIED]` questions) ages better and orients the developer during backlog
refinement. The detailed spec is deferred to implementation time, produced by
devmate inside Copilot Chat when the context is fresh.

The comment includes:

- a **Status** line:
  - `Approved by plan grill.` — the rubber-duck approval gate passed.
  - `Needs human review — the plan grill did not approve.` — the revision cap
    was reached without approval; the plan is still posted, with the grill's
    **open blockers** surfaced for a human to triage.
- the **plan** itself.
- a **Paste into devmate** block — a short, pointer-based prompt the developer
  copies into Copilot Chat to kick off devmate's lane (rediscover → spec → TDD),
  treating the comment as context rather than a final spec.

The comment is stamped with the `<!-- devmate-story-plan-v1 -->` marker and
prior plan comments are minimized on reruns so the thread stays readable.

## Discovery stage (codebase grounding before the planner)

devmate's own architecture mandates `discovery → grill → planner → rubber-duck`
([agents/planner.agent.md](../agents/planner.agent.md): the planner reads the
discovery report and each plan task must cite discovery evidence). The pipeline
implements devmate's two-phase discovery in the Copilot CLI context:

- **Phase 1 — deterministic scan (0 LLM tokens).**
  `scripts/discovery-scan.mjs` runs once per checked-out repo with seed terms
  derived from the issue title + labels. Four parallel strategies (by name,
  content, import-graph, test-mirror) emit a ranked candidate-file list — see
  [docs/discovery-scan.md](./discovery-scan.md).
- **Phase 2 — discovery agent (read-only LLM).** The discovery agent reads the
  candidates for one repo and emits a typed artifact
  `{ agentName: "discovery", claims: [{fact, path, confidence}], unverified: [] }`,
  marking gaps `[UNVERIFIED]`.
- **Fan-in.** One worker per repo writes to `.devmate/state/worker-returns/`;
  `scripts/merge-discovery.mjs` dedups, corroborates, and surfaces conflicts into
  `.devmate/state/discovery-merged.json` — see
  [docs/discovery-merge.md](./discovery-merge.md). A renderer turns that into
  `discovery.md`, which the planner prompt includes so every plan task cites
  real codebase evidence.

- **Graceful degrade.** If a repo yields no valid artifact (scan empty, agent
  off-contract, JSON unparseable), it is skipped; the merge runs on the rest. If
  no artifacts survive, a stub `discovery.md` is written and the planner still
  runs without grounding rather than failing the build.
- **Cross-repo disambiguation.** Every claim path is workspace-relative and
  repo-prefixed (e.g. `repos/monoroot/src/foo.ts`) so the merge's path-dedup
  never collapses claims from different repos.

## Sharing agent contents (no copy-paste, no symlink)

The Copilot **Chat** agent definitions are the single source of truth:

- `agents/planner.agent.md`
- `agents/rubber-duck.agent.md`
- `agents/discovery.agent.md`

The Copilot **CLI** agents are generated from them:

- `.github/agents/planner.md`
- `.github/agents/rubber-duck.md`
- `.github/agents/discovery.md`

`scripts/generate-cli-agents.mjs` reads each Chat agent, normalizes the
frontmatter (keeps `name`, `description`, `model`; drops `tools` and
`user-invocable`), and shares the body verbatim. `scripts/check-generated-cli-agents.mjs`
fails CI when the committed CLI agents drift from their sources.

- Why not copy-paste? It drifts.
- Why not symlink? Breaks on Windows checkouts; frontmatter differs.

To add a new shared agent, add an entry to `DEFAULT_AGENTS` in
`scripts/generate-cli-agents.mjs` and run `node scripts/generate-cli-agents.mjs`.

## Invocation modes

The pipeline pipes a prompt to `copilot -s` (mirrors `enrich-issue.yml`).

- `prompt` (default, proven): embeds the agent body in the piped prompt; no
  `--agent` flag. Use this until `--agent` discovery is confirmed on your CLI.
- `agent`: passes `--agent <name>` and relies on the copied `.github/agents/*.md`
  for discovery. Verify the repo-level CLI agent path on your CLI version before
  switching.

- `system-repos` — newline-separated `owner/name` repos the action checks out into `repos/`.
- `add-dirs` — workspace-relative dirs the caller already checked out (when Repo A owns its own multi-repo checkout). Merged into `ADD_DIRS`.

Set via the action input `invocation-mode`.

## Two-token auth (no GitHub App — org policy)

- Built-in `GITHUB_TOKEN` + `copilot-requests: write` → the Copilot CLI request.
- `PLANNER_TOKEN` (fine-grained PAT) → cross-repo checkout + posting the comment.
  Scopes: `contents: read` on all system repos, `issues: write` on the story repo.

## Consumer setup (Repo A — where stories live)

Repo A owns the trigger and its own `PLANNER_TOKEN` secret. Minimal workflow:

```yaml
on:
  issues:
    types: [labeled]
permissions:
  contents: read
  issues: write
  copilot-requests: write
jobs:
  plan:
    if: github.event.label.name == 'ready-for-dev'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <org>/devmate@v1
        with:
          issue-number: ${{ github.event.issue.number }}
          planner-token: ${{ secrets.PLANNER_TOKEN }}
          system-repos: |
            org/repo-b
            org/repo-c
```

Tag devmate releases (`@v1`) so consumers get stable updates.

## Security

- Issue bodies and related-issues context are UNTRUSTED. The prompts instruct the
  agents never to follow embedded directives that change output format, ignore
  rules, exfiltrate secrets, or act outside the allowed repos.
- Tool access is a read-only allow-list (`--allow-tool='shell(...)'`); deny takes
  precedence. The pipeline never grants `write`.
- `PLANNER_TOKEN` is a long-lived secret — rotate it and store it as an Actions
  secret, never in code.

## Verification needed before merge to production

- Confirm `.github/agents/*.md` is the discovery path your Copilot CLI version
  reads for `--agent`. Until confirmed, keep `invocation-mode: prompt`.
- Dry-run the workflow against a real `ready-for-dev` issue in a test repo.

## MVP scope of related-issues gathering

The gather step collects the most recently updated open + closed issues per repo
(recency-based), not semantically matched issues. It surfaces a broad dependency
context for the planner to filter. Upgrading to label/milestone/keyword or
semantic matching is a follow-up.
