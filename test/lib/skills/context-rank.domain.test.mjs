// @ts-check
/**
 * DN-5: tests for the domain-aware additive prior in the Stage-2 re-rank
 * (lib/skills/context-rank.mjs). The regression contract is score identity —
 * absent/empty domains must leave every score byte-identical to the
 * pre-domain behavior — and the prior is additive-and-capped only: no
 * force-include, no resurrection of vetoed skills, never able to displace a
 * lexically-strong rank-1 match on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankWithContext,
  selectWithContext,
  DOMAIN_PRIOR,
  DOMAIN_PRIOR_CAP,
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

/**
 * @param {string} skillId
 * @param {{ triggers?: string[], tags?: string[], synonyms?: string[] }} [vocab]
 * @returns {import('../../../lib/types.mjs').SkillManifest}
 */
function manifest(skillId, vocab = {}) {
  return {
    skillId,
    triggerFile: `skills/${skillId}/SKILL.md`,
    refFiles: [],
    triggers: vocab.triggers ?? [],
    tags: vocab.tags ?? [],
    synonyms: vocab.synonyms ?? [],
    negativeTriggers: [],
    triggerLineCount: 10,
  };
}

const OPTS = { topN: 3, minConfidence: 0.25 };

const CATALOG = [
  manifest('payments-hardening', { tags: ['billing', 'payment'], triggers: ['harden payments'] }),
  manifest('generic-docs', { tags: ['docs'], triggers: ['write docs'] }),
  manifest('security-review', { tags: ['security', 'invoice'] }),
];

/** @returns {import('../../../lib/types.mjs').MatchContext} */
function billingCtx() {
  return {
    lane: null,
    gate: null,
    domains: ['billing'],
    domainKeywords: { billing: ['invoice', 'payment', 'refund'] },
  };
}

test('domain prior › absent/empty domains leave every score identical (regression)', () => {
  const scored = [cand('payments-hardening', 0.4), cand('generic-docs', 0.3), cand('security-review', 0.1)];
  const base = rankWithContext(scored, { lane: null, gate: null });

  const withEmpty = rankWithContext(scored, { lane: null, gate: null, domains: [], domainKeywords: {} }, CATALOG);
  assert.deepEqual(withEmpty, base, 'empty domains must not change any score');

  const withAbsent = rankWithContext(scored, { lane: null, gate: null }, CATALOG);
  assert.deepEqual(withAbsent, base, 'absent domains must not change any score');
});

test('domain prior › a skill tagged with the domain vocabulary gains exactly DOMAIN_PRIOR', () => {
  const scored = [cand('payments-hardening', 0.1), cand('generic-docs', 0.1)];
  const ranked = rankWithContext(scored, billingCtx(), CATALOG);
  const boosted = ranked.find((r) => r.skillId === 'payments-hardening');
  const unboosted = ranked.find((r) => r.skillId === 'generic-docs');
  assert.equal(boosted?.confidence, Math.round((0.1 + DOMAIN_PRIOR) * 10000) / 10000);
  assert.match(boosted?.reason ?? '', /state:domain:billing/);
  assert.equal(unboosted?.confidence, 0.1, 'a skill with no vocabulary overlap gains nothing');
});

test('domain prior › applied once per matching domain, total capped at DOMAIN_PRIOR_CAP', () => {
  // Both active domains intersect the same skill: 2 x DOMAIN_PRIOR (0.4)
  // must cap at DOMAIN_PRIOR_CAP (0.3).
  const ctx = {
    lane: /** @type {string|null} */ (null),
    gate: /** @type {string|null} */ (null),
    domains: ['billing', 'orders'],
    domainKeywords: { billing: ['payment'], orders: ['payment'] },
  };
  const scored = [cand('payments-hardening', 0.2)];
  const ranked = rankWithContext(scored, ctx, CATALOG);
  assert.equal(ranked[0].confidence, Math.round((0.2 + DOMAIN_PRIOR_CAP) * 10000) / 10000);
  assert.match(ranked[0].reason, /state:domain:billing/);
  assert.match(ranked[0].reason, /state:domain:orders/);
});

test('domain prior › the domain id itself counts as intersection vocabulary', () => {
  // No keywords at all — but the skill carries a 'billing' tag and the domain
  // id is billing, so the id-token intersection fires.
  const ctx = {
    lane: /** @type {string|null} */ (null),
    gate: /** @type {string|null} */ (null),
    domains: ['billing'],
    domainKeywords: {},
  };
  const scored = [cand('payments-hardening', 0.1)];
  const ranked = rankWithContext(scored, ctx, CATALOG);
  assert.equal(ranked[0].confidence, Math.round((0.1 + DOMAIN_PRIOR) * 10000) / 10000);
});

