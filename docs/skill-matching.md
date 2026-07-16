# Skill matching — how devmate chooses which skill to load

> **Scope:** the end-to-end skill-selection pipeline: how the catalog is loaded,
> how a prompt is matched to skills, how workflow state and the model refine that
> choice, and how the whole thing is observed and regression-tested. Build rules
> live in [CONTRIBUTING.md](../CONTRIBUTING.md); the pattern catalog and honest
> enforcement labels live in [PATTERNS.md](./PATTERNS.md) (TCM-4/TCM-5, P19–P22).

## Why this exists

Skills are progressive-disclosure bundles (TCM-4): a tiny `SKILL.md` trigger stub
plus lazy `refs/`. Loading the wrong skill wastes a whole skill body in context;
failing to load the right one forces an agent to improvise. So on every prompt the
UserPromptSubmit hook decides which skills are relevant — cheaply, deterministically,
and without an LLM call for the common case (TCM-5).

The selection is **layered**: each layer handles what the layer before it cannot,
and each is independently observable and testable.

```
prompt ─▶ [load] plugin ∪ workspace catalog
       ─▶ [Stage 1] lexical scoring  (triggers, negatives, morphology)
       ─▶ [Stage 2] state re-rank    (lane/gate priors, lane force-include)
       ─▶ operating-point cut → .devmate/state/skill-matches.json  (file, orchestrator reads it)
       ─▶ [Stage 3] intent-gated menu (new-task/steer turns → model-visible stdout)
       ─▶ every candidate logged → .devmate/state/skill-decisions.jsonl
```

## Loading the catalog (dual root)

Plugin skills ship **inside the plugin** and the project may add its own. The loader
merges both roots (`loadMergedSkillManifests`, `lib/skills/skill-manifest.mjs`):

- **Plugin root** — resolved from `PLUGIN_ROOT`, falling back to the hook
  file's own location when the env var is unset. Never the consumer's working
  directory. (Resolving against the workspace was the historical "empty catalog"
  bug: an installed deployment matched every prompt against a directory that did
  not exist, so every prompt was a miss.)
- **Workspace root** — the project's own skills under `.devmate/skills/`.
- **Merge rule** — a later root (workspace) overrides an earlier one (plugin) on a
  `skillId` collision, **except** a reserved set of gate-machine skills the plugin
  owns exclusively (`RESERVED_SKILL_IDS`: the three orchestrator lane skills), which
  a workspace skill can never shadow.
- **Fault isolation** — a missing or unreadable root yields zero skills, never an
  error, so one bad root can never blank the catalog.
- **Provenance** — every manifest is tagged with its `source` (`plugin` / `workspace`),
  and per-root counts are reported for the decision ledger's canary.

## Stage 1 — lexical scoring (no LLM)

`scoreAll(query, manifests)` scores every manifest against the normalized prompt
tokens (`lib/skills/semantic-matcher.mjs`). The score is additive, capped at 1.0:

| Signal | Weight | Notes |
|---|---|---|
| Trigger phrase (verbatim, contiguous) | 0.5 | first matching phrase only |
| Trigger/synonym token overlap | 0.2 each, capped 0.3 | exact **or** morphological match |
| Tag match (all tokens present) | 0.15 each, capped 0.3 | |
| skillId token in query | 0.1 | |
| Position bonus (trigger token in first 3 words) | 0.05 | |

Two refinements make ordinary phrasings match reliably:

- **Phrase-level negative triggers.** A negative fires only when its whole tokens
  appear as a **contiguous run**, not on any single shared token. Previously a
  multi-word negative hard-excluded a skill on an incidental word — the coding
  skills' own `write code` trigger was killed by their `write docs` negative (shared
  `write`), and a bug report mentioning a test was excluded from the bug lane by its
  `unit test`/`write test` negatives (shared `test`). Single-word negatives are
  unchanged.
- **Trigram morphology** (`lib/skills/trigram.mjs`). A query token counts toward
  trigger overlap when it matches a trigger token exactly **or** morphologically, so
  inflected forms unify (`vulnerabilities`~`vulnerability`, `tests`~`test`,
  `throws`~`throw`) without a stemmer. A start-of-word guard plus a calibrated
  similarity threshold reject interior-substring lookalikes (`test`∈`latest`,
  `bug`∈`debug`, `readme`∈`read`).

