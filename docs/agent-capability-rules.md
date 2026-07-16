# Agent Capability Rules

This document is the authoritative reference for the claim-to-tool mapping rules used by
`lib/agent-validator.mjs` and enforced by `scripts/validate-agents.mjs` — authoritative for
capability rules only. See [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) (E9-28) for the
integrated end-to-end view.

---

## Overview

Each VS Code custom agent (`agents/*.agent.md`) declares its capabilities via YAML
frontmatter (`tools`, `capabilities`, `outputScope`). The agent body makes behavioral claims
in plain text. The validator ensures these two sources are consistent.

---

## Claim-to-tool mapping table

| Claim type     | Trigger phrases (case-insensitive)                           | Required frontmatter tool |
| -------------- | ------------------------------------------------------------ | ------------------------- |
| `writes-files` | `writes`, `creates`, `edits`, `updates <a file>`, `saves to` | `edit`                    |
| `runs-checks`  | `runs`, `executes`, `checks`, `verifies`, `lints`            | `execute`                 |
| `read-only`    | (no write or execute claims present)                         | _(none required)_         |

---

## Rule details

### `writes-files` → requires `edit`

An agent body that contains any of the following phrases is considered to claim file-write
capability and **must** declare `edit` (or a tool that provides edit access, e.g.
`create/file`, `edit/file`) in its frontmatter `tools` array.

Trigger phrases:

- `writes` / `write` — e.g. "writes the output to disk"
- `creates` / `create` — e.g. "creates a new file"
- `edits` / `edit` — e.g. "edits the config"
- `updates <noun>` — e.g. "updates a file", "updates the spec"
- `saves to` — e.g. "saves to `.devmate/session/output.md`"

Note: the validator matches `edit`, `edit/file`, `create/file` as satisfying the `edit`
requirement. Agents using VS Code custom-agent tool identifiers like `edit/file` are valid.

### `runs-checks` → requires `execute`

An agent body that contains any of the following phrases is considered to claim command
execution capability and **must** declare `execute` (or `run/terminal`) in its frontmatter
`tools` array.

Trigger phrases:

- `runs` / `run` — e.g. "runs linting"
- `executes` / `execute` — e.g. "executes the test suite"
- `checks` / `check` — e.g. "checks the type errors"
- `verifies` / `verify` — e.g. "verifies the build"
- `lints` / `lint` — e.g. "lints the codebase"

**Dispatcher exemption:** Agents that declare the `agent` dispatch tool are pure
coordinators. Their body describes what subagents should do, not what the agent
executes directly. The `runs-checks → execute` requirement is waived for them.

### `read-only` agents and `outputScope`

An agent that has neither `edit` nor `execute` in its `tools` is considered read-only.
If such an agent writes session-scoped artifacts (e.g. to `.devmate/session/`), it should
declare `outputScope: session-only` in frontmatter. Writing to repository paths without
`edit` in `tools` is a violation.

---

## Fixing violations

When the validator reports a violation, choose one of:

1. **Add the missing tool** to the agent's frontmatter `tools` array.
   - Example: add `edit` if the body claims writes.
   - Example: add `execute` if the body claims running checks.

2. **Rewrite the body claim** to avoid triggering the rule.
   - Instead of "writes the result to disk" → "requests that editor agent writes the result"
   - Instead of "runs linting" → "delegates linting to the editor agent"

3. **For read-only agents writing session artifacts**: add `outputScope: session-only`
   to frontmatter to declare that writes are scoped to the session only.

---

_Rules enforced by `lib/agent-validator.mjs`. See `scripts/validate-agents.mjs` for the CI runner._
