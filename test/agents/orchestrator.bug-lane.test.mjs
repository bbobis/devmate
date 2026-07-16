// @ts-check

/**
 * E5-1: Orchestrator bug-lane wiring tests.
 *
 * These tests assert that `agents/orchestrator.agent.md` documents the
 * bug lane as a strict 9-step procedure with explicit hard rules and
 * internal-gate auto-advance semantics. The orchestrator is a markdown
 * prompt, not an executable module, so the contract surface we validate
 * is the literal procedure body — the same surface an LLM dispatching as
 * the orchestrator reads at runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgent } from '../../lib/agent-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_PATH = resolve(__dirname, '../../agents/orchestrator.agent.md');

/**
 * Return the 1-based line number of the first line containing `needle`,
 * or -1 if absent.
 * @param {string[]} lines
 * @param {RegExp} needle
 * @returns {number}
 */
function lineOf(lines, needle) {
  for (let i = 0; i < lines.length; i++) {
    if (needle.test(lines[i])) return i + 1;
  }
  return -1;
}

describe('agents/orchestrator.agent.md — bug lane (E5-1)', () => {
  const body = readFileSync(AGENT_PATH, 'utf8');
  const lines = body.split('\n');

  // Extract just the bug-lane section from "## Bug lane" to next "## " heading
  /** @param {string} fullBody */
  function extractBugLaneSection(fullBody) {
    const bugLaneStart = fullBody.indexOf('## Bug lane');
    if (bugLaneStart === -1) throw new Error('Bug lane section not found');
    const nextHeading = fullBody.indexOf('\n## ', bugLaneStart + 1);
    const bugLaneEnd = nextHeading === -1 ? fullBody.length : nextHeading;
    return fullBody.substring(bugLaneStart, bugLaneEnd).split('\n');
  }

  const bugLaneLines = extractBugLaneSection(body);

  it('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  it('step order: diagnose before grill before fix before verify', () => {
    const diagnoseDispatchLine = lineOf(bugLaneLines, /^\s*2\.\s.*Dispatch\s+`@diagnose`/);
    const grillLine = lineOf(bugLaneLines, /^\s*4\.\s.*`@rubber-duck`.*mode=grill/);
    const fullstackLine = lineOf(bugLaneLines, /^\s*7\.\s.*Dispatch\s+`@fullstack`/);
    const verifyLine = lineOf(bugLaneLines, /^\s*8\.\s.*[Vv]erif(?:y|ication)/);

    assert.ok(
      diagnoseDispatchLine > 0,
      'diagnose dispatch line not found; expected "Dispatch `@diagnose`"'
    );
    assert.ok(grillLine > 0, 'grill dispatch line not found; expected mode=grill');
    assert.ok(
      fullstackLine > 0,
      'fullstack dispatch line not found; expected "Dispatch `@fullstack`"'
    );
    assert.ok(verifyLine > 0, 'verify line not found; expected step 8');

    assert.ok(diagnoseDispatchLine < grillLine, 'diagnose must come before grill');
    assert.ok(grillLine < fullstackLine, 'grill must come before fullstack dispatch');
    assert.ok(fullstackLine < verifyLine, 'fullstack dispatch must come before verify');
  });

  it('hard rule: diagnose must dispatch before fix', () => {
    assert.match(
      body,
      /Diagnose must dispatch before fix/i,
      'orchestrator must state the diagnose-before-fix rule as a hard rule'
    );
  });

  it('hard rule: schema validation is required', () => {
    assert.match(
      body,
      /Schema validation is required/i,
      'orchestrator must state schema validation requirement'
    );
    assert.match(
      body,
      /validateDiagnosisResult/,
      'orchestrator must reference validateDiagnosisResult from lib/workflow/bug-handoff.mjs'
    );
  });

  it('hard rule: scope.md is mandatory', () => {
    assert.match(
      body,
      /scope\.md is mandatory/i,
      'orchestrator must state scope.md requirement'
    );
  });

  it('hard rule: change-scope enforcement is hard', () => {
    assert.match(
      body,
      /Change-scope enforcement is hard/i,
      'orchestrator must state change-scope enforcement as a hard rule'
    );
  });

  it('lanes numbers steps 1 through 9 explicitly', () => {
    // Match a numbered list item at the start of a line for each step 1..9
    // within the bug lane section (after "Bug lane — orchestration sequence").
    const bugLaneStart = lineOf(lines, /## Bug lane/);
    assert.ok(bugLaneStart > 0, 'bug lane section not found');
    const bugLaneEnd = lineOf(lines, /## Chore lane/);
    assert.ok(bugLaneEnd > 0, 'chore lane section not found to mark bug lane end');
    const bugLaneLines = lines.slice(bugLaneStart, bugLaneEnd);
    for (let n = 1; n <= 9; n++) {
      const prefix = `${n}. `;
      const found = bugLaneLines.some((l) => l.trimStart().startsWith(prefix));
      assert.ok(found, `numbered step ${n} missing in bug lane section`);
    }
  });

  it('internal steps are documented for diagnosis-done (milestone), grill-done, and verification-passed', () => {
    // diagnosis-done is a prose milestone, not a workflowGate (E9-14).
    assert.match(body, /\[\s*MILESTONE\s*\]\s+diagnosis-done/i);
    assert.match(body, /\[\s*INTERNAL GATE\s*\]\s+`grill-done`/i);
    assert.match(body, /\[\s*INTERNAL GATE\s*\]\s+`verification-passed`/i);
  });

  it('pr-ready is called out as a human gate', () => {
    assert.match(
      body,
      /\[\s*HUMAN GATE\s*\]\s+`pr-ready`/i,
      'bug lane must explicitly mark pr-ready as a human gate'
    );
  });

  it('gate-guard scope enforcement is documented as the PreToolUse hook', () => {
    // Ground truth (hooks/hooks.json): scripts/gate-guard.mjs runs on PreToolUse.
    // Scope enforcement (Rule 6) happens before a change reaches disk; the
    // PostToolUse hook hosts the separate completion-time persona-scope re-check.
    assert.match(
      body,
      /gate-guard.*PreToolUse.*hook/i,
      'orchestrator must reference the gate-guard PreToolUse hook for scope enforcement'
    );
  });

  it('frontmatter declares diagnose and fullstack as dispatchable sub-agents', () => {
    const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    assert.ok(fmEnd > 0, 'frontmatter terminator not found');
    const fm = lines.slice(0, fmEnd + 1).join('\n');
    assert.match(fm, /diagnose/, 'orchestrator frontmatter must list diagnose under agents');
    assert.match(fm, /fullstack/, 'orchestrator frontmatter must list fullstack under agents');
  });

  it('dispatch results must be validated (assertDispatchResult requirement stated)', () => {
    assert.match(
      body,
      /Dispatch results must validate/i,
      'orchestrator must state dispatch-result validation requirement'
    );
    assert.match(
      body,
      /assertDispatchResult/,
      'orchestrator must reference assertDispatchResult from lib/workflow/orchestrator.mjs'
    );
  });

  it('diagnosis output includes DiagnosisResult and scope.md', () => {
    assert.match(body, /DiagnosisResult/, 'orchestrator must reference DiagnosisResult');
    assert.match(
      body,
      /scope\.md/i,
      'orchestrator must reference scope.md artifact from diagnose'
    );
  });

  it('TDD constraint is stated for fullstack dispatch', () => {
    assert.match(
      body,
      /TDD constraint|failing.*test.*first/i,
      'orchestrator must state TDD constraint: failing regression test first'
    );
    assert.match(
      body,
      /reproCommand/,
      'orchestrator must reference reproCommand from DiagnosisResult for regression test'
    );
  });
});
