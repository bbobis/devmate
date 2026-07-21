// @ts-check
/**
 * Unit tests for the shared codebase-alignment contract (issue 240 extraction).
 * The feature-lane planner (required) and the bug-lane DiagnosisResult (optional)
 * both consume `alignmentErrors`; this pins the shared behavior so the two lanes
 * cannot drift.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALIGNMENT_DECISIONS,
  alignmentEntryErrors,
  alignmentErrors,
} from '../../../lib/workflow/alignment.mjs';

/** A well-formed `extend` decision. */
function extendDecision() {
  return {
    capability: 'cursor clamp',
    decision: 'extend',
    target: { symbol: 'clampCursor', path: 'lib/cursor.mjs' },
    usageEvidence: [],
    patternRefs: ['lib/cursor.mjs:44'],
    reason: 'extend the existing clamp',
  };
}

test('ALIGNMENT_DECISIONS is the frozen reuse|extend|add set', () => {
  assert.deepEqual([...ALIGNMENT_DECISIONS], ['reuse', 'extend', 'add']);
  assert.equal(Object.isFrozen(ALIGNMENT_DECISIONS), true);
});

test('alignmentErrors / required (default): missing, non-array, and empty all fail', () => {
  assert.deepEqual(alignmentErrors(undefined, 'a'), ['a must be an array']);
  assert.deepEqual(alignmentErrors('x', 'a'), ['a must be an array']);
  assert.deepEqual(alignmentErrors([], 'a'), ['a must be a non-empty array']);
  assert.deepEqual(alignmentErrors([extendDecision()], 'a'), []);
});

test('alignmentErrors / optional: absent (undefined/null) and empty are accepted', () => {
  assert.deepEqual(alignmentErrors(undefined, 'a', { required: false }), []);
  assert.deepEqual(alignmentErrors(null, 'a', { required: false }), []);
  assert.deepEqual(alignmentErrors([], 'a', { required: false }), []);
  // A present value must still be an array of well-formed entries.
  assert.deepEqual(alignmentErrors('x', 'a', { required: false }), ['a must be an array']);
  assert.deepEqual(alignmentErrors([extendDecision()], 'a', { required: false }), []);
});

test('alignmentErrors / labels each entry positionally', () => {
  const errors = alignmentErrors([{ decision: 'refactor' }], 'a', { required: false });
  assert.equal(errors.some((e) => e.startsWith('a[0].decision must be one of')), true);
});

test('alignmentEntryErrors / per-decision evidence rules', () => {
  assert.deepEqual(alignmentEntryErrors(null, 'e'), ['e must be an object']);

  // reuse requires target + usageEvidence
  const reuseBad = alignmentEntryErrors(
    { capability: 'c', decision: 'reuse', target: null, usageEvidence: [], patternRefs: [], reason: 'r' },
    'e',
  );
  assert.equal(reuseBad.some((x) => x.includes('reuse requires target.symbol and target.path')), true);
  assert.equal(reuseBad.some((x) => x.includes('reuse requires at least one usageEvidence pointer')), true);

  // extend requires target + patternRefs
  const extendBad = alignmentEntryErrors(
    { capability: 'c', decision: 'extend', target: null, usageEvidence: [], patternRefs: [], reason: 'r' },
    'e',
  );
  assert.equal(extendBad.some((x) => x.includes('extend requires target.symbol and target.path')), true);
  assert.equal(extendBad.some((x) => x.includes('extend requires at least one patternRefs pointer')), true);

  // add requires patternRefs; target may be null
  const addBad = alignmentEntryErrors(
    { capability: 'c', decision: 'add', target: null, usageEvidence: [], patternRefs: [], reason: 'r' },
    'e',
  );
  assert.equal(addBad.some((x) => x.includes('add requires at least one patternRefs pointer')), true);

  assert.deepEqual(alignmentEntryErrors(extendDecision(), 'e'), []);
});
