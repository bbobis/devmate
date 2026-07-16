// @ts-check

/**
 * E11-2: Orchestrator feature-lane wiring tests.
 *
 * These tests assert that `agents/orchestrator.agent.md` documents the
 * 11-step feature lane with explicit grill (step 4) and critique (step 8)
 * dispatches plus the hard rules required by issue #169. The orchestrator
 * is a markdown prompt, not an executable module, so the contract surface
 * we validate is the literal procedure body — the same surface an LLM
 * dispatching as the orchestrator reads at runtime.
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

describe('agents/orchestrator.agent.md — feature lane (E11-2)', () => {
  const body = readFileSync(AGENT_PATH, 'utf8');
  const lines = body.split('\n');

  it('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  it('step order: discovery before grill before plan before critique before spec', () => {
    const discoveryLine = lineOf(lines, /^\s*2\.\s.*Dispatch\s+`@discovery`/);
    const grillLine = lineOf(lines, /^\s*4\.\s.*`@rubber-duck`.*mode=grill/);
    const plannerLine = lineOf(lines, /^\s*6\.\s.*Dispatch\s+`@planner`/);
    const critiqueLine = lineOf(lines, /^\s*8\.\s.*`@rubber-duck`.*mode=critique/);
    // Anchored on the DISPATCH, not on a `writeSpec(` call. The prompt used to
    // tell @spec-writer to "call writeSpec(repoRoot, content)" — a JS function,
    // to an agent whose tools are `['edit']`. It could type the spec's text and
    // nothing else, so the call never happened and the digest it was contracted
    // to record was never recorded (#91). This assertion pinned that instruction
    // in place; the step it should have been checking is the dispatch.
    const specLine = lineOf(lines, /^\s*9\.\s.*Dispatch\s+`@spec-writer`/);

    assert.ok(discoveryLine > 0, 'discovery dispatch line not found');
    assert.ok(grillLine > 0, 'grill dispatch line not found');
    assert.ok(plannerLine > 0, 'planner dispatch line not found');
    assert.ok(critiqueLine > 0, 'critique dispatch line not found');
    assert.ok(specLine > 0, 'spec-writer dispatch line not found');

    assert.ok(discoveryLine < grillLine, 'discovery must come before grill');
    assert.ok(grillLine < plannerLine, 'grill must come before plan');
    assert.ok(plannerLine < critiqueLine, 'plan must come before critique');
    assert.ok(critiqueLine < specLine, 'critique must come before spec write');
  });

  it('hard rule: grill must dispatch before plan (explicit, not a guideline)', () => {
    assert.match(
      body,
      /Grill must dispatch before plan/i,
      'orchestrator must state the grill-before-plan rule as a hard rule',
    );
  });

  it('hard rule: critique must dispatch before spec is written (explicit, not a guideline)', () => {
    assert.match(
      body,
      /Critique must dispatch before spec/i,
      'orchestrator must state the critique-before-spec rule as a hard rule',
    );
  });

  it('lane numbers steps 1 through 11 explicitly', () => {
    // Match a numbered list item at the start of a line for each step 1..11.
    for (let n = 1; n <= 11; n++) {
      const prefix = `${n}. `;
      const found = body.split('\n').some((line) => line.trimStart().startsWith(prefix));
      assert.ok(found, `numbered step ${n} missing`);
    }
  });

  it('grill blocking questions are documented to flow into spec.md assumptions section', () => {
    assert.match(
      body,
      /blockingQuestions[\s\S]*?SpecContent\.assumptions/i,
      'blocking questions must seed SpecContent.assumptions',
    );
    assert.match(
      body,
      /Assumptions \u2014 please verify/,
      'orchestrator must reference the spec.md "Assumptions — please verify" section',
    );
  });

  it('critique APPROVE_PLAN and REQUEST_REVISION verdict shapes are documented', () => {
    assert.match(body, /APPROVE_PLAN/, 'APPROVE_PLAN verdict missing');
    assert.match(body, /REQUEST_REVISION/, 'REQUEST_REVISION verdict missing');
  });

  it('critique iteration cap is exactly 2 (hard rule, not a guideline)', () => {
    assert.match(
      body,
      /iteration cap is 2/i,
      'orchestrator must state the 2-iteration cap as a hard rule',
    );
    assert.match(
      body,
      /iterationNumber=2/,
      'orchestrator must explicitly invoke a second critique with iterationNumber=2',
    );
  });

  it('after 2 failed critiques the lane folds open issues into SpecContent.risks and continues', () => {
    assert.match(
      body,
      /SpecContent\.risks/,
      'orchestrator must route post-cap open issues into SpecContent.risks',
    );
    assert.match(
      body,
      /risk flag/i,
      'orchestrator must flag the spec when the critique cap is hit',
    );
  });

  it('grill_complete, critique_complete, and plan_revised trace events are emitted by the lane', () => {
    assert.match(body, /grill_complete/, 'grill_complete trace event missing from lane prose');
    assert.match(
      body,
      /critique_complete/,
      'critique_complete trace event missing from lane prose',
    );
    assert.match(body, /plan_revised/, 'plan_revised trace event missing from lane prose');
  });

  it('critique verdict is captured in the trace regardless of APPROVE_PLAN or REQUEST_REVISION', () => {
    assert.match(
      body,
      /critique_complete[\s\S]*?regardless of verdict/i,
      'critique_complete must be emitted regardless of verdict',
    );
  });

  it('internal gates auto-advance and only spec-draft + pr-ready are human gates', () => {
    assert.match(body, /Internal gates auto-advance/i);
    assert.match(body, /`discovery-done`/);
    assert.match(body, /`grill-done`/);
    assert.match(body, /`plan-done`/);
    assert.match(
      body,
      /spec-draft\s*\u2192\s*spec-approved/,
      'spec-draft → spec-approved transition must be called out as a human gate',
    );
  });

  it('frontmatter declares rubber-duck as a dispatchable sub-agent', () => {
    const fmEnd = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    assert.ok(fmEnd > 0, 'frontmatter terminator not found');
    const fm = lines.slice(0, fmEnd + 1).join('\n');
    assert.match(fm, /rubber-duck/, 'orchestrator frontmatter must list rubber-duck under agents');
  });
});

describe('agents/orchestrator.agent.md — Step 2 discovery fan-out (FO-5)', () => {
  const body = readFileSync(AGENT_PATH, 'utf8');

  // This block used to pin a two-phase design whose Phase 1 was
  // `node "${PLUGIN_ROOT}/scripts/discovery-scan.mjs"` and whose fan-in was
  // `merge-discovery.mjs` — commands the orchestrator has never had a tool to
  // run, since it declares no `execute`. The tests asserted those commands were
  // PRESENT, so CI actively guaranteed an instruction that could not execute.
  //
  // Unable to run the scan, the model searched for the script instead, got "no
  // matches" (the plugin directory sits outside the workspace, where the search
  // tool cannot see), concluded devmate's tooling was broken, and did discovery
  // inline with grep — the exact delegation violation the same prompt forbids.
  //
  // The fan-out is now sized directly from budgetClass, and the fan-in reads the
  // worker returns that the PostToolUse hook persists.

  it('does not instruct a script the orchestrator has no tool to run', () => {
    assert.doesNotMatch(body, /discovery-scan\.mjs/);
    assert.doesNotMatch(body, /merge-discovery\.mjs/);
    assert.match(body, /You have no terminal/i);
  });

  it('sizes the fan-out from budgetClass', () => {
    assert.match(body, /tiny -> 1 \(no fan-out\), standard -> 2,\s+large -> 3/, 'K mapping must be explicit');
  });

  it('states the ceiling arithmetic explicitly and forbids leaning on the budget guard deny', () => {
    assert.match(
      body,
      /K discovery workers \+ @tech-design share\s+maxConcurrentAgents = 3/,
      'ceiling arithmetic missing',
    );
    assert.match(body, /dispatch in waves/i, 'wave dispatch instruction missing');
    assert.match(body, /never rely on\s+the budget guard's deny/, 'no-deny-reliance rule missing');
  });

  it('fans in by reading the hook-persisted worker returns', () => {
    assert.match(body, /\.devmate\/state\/worker-returns\//, 'worker-return path missing');
    assert.match(body, /persisted for you by the PostToolUse hook/, 'hook persistence guarantee missing');
  });

  it('pins the degradation ladder — and never degrades to inline work', () => {
    assert.match(body, /proceed with the valid remainder/, 'partial-failure tolerance missing');
    assert.match(body, /finish that wave sequentially/, 'mid-wave quota handling missing');
    // The load-bearing rule: an all-empty wave HALTS. It does not license the
    // orchestrator to do discovery itself, which is exactly what happened.
    assert.match(body, /If ALL workers came back empty, that is a HALT/);
    assert.match(body, /never a\s+licence to do the discovery yourself/);
  });
});
