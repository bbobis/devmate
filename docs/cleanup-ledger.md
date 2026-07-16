# Artifact Cleanup Ledger — E0-2 / E0-4

> This file records every deletion and archive decision made during the E0-2
> artifact cleanup, and every content extraction made during the E0-4 protocol
> card refactor. It is the human-readable complement to
> `docs/artifact-allowlist.json`.

## Audit date: 2026-06-24

---

## E0-2: Initial artifact audit decisions

### Methodology

The repo was audited against the Version B Rebuild Blueprint criteria
(`ws1-artifact-audit.md:686-691`, `ws1-artifact-audit.md:784-803`):

- **DELETE** — release-note stubs with no matching release, template-era
  placeholder files, development-plan documents predating the current rebuild
  scope, and files with no content value for the Version B rewrite.
- **ARCHIVE** — files containing accurate human-facing release history that
  must be preserved but are no longer agent-loadable.
- **KEEP** — files that are correct, current, and belong in the agent-loadable
  surface or serve an active engineering function.

### Decisions

| File                             | Decision | Rationale                                              |
| -------------------------------- | -------- | ------------------------------------------------------ |
| `hooks/hooks.json`               | **KEEP** | Canonical hook manifest from E0-1. Agent-loadable.     |
| `docs/AGENTS.md`                 | **KEEP** | Active agent-instruction file; loaded every session.   |
| `docs/ARCHITECTURE.md`           | **KEEP** | Current system architecture; agent-loadable reference. |
| `docs/PATTERNS.md`               | **KEEP** | Active engineering patterns doc.                       |
| `docs/README.md`                 | **KEEP** | Docs index; human + agent readable.                    |
| `docs/hooks.md`                  | **KEEP** | Hook system reference.                                 |
| `docs/IMPLEMENT_ISSUE.prompt.md` | **KEEP** | Active autonomous prompt template.                     |
| `docs/artifact-allowlist.json`   | **KEEP** | This issue's output; the allowlist itself.             |
| `docs/cleanup-ledger.md`         | **KEEP** | This file; human-only history record.                  |

### No files flagged DELETE in this repo

The current `main` branch (post E0-1 merge) contains no release-note stubs,
no template-era placeholder files, and no stale development-plan documents.
All files in `.devmate/`, `docs/`, and `hooks/` are either:

1. Actively used by the running agent/hook system, **or**
2. Engineering documentation that supports the Version B rebuild.

No deletions or archives were required. The allowlist (`docs/artifact-allowlist.json`)
enumerates all remaining agent-loadable files as the single source of truth.

---

## E0-4: Protocol card extraction (issue #6)

### What was extracted

Embedded loop, TDD, and debug protocol prose was identified as the primary
context-bloat risk in agent and skill files
(`ws1-artifact-audit.md:11-11`, `ws1-artifact-audit.md:1043-1053`).
Each section was extracted into a standalone protocol card under `docs/protocols/`
and replaced with a one-line lazy-load reference in the source file.

### Extraction log

| Extracted section                                 | Source                                         | Destination                        | Reference added                                                          |
| ------------------------------------------------- | ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Loop/retry cycle, retry limit, escalation rules   | orchestrator, backend, frontend agent prose    | `docs/protocols/loop-protocol.md`  | `> Protocol: see [Loop Protocol](../../docs/protocols/loop-protocol.md)` |
| Red-Green-Refactor cycle, output contract         | `tdd-debug/SKILL.md` + frontend/backend agents | `docs/protocols/tdd-protocol.md`   | `[TDD Protocol](../docs/protocols/tdd-protocol.md)`                      |
| Hypothesis loop, pre-mortem checklist, escalation | diagnose agent + backend agent                 | `docs/protocols/debug-protocol.md` | `[Debug Protocol](../docs/protocols/debug-protocol.md)`                  |

### Files refactored

| File                                   | Before                     | After                                 | Budget (maxLines) |
| -------------------------------------- | -------------------------- | ------------------------------------- | ----------------- |
| `.github/agents/orchestrator.agent.md` | embedded loop/retry prose  | lean role card + lazy-load link       | 80                |
| `.github/agents/frontend.agent.md`     | embedded TDD + loop prose  | lean role card + lazy-load links      | 80                |
| `.github/agents/bsa.agent.md`          | embedded loop prose        | lean role card + lazy-load link       | 80                |
| `tdd-debug/SKILL.md`                   | embedded TDD + debug prose | lean skill card + protocol references | 120               |
| `plugin-guide.md`                      | embedded protocol detail   | lean overview + protocol links        | 120               |

### Reachability confirmation

All moved prose is reachable from the refactored files via lazy-load links:

- Orchestrator → `docs/protocols/loop-protocol.md`
- Frontend → `docs/protocols/tdd-protocol.md`, `docs/protocols/loop-protocol.md`
- BSA → `docs/protocols/loop-protocol.md`
- TDD-Debug skill → all three protocol cards
- Plugin guide → all three protocol cards

No content was deleted.

---

_Maintained by: autonomous agent (E0-2 / E0-4 implementation). Review before merging._
