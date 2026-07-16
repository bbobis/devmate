---
name: devmate-init
description: Infer and propose a .devmate/devmate.config.json from the repo structure, then write it only after you confirm. Use when setting up devmate in a repo for the first time.
triggers: ['devmate init', 'setup devmate', 'configure devmate', 'init devmate', 'first time setup', 'devmate config', 'initialize devmate']
tags: ['devmate', 'init', 'config', 'setup', 'onboarding']
negative_triggers: ['implement', 'fix', 'debug', 'review', 'refactor']
argument-hint: "[--path <file>] [--force]"
---

# devmate Init

Propose a codebase-specific `.devmate/devmate.config.json` from the repo, and
write it ONLY after the user confirms — never a guessed config, never invented
commands or globs.

## Common path

1. **Generate** — `node "${PLUGIN_ROOT}/scripts/init.mjs" --infer` writes a deterministic
   floor (`.devmate/state/init-proposal.json`) + scanned evidence (`init-evidence.json`).
   Read both; the script is the single source of truth.
2. **Enrich** — from the evidence, select/label checks and tighten personas/globs to
   this codebase. Only select and label — never invent; tag ungrounded items
   `source: "[UNVERIFIED]"`. Edit the proposal in place.
3. **Review** — show the proposal; invite edits to off-limits globs and checks.
4. **Write** — after confirmation (never overwrite without `--force`):
   `node "${PLUGIN_ROOT}/scripts/init.mjs" --infer --write` applies the reviewed proposal.
5. **Report** — path written + reminder to review personas, globs, and checks.

Full flow and flags: [refs/usage.md](refs/usage.md)
