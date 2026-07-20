# Hook payload fixtures — the wire contract, as evidence

devmate's hook layer was written against a Claude-Code-shaped contract and runs
under **GitHub Copilot in VS Code**. Five production defects came out of the gap
(#72, #74, #75, #76, #77), and every one of them was invisible to CI, because the
tests called pure functions with hand-authored payloads that encoded devmate's own
wrong assumptions. A test that asserts against a made-up payload confirms the bug
instead of catching it.

These files are the fix: the payloads the host really sends, spawned into the real
entrypoints by [`test/conformance/hooks-contract.test.mjs`](../../conformance/hooks-contract.test.mjs).

## Two kinds of fixture, and the difference matters

| Directory   | What it is | How far to trust it |
| ----------- | ---------- | ------------------- |
| `captured/` | Copied byte-for-byte from a real VS Code Copilot agent hook log. | Ground truth. If devmate disagrees with one of these, devmate is wrong. |
| `derived/`  | Built from the documented schema in the VS Code hooks reference, using only fields that reference lists for that event. | The best available evidence — not proof. Replace with a capture when you can. |

Each fixture's exact provenance, and the defect it pins, is in
[`manifest.json`](./manifest.json). Nothing carries a field devmate invented:
there is no `repoRoot`, no `taskId`, no `workspaceRoot`, no `agentName` on a
subagent event, and no `tool_input.path`. Adding one to make a test pass would
put the bug back.

**Hooks are a Preview API and this contract will move.** When it does, these
files are what tells you.

## Capturing a real payload (five minutes, and worth it)

1. In VS Code, open **Output** → the **GitHub Copilot Chat Hooks** channel (a
   dedicated hooks log; older builds folded this into the **GitHub Copilot
   Chat** channel). Hook invocations appear as
   `[#905] [PreToolUse] Input: {...}` followed by `Output: {...}`.
   **Caution (verified 2026-07-17):** this channel elides `tool_input` to the
   literal `"..."` on `PreToolUse`/`PostToolUse` lines — do not capture those
   two events from it and treat `"tool_input": "..."` as the real payload; the
   envelope fields (ids, cwd, transcript_path, timestamp) are faithful.
2. Run a session in a devmate-initialized workspace and trigger the event you
   want — an edit for `PreToolUse`/`PostToolUse`, a subagent dispatch for
   `SubagentStart`, and so on.
3. Copy the `Input:` JSON verbatim into `captured/<event>.<tool>.json`. Do not
   reformat, do not drop fields, do not fill in blanks.
4. Move its entry in `manifest.json` from `derived` to `captured`, and record the
   VS Code version and the model in `source` — the concrete tool names and their
   input schemas can vary by both.

**One trap.** The agent log elides `tool_input` to `"..."` for some edit tools,
so what you copy is an envelope with a hole in it. That is why
`derived/pretooluse.replace-string-in-file.json` is derived: its envelope is
verbatim, its `tool_input` is reconstructed from the tool's input schema. A
fixture is only `captured` when every field of it came off the wire.

## What the fixtures already proved

- `cwd` is the hook's *only* root-bearing field, it is **optional**, and in a
  monoroot multi-root workspace it is `workspaceFolders[0]` — the workspace's own
  `.devmate/` folder. Every path devmate resolved relative to it landed in
  `.devmate/.devmate/` (#76).
- The edit target is `tool_input.filePath`. devmate read `tool_input.path`, so
  every path-keyed rule — persona scope, `scope.md`, TDD — evaluated against `''`
  and never fired (#74).
- A subagent is identified by `agent_type` + `agent_id`. devmate read `agentName`,
  got the literal `"unknown"`, and the HITL-1 dispatch gate never evaluated (#76).
- `agent_id` **is** a parent link: it is the `tool_use_id` of the `runSubagent`
  call that spawned the subagent (`captured/subagentstart.router.json` and the
  `runSubagent` `PreToolUse` in `sessions/feature-lane-router.session.json` carry
  the same id). It links a child to its dispatch **call** — not to the agent that
  made the call.
- **A `PreToolUse` payload carries no agent identity at all** — `session_id`,
  `tool_name`, `tool_input`, `tool_use_id`, `cwd`, `transcript_path`, and nothing
  else. So an *edit* can never be attributed to one of several concurrent workers,
  and the parent link above has nothing to join against on the event where it would
  matter. That is what killed gate-guard Rule 5 (per-edit persona scope), which was
  deleted in #99 rather than repaired; the per-worker boundary moved to completion
  time, where the persona rides the worker's own returned contract. Both facts are
  asserted against these captures in
  [`test/conformance/agent-identity.test.mjs`](../../conformance/agent-identity.test.mjs),
  so a host that starts sending an agent field on `PreToolUse` breaks a test rather
  than a design.
- A `runSubagent`'s `tool_input` reaches the hook elided (the literal string
  `"..."`, `captured/posttooluse.run-subagent.json`). Anything devmate sends *into*
  a dispatch — `agentName`, `persona` — is therefore invisible to its own hooks;
  the only thing that comes back is what the agent returns in `tool_response`.
