// @ts-check

/**
 * E10-4: per-turn intent router tests.
 *
 * Covers the deterministic fast path (exact approval/revision phrases,
 * trivially new-task at the terminal/no-lane gates, null-deferral for
 * free-form messages), the structured-output validator that mirrors the
 * lane router's validation shape, the orchestrator prompt's Turn routing
 * preamble (intent vocabulary + non-mutating hard rules), and the
 * approval-listener persistence of the fast-path verdict to
 * `.devmate/state/turn-intent.json`. All writes go to temp dirs only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TURN_INTENTS,
  MIN_TURN_INTENT_CONFIDENCE,
  classifyTurnDeterministic,
  parseTurnIntentResult,
} from '../../../lib/routing/turn-intent.mjs';
import { MIN_ROUTER_CONFIDENCE } from '../../../lib/routing/router.mjs';
import { handleUserPromptSubmit } from '../../../hooks/approval-listener.mjs';

/** @typedef {import('../../../lib/types.mjs').TaskState} TaskState */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PATH = resolve(__dirname, '../../../agents/orchestrator.agent.md');

/**
 * Build a minimal valid TaskState fixture.
 * @param {Partial<TaskState>} [overrides]
 * @returns {TaskState}
 */
function makeState(overrides) {
  return {
    taskId: 'feat-340',
    lane: 'feature',
    workflowGate: 'impl-started',
    artifactHashes: {
      spec: '.devmate/session/spec.md',
      specDigest: 'abc123',
    },
    preImplStash: null,
    currentStep: 0,
    budget: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

/**
 * Create a temp repo root with `.devmate/state/task.json` written (or
 * omitted when `stateOverrides` is null).
 * @param {Partial<TaskState>|null} [stateOverrides]
 * @returns {{ root: string, intentPath: string, cleanup: () => void }}
 */
function makeFixture(stateOverrides) {
  const root = mkdtempSync(join(tmpdir(), 'devmate-turn-intent-'));
  const stateDir = join(root, '.devmate', 'state');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  if (stateOverrides !== null) {
    writeFileSync(
      join(stateDir, 'task.json'),
      JSON.stringify(makeState(stateOverrides), null, 2),
      'utf8'
    );
  }
  return {
    root,
    intentPath: join(stateDir, 'turn-intent.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('TURN_INTENTS vocabulary', () => {
  it('contains exactly the eight canonical intents', () => {
    assert.deepEqual(
      [...TURN_INTENTS],
      [
        'new-task',
        'approve-gate',
        'revise-artifact',
        'steer-scope',
        'question',
        'status',
        'abandon',
        'chat',
      ]
    );
  });

  it('is frozen and shares the router confidence threshold', () => {
    assert.equal(Object.isFrozen(TURN_INTENTS), true);
    assert.equal(MIN_TURN_INTENT_CONFIDENCE, MIN_ROUTER_CONFIDENCE);
  });
});

describe('classifyTurnDeterministic — fast path', () => {
  it('returns new-task at the no-lane gate for a free-form message', () => {
    const result = classifyTurnDeterministic(
      'add a dark mode toggle to the settings page',
      makeState({ workflowGate: 'no-lane' })
    );
    assert.deepEqual(result, { intent: 'new-task', confidence: 1 });
  });

  it('returns new-task at the terminal done gate', () => {
    const result = classifyTurnDeterministic(
      'now migrate the auth module to the new API',
      makeState({ workflowGate: 'done' })
    );
    assert.deepEqual(result, { intent: 'new-task', confidence: 1 });
  });

  it('returns approve-gate for the exact "approve spec" phrase', () => {
    const result = classifyTurnDeterministic(
      'approve spec',
      makeState({ workflowGate: 'spec-draft' })
    );
    assert.deepEqual(result, { intent: 'approve-gate', confidence: 1 });
  });

  it('returns approve-gate for "approve pr" case- and whitespace-insensitively', () => {
    const result = classifyTurnDeterministic(
      '  APPROVE PR  ',
      makeState({ workflowGate: 'verification-passed' })
    );
    assert.deepEqual(result, { intent: 'approve-gate', confidence: 1 });
  });

  it('classifies an exact approval phrase ahead of the terminal-gate rule', () => {
    const result = classifyTurnDeterministic('approve spec', makeState({ workflowGate: 'done' }));
    assert.deepEqual(result, { intent: 'approve-gate', confidence: 1 });
  });

  it('returns revise-artifact for the exact "revise spec:" phrase', () => {
    const result = classifyTurnDeterministic(
      'revise spec: tighten the error-handling acceptance criteria',
      makeState({ workflowGate: 'spec-draft' })
    );
    assert.deepEqual(result, { intent: 'revise-artifact', confidence: 1 });
  });

  it('returns null (defer to LLM) for a free-form change request mid-implementation', () => {
    const result = classifyTurnDeterministic(
      'actually, can we also support SSO login while you are in there?',
      makeState({ workflowGate: 'impl-started' })
    );
    assert.equal(result, null);
  });

  it('returns null (defer to LLM) for a question at a human review gate', () => {
    const result = classifyTurnDeterministic(
      'what does the spec say about retry behavior?',
      makeState({ workflowGate: 'spec-draft' })
    );
    assert.equal(result, null);
  });

  it('returns null for an approval-adjacent but non-exact phrase', () => {
    const result = classifyTurnDeterministic(
      'looks good to me, ship it',
      makeState({ workflowGate: 'spec-draft' })
    );
    assert.equal(result, null);
  });

  it('returns null for the no-tdd override phrase (not a gate approval)', () => {
    const result = classifyTurnDeterministic(
      'approve no-tdd reason="spike, tests follow in E10-05"',
      makeState({ workflowGate: 'impl-started' })
    );
    assert.equal(result, null);
  });

  it('returns null for empty and whitespace-only prompts', () => {
    assert.equal(classifyTurnDeterministic('', makeState({ workflowGate: 'no-lane' })), null);
    assert.equal(classifyTurnDeterministic('   ', makeState({ workflowGate: 'done' })), null);
  });
});

describe('parseTurnIntentResult — structured-output validation', () => {
  it('accepts a valid intent object and normalises a missing targetArtifact to null', () => {
    const parsed = parseTurnIntentResult({ intent: 'steer-scope', confidence: 0.82 });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.deepEqual(parsed.result, {
        intent: 'steer-scope',
        confidence: 0.82,
        targetArtifact: null,
      });
    }
  });

  it('accepts a valid targetArtifact', () => {
    const parsed = parseTurnIntentResult({
      intent: 'revise-artifact',
      confidence: 0.9,
      targetArtifact: 'spec',
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.result.targetArtifact, 'spec');
  });

  it('rejects a non-object payload', () => {
    const parsed = parseTurnIntentResult('approve');
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /JSON object/);
  });

  it('rejects an intent outside the vocabulary', () => {
    const parsed = parseTurnIntentResult({ intent: 'merge-now', confidence: 0.9 });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /must be one of/);
  });

  it('rejects out-of-range or non-finite confidence', () => {
    for (const confidence of [-0.1, 1.1, Number.NaN, '0.9']) {
      const parsed = parseTurnIntentResult({ intent: 'chat', confidence });
      assert.equal(parsed.ok, false, `confidence ${String(confidence)} must be rejected`);
    }
  });

  it('rejects an unknown targetArtifact', () => {
    const parsed = parseTurnIntentResult({
      intent: 'revise-artifact',
      confidence: 0.9,
      targetArtifact: 'readme',
    });
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.error, /targetArtifact/);
  });
});

