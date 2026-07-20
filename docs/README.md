# devmate — Documentation

devmate is a **GitHub Copilot plugin for VS Code** that turns ad-hoc AI coding into a deterministic, gated, resumable workflow. This folder is the design reference for the fresh rewrite.

## Read in this order

1. **[SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md)** *(canonical entry)* — the integrated end-to-end view and system diagram; every other doc below is authoritative for its own scope and defers here for the cross-cutting picture.
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how a request flows, every component, and how the Copilot artifacts (agents, prompts, skills, hooks, instructions) connect.
3. **[AGENTS.md](./AGENTS.md)** — the full agent roster (orchestrator + specialists + utilities), what each does, and how they hand work to each other (`agents` dispatch and `handoffs`).
4. **[PATTERNS.md](./PATTERNS.md)** — the design patterns behind it all: the 12 Token & Context Management rules (the secret sauce) and the workflow/agent patterns, each with why/benefit/enforcement status.
5. **[orchestrator-conversation.md](./orchestrator-conversation.md)** — the orchestrator turn lifecycle: how the three layers (LLM interprets, state machine validates, hooks enforce) handle every user turn — re-anchor, classify intent, act.

Build conventions live in **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — `.mjs` + JSDoc, Node 24+ guard, capped tool output, `node:test`.

## Mechanism references

Each of these is authoritative for exactly its own mechanism:

- [gates.md](./gates.md) — gate names, statuses, `gatectl` syntax
- [state-management.md](./state-management.md) — how `task.json` is mutated: `stateVersion`, the atomic mutation API, the transition log, the writer guard
- [gate-guard.md](./gate-guard.md) — the fail-closed PreToolUse guard
- [skill-matching.md](./skill-matching.md) — how skills are chosen: dual-root loading, lexical scoring, state re-rank, the intent-gated menu, the decision ledger, and the eval
- [artifacts.md](./artifacts.md) — session artifacts + spec digest flow
- [memory.md](./memory.md) — fact ledger, promotion, rendered memory
- [context-management.md](./context-management.md) — budget classes (`tiny`/`standard`/`large`), thresholds, compaction
- [config.md](./config.md) — `devmate.config.json` reference
- [hooks.md](./hooks.md) — hook registrations and payloads
- [discovery-scan.md](./discovery-scan.md) — deterministic, zero-LLM-cost candidate-file scan (fan-out/fan-in Phase 1)
- [discovery-merge.md](./discovery-merge.md) — discovery-artifact fan-in merge: dedup, corroboration, conflicts, rank-before-cap (fan-out/fan-in Phase 2)
- [transition-matrix.md](./transition-matrix.md) — the model-based exhaustive gate × event × lane E2E net: oracle sources, nightly/PR budget split, golden-cell guardrails
- [SCRIPTS.md](./SCRIPTS.md) — every CLI script, usage and exit codes
- [model-policy.md](./model-policy.md) — model routing policy (no hardcoded IDs)
- [agent-capability-rules.md](./agent-capability-rules.md) — claim-to-tool mapping rules
- [CURRENT_BEHAVIOR.md](./CURRENT_BEHAVIOR.md) — generated ground truth (do not hand-edit)

## How these docs connect to the backlog

Each component and pattern maps to an epic (E0–E8) and its issues. See the **Pattern → epic quick map** at the end of [PATTERNS.md](./PATTERNS.md), and the epic tracking issues in this repo.

## Grounding

Every claim about a Copilot capability (agents, prompts, skills, hooks, instructions) is grounded to official docs only:

- [VS Code custom agents](https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- [VS Code prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [VS Code hooks](https://code.visualstudio.com/docs/copilot/customization/hooks)
- [VS Code custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [GitHub Copilot repository custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)

Anything not backed by an official source is marked `[UNVERIFIED]` and kept configurable (for example, concrete model IDs are never hardcoded).

_Documentation index for the fresh rewrite. Source: devmate Version B Rebuild Blueprint (this Space)._