// @ts-check

/**
 * Delegation contract — a single high-signal regression guard for the whole
 * "the orchestrator must not silently regress to inline work" fix. If a future
 * edit re-adds the edit tool, drops the Delegation policy, restores the
 * inline-biasing "maximize a single agent first" phrasing, unwires the floor
 * script, or shrinks the floor coverage, exactly one of these pins fails.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentFrontmatter } from '../../lib/agent-validator.mjs';
import {
  GATE_DISPATCH_FLOOR,
  assertDispatchResultBacked,
  isTraceBackedResultAgent,
} from '../../lib/workflow/orchestrator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH = resolve(__dirname, '../../agents/orchestrator.agent.md');

describe('delegation contract — the orchestrator cannot silently regress to inline work', () => {
  const body = readFileSync(ORCH, 'utf8');
  const fm = parseAgentFrontmatter(body);

  it('the orchestrator holds no edit tool (cannot write files inline)', () => {
    assert.ok(
      !fm.tools.includes('edit'),
      `orchestrator must not declare the edit tool; got ${JSON.stringify(fm.tools)}`,
    );
  });

  it('makes delegation the default via a Delegation policy', () => {
    assert.match(body, /##\s+Delegation policy/i);
    assert.match(body, /delegate it to a specialist subagent/i);
    assert.match(body, /A gate never advances on inline work/i);
  });

  it('forbids using the terminal as an editor (no inline edits on follow-ups)', () => {
    // Closes the observed bypass: no `edit` tool, so the orchestrator reached
    // for `execute`/terminal (sed, redirects, patch) to edit source inline.
    assert.match(body, /never use it as an editor/i);
    assert.match(body, /sed -i/i);
    assert.match(body, /follow-up/i);
  });

  it('effort scaling never licenses inline work', () => {
    assert.doesNotMatch(body, /maximize a single agent first/i);
    assert.match(body, /never whether to delegate/i);
  });

  it('enforces the dispatch floor by evidence the orchestrator can actually reach', () => {
    // This used to assert the prompt contained `orch-assert-floor.mjs` — a
    // command the orchestrator has never had a tool to run (it declares no
    // `execute`). The test therefore guaranteed the presence of an inert
    // instruction, which is how CI stayed green while the floor was unenforced.
    // The floor is now checked against the worker returns the PostToolUse hook
    // persists, which the orchestrator CAN Read.
    assert.doesNotMatch(body, /orch-assert-floor\.mjs/);
    assert.match(body, /worker-returns/);
    assert.match(body, /confirm the specialist ran/i);
  });

  it('tells the orchestrator it has no terminal, so it stops hunting for scripts', () => {
    // The reported failure: unable to run a script, the model fell back to
    // SEARCHING for it, got "no matches" (the plugin dir is outside the
    // workspace), concluded devmate was broken, and did the work inline.
    assert.match(body, /You have no terminal/i);
    assert.doesNotMatch(body, /node "\$\{PLUGIN_ROOT\}\/scripts\/[a-z-]+\.mjs"/);
  });

  it('an empty subagent return is never a licence to work inline', () => {
    assert.match(body, /never a licence to do/i);
  });

  it('covers every analysis gate/milestone with a dispatch floor', () => {
    const keys = Object.keys(GATE_DISPATCH_FLOOR);
    for (const gate of ['discovery-done', 'grill-done', 'plan-done', 'diagnosis-done']) {
      assert.ok(keys.includes(gate), `dispatch floor must cover ${gate}`);
    }
  });

  it('forbids the orchestrator authoring or reshaping a dispatch-result artifact', () => {
    // Closes the observed bypass: on a malformed fullstack reply the orchestrator
    // rewrote the result artifact to match the validator's shape ("complete the
    // gate"), fabricating the very evidence the guard checks.
    assert.match(body, /never yours to author/i);
    assert.match(body, /never author or reshape/i);
  });

  it('states that the implementation gate is enforced structurally, not by a script the orchestrator runs', () => {
    // The trace-backed result guard still exists and is still enforced — but by
    // the hooks (see the lib-level assertions below), not by a `--trace` command
    // in a prompt that could never execute it.
    assert.doesNotMatch(body, /--trace \.devmate\/state\/trace/);
    assert.match(body, /enforced structurally/i);
  });

  it('exports a dispatch-backing result guard (not shape-only) for fullstack', () => {
    assert.equal(typeof assertDispatchResultBacked, 'function');
    assert.equal(isTraceBackedResultAgent('fullstack'), true);
    assert.equal(isTraceBackedResultAgent('discovery'), false);
  });

  it('tells the orchestrator to Read state artifacts by path, not search for them', () => {
    // The observed run flailed searching `.devmate/state/**`, which is gitignored
    // and excluded from search — surfacing "No matches found" for a file that exists.
    assert.match(body, /Read them directly rather than searching/i);
    assert.match(body, /gitignored/i);
  });
});
