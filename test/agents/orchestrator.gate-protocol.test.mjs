// @ts-check

/**
 * E10-01 (#337): Orchestrator gate conversation protocol tests.
 *
 * These tests assert that `agents/orchestrator.agent.md` carries the
 * "Human gates — input handling" protocol so that free-form input at a
 * human gate is classified (approve / change-request / question /
 * new-task / abandon) instead of being dropped, and that every lane's
 * human/verification gate references the protocol. The orchestrator and
 * the lane skills are markdown prompts, not executable modules, so the
 * contract surface we validate is the literal prompt body — the same
 * surface an LLM dispatching as the orchestrator reads at runtime.
 *
 * Read-only over the repo tree: files are read, never written.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgent } from '../../lib/agent-validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const AGENT_PATH = resolve(ROOT, 'agents/orchestrator.agent.md');

/** Canonical protocol section name (em dash, as embedded in the prompts). */
const PROTOCOL_NAME_RE = /Human gates — input handling/;

/**
 * Lane skill surfaces that must reference the protocol at their gates.
 * @type {Array<{ label: string, path: string }>}
 */
const LANE_FILES = [
  {
    label: 'feature lane procedure',
    path: 'skills/orchestrator-feature-lane/refs/procedure.md',
  },
  {
    label: 'feature lane trigger stub',
    path: 'skills/orchestrator-feature-lane/SKILL.md',
  },
  { label: 'bug lane procedure', path: 'skills/orchestrator-bug-lane/refs/procedure.md' },
  {
    label: 'chore lane procedure',
    path: 'skills/orchestrator-chore-lane/refs/procedure.md',
  },
];

/**
 * Split markdown into blank-line-delimited paragraphs.
 * @param {string} text
 * @returns {string[]}
 */
function paragraphsOf(text) {
  return text.split(/\n[ \t]*\n/);
}

describe('agents/orchestrator.agent.md — human gates input handling (E10-01)', () => {
  const body = readFileSync(AGENT_PATH, 'utf8');
  const lines = body.split('\n');

  it('passes validate-agents (no frontmatter/body claim mismatches)', async () => {
    const result = await validateAgent(AGENT_PATH);
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
  });

  it('declares a top-level protocol section that applies at every human gate', () => {
    assert.match(
      body,
      /^## Human gates — input handling \(applies at every \[HUMAN GATE\]\)$/m,
      'protocol section heading missing or reworded',
    );
  });

  it('presents the gate options: approve / request changes / ask a question / abandon', () => {
    assert.match(
      body,
      /1\. Approve\s+2\. Request changes \(just describe them\)\s+3\. Ask a question\s+4\. Abandon/,
      'gate option list missing',
    );
    assert.match(
      body,
      /classify it BEFORE any other action/,
      'classify-first instruction missing',
    );
  });

  it('default-to-revision clause: any non-approval input at a gate is revision feedback', () => {
    assert.match(
      body,
      /ANY requested change, correction, addition, or concern — regardless of phrasing/,
      'default-to-revision clause missing',
    );
    assert.match(
      body,
      /this IS revision feedback/,
      'revision-feedback declaration missing',
    );
    assert.match(
      body,
      /stay at the gate, re-present/,
      'stay-at-gate + re-present instruction missing',
    );
  });

  it('explicit-approval clause: approval must be explicit and is never inferred', () => {
    assert.match(body, /EXPLICIT approval/, 'explicit-approval clause missing');
    assert.match(
      body,
      /must be explicit; never infer it/,
      'never-infer-approval rule missing',
    );
    assert.match(
      body,
      /MUST NOT proceed past a gate without explicit approval/,
      'no-advance-without-approval rule missing',
    );
    assert.match(
      body,
      /Ambiguous between approval and change[\s\S]*?treat as revision/,
      'ambiguity-resolves-to-revision rule missing',
    );
  });

  it('question-handling clause: answering a question never advances or abandons the gate', () => {
    assert.match(
      body,
      /A question → answer from the artifacts, then re-present the options/,
      'question-at-gate handling missing',
    );
    assert.match(
      body,
      /question NEVER advances or abandons the gate/,
      'question-never-advances rule missing',
    );
  });

  it('new-task clause: confirm park or abandon before switching tasks', () => {
    assert.match(
      body,
      /new, unrelated task → confirm whether to park or abandon the current task first/,
      'new-task-at-gate handling missing',
    );
  });

  it('do-not-stop-dispatching clause: unrecognized phrasing never halts subagent dispatch', () => {
    assert.match(
      body,
      /MUST NOT stop dispatching subagents/,
      'do-not-stop-dispatching rule missing',
    );
    assert.match(
      body,
      /there is no required phrase/,
      'no-required-phrase declaration missing',
    );
    assert.match(
      body,
      /MUST continue the\s+feedback→revision cycle/,
      'feedback-to-revision loop requirement missing',
    );
  });

  it('every [HUMAN GATE] step references the protocol', () => {
    const gateStepLines = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes('[HUMAN GATE]') && !line.startsWith('##'));
    assert.ok(
      gateStepLines.length >= 3,
      `expected at least 3 [HUMAN GATE] steps, found ${gateStepLines.length}`,
    );
    for (const { line, i } of gateStepLines) {
      const window = lines.slice(i, i + 5).join('\n');
      assert.match(
        window,
        PROTOCOL_NAME_RE,
        `[HUMAN GATE] step at line ${i + 1} does not reference the protocol: ${line.trim()}`,
      );
    }
  });

  it('chore lane references the protocol at its verification gate', () => {
    assert.match(
      body,
      /verification gate per "Human gates — input handling"/,
      'chore verification gate does not reference the protocol',
    );
  });

  it('does not retain the old approves-or-asks-for-revisions prose with no off-script branch', () => {
    assert.doesNotMatch(
      body,
      /either\s+approves it or asks for revisions|either approves or\s+requests revisions/,
      'old gate prose without an off-script branch must be replaced by the protocol',
    );
  });
});

