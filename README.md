# devmate

A **GitHub Copilot plugin for VS Code** that turns ad-hoc AI coding into a deterministic, gated, resumable workflow. This repo is a fresh rewrite tracked as a backlog of detailed, autonomous issues (epics E0–E8).

> **Supported surface: GitHub Copilot in VS Code — and only that.** Copilot CLI and the Copilot cloud agent are not targets. They have a *different* hook contract (different tool names, payload keys, and output shapes), and code written to satisfy both satisfies neither: that is precisely how three of devmate's enforcement layers came to be registered, documented, and completely inert. See **[docs/hooks.md](./docs/hooks.md)**.
>
> **Exception — the story planner CI surface:** devmate ships a Copilot CLI-based GitHub Actions pipeline (the story planner) that reuses the planner + rubber-duck agent definitions as CLI agents. This is a CI-only surface; the VS Code plugin hook contract is unchanged. See **[docs/story-planner.md](./docs/story-planner.md)**.

> **Build rules:** all code is `.mjs` ES modules with `// @ts-check` + JSDoc types, Node 24+ (engines + a runtime guard), capped tool output, and `node:test`. See **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

---

## Capabilities

All capability counts and tables below are generated from [`docs/capability-registry.json`](./docs/capability-registry.json). Run `node scripts/generate-docs.mjs` to regenerate. Do **not** hand-edit the generated blocks.

<!-- generated:capability-table -->
| ID | Type | Name | Description | Invocation |
|---|---|---|---|---|
| session-start-hook | hook | Session Start Hook | Runs on Copilot SessionStart to initialise the session budget and context. | auto-registered |
| post-tool-use-hook | hook | Post Tool Use Hook | Runs on Copilot PostToolUse to audit and record tool calls. | auto-registered |
| check-session-budget-hook | hook | Session Budget Hook | Runs on Copilot PostToolUse to measure session context size and warn when the token budget is approached or exceeded. | auto-registered |
| compact-session-hook | hook | Compact Session Hook | Runs on Copilot PreCompact to write a typed, high-recall compaction artifact a fresh session can resume from. | auto-registered |
| session-stop-hook | hook | Session Stop Hook | Runs on Copilot Stop to persist session state and emit a digest. | auto-registered |
| validate-hooks | script | Validate Hooks | Validates hooks/hooks.json against official VS Code event names; the live manifest contract is enforced in CI by the hooks-smoke test job. | agent-invoked |
| check-artifact-allowlist | script | Check Artifact Allowlist | CI script that verifies every repo file is listed in the artifact allowlist. | agent-invoked |
| generate-docs | script | Generate Docs | Regenerates all sentinel-delimited capability sections in README and docs from the registry. | agent-invoked |
| check-generated-docs | script | Check Generated Docs | CI lint step that exits 1 when any sentinel-delimited generated block is stale. | agent-invoked |
| check-file-budgets | script | Check File Budgets | CI script that enforces per-file line and token budgets for agent and skill files. | agent-invoked |
| generate-current-behavior | script | Generate Current Behavior | CI script that generates docs/CURRENT_BEHAVIOR.md from the registry, hooks manifest, and test summary. | agent-invoked |
| check-docs-drift | script | Check Docs Drift | CI lint step that exits 1 when docs assert hook events, config keys, or state names not in verified ground truth. | agent-invoked |
| orchestrator-agent | agent | Orchestrator | Stage-gated workflow coordinator for feature, bug, and chore lanes. | user-invoked |
| fullstack-agent | agent | Full-stack | Generic language/tool-agnostic implementation agent dispatched N times with a persona from devmate.config.json. | agent-invoked |
| diagnose-agent | agent | Diagnose | Bug-lane diagnosis agent that reproduces the bug and hands off to the full-stack fixer with the diagnosed persona. | agent-invoked |
| rubber-duck-agent | agent | Rubber-Duck | Adversarial reasoning agent dispatched in grill (pre-plan) and critique (post-plan) modes. Read-only. | agent-invoked |
| spec-writer-agent | agent | Spec-Writer | Writes deterministic .devmate/session/spec.md output from planner artifacts and records task-state metadata. | agent-invoked |
| backend-agent | agent | Backend | Backend specialist persona wrapper. Dispatches fullstack with persona=backend. Scope: editableGlobs/offLimitsGlobs for backend persona in devmate.config.json. | agent-invoked |
| frontend-agent | agent | Frontend | Frontend specialist persona wrapper. Dispatches fullstack with persona=frontend. Scope: editableGlobs/offLimitsGlobs for frontend persona in devmate.config.json. | agent-invoked |
| editor-agent | agent | Editor | Non-source editor persona wrapper. Dispatches fullstack with persona=editor. Scope: docs, configs, CI, migrations, chore files only. | agent-invoked |
| ui-ux-agent | agent | UI-UX | Design-only feature-lane agent that produces a UI brief artifact with screens, interactions, error states, components, and unverified items. | agent-invoked |
| security-agent | agent | Security | Pre-PR security review agent that reports typed findings with evidence pointers. | agent-invoked |
| tdd-debug-skill | skill | TDD & Debug | Activates the Red-Green-Refactor cycle and debug hypothesis loop for implementation agents. | agent-invoked |
| init-skill | skill | Devmate Init | User-invocable skill exposed as the /devmate:devmate-init slash command. After running the command, reads .devmate/state/init-proposal.json for the proposed devmate.config.json. | user-invoked |
| map-skill | skill | Devmate Map | User-invocable skill exposed as the /devmate:devmate-map slash command. Generates a DRAFT business-domain map + context-file stubs under .devmate/session/ from repo structure, then applies to devmate.config.json only after explicit user confirmation (generate, review, apply). | user-invoked |
| pr-review-skill | skill | PR Review | User-invocable skill exposed as the /devmate:devmate-pr-review slash command. Gathers a capped diff-vs-plan review context at .devmate/state/pr-review-context.json (branch diff, planning artifacts as pointers, precomputed alignment signals), then emits a typed PrReviewArtifact verdict to .devmate/state/pr-review-result.json. Defers authoritative security scanning to the security agent. | user-invoked |
<!-- /generated:capability-table -->

