// @ts-check
/**
 * Skill-matching eval suite. Auto-runs under `node --test` as part of
 * `npm run verify`. Mirrors evals/gate-robustness/suite.test.mjs (real modules,
 * end-state grading) and evals/model-routing (a committed baseline the suite
 * gates NON-REGRESSION against, so a deliberately-RED baseline still merges
 * green and every fix ratchets the numbers up).
 *
 * It loads the REAL skill manifests and runs the REAL matcher at the exact
 * production operating point (imported from lib/skills/operating-point.mjs), so
 * the numbers here are what customers actually get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSkillManifests } from '../../lib/skills/skill-manifest.mjs';
import { scoreAll } from '../../lib/skills/semantic-matcher.mjs';
import { selectWithContext } from '../../lib/skills/context-rank.mjs';
import {
  SKILL_MATCH_TOP_N,
  SKILL_MATCH_MIN_CONFIDENCE,
} from '../../lib/skills/operating-point.mjs';
import { scoreSkillMatching } from './scorer.mjs';

const HERE = import.meta.dirname;
const EPS = 1e-9;

/** Load and flatten every fixture file into a case list (skillId injected per file). */
async function loadCases() {
  const dir = join(HERE, 'fixtures');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const docs = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8'))),
  );
  return docs.flatMap((doc) =>
    doc.cases.map((c) => ({
      phrasing: c.phrasing,
      skillId: doc.skillId,
      expect: c.expect,
      bucket: c.bucket,
      context: c.context,
    })),
  );
}

test('skill-matching eval › does not regress against the committed baseline', async (t) => {
  const [cases, manifests, baseline] = await Promise.all([
    loadCases(),
    loadSkillManifests(join(HERE, '../../skills')),
    readFile(join(HERE, 'baseline.json'), 'utf8').then(JSON.parse),
  ]);

  /**
   * @param {string} phrasing
   * @param {import('../../lib/types.mjs').MatchContext} [context]
   */
  const run = (phrasing, context) =>
    selectWithContext(
      scoreAll(phrasing, manifests),
      context ?? null,
      {
        topN: SKILL_MATCH_TOP_N,
        minConfidence: SKILL_MATCH_MIN_CONFIDENCE,
      },
      // DN-5: the catalog feeds the domain-vocabulary prior, exactly as the
      // production hook passes it.
      manifests,
    );

  const score = scoreSkillMatching(cases, run);

  // Visible report (the RED numbers are the baseline signal).
  t.diagnostic(
    `recall=${score.recall} precision=${score.precision} suppressRate=${score.suppressRate} ` +
      `neverFalseSuppress=${score.neverFalseSuppress}`,
  );
  for (const [bucket, b] of Object.entries(score.perBucket)) {
    t.diagnostic(`  [${bucket}] recall=${b.recall} precision=${b.precision} (m=${b.matchTotal} n=${b.noMatchTotal})`);
  }

  // Non-regression gates.
  assert.ok(
    score.recall + EPS >= baseline.recall,
    `overall recall regressed: ${score.recall} < baseline ${baseline.recall}`,
  );
  assert.ok(
    score.precision + EPS >= baseline.precision,
    `overall precision regressed: ${score.precision} < baseline ${baseline.precision}`,
  );
  assert.ok(
    score.suppressRate <= baseline.suppressRate + EPS,
    `suppressRate regressed (more false suppressions): ${score.suppressRate} > baseline ${baseline.suppressRate}`,
  );
  for (const [bucket, b] of Object.entries(baseline.perBucket ?? {})) {
    const cur = score.perBucket[bucket];
    if (b && typeof (/** @type {any} */ (b).recall) === 'number' && cur && typeof cur.recall === 'number') {
      assert.ok(
        cur.recall + EPS >= /** @type {any} */ (b).recall,
        `bucket '${bucket}' recall regressed: ${cur.recall} < baseline ${/** @type {any} */ (b).recall}`,
      );
    }
  }
});
