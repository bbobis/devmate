// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeLearnCommand,
  isPatternAuthoringRequest,
  validatePatternApproval,
  PATTERN_APPROVAL_PREFIX,
} from '../../../lib/workflow/learn.mjs';

/** @returns {import('../../../lib/types.mjs').Pattern} */
function makePattern(over = {}) {
  return {
    id: 'use-atomic-writes',
    title: 'Use atomic writes',
    body: '# Use atomic writes\n',
    filePath: '.devmate/patterns/use-atomic-writes.md',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** @returns {import('../../../lib/types.mjs').PatternApproval} */
function makeApproval(over = {}) {
  return {
    patternId: 'use-atomic-writes',
    approvedBy: 'approve pattern: use-atomic-writes',
    approvedAt: new Date().toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// routeLearnCommand
// ---------------------------------------------------------------------------

test('routeLearnCommand — "create pattern ..." routes to pattern-authoring', () => {
  assert.equal(routeLearnCommand('create pattern for atomic writes'), 'pattern-authoring');
});

test('routeLearnCommand — explanatory input routes to help', () => {
  assert.equal(routeLearnCommand('explain how gates work'), 'help');
});

test('routeLearnCommand — "approve pattern: foo" routes to pattern-authoring', () => {
  assert.equal(routeLearnCommand('approve pattern: foo'), 'pattern-authoring');
});

test('routeLearnCommand — empty string routes to help', () => {
  assert.equal(routeLearnCommand(''), 'help');
});

test('routeLearnCommand — is case-insensitive', () => {
  assert.equal(routeLearnCommand('WRITE PATTERN here'), 'pattern-authoring');
});

test('isPatternAuthoringRequest — mirrors routeLearnCommand', () => {
  assert.equal(isPatternAuthoringRequest('add pattern foo'), true);
  assert.equal(isPatternAuthoringRequest('how does verify work'), false);
});

// ---------------------------------------------------------------------------
// validatePatternApproval
// ---------------------------------------------------------------------------

test('validatePatternApproval — matching approval returns null', () => {
  assert.equal(validatePatternApproval(makePattern(), [makeApproval()]), null);
});

test('validatePatternApproval — missing approval returns block string', () => {
  const result = validatePatternApproval(makePattern(), []);
  assert.ok(typeof result === 'string');
  assert.match(result, /No approval found for pattern 'use-atomic-writes'/);
});

test('validatePatternApproval — wrong approvedBy prefix returns block string', () => {
  const result = validatePatternApproval(makePattern(), [
    makeApproval({ approvedBy: 'sure go ahead' }),
  ]);
  assert.ok(typeof result === 'string');
});

test('PATTERN_APPROVAL_PREFIX — is the documented phrase', () => {
  assert.equal(PATTERN_APPROVAL_PREFIX, 'approve pattern:');
});
