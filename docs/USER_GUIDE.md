<!--
  Consumer-facing user guide for the devmate Copilot plugin.
  Every Copilot/VS Code claim here is grounded in an official doc URL (see "Sources").
  Every devmate command/agent/hook/setting is grounded in the repo's own artifacts:
  docs/capability-registry.json, hooks/hooks.json, skills/, agents/, README.md.
  This file is NOT one of the docs-drift-scanned files (only CHANGELOG.md + docs/hooks.md are),
  so backticks around identifiers are fine here.
-->

# devmate User Guide

A guide for **consumers** of the devmate plugin — developers who install devmate into their repo and use it day to day. It does not cover contributing to devmate itself (see [CONTRIBUTING.md](../CONTRIBUTING.md) for that).

---

## 1. What devmate is (in plain language)

devmate is a **GitHub Copilot plugin for VS Code**. It turns ad-hoc AI coding into a **deterministic, gated, resumable workflow**.

Think of it as a set of guardrails around Copilot:

- **Deterministic** — the same task follows the same steps, not a random walk.
- **Gated** — work moves through stages, and each stage has a check before the next one starts.
- **Resumable** — if a session ends, devmate writes a handoff so a fresh session can pick up where you left off.

It installs as three kinds of pieces ([README](../README.md)):

| Piece | What it is | You invoke it? |
|---|---|---|
| **Agents** | Role-based AI assistants (orchestrator, full-stack, diagnose) | Only the orchestrator |
| **Hooks** | Scripts that run automatically on Copilot lifecycle events | No — automatic |
| **Skills** | Reusable capabilities that load on demand; the user-invocable ones appear as slash commands (`/devmate:devmate-init`, `/devmate:devmate-map`, `/devmate:devmate-pr-review`) | Yes |

> **Why skills, not prompt files?** In a VS Code agent plugin, slash commands are delivered as **skills**. A plugin's `plugin.json` ships `skills/`, `agents/`, and `hooks/` — it does **not** ship workspace prompt files (`.prompt.md`). VS Code makes user-invocable skills available as `/` commands in chat ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)). So devmate's `/devmate:devmate-init`, `/devmate:devmate-map`, and `/devmate:devmate-pr-review` are skills under the hood (the `devmate:` prefix is the plugin name, added automatically by VS Code).

> The full, always-current list of pieces lives in [`docs/capability-registry.json`](./capability-registry.json) — that file is the single source of truth.

---

## 2. Requirements (read this first)

devmate uses VS Code **agent plugins**, which are **Preview / Experimental** ([VS Code: Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)).

- **VS Code** with GitHub Copilot Chat.
- The setting **`chat.plugins.enabled`** must be on. This is managed at the **organization level** — if it is off, contact your administrator ([VS Code: Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)).
- **Node.js 24+** on your machine. devmate's hooks and commands run as Node scripts, and there is a runtime version guard ([README](../README.md)).

---

## 3. Install

devmate ships through a **private (Git-repo) plugin marketplace** that lives in the devmate repo itself ([README](../README.md)). Pick one option.

### Option A — register the marketplace (recommended)

1. Add the repo as a marketplace in your VS Code settings:

   ```json
   "chat.plugins.marketplaces": ["LP-GTM-Product-Engineering/devmate"]
   ```

2. Open the **Extensions** view, search `@agentPlugins`, and install **devmate**.

### Option B — one-off install from source

Run the command **Chat: Install Plugin From Source** and provide:

```
https://github.com/LP-GTM-Product-Engineering/devmate
```

### Team auto-enable (per repo)

