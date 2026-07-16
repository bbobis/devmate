---
name: devmate-map
description: Bootstrap a draft business-domain map + context-file stubs from repo structure, then apply to devmate.config.json only after you confirm.
triggers: ['map domains', 'domain map', 'bootstrap domains', 'devmate map', 'infer domains']
tags: ['devmate', 'domains', 'config', 'onboarding', 'context']
negative_triggers: ['implement', 'fix', 'debug', 'review']
---

# devmate Map

Draft a `domains` section for `.devmate/devmate.config.json` from the repo's
actual structure. Nothing touches real config without explicit user
confirmation — generate writes DRAFTS under `.devmate/session/` only.

## Common path

1. **Generate** — run `node "${PLUGIN_ROOT}/scripts/generate-domain-map.mjs"`,
   read `.devmate/session/domain-map-draft.json`, and show the digest
   (domain ids + paths) to the user. Inference is a proposal, never truth.
2. **Review** — invite edits to ids, keywords, and globs in the draft and to
   the stub files under `.devmate/session/domain-contexts-draft/`.
3. **Apply** — only after explicit confirmation:
   `node "${PLUGIN_ROOT}/scripts/apply-domain-map.mjs"`
4. **Report** — domains merged into config + stubs copied to
   `.devmate/contexts/`; remind the user to fill the TODO sections.

Full procedure, heuristics, and caveats: [refs/procedure.md](refs/procedure.md)