describe('orchestrator prompt — Turn routing preamble', () => {
  const body = readFileSync(ORCHESTRATOR_PATH, 'utf8');

  it('has a Turn routing section covering every in-flight message', () => {
    assert.match(body, /## Turn routing \(every in-flight message\)/);
  });

  it('carries the full intent vocabulary', () => {
    for (const intent of TURN_INTENTS) {
      assert.ok(body.includes(intent), `intent "${intent}" missing from orchestrator prompt`);
    }
  });

  it('declares the non-mutating hard rule for question/chat/status', () => {
    assert.match(
      body,
      /`question`, `chat`, and `status` are read-only turns: they never advance,\s+reset, or abandon a gate/
    );
  });

  it('routes ambiguity at a pending human review to revise-artifact, never approval', () => {
    assert.match(body, /default to `revise-artifact`\. Never treat an ambiguous message as\s+approval/);
  });

  it('routes low confidence elsewhere to an explicit ask at the shared threshold', () => {
    assert.match(body, /If `confidence < 0\.75` anywhere else: do not guess — ask the human/);
  });
});

describe('approval-listener — fast-path persistence to turn-intent.json', () => {
  it('persists the pre-transition gate and approve-gate intent for "approve pr"', async () => {
    const fx = makeFixture({ workflowGate: 'verification-passed' });
    try {
      const result = await handleUserPromptSubmit({ prompt: 'approve pr', root: fx.root });
      assert.equal(result.action, 'gate_advanced');
      const summary = JSON.parse(readFileSync(fx.intentPath, 'utf8'));
      assert.equal(summary.gate, 'verification-passed');
      assert.equal(summary.intent, 'approve-gate');
      assert.equal(summary.confidence, 1);
      assert.equal(summary.deferred, false);
      assert.equal(summary.source, 'deterministic');
    } finally {
      fx.cleanup();
    }
  });

  it('persists a deferred verdict for a free-form prompt without changing the hook result', async () => {
    const fx = makeFixture({ workflowGate: 'impl-started' });
    try {
      const result = await handleUserPromptSubmit({
        prompt: 'what is the current status of this task?',
        root: fx.root,
      });
      assert.equal(result.action, 'passthrough');
      const summary = JSON.parse(readFileSync(fx.intentPath, 'utf8'));
      assert.equal(summary.gate, 'impl-started');
      assert.equal(summary.intent, null);
      assert.equal(summary.confidence, null);
      assert.equal(summary.deferred, true);
      assert.match(summary.hint, /Turn routing preamble/);
    } finally {
      fx.cleanup();
    }
  });

  it('writes a deferred verdict with a null gate when task state is missing', async () => {
    const fx = makeFixture(null);
    try {
      const result = await handleUserPromptSubmit({
        prompt: 'kick off a new task for the billing report',
        root: fx.root,
      });
      assert.equal(result.action, 'passthrough');
      const summary = JSON.parse(readFileSync(fx.intentPath, 'utf8'));
      assert.equal(summary.gate, null);
      assert.equal(summary.intent, null);
      assert.equal(summary.deferred, true);
    } finally {
      fx.cleanup();
    }
  });
});
