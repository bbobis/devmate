# Unverified VS Code Settings

This document lists VS Code setting keys that **could not be confirmed** against the
[official VS Code AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings)
at the time of the E0-8 audit.

These keys are **excluded from all recommendations** and must not appear in committed
bootstrap or scaffold files. Any scaffold file that previously used an unverified key
has had that key removed or commented out with an `# UNVERIFIED` annotation.

---

## Unverified Keys

No unverified keys were found in the post-audit codebase. The repo's initial state
(devmate fresh rewrite) did not yet contain `.vscode/settings.json` or
`.devmate/*.json` settings scaffolds with unverifiable keys.

If a future issue introduces a scaffold settings file, any key not listed in
`docs/verified-settings.json` must be moved here before merging.

---

## How to Promote a Key to Verified

1. Locate the official VS Code documentation page that explicitly lists the setting key.
   The canonical reference is:
   <https://code.visualstudio.com/docs/agents/reference/ai-settings>
2. Add a new entry to `docs/verified-settings.json`:
   ```json
   {
     "key": "the.setting.key",
     "evidenceUrl": "https://code.visualstudio.com/docs/agents/reference/ai-settings#_section",
     "description": "Short human-readable description from the docs page."
   }
   ```
3. Remove the key from this file (`docs/unverified-settings.md`).
4. Re-run `node scripts/check-settings-keys.mjs` to confirm the guard passes (CI runs it as its own step; it is not part of `npm run verify`).
5. Open a PR — the `check-settings-keys` CI gate will verify the key on every future commit.

---

## Sources Audited

| File                    | Outcome                                |
| ----------------------- | -------------------------------------- |
| `.vscode/settings.json` | Not present in repo at E0-8 audit time |
| `.devmate/*.json`       | Not present in repo at E0-8 audit time |
