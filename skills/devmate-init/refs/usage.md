# devmate Init — full guided flow

The `/devmate-init` skill follows generate → enrich → review → write. The
deterministic scan and the write are performed by
`"${PLUGIN_ROOT}/scripts/init.mjs"`, never by the agent directly. The agent's
only job is the **enrich** step in between — and even there it may only select
and label evidence the scan already found. Do not skip the confirmation step.

## Step 1 — Generate

Get the proposal + evidence from the backing script (the single source of truth
— do not invent personas or commands from chat history or docs):

```
node "${PLUGIN_ROOT}/scripts/init.mjs" --infer
```

This scans a bounded set of repo signals (top-level directories, marker files
like `package.json` / `tsconfig.json` / `pom.xml` / `build.gradle`, the real
`src/` layout) **and grounded verification evidence** — `package.json` scripts,
`Makefile` targets, `.github/workflows/*.yml` `run:` steps, and language-marker
conventions (pytest / cargo / go / maven / gradle). It writes two drafts under
`.devmate/state/` and prints a digest only — it writes no real config:

- `init-proposal.json` — the deterministic floor: personas with globs grounded
  in the real layout, plus a `verification.checks` list built from the actual
  commands the scan found. Same repo ⇒ same floor.
- `init-evidence.json` — every candidate the scan saw (`{ command, category,
  source, confidence }`) plus the observed layout. This is the menu the enrich
  step selects from.

Read **both** files. They are the reliable source of truth even when VS Code
shell integration is inactive.

## Step 2 — Enrich

Make the proposal specific to this codebase by editing `init-proposal.json` in
place, using `init-evidence.json` as the menu:

- **Verification checks.** Keep the checks that match how this repo really
  verifies work; drop noise; set `optional: true` on advisory checks; give each
  a human-meaningful `category` (conventional: `unit-test`, `type-check`, `e2e`,
  `lint`, `format`, `build`, `audit`, `contract`, `integration` — but the label
  is open). The check with category `unit-test` drives the TDD gate.
- **Personas.** Rename personas to the codebase's real vocabulary and tighten
  `editableGlobs` / `offLimitsGlobs` to the observed layout.

Hard rule (anti-hallucination): **only select and label evidence — never invent
a command or glob that isn't grounded in `init-evidence.json`.** If you must
propose something ungrounded, set its `source` to `"[UNVERIFIED]"` so the human
sees it needs confirmation.

## Step 3 — Review

Show the enriched proposal to the user. Explain that the globs are heuristics
inferred from the repo layout, not verified boundaries. Invite edits —
especially to the `offLimitsGlobs` (what each persona must not touch) and to the
verification checks.

## Step 4 — Write

Only after the user explicitly confirms, apply the reviewed proposal:

```
node "${PLUGIN_ROOT}/scripts/init.mjs" --infer --write
```

- This **reads the reviewed `init-proposal.json`** and applies it, re-validating
  it before writing — your enrichment and the user's edits are honored. (With no
  proposal on disk it falls back to writing a fresh deterministic floor.)
- If a config already exists, the script refuses to overwrite it. Re-run with
  `--force` ONLY if the user explicitly approves replacing their existing config.
- Pass `--path <file>` if the target is not the default `.devmate/devmate.config.json`.
- The write step also scaffolds `.github/prompts/devmate.prompt.md` — the
  `/devmate` slash command that routes a task straight to the orchestrator. The
  scaffold is create-only: an existing (possibly customised) prompt file is left
  untouched. `--force` replaces the config only, never the prompt file.

## Step 5 — Report

Report the outcome: the config path written, whether the `/devmate` prompt file
was scaffolded (its path) or already present, and a reminder to review the
personas, globs, and verification checks once more, then commit the files.

## Flags

- `--infer` — GENERATE a proposal + evidence from the repo structure (writes no config).
- `--write` — with `--infer`, APPLY the reviewed proposal.
- `--path <file>` — target a non-default config path.
- `--force` — overwrite an existing config (explicit user approval only).
