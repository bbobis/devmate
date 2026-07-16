# devmate Plugin Guide

> A lean overview of the devmate plugin system. For protocol detail, see the cards in `docs/protocols/`.

## What devmate is

devmate is a Node.js-native Copilot plugin that brings loop engineering, TDD, and
token-aware context management to VS Code. It installs as a set of agent files, hook
scripts, and skill cards.

## Core components

| Component | Location | Purpose |
|---|---|---|
| Agent files | `agents/*.agent.md` | Role cards for each specialist agent |
| Hook scripts | `hooks/hooks.json` + `scripts/*.mjs` | Auto-registered event hooks |
| Skill cards | `skills/<id>/SKILL.md` | Opt-in trigger stubs; deep content in `skills/<id>/refs/` |
| Protocol cards | `docs/protocols/` | Shared loop, TDD, debug contracts |
| Capability registry | `docs/capability-registry.json` | Single source of truth for all capabilities |

## Protocols (lazy-loaded)

Protocol prose is **not** embedded here or in agent files. Load as needed:

- [Loop Protocol](docs/protocols/loop-protocol.md) — loop/retry, escalation rules
- [TDD Protocol](docs/protocols/tdd-protocol.md) — Red-Green-Refactor cycle
- [Debug Protocol](docs/protocols/debug-protocol.md) — hypothesis loop, pre-mortem

## How to install

devmate installs as a VS Code agent plugin (Preview). See the [README install section](README.md#install-consumers) for the full marketplace / from-source steps.

Once installed, scaffold your repo config with the init slash command in Copilot Chat:

1. Run `/devmate-init` to infer and propose a `.devmate/devmate.config.json`, then confirm before it writes.

For a full consumer walkthrough of every command, agent, and hook, see the [User Guide](docs/USER_GUIDE.md).

## Token discipline

All tool output is capped: agents receive `{ digest, fullOutputPath }`, never raw logs.
See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [PATTERNS.md](docs/PATTERNS.md).

## Further reading

- [AGENTS.md](docs/AGENTS.md) — full agent roster and wiring diagrams
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture
- [docs/PATTERNS.md](docs/PATTERNS.md) — engineering patterns

---

_devmate — Version B rewrite. Node 24+, ES modules, no build step._
