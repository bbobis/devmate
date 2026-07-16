# devmate-map — full procedure

The domain map feeds real machinery: the resolver ranks domains per prompt,
dispatch injects each active domain's context file (budgeted), and the skill
re-rank boosts domain-relevant skills. A stale or wrong map is worse than
none — which is why this flow is human-gated end to end.

## What generate infers (and what it cannot)

`node "${PLUGIN_ROOT}/scripts/generate-domain-map.mjs"` walks the repo
(skipping node_modules, .git, .devmate, dist, build, coverage) and infers
draft domains deterministically — the same tree always produces the same
draft:

1. **Workspace packages** — every top-most directory containing its own
   package manifest becomes a domain (the standard `packages/<name>/`
   monorepo layout).
2. **src subdirectories** — every `src/<name>/` holding at least 5 files
   (provisional threshold) becomes a domain.
3. **Discovery-scan seed (optional)** — when
   `.devmate/state/discovery-candidates.json` exists (the deterministic
   candidate scan), clusters of candidate files outside the domains above can
   add further domains. Its absence changes nothing.

At most 12 domains are kept (largest first); the digest names any dropped.
Keywords come from directory/package-name tokens plus the most frequent
identifier-style tokens in file basenames. **Not inferred:** related domains
(cross-directory import analysis is not performed — fill the stub's
Cross-domain contracts section yourself) and everything marked TODO.

## Reviewing the draft

Edit `.devmate/session/domain-map-draft.json` directly:

- **Domain ids** — kebab-case business names (`billing`, not `pkg-billing2`).
  Rename freely; keep them unique.
- **Good keywords** are the words a human would type in a task — business
  vocabulary (`invoice`, `refund`, `charge`), not tech stack (`controller`,
  `service`, `index`). Remove generic tokens the inference let through; add
  the domain terms only insiders know.
- **Globs** should own the domain's files precisely; split or widen as needed
  (`packages/billing/src/**`, not `packages/**`).
- Delete inferred domains that are infrastructure, not business domains.

Each stub under `.devmate/session/domain-contexts-draft/<id>.md` follows the
context-file template — the sections dispatch will inject once applied:

```
# <id> — domain context (DRAFT — edit before applying)
## Key entry files            <- inferred entry points: say what each does
## Invariants (what NOT to touch)   <- fill in — highest-value section
## Tests to run for this domain     <- inferred when obvious, else fill in
## Cross-domain contracts           <- name adjacent domains + the contract
```

Keep each stub focused (~100–150 lines max): invariants, key files,
what-not-to-touch, domain tests, cross-domain contracts. Dispatch injection
is budgeted — an oversized file degrades to a digest plus a pointer.

## Applying

`node "${PLUGIN_ROOT}/scripts/apply-domain-map.mjs"`:

- refuses to run when the draft file is absent (fail closed);
- validates the merged config with the same validation the loader uses — an
  invalid draft is rejected naming the bad field, and nothing is written;
- merges into `.devmate/devmate.config.json`: existing domain ids are
  updated, new ids appended, ids never duplicated, unrelated config keys
  untouched; re-applying the same draft is idempotent;
- copies the reviewed stubs to `.devmate/contexts/<id>.md`.

Commit the config and context files so the map is shared with the team.
Update `relatedDomains` in the config as the Cross-domain contracts sections
get filled in.
