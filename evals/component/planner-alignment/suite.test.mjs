// @ts-check
/**
 * Issue 238: planner-alignment component eval suite. Auto-runs under
 * `node --test` (and so `npm run verify`). Grades a captured plan.json's
 * codebase-alignment decisions against a committed rubric in isolation from the
 * lane, so an alignment regression fails THIS suite on its own (attributability).
 * Mirrors the E16-4 planner component eval.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scoreComponent } from './scorer.mjs';

const HERE = import.meta.dirname;
const FIX = join(HERE, '..', 'fixtures', 'planner-alignment');

/** @param {string} name */
async function load(name) {
  return JSON.parse(await readFile(join(FIX, name), 'utf8'));
}

test('alignment scorer › known-good and known-bad outputs score correctly (no fixture)', () => {
  const rubric = { requiredCapabilities: ['hash persistence', 'role-claim guard'] };

  const good = scoreComponent(
    {
      tasks: [
        {
          alignment: [
            {
              capability: 'hash persistence',
              decision: 'reuse',
              target: { symbol: 'recordArtifactHash', path: 'lib/task-state.mjs' },
              usageEvidence: ['lib/workflow/agents/planner.mjs:321'],
              patternRefs: [],
              reason: 'existing helper already writes the hash',
            },
            {
              capability: 'role-claim guard',
              decision: 'add',
              target: null,
              usageEvidence: [],
              patternRefs: ['src/cursor.mjs:44'],
              reason: 'no existing guard for the absent-claim path',
            },
          ],
        },
      ],
    },
    rubric,
  );
  assert.equal(good.score, 1);
  assert.deepEqual(good.missing, []);
  assert.deepEqual(good.spurious, []);

  // An add decision with no patternRefs is unsatisfied; 'role-claim guard' is absent.
  const bad = scoreComponent(
    {
      tasks: [
        {
          alignment: [
            {
              capability: 'hash persistence',
              decision: 'add',
              target: null,
              usageEvidence: [],
              patternRefs: [],
              reason: 'x',
            },
            {
              capability: 'extra capability',
              decision: 'add',
              target: null,
              usageEvidence: [],
              patternRefs: ['src/x.mjs:1'],
              reason: 'y',
            },
          ],
        },
      ],
    },
    rubric,
  );
  assert.equal(bad.score, 0);
  assert.deepEqual(bad.missing, ['hash persistence', 'role-claim guard']);
  assert.deepEqual(bad.spurious, ['extra capability']);
});

test('alignment scorer › a reuse decision without usageEvidence is unsatisfied', () => {
  const r = scoreComponent(
    {
      tasks: [
        {
          alignment: [
            {
              capability: 'only cap',
              decision: 'reuse',
              target: { symbol: 'foo', path: 'lib/foo.mjs' },
              usageEvidence: [],
              patternRefs: [],
              reason: 'reuse foo',
            },
          ],
        },
      ],
    },
    { requiredCapabilities: ['only cap'] },
  );
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing, ['only cap']);
});

test('alignment eval › good fixture meets the committed baseline', async () => {
  const [output, rubric] = await Promise.all([load('good.json'), load('rubric.json')]);
  const { score, missing } = scoreComponent(output, rubric);
  assert.equal(score, rubric.expectedGoodScore, 'good-fixture score drifted from the committed baseline');
  assert.ok(score >= rubric.passThreshold, `score ${score} below threshold ${rubric.passThreshold}`);
  assert.deepEqual(missing, [], 'good fixture should satisfy every required capability');
});

test('alignment eval › degraded fixture fails this suite (attributable regression)', async () => {
  const [output, rubric] = await Promise.all([load('degraded.json'), load('rubric.json')]);
  const { score, missing } = scoreComponent(output, rubric);
  assert.ok(score < rubric.passThreshold, `degraded score ${score} should fall below ${rubric.passThreshold}`);
  assert.ok(missing.length > 0, 'degraded plan should leave a required capability unsatisfied');
});
