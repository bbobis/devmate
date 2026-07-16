// @ts-check
/**
 * E7-6 / E8 (#81): issue-quality eval suite. Asserts every positive case scores
 * 7/7 and every negative case surfaces exactly its intended broken dimension,
 * including the two #81 dimensions (contractsInlined, externalClaimsSourced).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreIssueQuality, IMPERATIVE_VERBS } from './scorer.mjs';
import { POSITIVE_CASES } from './cases.mjs';
import { NEGATIVE_CASES, ALL_BAD, FULLY_GROUNDED } from './negative-cases.mjs';

for (const c of POSITIVE_CASES) {
  test(`issue-quality › positive case scores 7/7 [${c.id}]`, () => {
    const result = scoreIssueQuality(c.id, c.body);
    assert.equal(result.score, 7, `expected 7/7, got ${result.score}: ${JSON.stringify(result)}`);
  });
}

test('issue-quality › noun title → titleImperative=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'titleImperative');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).titleImperative, false);
});

test('issue-quality › no citation → problemCited=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'problemCited');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).problemCited, false);
});

test('issue-quality › single AC bullet → hasAcceptanceCriteria=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'hasAcceptanceCriteria');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).hasAcceptanceCriteria, false);
});

test('issue-quality › missing dependencies section → dependencyListed=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'dependencyListed');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).dependencyListed, false);
});

test('issue-quality › no token impact → tokenImpactStated=false', () => {
  // eslint-disable-next-line secure-coding/no-insecure-comparison -- 'tokenImpactStated' is a rubric field name in an eval fixture, not a credential; the rule keyword-matches the literal.
  const c = NEGATIVE_CASES.find((n) => n.defect === 'tokenImpactStated');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).tokenImpactStated, false);
});

test('issue-quality › all-bad issue fails all five core dimensions', () => {
  const r = scoreIssueQuality('all-bad', ALL_BAD);
  assert.equal(r.titleImperative, false);
  assert.equal(r.problemCited, false);
  assert.equal(r.hasAcceptanceCriteria, false);
  assert.equal(r.dependencyListed, false);
  assert.equal(r.tokenImpactStated, false);
  // The two #81 dimensions are trivially true when not applicable: ALL_BAD has
  // no #N dependency (contractsInlined) and no inlined section
  // (externalClaimsSourced), so the floor score is 2, not 0.
  assert.equal(r.contractsInlined, true);
  assert.equal(r.externalClaimsSourced, true);
  assert.equal(r.score, 2);
});

test('issue-quality › imperative verb list includes Add, Build, Fix', () => {
  for (const v of ['Add', 'Build', 'Fix']) {
    assert.ok(IMPERATIVE_VERBS.includes(v), `${v} must be an approved imperative verb`);
  }
});

// ---- #81: contractsInlined dimension ----

test('issue-quality › dependency #N present + inlined contract block → contractsInlined=true', () => {
  const result = scoreIssueQuality('grounded', FULLY_GROUNDED);
  assert.equal(result.contractsInlined, true);
});

test('issue-quality › dependency #N present + no inlined block → contractsInlined=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'contractsInlined');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).contractsInlined, false);
});

test('issue-quality › Dependencies "None" → contractsInlined=true (trivial)', () => {
  const body = ['## Add a thing', '## Dependencies', 'None'].join('\n');
  assert.equal(scoreIssueQuality('none-deps', body).contractsInlined, true);
});

// ---- #81: externalClaimsSourced dimension ----

test('issue-quality › inlined block with "Source of truth: #38" → externalClaimsSourced=true', () => {
  const result = scoreIssueQuality('grounded', FULLY_GROUNDED);
  assert.equal(result.externalClaimsSourced, true);
});

test('issue-quality › inlined block without provenance line → externalClaimsSourced=false', () => {
  const c = NEGATIVE_CASES.find((n) => n.defect === 'externalClaimsSourced');
  assert.ok(c);
  assert.equal(scoreIssueQuality(c.id, c.body).externalClaimsSourced, false);
});

test('issue-quality › no inlined section → externalClaimsSourced=true (trivial)', () => {
  const body = ['## Add a thing', '## Dependencies', 'None'].join('\n');
  assert.equal(scoreIssueQuality('no-section', body).externalClaimsSourced, true);
});

test('issue-quality › fully-grounded issue scores 7/7', () => {
  assert.equal(scoreIssueQuality('grounded', FULLY_GROUNDED).score, 7);
});