To turn devmate on for your whole team in a given repo, add this to that repo's `.github/copilot/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "devmate-marketplace": { "source": "LP-GTM-Product-Engineering/devmate" }
  },
  "enabledPlugins": ["devmate"],
  "chat.subagents.allowInvocationsFromSubagents": true,
  "chat.customAgentInSubagent.enabled": true
}
```

- `enabledPlugins` pre-enables devmate for everyone on the team.
- `chat.subagents.allowInvocationsFromSubagents` lets the single generic `fullstack` agent be dispatched several times in parallel ([VS Code: Custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)).
- `chat.customAgentInSubagent.enabled` lets custom `.agent.md` agents (`@discovery`, `@tech-design`) be invoked as subagents at all.

> All setting names above are copied from the official [VS Code agent-plugins doc](https://code.visualstudio.com/docs/agent-customization/agent-plugins).

---

## 4. First-time setup: create your config

devmate needs one file in your repo: **`.devmate/devmate.config.json`**. It tells devmate which parts of the codebase each "persona" (frontend, backend, etc.) is allowed to edit and which are off-limits.

### Step 1 — run the init command

In Copilot Chat, type:

```
/devmate:devmate-init
```

> **Important — use the plugin prefix.** When a skill ships inside a plugin, VS Code automatically prefixes the command with the plugin name and a **colon**: `/devmate:devmate-init` ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)). It is **one token** — there is **no space** between the prefix and the skill name. Typing `/devmate devmate-init` (with a space) is **not** a valid command; the part after the space is treated as extra text, so the agent may try to run it in your terminal instead.

**Tips for invoking commands:**

- Type `/` alone to open the menu, then pick the command — this avoids typos in the prefix.
- Add arguments **after a space**, e.g. `/devmate:devmate-init --path config/devmate.config.json`. Text after the space is context/arguments, not a sub-command ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)).
- If you added the skill as a **local/workspace** skill (not via the plugin), there is no prefix — use the bare `/devmate-init` instead.

### Step 2 — review the proposal

devmate reads your repo structure and **proposes** a config — it does **not** write anything yet. The flow is strictly **propose → confirm → write**:

1. It prints a proposed `.devmate/devmate.config.json` (personas + editable/off-limits globs).
2. The globs are **heuristics** inferred from your layout — not verified boundaries. Review them carefully, especially the **off-limits** globs.
3. Only after you **explicitly confirm** does devmate write the file.

> If a config already exists, devmate refuses to overwrite it. It will only replace it if you explicitly approve a force overwrite.

### Step 3 — commit it

Edit the personas/globs as needed, then commit `.devmate/devmate.config.json`. A typical config looks like this (real example from the repo):

```json
{
  "schemaVersion": 1,
  "personas": [
    {
      "persona": "frontend",
      "editableGlobs": ["src/**/*.{ts,tsx,css}", "public/**"],
      "offLimitsGlobs": ["src/main/java/**", "src/test/java/**"]
    },
    {
      "persona": "backend",
      "editableGlobs": ["src/main/**", "src/test/**", "lib/**"],
      "offLimitsGlobs": ["src/ui/**", "public/**"]
    }
  ]
}
```

- `editableGlobs` — files this persona **may** change.
- `offLimitsGlobs` — files this persona **must not** touch (optional but recommended).

More detail in [docs/config.md](./config.md).

### Optional follow-on — map your business domains (`/devmate:devmate-map`)

Once the config exists you can optionally add a **business-domain map** — the
`domains` section that tells devmate which files, vocabulary, and context
notes belong to areas like "billing" or "orders". Domains power per-task
context injection and domain-aware skill ranking; repos without them behave
exactly as before (fully opt-in).

The flow is the same propose → confirm → apply shape as init:

1. Run `/devmate:devmate-map`. devmate infers **draft** domains from your repo
   structure (workspace packages, `src/` subdirectories) and writes the draft
   plus one context-file stub per domain under `.devmate/session/` — nothing
   touches your real config yet.
2. Review and edit the draft: rename ids, replace inferred keywords with real
   business vocabulary, tighten globs, and fill in each stub's TODO sections
   (invariants are the highest-value part).
3. Confirm, and devmate applies it: the `domains` section merges into
   `.devmate/devmate.config.json` (validated first; existing keys untouched)
   and the stubs land in `.devmate/contexts/`. Commit both.

The inference is a proposal, never truth — a wrong domain map wastes context
tokens, so keep it honest or keep it small.

---

## 5. Everything you can do

This is the consumer-facing feature list. It is grouped by **how you use it**: things you run, things that happen automatically, and things working behind the scenes.

### 5a. Commands you run (skill-backed slash commands)

You type these directly in Copilot Chat with `/`. They are user-invocable **skills** — that is how a VS Code plugin contributes slash commands ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)).

Because these skills ship inside the plugin, VS Code prefixes each command with the plugin name and a colon (`/devmate:...`) — one token, no space ([VS Code: Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)).

| Command (plugin install) | What it does |
|---|---|
| **`/devmate:devmate-init`** | Reads your repo and **proposes** a `.devmate/devmate.config.json`, then writes it only after you confirm (propose → confirm → write). |
| **`/devmate:devmate-map`** | Infers a **draft** business-domain map + context-file stubs from your repo structure, and applies it to your config only after you review and confirm (Section 4). |
| **`/devmate:devmate-pr-review`** | Reviews the current task's branch diff against its plan (alignment) plus security and quality best practices, then emits a typed verdict. Run it before opening a PR. |

> Installed as a local/workspace skill instead of via the plugin? Drop the prefix: `/devmate-init`, `/devmate-map`, `/devmate-pr-review`.

> These three are the only user-invocable slash commands devmate ships today. Anything not listed here is not a slash command.

### 5b. The workflow you drive (the orchestrator agent)

devmate's main way of working is the **orchestrator** — the one agent you select yourself. You pick it from the Chat **agent picker** in VS Code (select the agent in the Chat view; you can also type `/agents` to open the agent menu) ([VS Code: Custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)).

What the orchestrator does ([orchestrator agent](../agents/orchestrator.agent.md)):

- **Accepts a task** and figures out the **lane**: feature, bug, or chore.
- **Routes the work** to the right specialist agents — you don't manage them by hand.
- **Tracks gate state** so the task moves through stages in order.
- **Never edits source itself** — all code changes go through specialist agents with the right persona and edit boundaries.

So as a consumer, your normal loop is:

1. Select the **orchestrator** agent.
2. Describe your task ("add X feature", "fix this bug", "do this chore").
3. Let devmate route it through its gated lanes.
4. When you think it's done, open a pull request for review.

### 5c. Specialist agents (work for you behind the scenes)

You don't invoke these directly — the orchestrator dispatches them. Knowing they exist helps you read what devmate is doing.

| Agent | Role |
|---|---|
| **Full-stack** | The generic implementation agent. Dispatched several times, each with a persona from your `.devmate/devmate.config.json`, and edits only within that persona's globs. |
| **Diagnose** | Bug-lane agent. Reproduces the bug, finds the responsible layer/persona, then hands off to the full-stack fixer with the persona pre-filled. |
| **BSA** (Business/Systems Analyst) | Maps actors, edge cases, and assumptions into a structured analysis before building. |

### 5d. Automatic hooks (you never call these)

These run on their own when Copilot fires lifecycle events. They are what make devmate **resumable** and **token-aware**. All are auto-registered ([hooks manifest](../hooks/hooks.json), [capability registry](./capability-registry.json)).

| Hook | Fires on | What it gives you |
|---|---|---|
| **Session Start** | `SessionStart` | Sets up the session's budget and context, and **injects recalled memory** so each session starts with prior knowledge (Section 6). |
| **Post Tool Use** | `PostToolUse` | Audits each tool call **and records a memory fact for each edited file** (Section 6). |
| **Session Budget** | `PostToolUse` | Measures how big the session context is and **warns** as you approach or exceed the token budget. |
| **Compact Session** | `PreCompact` | Writes a **high-recall handoff artifact** so a fresh session can resume your work after a compaction — and **persists memory** before context is dropped (Section 6). |
| **Session Stop** | `Stop` | **Persists memory** — promotes the session's facts and regenerates `.devmate/MEMORY.md` — when the session ends (Section 6). |

The practical payoff:

- **Token discipline** — agents get a short `{ digest, fullOutputPath }`, never giant raw logs ([plugin guide](../plugin-guide.md)).
- **Resumability** — long tasks survive session resets because state is written to disk.

### 5e. Skills (auto-activated)

| Skill | What it adds |
|---|---|
| **TDD & Debug** | Switches implementation agents into the **Red-Green-Refactor** cycle and a structured debug hypothesis loop. Activated automatically by the agents that need it. |

### 5f. Auto-approving devmate scripts (optional)

devmate's hooks and skills run bundled Node scripts, e.g. `node "${PLUGIN_ROOT}/scripts/<name>.mjs"`. By default VS Code asks you to approve **every** terminal command before it runs. If you trust devmate's shipped scripts, you can pre-approve just those commands with the `chat.tools.terminal.autoApprove` setting ([VS Code: AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings), [Manage approvals](https://code.visualstudio.com/docs/agents/approvals)).

This is a **consumer setting** — it lives in your own `settings.json`, not in the plugin. devmate ships a ready-to-use template at [`.vscode/settings.json`](../.vscode/settings.json):

```json
"chat.tools.terminal.autoApprove": {
  "/^node\\b.*PLUGIN_ROOT.*\\.mjs/": true
}
```

- The key is a **regex** (the surrounding slashes tell VS Code to treat it as a regex). It matches `node ... .mjs` commands whose path contains `PLUGIN_ROOT` — that is, devmate's own scripts.
- A value of `true` auto-approves; `false` always requires approval.
- Copy the template into your workspace `.vscode/settings.json` (or your user settings) to apply it. Remove it any time to go back to per-command approval.

> Note: in org-managed environments the master switch `chat.tools.terminal.enableAutoApprove` may be disabled by your administrator, in which case auto-approval is off regardless of this setting ([AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings)).

### 5g. Keeping work delegated (optional)

devmate's whole point is **token/context management**: the orchestrator should **hand off** the heavy analysis — exploring the codebase, design, grilling assumptions, planning, diagnosis — to specialist sub-agents, so that work burns a *sub-agent's* context window instead of clogging the orchestrator's. When the orchestrator does that analysis itself, its context fills up and quality drops. devmate gives you two ways to keep delegation honest.

**Enforce it (config).** In `.devmate/devmate.config.json`, set `delegationFloor`. Start with `warn` to observe, then move to `block` once it looks clean:

```json
{ "delegationFloor": "warn" }
```

- `off` (default) — no change.
- `warn` — records a violation you can see in the report, but lets the task proceed.
- `block` — refuses to start implementation until the lane's analysis was delegated.

You can tune which specialists each lane must delegate to with `delegationFloorRequirements`. Full reference: [docs/config.md → Delegation floor](./config.md#delegation-floor-optional).

**Observe it (report).** Check how much a task delegated versus did inline:

```bash
node scripts/delegation-report.mjs --task <taskId>   # one task
node scripts/delegation-report.mjs --all             # a fleet dashboard
```

It gives a **GREEN / YELLOW / RED** verdict. The automatic `Stop` hook (Section 5d) also flags a session that reached implementation with no sub-agent dispatch — so a non-delegating run tells on itself.

---

## 6. Memory: what devmate remembers

devmate keeps a small, **committed** memory of facts about your codebase in `.devmate/MEMORY.md` — one-line notes tied to the files they came from (never raw file contents or chat history). This is what lets a later session recall "we already worked this out" instead of re-deriving it.

### It's automatic — nothing extra to install or configure

Memory rides entirely on the plugin's hooks, which are already auto-registered when you install devmate (Section 5d). There is **no separate install** and **no MCP server to set up** — installing the plugin is the whole setup.

| Stage | When | What happens |
|---|---|---|
| **Collect** | as you edit (`PostToolUse`) | a fact per edited file is recorded into a per-task staging ledger. |
| **Persist** | session end (`Stop`), compaction (`PreCompact`), or task completion | staged facts are promoted and `.devmate/MEMORY.md` is regenerated. |
| **Recall** | session start (`SessionStart`) | the most relevant facts are injected into context, so the agent starts with prior knowledge instead of re-inferring it. |

Only `.devmate/MEMORY.md` is committed. The staging and ledger files under `.devmate/memory/` and `.devmate/state/` are transient and gitignored (devmate keeps your `.gitignore` in sync automatically).

### Recalling on demand

Beyond the automatic startup injection, devmate can pull memory mid-task:

- **In Claude Code**, devmate registers a **`query_memory` tool** (bundled via the plugin's `.mcp.json`, auto-loaded on install — your host may ask you to approve the MCP server the first time). The model can call it to fetch the top facts for a lane or path.
- The orchestrator lane procedures also tell the agent to consult recalled memory before re-deriving known facts.

**Verify before trusting.** Recalled facts are treated as *hints*: devmate checks that a fact's source file still exists and drops drifted ones, and the injected block reminds the agent to verify against current code before relying on it.

### If memory ever looks stuck

devmate ships a **memory doctor** (`scripts/devmate-doctor.mjs`) that checks the three stages in order — task ledgers → repo ledger → `.devmate/MEMORY.md` — and names the first empty one, so you can tell at a glance whether collection, promotion, or rendering is the problem.

### Host note

The automatic collect / persist / recall above runs wherever devmate's hooks run. The **`query_memory` tool** specifically is a **Claude Code** MCP feature; in a VS Code Copilot host you still get the full automatic memory, but that tool surface may not appear.

### Optional: external code-graph MCP servers (your repo, not devmate)

Some teams add a code-graph MCP server (symbol search, call graphs) to their own repo for richer navigation. That is entirely **consumer-side and optional**: devmate itself ships only the zero-dependency memory server above — still no separate install, no MCP server to set up — and nothing in devmate requires, configures, or notices an external one. Evaluated options with honest verdicts: [docs/research/external-code-graph-mcp.md](./research/external-code-graph-mcp.md).

---

## 7. A typical end-to-end flow

Putting it together, here's what a normal session looks like:

1. **Install** devmate and make sure `chat.plugins.enabled` is on (Section 2–3).
2. **Run `/devmate:devmate-init`** once per repo → review the proposed config → confirm → commit `.devmate/devmate.config.json` (Section 4).
3. **Select the orchestrator** agent and describe your task (Section 5b).
4. devmate routes the work through its gated lane; hooks track budget and write resume points automatically (Section 5d).
5. **Open a pull request** for review once the task has passed its gates (Section 5b).

---

## 8. Troubleshooting

For multi-root workspace issues, see [Multi-root setup guide](conventions/multi-root-setup.md).

| Symptom | Likely cause / fix |
|---|---|
| devmate doesn't appear in VS Code | `chat.plugins.enabled` is off. It's org-managed — ask your administrator ([VS Code: Agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)). |
| Hooks/commands error out | Node version. devmate needs **Node 24+** and guards against older versions ([README](../README.md)). |
| My command ran in the terminal / PowerShell instead of executing | You typed the prefix and skill name with a **space** (`/devmate devmate-init`). Use the **colon** form as one token: `/devmate:devmate-init`. Text after a space is treated as arguments, so an unrecognized command can fall through to the terminal (Section 4). |
| `/devmate:devmate-init` won't overwrite my config | By design — it never overwrites silently. Approve a force overwrite only if you really mean to replace your existing config (Section 4). |
| The commands don't appear in the `/` menu | These are user-invocable skills. Make sure the plugin is installed and enabled (Section 3) and that you typed `/` to open the skills menu. If still missing, the plugin may not be loaded — re-check `chat.plugins.enabled` and `enabledPlugins`. |
| I can't find `@devmate-update` / `@devmate-learn` | They are not shipped. The only slash commands are `/devmate:devmate-init`, `/devmate:devmate-map`, and `/devmate:devmate-pr-review` (Section 5a). |
| The specialist agents (orchestrator, fullstack, etc.) don't show up | The plugin ships its agents from its own `agents/` folder (declared in `plugin.json`). Make sure you have the latest version installed and the plugin is enabled (Section 3). Agent files live at `agents/*.agent.md` per the [VS Code custom agents docs](https://code.visualstudio.com/docs/copilot/customization/custom-agents). |
| VS Code asks me to approve every devmate script | Default behavior. Pre-approve devmate's scripts with `chat.tools.terminal.autoApprove` — see Section 5f and the shipped [`.vscode/settings.json`](../.vscode/settings.json) template. |
| `.devmate/MEMORY.md` is empty / memory isn't updating | Run the memory doctor (`scripts/devmate-doctor.mjs`); it names the first broken stage. Common causes: no valid active task (memory writes need a valid taskId), or the session ended in a host that didn't run the `Stop` hook (Section 6). |
| The `query_memory` tool doesn't show up | It's a Claude Code MCP feature. In a VS Code Copilot host the automatic memory still works, but the tool surface may not appear; your host may also ask you to approve the MCP server the first time (Section 6). |

---

## 9. Sources

**Official VS Code / Copilot docs** (every Copilot/VS Code claim above is grounded here):

- VS Code — Agent plugins (Preview): https://code.visualstudio.com/docs/agent-customization/agent-plugins
- VS Code — Agent Skills (skills as slash commands): https://code.visualstudio.com/docs/copilot/customization/agent-skills
- VS Code — Custom agents: https://code.visualstudio.com/docs/copilot/customization/custom-agents
- VS Code — AI settings reference (`chat.tools.terminal.autoApprove`): https://code.visualstudio.com/docs/agents/reference/ai-settings
- VS Code — Manage approvals: https://code.visualstudio.com/docs/agents/approvals

**devmate repo artifacts** (every devmate feature above is grounded here):

- Capability registry (source of truth): [`docs/capability-registry.json`](./capability-registry.json)
- Hooks manifest: [`hooks/hooks.json`](../hooks/hooks.json)
- Commands (skills): the `/devmate:devmate-init`, `/devmate:devmate-map`, and `/devmate:devmate-pr-review` skills under `skills/` (see [`docs/capability-registry.json`](./capability-registry.json))
- Orchestrator agent: [`agents/orchestrator.agent.md`](../agents/orchestrator.agent.md)
- Config reference: [`docs/config.md`](./config.md)
- Delegation floor & report (Section 5g): [`docs/config.md`](./config.md#delegation-floor-optional), [`docs/research/orchestrator-fix-implementation.md`](./research/orchestrator-fix-implementation.md)
- Memory system: [`docs/memory.md`](./memory.md)
- Install / overview: [`README.md`](../README.md)
