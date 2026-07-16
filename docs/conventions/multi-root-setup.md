# Multi-root setup

Running devmate in a workspace that spans multiple repos — created and maintained by
[`monoroot`](https://github.com/LP-GTM-Product-Engineering/monoroot).

## 1. Prerequisites

`monoroot` (the **VS Code extension**, previously published under a longer working title) is
required. Manual multi-root
setups are **not supported** — devmate expects the exact workspace-level layout the extension
produces.

- Repository: https://github.com/LP-GTM-Product-Engineering/monoroot
- Minimum extension version: **2.1.0**
- Minimum devmate version: **0.4.0**

Always open VS Code with the generated `.code-workspace` file. Do **not** open a repo subfolder
directly.

> **Producer / consumer split.** The extension is the **sole writer** of the workspace-level
> config (the "hands"); devmate **reads, validates, and orchestrates** (the "eyes"). You never
> hand-edit the merged config — you edit each repo's own `.devmate/devmate.config.json` and run
> **Re-sync devmate** in the extension.

## 2. Required folder layout

The extension's *Create Session* produces this layout:

```text
<worktreeRoot>/
  feature-123/
    feature-123.code-workspace   ← always open THIS in VS Code
    .devmate/                    ← workspace-level; written by the extension
      devmate.config.json        ← merged from all repo configs; do NOT edit manually
      session.json               ← session metadata + { mode, primary, configPath } handshake
      .devmate/MEMORY.md         ← workspace memory (indexes each repo's .devmate/MEMORY.md)
      README.md
      .gitignore                 ← ignores state/ session/ memory/tasks/ *.log; tracks .devmate/MEMORY.md + devmate.config.json
      state/                     ← devmate runtime state (gitignored)
    portals-api/                 ← repo A worktree (has its own .devmate/ as source)
    portals-ui/                  ← repo B worktree (has its own .devmate/ as source)
```

The `.devmate/` folder at the worktree root is the **workspace-level** config. It wins over any
per-repo `.devmate/` folders inside the repo subfolders.

## 3. Creating a session

1. In VS Code, run **Multi-Repo Workspace: Create Session** (or the **+** in the Worktree
   Sessions panel) and pick the branch name + repos.
2. The extension creates the worktrees, **merges each repo's `.devmate` config** into the
   workspace-level `devmate.config.json`, and writes the `.code-workspace` + `session.json`. A
   repo with no `.devmate` config gets a synthesized **fallback persona** (see §6) rather than
   being skipped, so the session is never dead-on-arrival.
3. Open `feature-123.code-workspace` — **not** any subfolder.
4. Run `/devmate:devmate-init`. In multi-root mode this **validates** the existing config; it
   does not re-initialize it. On success it reports the primary repo (from the `session.json`
   handshake) and nudges you about any repo on fallback scoping. On a bad config it does **not**
   dead-end — it names the problem and points you at **Re-sync devmate**.

## 4. Persona naming rule

Persona names are the **dispatch key** the orchestrator uses to route subagent calls to the right
repo. Each name must be **unique across all repos** in the workspace.

Duplicate names are rejected at validation time with an error naming both conflicting repos. To
fix: rename one persona in the affected repo's `.devmate/devmate.config.json`, then run **Re-sync
devmate** to rebuild the workspace config.

Valid two-repo example:

```json
[
  { "persona": "api",      "repo": "portals-api", "editableGlobs": ["src/**"] },
  { "persona": "frontend", "repo": "portals-ui",  "editableGlobs": ["src/**"] }
]
```

## 5. How devmate resolves the workspace

When VS Code opens the worktree root, devmate checks whether `.devmate/` is a **direct child** of
the working directory; if so it short-circuits to that root (step 0 of `resolveRepoRoot`). It also
reads the `session.json` handshake (`readSessionHandshake`) for the authoritative primary + config
path, and **normalizes a cwd that lands *inside* the `.devmate/` folder** back to its parent — so
state is never written to a doubled `.devmate/.devmate/` path.

The stderr line `[devmate] repoRoot resolved: … (step: 0 — multi-root .devmate sibling)` confirms
step 0 fired.

## 6. Per-repo `.devmate/` and fallback personas

Each repo worktree still contains its own `.devmate/devmate.config.json` and `.devmate/MEMORY.md`.
These are **source material** the extension merges into the workspace-level config; they are not
loaded at runtime.

- A repo **with** a config contributes its personas (stamped `source: "repo"`).
- A repo **without** a usable config gets a synthesized **fallback persona** (`source: "fallback"`):
  whole-repo editable, minus a seeded deny-list of secrets / keys / CI / infra. The session runs
  immediately; devmate emits a non-blocking nudge naming those repos so you can upgrade them to
  real scoping.

The workspace-level config is the **authoritative runtime config**. Don't hand-edit it — edit a
repo's own config and run **Re-sync devmate**.

## 7. Repairing & changing a session (no tear-down)

From a session's context menu in the extension's Sessions panel:

- **Re-sync devmate** — re-read every repo's `.devmate` and rebuild the merged config in place.
  Run this after init'ing a repo that was on fallback, or whenever a repo's personas change.
- **Add Repo to Session** / **Remove Repo from Session** — grow or shrink a session without
  recreating it.
- **Set Primary Repo** — change the orchestrator entry point.

The Sessions tree also shows a per-repo **readiness board**: `ready`, `fallback` (on a synthesized
persona), or `drifted` (init'd since the last merge — run Re-sync).

## 8. The config contract

The shape of the merged config is a versioned contract shared by both tools:

- Canonical schema: `schema/devmate-config.schema.json` in the extension, vendored byte-identical
  into devmate at `docs/devmate-config.schema.json`.
- Both sides validate against a shared fixtures corpus (`test/fixtures/config-contract`, also
  byte-identical) pinned by `contractVersion`. Every fixture carries a **scope tag** in the
  manifest — `both`, `consumer`, or `producer-merge` — naming who must exercise it, so neither
  side can silently skip a fixture.
- Additive fields (like `source` / `synthesized` / `contractVersion`) do not bump `schemaVersion`;
  devmate rejects a config numbered newer than it supports with an upgrade pointer.
- Contract v4 publishes the session-artifact protection keys (`sessionArtifactPaths`,
  `sessionArtifactWriters`, see [`docs/config.md`](../config.md)): the extension propagates them
  from the **primary** repo's config into the merged config, dropping a malformed policy rather
  than writing a config devmate would refuse to load. Omit them and the protective defaults apply.
- The producer stamps its `contractVersion` into the merged config; when it differs from the
  version devmate targets, `devmate-init` prints a non-blocking **skew nudge** naming both
  versions (fail-open — an unstamped config from an older producer never nudges).
- The **session handshake** (`.devmate/session.json`) is formalized the same way: canonical schema
  `schema/session-handshake.schema.json` in the extension, vendored at
  `docs/session-handshake.schema.json`, with a shared corpus at `test/fixtures/session-handshake`
  pinned by `handshakeVersion`.
- A CI **drift guard** (`node scripts/check-contract-drift.mjs`, part of `npm run verify`) pins an
  EOL-normalized hash of every shared file — any edit fails until the hash is deliberately bumped
  with the contract version — and, when a monoroot checkout sits at `../monoroot` (overridable via
  the `DEVMATE_MONOROOT_PATH` environment variable), diffs the shared files across the two repos,
  self-skipping when the sibling is absent.

See [`docs/config.md`](../config.md) for the field reference.

## 9. Opening correctly

| Do | Don't |
|---|---|
| Open `feature-123.code-workspace` in VS Code | Open `portals-api/` or `portals-ui/` directly |
| Use File › Open Workspace from File… | Drag a subfolder into VS Code |
| Run devmate skills from the workspace root terminal | Run devmate from inside a repo subfolder |

## 10. Upgrading existing sessions

Coming from an older build? Update the extension to **2.1.0** and devmate to **0.4.0**, then
for each existing session:

1. **Run "Re-sync devmate"** — rebuilds the merged config in place, writes the current
   `.gitignore`, populates the `session.json` handshake, and synthesizes fallback personas for
   un-init'd repos.
2. **Delete leftover debris**: any doubled `.devmate/.devmate/` folder and any `.devmate/evals/`
   folder inside a session (the resolver fix stops them recurring but won't clean what's there).
3. Legacy sessions from the old PowerShell `meta\` layout aren't auto-migrated — recreate them with
   **Create Session**.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `repoRoot resolved` log shows a repo subfolder, not the worktree root | VS Code opened a subfolder, not the `.code-workspace` file | Close VS Code; open `feature-123.code-workspace` via File › Open Workspace from File… |
| `devmate-init` reports a validation problem | The merged config drifted, or a repo's config is malformed | Follow the printed pointer: fix the offending repo's `.devmate/devmate.config.json` (or run `devmate init` in it), then run **Re-sync devmate** |
| `devmate: duplicate persona 'X' found in repos 'A' and 'B'` | Two repos declare a persona with the same name | Rename one persona in the affected repo's `devmate.config.json`, then run **Re-sync devmate** |
| `personas[N].repo must be a non-empty string in multi-root mode` | A per-repo config's persona is missing its `repo` field | Add `"repo": "<repo-folder-name>"` to the persona, then run **Re-sync devmate** |
| A repo shows `fallback scoping` in the readiness board | The repo has no `.devmate/devmate.config.json` | Add one (or run `devmate init` in it), then run **Re-sync devmate** |
| A repo shows `drifted — run Re-sync` | The repo gained a config after the last merge | Run **Re-sync devmate** |
| Plugin state appears under a doubled `.devmate/.devmate/` path | An older build (pre-0.4.0) resolved a `.devmate` cwd incorrectly | Upgrade to 0.4.0 and delete the stray `.devmate/.devmate/` folder |
