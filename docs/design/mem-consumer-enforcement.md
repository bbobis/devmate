# Memory enforcement in a consumer repo (devmate installed elsewhere)

> **Design doc (#153, Memory v2 / epic #144).** Output is this enforcement matrix + a
> recommendation + follow-up issues — no production code. Grounded in
> [`.plugin/plugin.json`](../../.plugin/plugin.json),
> [`lib/init/devmate-init.mjs`](../../lib/init/devmate-init.mjs),
> [`lib/init/layout.mjs`](../../lib/init/layout.mjs), and
> [`docs/USER_GUIDE.md`](../USER_GUIDE.md). Anything not verifiable from this repo is
> tagged `[UNVERIFIED]` and kept out of the recommendation.

## The gap

Every enforcement classification in the Memory v2 assessment was run against **devmate's
own repository**. But devmate is a **plugin installed into other repos**
([`docs/USER_GUIDE.md:12`](../USER_GUIDE.md) — "developers who install devmate into their
repo"), delivered via a private plugin marketplace. A plugin install delivers the plugin
package — [`.plugin/plugin.json`](../../.plugin/plugin.json) names `agents/`, `skills/`,
`hooks/hooks.json`, and the hooks invoke `${PLUGIN_ROOT}/scripts/*.mjs` which import from
`lib/`, so `scripts/` and `lib/` ship in the package too (`.plugin/marketplace.json` sources
`./`). But that package lands in the host's plugin install/cache dir — it is **never
committed into the consumer's own tree**, and it brings no `ci.yml` / `.github/`. The
distinction that matters is not *delivery* but *where a check runs*: GitHub Actions only runs
a workflow committed to the **consumer's** `.github/`, and nothing makes the consumer's CI run
devmate's `scripts/check-*.mjs` against the consumer's PRs.

So the trust boundary the assessment concluded any safe committed-memory system needs — CI
that blocks direct edits to promoted memory, schema validation, secret scanning,
deterministic-regeneration verification, CODEOWNER routing — **does not run against a
consumer repo's changes, and a plugin cannot make it: it cannot commit a workflow into the
consumer's `.github/workflows/`.** A design that leans on "CI + human PR review"
silently asks each consumer team to build and maintain that boundary. This doc decides,
per mechanism, what devmate can actually ship versus what a consumer must opt into.

## What devmate ships into a consumer repo today

| Delivered by the plugin | Mechanism | Consumer-repo enforcement class |
| --- | --- | --- |
| `agents/`, `skills/`, `hooks/hooks.json` | plugin manifest | code, runs in the host |
| the `STATE_DIRS` layout (`.devmate/state`, `…/state/trace`, `…/state/handoff`, `…/state/worker-returns`, `…/state/compaction`, `…/state/repo`, and `.devmate/memory/tasks`); a seed `.devmate/MEMORY.md` (`MEMORY_SEED`, create-only); a `.devmate/.gitignore` that **tracks** `.devmate/MEMORY.md` + `devmate.config.json` and ignores `state/ session/ memory/tasks/` | `ensureDevmateLayout` on `SessionStart` (`lib/init/devmate-init.mjs`, `lib/init/layout.mjs`) | `structural` **at seed time**, but fail-open (a `SessionStart` that never fires seeds nothing) |

Crucially, the seeded `.gitignore` already makes the committed-memory *storage* decision for
the consumer: `.devmate/MEMORY.md` is tracked; the ledger (`state/repo/repo.jsonl`) and task-local
staging (`memory/tasks/`) are not. That matches the kernel (#149/#150): what a clone
carries is the rendered `.devmate/MEMORY.md`, never the private ledger.

## Enforcement matrix (consumer-repo context)

Each memory mechanism, classified for a repo that *installed* devmate. The PATTERNS
taxonomy (`structural | ci-enforced | hook-runtime | prompt-only | aspirational`) is
re-evaluated for the consumer context — a mechanism that is `ci-enforced` in devmate's repo
is often **not available** in a consumer's.

| Mechanism | In devmate's repo | In a consumer repo | Verdict |
| --- | --- | --- | --- |
| **Collection** — PostToolUse fact-writer → `memory/tasks/<taskId>.jsonl` | `hook-runtime` | `hook-runtime` (ships in `hooks/`) | **shippable-by-seeding** |
| **Promotion** — session-stop / compaction / complete-task → `repo.jsonl` | `hook-runtime` | `hook-runtime` (ships) | **shippable-by-seeding** |
| **Render** — regenerate `.devmate/MEMORY.md` from the ledger, write-on-change (#149) | `hook-runtime` | `hook-runtime` (ships) | **shippable-by-seeding** |
| **Recall injection** — `SessionStart` recall block + fresh-clone fallback (#149) | `hook-runtime` | `hook-runtime` (ships) | **shippable-by-seeding** |
| **Discovery-fact freshness** — verify-before-use content digest (#148) | `structural` | `structural` (ships in the query/recall code) | **shippable-by-seeding** |
| **Dispatch-memory budget** — cap the injected memory (#151) | `structural` | `structural` (ships) | **shippable-by-seeding** |
| **Layout + gitignore + seed `.devmate/MEMORY.md`** | `structural` at seed | `structural` at seed (fail-open) | **shippable-by-seeding** |
| **Pipeline health check** — `diagnoseMemory` / `devmate-doctor` | script, run by `npm run verify` here | a bundled script the consumer must *choose* to run | **consumer-CI-required** (devmate can provide a drop-in) |
| **Canonical-path guard** — `check-memory-path-refs` | `ci-enforced` | n/a — it guards *devmate's own source*, not a consumer's memory content | **out-of-scope** (devmate-source guard) |
| **State-writer guard** — `check-state-writers` | `ci-enforced` | n/a — guards devmate's code | **out-of-scope** (devmate-source guard) |
| **Promotion guardrails** — CI blocks direct edits to promoted memory; schema validation; secret scanning; deterministic-regeneration verify | `ci-enforced` + `.github/` | **does not exist**; a plugin cannot install a workflow | **consumer-CI-required** (devmate can ship a drop-in snippet) |
| **CODEOWNER routing of memory changes** | `.github/CODEOWNERS` | consumer owns their `.github/` | **out-of-scope** (consumer policy) |

### The two honest conclusions

1. **The memory *pipeline* is fully shippable.** Collect → promote → render → recall, plus
   freshness and the dispatch budget, are all code that runs in the host via the plugin's
   hooks and seeded layout. A consumer gets working committed-memory recall with **zero**
   setup beyond installing devmate — fail-open and host-gated, exactly like every other
   devmate hook.

2. **The promotion *guardrails* are not.** The part that makes committed memory *safe at
   scale* — rejecting a hand-edit to `.devmate/MEMORY.md` that doesn't match a deterministic
   regeneration from the ledger, scanning promoted content for secrets, schema-validating
   entries — is a CI concern, and a plugin cannot add CI to someone else's repo. Without it,
   a consumer's committed `.devmate/MEMORY.md` is trusted-by-convention: anyone with write access can
   edit it directly, and nothing re-derives or scans it.

## Recommendation — the minimal consumer surface

**(a) Ship the pipeline by seeding (already done).** No new work: the kernel hooks + the
seeded `.gitignore`/`.devmate/MEMORY.md` give a consumer recall out of the box. Keep committed memory
**per-repo**: `.devmate/MEMORY.md` lives inside the repo it describes and is tracked there; the ledger
stays local. This is what `loadRepoMemories` already assumes and what the seeded gitignore
already encodes.

**(b) Provide an OPT-IN drop-in CI check — do not pretend it is automatic.** Devmate should
expose a single bundled command — e.g. `npx devmate check-memory` (or a documented
`node .../check-memory.mjs`) — that a consumer adds to their own `.github/workflows/`, giving
them the promotion guardrails without building them. Minimal surface for v1:
  - **Deterministic regeneration:** re-render `.devmate/MEMORY.md` from the committed ledger inputs
    available in the clone and fail if the committed file differs — the check that catches a
    hand-edit. (Note the tension: the ledger is git-ignored, so "regenerate from committed
    inputs" needs the consumer to *also* commit a source of truth, or the check degrades to
    "the block between the sentinels parses and is within budget." This is the crux the
    follow-up must resolve.)
  - **Secret scan** of the promoted content (reuse `redactSecrets` from
    `lib/loop/output-cap.mjs`).
  - **Bounds:** the rendered file is within the soft cap (reuse the render's oversize signal).
The check must be **loud on opt-out**: if a consumer has committed memory but no workflow,
`devmate-doctor` should note that the promotion guardrails are unenforced — surfaced, never
silently assumed.

**(c) Out of scope for devmate to ship:** CODEOWNER routing, branch-protection rules, and
marketplace-private policy — these are the consumer's `.github/` and org settings. Document
them as *recommended consumer configuration* in the USER_GUIDE, not as something devmate
enforces.

## The five key questions, answered

1. **What does `devmate-init` seed, and what would committed memory need?** It seeds the
   `STATE_DIRS` layout, a minimal `.devmate/MEMORY.md` (`MEMORY_SEED`), and a `.devmate/.gitignore`
   that already tracks `.devmate/MEMORY.md` + `devmate.config.json` and ignores `state/ session/
   memory/tasks/`. Committed memory needs **nothing more** for storage — the decision is
   already seeded. It needs the *guardrail* surface of (b) to be *safe*.
2. **Hooks vs. consumer CI?** The whole pipeline (collect/promote/render/recall/freshness/
   budget) is hooks/code and ships. Everything that *blocks a bad state* (regen-verify,
   secret scan, schema) is CI and does not ship — it becomes the opt-in drop-in of (b).
3. **Drop-in CI snippet?** Yes — a `check-memory` subcommand + a documented reusable
   workflow YAML is the minimal surface. It is the single lever that turns
   trusted-by-convention memory into verified memory in a consumer repo.
4. **Where does committed memory live / collisions?** Per-repo, at `.devmate/MEMORY.md`,
   tracked; the seeded `.devmate/.gitignore` is scoped to `.devmate/` and does not touch the
   consumer's root `.gitignore` or `.github/`, so there is no collision with consumer
   conventions.
5. **Multi-root / monoroot committed shards?** `[UNVERIFIED]` — when the workspace-root
   `.devmate/` is not inside a single git repo, there is no obvious repo to commit a shard
   into. The monoroot sibling repo's config (`src/devmateConfig.ts`) and its git membership
   were not read here (out of this environment's reach) and must not be assumed. Recommend a
   dedicated spike before designing multi-root committed shards; the per-repo model in (a)
   covers the single-root and per-persona-repo cases, which is where the kernel already works.

## Follow-ups (filed from this doc)

- **Shippable — #212:** a `check-memory` bundled command + a drop-in reusable GitHub workflow
  the consumer opts into (guardrail (b)); resolve the "regenerate from committed inputs when
  the ledger is git-ignored" crux as part of it.
- **Shippable — #213:** `devmate-doctor` surfaces an "unenforced committed memory" notice when
  a repo tracks `.devmate/MEMORY.md` but has no promotion-guardrail workflow.
- **Deferred (needs a spike):** multi-root / monoroot committed-shard placement — blocked on
  reading the monoroot config + workspace-root git membership (`[UNVERIFIED]`).
- **Deferred (consumer policy, documented not enforced):** CODEOWNER routing + branch
  protection for `.devmate/MEMORY.md`, as recommended USER_GUIDE configuration.
