# Story Planner Agent

A label-triggered pipeline that turns a `ready-for-dev` issue into a
rubber-ducked implementation plan, posted back as a comment. Packaged as a
portable composite action so any team can consume it with a few lines of
workflow.

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
   5. run planner agent  ──► plan.md
   6. rubber-duck critique loop (2-revision cap) ──► APPROVE_PLAN | REQUEST_REVISION
   7. post approved plan as issue comment (minimizes prior plan comments)
   8. upload transcript artifact
```

## Sharing agent contents (no copy-paste, no symlink)

The Copilot **Chat** agent definitions are the single source of truth:

- `agents/planner.agent.md`
- `agents/rubber-duck.agent.md`

The Copilot **CLI** agents are generated from them:

- `.github/agents/planner.md`
- `.github/agents/rubber-duck.md`

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