describe('lane skills — human gates reference the protocol (E10-01)', () => {
  for (const { label, path } of LANE_FILES) {
    it(`${label} references the protocol`, () => {
      const text = readFileSync(resolve(ROOT, path), 'utf8');
      assert.match(text, PROTOCOL_NAME_RE, `${path} never references the protocol`);
    });
  }

  it('every [HUMAN GATE] step in each lane procedure references the protocol', () => {
    for (const { path } of LANE_FILES) {
      const text = readFileSync(resolve(ROOT, path), 'utf8');
      const gateParagraphs = paragraphsOf(text).filter((p) => p.includes('[HUMAN GATE]'));
      for (const paragraph of gateParagraphs) {
        assert.match(
          paragraph,
          PROTOCOL_NAME_RE,
          `[HUMAN GATE] step in ${path} does not reference the protocol:\n${paragraph}`,
        );
      }
    }
  });

  it('feature lane procedure states the default-to-revision rule at the spec-draft gate', () => {
    const text = readFileSync(
      resolve(ROOT, 'skills/orchestrator-feature-lane/refs/procedure.md'),
      'utf8',
    );
    const specGate = paragraphsOf(text).find(
      (p) => p.includes('[HUMAN GATE]') && p.includes('`spec-draft`'),
    );
    assert.ok(specGate !== undefined, 'spec-draft human gate step not found');
    assert.match(
      specGate,
      /IS revision feedback/,
      'spec-draft gate step must state the default-to-revision rule',
    );
    assert.match(
      specGate,
      /Never infer approval/,
      'spec-draft gate step must forbid inferred approval',
    );
  });

  it('chore lane procedure references the protocol at its verification gate (step 7)', () => {
    const text = readFileSync(
      resolve(ROOT, 'skills/orchestrator-chore-lane/refs/procedure.md'),
      'utf8',
    );
    const verifyStep = paragraphsOf(text).find((p) => p.startsWith('**7. Verify.**'));
    assert.ok(verifyStep !== undefined, 'chore verification step not found');
    assert.match(
      verifyStep,
      PROTOCOL_NAME_RE,
      'chore verification step must reference the protocol',
    );
  });
});