---

## Install (consumers)

devmate ships as a VS Code **agent plugin** (Preview) distributed through a private (Git-repo) plugin marketplace. The plugin and the marketplace live in this same private repo. Manifests point at the existing folders — no files are relocated.

> Agent plugins are Preview/Experimental. Support is gated by the `chat.plugins.enabled` setting, which is managed at the organization level — contact your administrator if it is not enabled. See [VS Code: Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

### Option A — register the marketplace

1. Add this repo as a marketplace in your VS Code settings (private repos are supported):

   ```json
   "chat.plugins.marketplaces": ["LP-GTM-Product-Engineering/devmate"]
   ```

2. Open the Extensions view, search `@agentPlugins`, and install **devmate**.

### Option B — one-off install from source

Run the command **Chat: Install Plugin From Source** and provide:

```
https://github.com/LP-GTM-Product-Engineering/devmate
```

### Team auto-enable (per consuming repo)

In a consuming repo's `.github/copilot/settings.json`, auto-register the marketplace and pre-enable the plugin:

```json
{
  "extraKnownMarketplaces": {
    "devmate-marketplace": { "source": "LP-GTM-Product-Engineering/devmate" }
  },
  "enabledPlugins": ["devmate"],
  "chat.subagents.allowInvocationsFromSubagents": true
}
```

- `enabledPlugins` pre-enables devmate for everyone on the team.
- `chat.subagents.allowInvocationsFromSubagents` is required so the single generic `fullstack` agent can be dispatched N times via self-referential subagent dispatch (see [VS Code: Custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)).

All setting names above are copied from the official [VS Code agent-plugins doc](https://code.visualstudio.com/docs/agent-customization/agent-plugins) and the [Claude Code marketplace schema](https://docs.claude.com/en/docs/claude-code/plugin-marketplaces) it defers to.

> Note: the `skills` path in `plugin.json` points at `skills/`, the parent directory holding each skill as a trigger stub (`skills/<id>/SKILL.md`) plus lazy `refs/` files (#34, E4-4).

---

## Start here

### 1. How to build it (per issue)

Each issue is a self-contained spec an LLM (or a human) can implement on its own. To work an issue:

1. Open **[docs/IMPLEMENT_ISSUE.prompt.md](./docs/IMPLEMENT_ISSUE.prompt.md)**.
2. Copy the fenced prompt block, replace `<ISSUE_NUMBER>` with the issue you're building, and paste it to your LLM.
3. The prompt makes the LLM: read the issue → branch → implement → **verify against the issue's acceptance criteria** (`npm run verify`) → open a PR containing `Closes #<N>` → drive CI to green.
4. When the PR merges into `main`, the issue **closes automatically** and the branch is deleted.

Do one issue per PR. Don't start an issue whose dependencies aren't merged yet.

### 2. What order to build in

Each issue is a self-contained spec, so order is a scheduling choice, not a hard constraint. Pick the next open issue your team is prioritizing (the current epic's issues carry a `**Workstream:** W1/W2/W3` header that groups them into dependency-ordered waves), and honor two rules:

- **Respect dependencies.** Never start an issue whose `Blocked by #M` links are still open/unmerged — the prompt stops and reports if you do.
- **One issue per PR.** Build exactly the issue you named; note any out-of-scope reach into the PR's "Out of scope / follow-ups" section.

### 3. Understand the design

- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** — system diagram + how everything connects.
- **[docs/AGENTS.md](./docs/AGENTS.md)** — the agent roster and how they hand work to each other.
- **[docs/PATTERNS.md](./docs/PATTERNS.md)** — the 12 context-management rules (secret sauce) + workflow patterns, with why and how.
- **[docs/README.md](./docs/README.md)** — docs index.
- **[docs/conventions/multi-root-setup.md](./docs/conventions/multi-root-setup.md)** — running devmate in a multi-repo workspace created by monoroot (fallback personas, Re-sync, the session handshake).

---

## Grounding

Every claim about a Copilot capability (agents, prompts, skills, hooks, instructions) is grounded to official docs only ([VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents), [prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files), [hooks](https://code.visualstudio.com/docs/copilot/customization/hooks), [custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)). Anything unverified is marked `[UNVERIFIED]` and kept configurable — including model IDs, which are never hardcoded.