`selectMatches` then applies the **operating point** — the single source of truth in
`lib/skills/operating-point.mjs` (top-3, minimum confidence 0.25), imported by both
the hook and the eval so they can never disagree. It drops negatively-triggered and
below-floor candidates and caps the result.

## Stage 2 — state-conditional re-rank

Lexical scoring only sees the prompt text. A mid-implementation paraphrase like "why
is this value undefined at runtime" carries no trigger tokens — but the durable
workflow state says which skill is almost certainly needed. `rankWithContext` /
`selectWithContext` (`lib/skills/context-rank.mjs`) add priors from `task.json`:

- **Lane force-include.** During an active lane, that lane's orchestrator skill
  (`orchestrator-<lane>-lane`) is boosted and **always surfaced**. The matcher may be
  wrong about which *secondary* skill to load, but never about whether to load the
  lane skill mid-lane.
- **Debug gate boost.** At an implementation gate (`impl-started`,
  `verification-passed`) the debug skill (`tdd-debug`) is boosted, so debugging
  paraphrases surface it.
- **Domain prior (DN-5).** When the domain resolver (DN-2, see
  [context-management.md](context-management.md)) has resolved active business
  domains for the prompt, the hook extends the match context with the domain ids
  and their configured keywords, and `rankWithContext` adds `DOMAIN_PRIOR` (0.2,
  provisional) once per active domain whose vocabulary (keywords ∪ the domain id)
  intersects the skill's matchable tokens (tags ∪ synonyms ∪ trigger tokens ∪
  skillId tokens; same normalization and trigram morphology as Stage 1), capped
  at `DOMAIN_PRIOR_CAP` (0.3, provisional) total. So a consumer repo's
  `payments-hardening` skill surfaces when the billing domain is active without
  the user typing a trigger word. Deliberately weaker than every workflow-state
  signal (below the lane and debug priors, and the cap sits below the 0.5
  trigger-phrase weight) and **never force-included** — a wrong domain map can
  waste a prior; it cannot force a skill in, displace a lexically-strong rank-1
  match on its own, or push a zero-lexical skill past the confidence floor. The
  resolution is computed once per prompt and shared with the domain-context
  writer — never re-resolved.

Priors are additive, capped, deterministic, and never resurrect a negatively-triggered
skill. A fresh session (no lane/gate) is a **no-op**, so nothing changes outside an
active task. The active workflow gate is read from the durable `workflowGate` field of
`task.json`.

## Delivery

The selected matches are written to `.devmate/state/skill-matches.json` (atomic
tmp+rename), with a one-line hint. The orchestrator consults this file before loading
heavy skills — the load decision itself stays prompt-mediated.

## Stage 3 — intent-gated skill menu (model self-selection)

Some prompts have neither trigger tokens nor workflow-state signal — stateless
library-skill paraphrases like "how should I name this variable" or "are we storing
passwords in plaintext". No lexical or state rule can cleanly rescue these, so the
final layer hands the choice to the model, which resolves paraphrase natively.

On **new-task and steer turns** (classified by the deterministic turn-intent
classifier), the hook emits the full catalog — one line per skill, from its
frontmatter `description` — as a `<devmate-skills>` block into the model-visible
stream (`lib/skills/skill-menu.mjs`). The model picks the skill that fits. The menu is
emitted only on those turns, so its token cost is paid a handful of times per session,
not every prompt; approve / question / status / chat / deferred turns emit nothing.

## Observability — the decision ledger

Every decision is appended to `.devmate/state/skill-decisions.jsonl`
(`lib/skills/decision-ledger.mjs`): the **full** scored candidate list (including
negatively-triggered and below-floor candidates that never surface), the selected
subset, the operating point, the turn intent, and the `manifestsLoaded` / `sources`
canary. The write is awaited and exclusive-locked (the worker-telemetry pattern), so
concurrent writes never interleave.