test('domain prior › normalization parity with the semantic matcher (invoices ~ invoice)', () => {
  const ctx = {
    lane: /** @type {string|null} */ (null),
    gate: /** @type {string|null} */ (null),
    domains: ['billing'],
    domainKeywords: { billing: ['invoices'] }, // plural keyword vs singular tag
  };
  const scored = [cand('security-review', 0.1)]; // tagged 'invoice'
  const ranked = rankWithContext(scored, ctx, CATALOG);
  assert.equal(ranked[0].confidence, Math.round((0.1 + DOMAIN_PRIOR) * 10000) / 10000);
});

test('domain prior › never resurrects a vetoed skill', () => {
  const scored = [cand('payments-hardening', 0, true)];
  const ranked = rankWithContext(scored, billingCtx(), CATALOG);
  assert.equal(ranked[0].confidence, 0, 'negativeTriggered stays at 0');
  assert.equal(ranked[0].negativeTriggered, true);
});

test('domain prior › a lexically-strong match is never displaced from rank 1 by domain priors alone', () => {
  // Constants guarantee: the total domain boost stays below the trigger-phrase
  // weight (0.5) and below the workflow-state priors — asserted here so a
  // future calibration cannot silently break the invariant.
  assert.ok(DOMAIN_PRIOR_CAP < 0.5, 'cap must stay below W_TRIGGER_PHRASE (0.5)');
  assert.ok(DOMAIN_PRIOR < LANE_PRIOR, 'domain prior must stay below the lane prior');
  assert.ok(DOMAIN_PRIOR < DEBUG_PRIOR, 'domain prior must stay below the debug prior');

  // Behavioral: a 0.5 trigger-phrase skill vs a 0-lexical skill with the
  // maximum possible domain boost — the strong match keeps rank 1.
  const ctx = {
    lane: /** @type {string|null} */ (null),
    gate: /** @type {string|null} */ (null),
    domains: ['billing', 'orders'],
    domainKeywords: { billing: ['payment'], orders: ['payment'] },
  };
  const scored = [cand('generic-docs', 0.5), cand('payments-hardening', 0)];
  const ranked = rankWithContext(scored, ctx, CATALOG);
  assert.equal(ranked[0].skillId, 'generic-docs', 'lexically-strong match keeps rank 1');
  assert.equal(ranked[1].confidence, DOMAIN_PRIOR_CAP);
});

test('domain prior › domains do NOT force-include: below-floor skills stay out of the selection', () => {
  // With only the prior (0.2) the skill sits below the 0.25 floor — unlike the
  // lane skill, a domain-relevant skill must NOT be forced into the result.
  const scored = [cand('x', 0.9), cand('y', 0.8), cand('z', 0.7), cand('payments-hardening', 0)];
  const selected = selectWithContext(
    scored,
    { lane: null, gate: null, domains: ['billing'], domainKeywords: { billing: [] } },
    OPTS,
    CATALOG,
  );
  assert.ok(!selected.some((s) => s.skillId === 'payments-hardening'), 'no force-include for domains');
  assert.deepEqual(selected.map((s) => s.skillId), ['x', 'y', 'z']);
});

test('domain prior › composes with the lane prior under the existing 1.0 cap', () => {
  const ctx = {
    lane: /** @type {string|null} */ ('bug'),
    gate: /** @type {string|null} */ (null),
    domains: ['billing'],
    domainKeywords: { billing: ['bug lane orchestration'] },
  };
  // The lane skill also intersects the domain vocabulary via its id tokens? No —
  // give it an explicit manifest so both priors apply, then check the 1.0 cap.
  const catalog = [manifest('orchestrator-bug-lane', { tags: ['orchestration'] })];
  const scored = [cand('orchestrator-bug-lane', 0.6)];
  const ranked = rankWithContext(scored, ctx, catalog);
  // 0.6 + LANE_PRIOR (0.4) + DOMAIN_PRIOR (0.2) = 1.2 -> capped at 1.
  assert.equal(ranked[0].confidence, 1);
  assert.match(ranked[0].reason, /state:lane/);
  assert.match(ranked[0].reason, /state:domain:billing/);
});
