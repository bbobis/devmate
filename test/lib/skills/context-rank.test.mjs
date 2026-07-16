// @ts-check
/**
 * Tests for lib/skills/context-rank.mjs — the Stage-2 state-conditional re-rank
 * and lane-skill force-include.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankWithContext,
  selectWithContext,
  laneSkillId,
  LANE_PRIOR,
  DEBUG_PRIOR,
} from '../../../lib/skills/context-rank.mjs';

/**
 * @param {string} skillId
 * @param {number} confidence
 * @param {boolean} [negativeTriggered]
 * @returns {import('../../../lib/types.mjs').MatchResult}
 */
function cand(skillId, confidence, negativeTriggered = false) {
  return { skillId, confidence, reason: '', triggerFile: '', refFiles: [], negativeTriggered, priority: 5 };
}

const OPTS = { topN: 3, minConfidence: 0.25 };

test('laneSkillId › maps lanes to orchestrator skill ids, else null', () => {
  assert.equal(laneSkillId('bug'), 'orchestrator-bug-lane');
  assert.equal(laneSkillId('feature'), 'orchestrator-feature-lane');
  assert.equal(laneSkillId(null), null);
  assert.equal(laneSkillId('nonsense'), null);
});

test('rankWithContext › null context is a no-op', () => {
  const scored = [cand('a', 0.5), cand('b', 0.1)];
  assert.deepEqual(rankWithContext(scored, null), scored);
});

test('rankWithContext › lane prior lifts the active lane skill', () => {
  const scored = [cand('orchestrator-bug-lane', 0.0), cand('other', 0.3)];
  const ranked = rankWithContext(scored, { lane: 'bug', gate: null });
  const bug = ranked.find((r) => r.skillId === 'orchestrator-bug-lane');
  assert.equal(bug?.confidence, LANE_PRIOR);
});

test('rankWithContext › debug prior lifts tdd-debug at an implementation gate', () => {
  const scored = [cand('tdd-debug', 0.0)];
  assert.equal(rankWithContext(scored, { lane: null, gate: 'impl-started' })[0].confidence, DEBUG_PRIOR);
  // ...but not at a non-implementation gate.
  assert.equal(rankWithContext(scored, { lane: null, gate: 'spec-draft' })[0].confidence, 0);
});

test('rankWithContext › a vetoed skill is never resurrected', () => {
  const scored = [cand('orchestrator-bug-lane', 0, true)];
  const ranked = rankWithContext(scored, { lane: 'bug', gate: 'impl-started' });
  assert.equal(ranked[0].confidence, 0, 'negativeTriggered stays at 0');
});

test('selectWithContext › force-includes the lane skill even when the cut would drop it', () => {
  // Three strong non-lane skills would fill topN; the lane skill scores 0
  // lexically but must still be surfaced during its lane.
  const scored = [cand('x', 0.9), cand('y', 0.8), cand('z', 0.7), cand('orchestrator-bug-lane', 0.0)];
  const selected = selectWithContext(scored, { lane: 'bug', gate: null }, OPTS);
  assert.ok(selected.some((s) => s.skillId === 'orchestrator-bug-lane'), 'lane skill force-included');
  assert.equal(selected.length, 3, 'still capped at topN');
});

test('selectWithContext › does NOT force-include a different lane skill', () => {
  const scored = [cand('orchestrator-feature-lane', 0.0), cand('x', 0.9)];
  const selected = selectWithContext(scored, { lane: 'bug', gate: null }, OPTS);
  assert.ok(!selected.some((s) => s.skillId === 'orchestrator-feature-lane'), 'wrong lane not surfaced');
});

test('selectWithContext › null context behaves like a plain operating-point cut', () => {
  const scored = [cand('a', 0.5), cand('b', 0.1)];
  const selected = selectWithContext(scored, null, OPTS);
  assert.deepEqual(selected.map((s) => s.skillId), ['a']);
});
