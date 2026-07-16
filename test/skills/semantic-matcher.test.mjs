// @ts-check
/**
 * Unit tests for lib/skills/semantic-matcher.mjs
 * Covers: normalizeQuery (lowercase + punctuation stripping), scoreManifest
 * (synonyms, priority, negative triggers, position bonus), and matchSkills
 * (sort, filter, topN).
 *
 * NOTE: normalizeQuery runs a simple suffix stripper, not a full Porter
 * stemmer. Tests here only assert on tokenisation behaviour that is stable
 * and verified by the pre-existing suite at test/lib/skills/semantic-matcher.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQuery,
  scoreManifest,
  matchSkills,
  scoreAll,
  selectMatches,
} from '../../lib/skills/semantic-matcher.mjs';

/** @typedef {import('../../lib/types.mjs').SkillManifest} SkillManifest */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SkillManifest with sane defaults.
 * @param {Partial<SkillManifest>} overrides
 * @returns {SkillManifest}
 */
function makeManifest(overrides = {}) {
  return {
    skillId: 'test-skill',
    triggerFile: 'skills/test-skill/SKILL.md',
    refFiles: [],
    triggers: [],
    tags: [],
    negativeTriggers: [],
    synonyms: [],
    priority: 5,
    triggerLineCount: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeQuery
// ---------------------------------------------------------------------------

describe('normalizeQuery', () => {
  it('lowercases tokens', () => {
    const result = normalizeQuery('DEPLOY');
    assert.ok(result.some((t) => t === 'deploy' || t.startsWith('deploy')),
      `expected a token starting with 'deploy' in ${JSON.stringify(result)}`);
  });

  it('strips punctuation', () => {
    const result = normalizeQuery('hello, world!');
    assert.ok(!result.some((t) => t.includes(',') || t.includes('!')),
      `punctuation should be stripped, got ${JSON.stringify(result)}`);
  });

  it('returns empty array for non-string input', () => {
    // @ts-expect-error intentional bad input
    assert.deepEqual(normalizeQuery(null), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(normalizeQuery(''), []);
  });

  it('does NOT collapse a multi-word phrase into one token', () => {
    const result = normalizeQuery('write code');
    assert.ok(result.length >= 2, `expected at least 2 tokens, got ${JSON.stringify(result)}`);
  });
});

// ---------------------------------------------------------------------------
// scoreManifest — synonyms
// ---------------------------------------------------------------------------

describe('scoreManifest: synonyms expand token overlap', () => {
  it('synonym token increases confidence over baseline', () => {
    const manifest = makeManifest({
      skillId: 'crash-debug',
      triggers: ['debug'],
      synonyms: ['crash', 'panic'],
    });
    const withSynonymQuery = normalizeQuery('the app crash');
    const withoutSynonymQuery = normalizeQuery('app stopped working');

    const withResult = scoreManifest(manifest, withSynonymQuery);
    const withoutResult = scoreManifest(manifest, withoutSynonymQuery);

    assert.ok(
      withResult.confidence > withoutResult.confidence,
      `expected synonym query (${withResult.confidence}) > baseline (${withoutResult.confidence})`,
    );
  });

  it('reason string mentions (+synonyms) when synonyms contributed', () => {
    const manifest = makeManifest({
      skillId: 'crash-debug',
      triggers: ['debug'],
      synonyms: ['crash'],
    });
    const result = scoreManifest(manifest, normalizeQuery('crash the service'));
    assert.match(result.reason, /\+synonyms/);
  });

  it('zero synonyms: reason does NOT mention (+synonyms)', () => {
    const manifest = makeManifest({
      skillId: 'tdd',
      triggers: ['test'],
      synonyms: [],
    });
    const result = scoreManifest(manifest, normalizeQuery('test the function'));
    assert.ok(
      !result.reason.includes('+synonyms'),
      `unexpected +synonyms in reason: ${result.reason}`,
    );
  });
});

// ---------------------------------------------------------------------------
// scoreManifest — priority
// ---------------------------------------------------------------------------

describe('scoreManifest: priority field', () => {
  it('carries manifest.priority through to MatchResult', () => {
    const manifest = makeManifest({ skillId: 'hi-pri', triggers: ['deploy'], priority: 1 });
    const result = scoreManifest(manifest, normalizeQuery('deploy the service'));
    assert.equal(result.priority, 1);
  });

  it('defaults priority to 5 when manifest.priority is undefined', () => {
    const manifest = makeManifest({ skillId: 'default-pri', triggers: ['deploy'] });
    const manifestWithoutPriority = /** @type {SkillManifest} */ ({ ...manifest, priority: undefined });
    const result = scoreManifest(manifestWithoutPriority, normalizeQuery('deploy the service'));
    assert.equal(result.priority, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreManifest — negative triggers
// ---------------------------------------------------------------------------

describe('scoreManifest: negative triggers', () => {
  it('hard-excludes the skill when a negative trigger fires', () => {
    const manifest = makeManifest({
      skillId: 'learn-skill',
      triggers: ['learn', 'research'],
      negativeTriggers: ['debug', 'fix'],
    });
    const result = scoreManifest(manifest, normalizeQuery('debug and fix the error'));
    assert.equal(result.negativeTriggered, true);
    assert.equal(result.confidence, 0);
  });

  it('does NOT exclude when no negative trigger fires', () => {
    const manifest = makeManifest({
      skillId: 'learn-skill',
      triggers: ['learn'],
      negativeTriggers: ['debug'],
    });
    const result = scoreManifest(manifest, normalizeQuery('learn how to write tests'));
    assert.equal(result.negativeTriggered, false);
    assert.ok(result.confidence > 0);
  });

  it('a multi-word negative does NOT fire on a single shared token (self-nuke fix)', () => {
    // 'write docs' shares the token 'write' with the trigger 'write code', but
    // must not exclude the skill unless the full phrase 'write docs' appears.
    const manifest = makeManifest({
      skillId: 'coding',
      triggers: ['write code'],
      negativeTriggers: ['write docs'],
    });
    const result = scoreManifest(manifest, normalizeQuery('write code to parse the CSV'));
    assert.equal(result.negativeTriggered, false, "'write docs' must not fire on bare 'write'");
    assert.ok(result.confidence > 0, 'the trigger phrase scores');
  });

  it('a multi-word negative still fires on a contiguous phrase match', () => {
    const manifest = makeManifest({
      skillId: 'coding',
      triggers: ['write code'],
      negativeTriggers: ['write docs'],
    });
    const result = scoreManifest(manifest, normalizeQuery('write docs for the module'));
    assert.equal(result.negativeTriggered, true);
    assert.equal(result.confidence, 0);
  });
});

// ---------------------------------------------------------------------------
// scoreManifest — exact trigger phrase
// ---------------------------------------------------------------------------

describe('scoreManifest: exact trigger phrase', () => {
  it('exact trigger phrase gives higher confidence than token overlap alone', () => {
    const manifest = makeManifest({
      skillId: 'tdd-debug',
      triggers: ['test driven development'],
      tags: ['tdd'],
    });
    const exact = scoreManifest(manifest, normalizeQuery('test driven development cycle'));
    const partial = scoreManifest(manifest, normalizeQuery('development cycle'));
    assert.ok(
      exact.confidence > partial.confidence,
      `exact (${exact.confidence}) should beat partial (${partial.confidence})`,
    );
  });
});

// ---------------------------------------------------------------------------
// matchSkills — sorting, filtering, topN
// ---------------------------------------------------------------------------

describe('matchSkills: sorting and filtering', () => {
  it('sorts by confidence descending', () => {
    const manifests = [
      makeManifest({ skillId: 'low', triggers: ['alpha'] }),
      makeManifest({ skillId: 'high', triggers: ['debug', 'fix', 'error'] }),
    ];
    const results = matchSkills('debug the error fix it', manifests, { minConfidence: 0 });
    assert.ok(results.length >= 1);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].confidence >= results[i].confidence,
        `result[${i - 1}].confidence (${results[i - 1].confidence}) < result[${i}].confidence (${results[i].confidence})`,
      );
    }
  });

  it('uses priority as tiebreaker when confidence is equal', () => {
    const manifests = [
      makeManifest({ skillId: 'z-skill', triggers: ['zzz'], priority: 10 }),
      makeManifest({ skillId: 'a-skill', triggers: ['zzz'], priority: 1 }),
    ];
    const results = matchSkills('zzz query', manifests, { minConfidence: 0 });
    assert.ok(results.length >= 2);
    const idx_a = results.findIndex((r) => r.skillId === 'a-skill');
    const idx_z = results.findIndex((r) => r.skillId === 'z-skill');
    assert.ok(idx_a < idx_z, `a-skill (priority=1) should come before z-skill (priority=10)`);
  });

  it('filters results below minConfidence', () => {
    const manifests = [
      makeManifest({ skillId: 'zero', triggers: ['xyzzy'] }),
    ];
    const results = matchSkills('completely unrelated query', manifests, { minConfidence: 0.5 });
    for (const r of results) {
      assert.ok(r.confidence >= 0.5, `confidence ${r.confidence} is below minConfidence 0.5`);
    }
  });

  it('caps results at topN', () => {
    const manifests = Array.from({ length: 10 }, (_, i) =>
      makeManifest({ skillId: `skill-${i}`, triggers: ['debug'] }),
    );
    const results = matchSkills('debug everything', manifests, { topN: 3 });
    assert.ok(results.length <= 3, `expected <= 3 results, got ${results.length}`);
  });

  it('returns empty array when no manifests match above minConfidence', () => {
    const manifests = [makeManifest({ skillId: 'irrelevant', triggers: ['xyzzy'] })];
    const results = matchSkills('completely different query', manifests, { minConfidence: 0.9 });
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// matchSkills — pure, no I/O (telemetry now lives in the decision ledger)
// ---------------------------------------------------------------------------

describe('matchSkills: pure with no side effects', () => {
  it('returns empty array without throwing when nothing matches', () => {
    const manifests = [makeManifest({ skillId: 'irrelevant', triggers: ['xyzzy'] })];
    const results = matchSkills('no match at all', manifests, { minConfidence: 0.9 });
    assert.deepEqual(results, []);
  });
});

// ---------------------------------------------------------------------------
// scoreAll / selectMatches — the full candidate list vs the operating-point cut
// ---------------------------------------------------------------------------

describe('scoreAll: full candidate list', () => {
  it('returns one result per manifest, sorted by confidence descending', () => {
    const manifests = [
      makeManifest({ skillId: 'low', triggers: ['xyzzy'] }),
      makeManifest({ skillId: 'high', triggers: ['debug'] }),
    ];
    const scored = scoreAll('debug the crash', manifests);
    assert.equal(scored.length, 2, 'every manifest is scored');
    assert.ok(scored[0].confidence >= scored[1].confidence, 'sorted descending');
  });

  it('retains negatively-triggered candidates (they are not dropped)', () => {
    const manifests = [
      makeManifest({ skillId: 'vetoed', triggers: ['debug'], negativeTriggers: ['crash'] }),
    ];
    const scored = scoreAll('debug the crash', manifests);
    assert.equal(scored.length, 1, 'the vetoed candidate is still present');
    assert.equal(scored[0].negativeTriggered, true);
    assert.equal(scored[0].confidence, 0);
  });
});

describe('selectMatches: applies the operating point', () => {
  it('drops negatively-triggered and below-floor candidates, then caps at topN', () => {
    const manifests = [
      makeManifest({ skillId: 'vetoed', triggers: ['debug'], negativeTriggers: ['crash'] }),
      makeManifest({ skillId: 'weak', triggers: ['xyzzy'] }),
      makeManifest({ skillId: 'strong', triggers: ['debug'] }),
    ];
    const scored = scoreAll('debug the crash', manifests);
    const selected = selectMatches(scored, { topN: 3, minConfidence: 0.25 });
    const ids = selected.map((r) => r.skillId);
    assert.ok(!ids.includes('vetoed'), 'negative-triggered excluded');
    assert.ok(!ids.includes('weak'), 'below-floor excluded');
    assert.ok(ids.includes('strong'), 'qualifying match kept');
  });

  it('matchSkills equals selectMatches(scoreAll(...))', () => {
    const manifests = [
      makeManifest({ skillId: 'a', triggers: ['debug'] }),
      makeManifest({ skillId: 'b', triggers: ['implement'] }),
    ];
    const opts = { topN: 2, minConfidence: 0.1 };
    assert.deepEqual(
      matchSkills('debug this', manifests, opts),
      selectMatches(scoreAll('debug this', manifests), opts),
    );
  });
});