This closes what used to be a triple-blind telemetry hole: the old miss-log recorded
only zero-result misses, stripped excluded candidates before logging, and wrote via an
un-awaited fire-and-forget. Now a silently-excluded skill is a first-class ledger row,
and an empty plugin catalog (the loader bug) shows up as `manifestsLoaded: 0`. The
ledger is the input to the nightly telemetry mining (issue #366).

## Measurement — the eval and its baseline

`evals/skill-matching/` grades the matcher against a labelled corpus at the exact
production operating point:

- **scorer** (`scorer.mjs`) reports `recall` (should-load phrasings that surfaced the
  skill), `precision` (must-not phrasings that stayed out), and `suppressRate` (a
  safety metric: should-load phrasings that returned zero results — the case that
  triggers the "no skills matched" hint). `neverFalseSuppress` (suppressRate 0) is the
  target.
- **fixtures** (`fixtures/<skillId>.json`) are seeded from real defects and bucketed
  (exact / morphology / negative / paraphrase / state-rescue). State-rescue cases carry
  per-case workflow `context`.
- **baseline** (`baseline.json`) is the committed, measured state. CI gates
  **non-regression**: recall/precision may not fall below the baseline and suppressRate
  may not rise above it, so any change that helps ratchets the numbers up and any
  regression fails `verify`. The suite (`suite.test.mjs`) runs inside `npm test`.

The stateless-paraphrase bucket reads low in this lexical eval **by design** — that
class is handled by the Stage-3 menu (model choice), which a deterministic eval cannot
score. The menu is instead validated by a *coverage* test: the right skill is always
present in the emitted catalog.

## Enforcement status

| Layer | Where | Enforcement |
|---|---|---|
| Progressive-disclosure bundles | `validate-skill-split` (CI) | ci-enforced (TCM-4) |
| Lexical matcher runs, matches persisted | UserPromptSubmit hook | hook-runtime (TCM-5) |
| Dual-root merge, reserved ids, fault isolation | `loadMergedSkillManifests` | structural (P19) |
| State re-rank + lane force-include | UserPromptSubmit hook | hook-runtime (P20) |
| Intent-gated menu | UserPromptSubmit hook | hook-runtime (P21) |
| Decision ledger (every candidate) | UserPromptSubmit hook | hook-runtime (P22) |
| Non-regression eval | `evals/skill-matching/` in `npm test` | ci-enforced (extends P7) |

## Adding or customizing a skill

- **Plugin skill:** add `skills/<id>/SKILL.md` with frontmatter — `name`,
  `description` (the menu line), `triggers`, optional `tags`, `synonyms`,
  `negative_triggers`, `priority` (lower = higher; lane skills 1–2, gate/utility 3,
  libraries 5+). Keep the stub within the line budget (TCM-4); deep content goes in
  `refs/`.
- **Project skill:** drop the same structure under `.devmate/skills/<id>/`. It merges
  with the plugin catalog and wins on a non-reserved id collision.
- **Recall tuning:** prefer adding `synonyms` (they widen token overlap without
  polluting the exact-phrase triggers) over broadening triggers. Use `negative_triggers`
  as whole phrases; a single-word negative fires on that word alone.
- **Verify:** the eval measures the operating point; add a fixture for a phrasing that
  should (or must not) match, and `npm run verify` will hold the line.

## File map

| Concern | File |
|---|---|
| Load + merge | `lib/skills/skill-manifest.mjs` (`loadMergedSkillManifests`, `RESERVED_SKILL_IDS`) |
| Lexical scoring | `lib/skills/semantic-matcher.mjs` (`scoreAll`, `selectMatches`, `scoreManifest`) |
| Morphology | `lib/skills/trigram.mjs` |
| Operating point | `lib/skills/operating-point.mjs` |
| State re-rank | `lib/skills/context-rank.mjs` (`rankWithContext`, `selectWithContext`) |
| Menu | `lib/skills/skill-menu.mjs` (`buildSkillMenu`, `shouldEmitMenu`) |
| Decision ledger | `lib/skills/decision-ledger.mjs` |
| Hook wiring | `hooks/approval-listener.mjs` |
| Eval | `evals/skill-matching/` |
