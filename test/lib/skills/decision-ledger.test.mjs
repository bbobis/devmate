// @ts-check
/**
 * Tests for lib/skills/decision-ledger.mjs — the append/read cycle, the loader
 * canary, and concurrency safety. All writes go to a tmpdir; the repo tree is
 * never touched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  recordSkillDecision,
  readSkillDecisions,
} from '../../../lib/skills/decision-ledger.mjs';

/** @returns {Promise<string>} a unique temp ledger path (nested dir does not exist yet). */
async function tempLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'devmate-skill-ledger-'));
  return join(dir, 'state', 'skill-decisions.jsonl');
}

/**
 * @param {Partial<import('../../../lib/types.mjs').SkillDecision>} [over]
 * @returns {Omit<import('../../../lib/types.mjs').SkillDecision, 'timestamp'>}
 */
function makeDecision(over = {}) {
  return {
    query: 'debug the crash',
    manifestsLoaded: 3,
    skillsDir: '/plugin/skills',
    sources: [
      { source: 'plugin', dir: '/plugin/skills', count: 3 },
      { source: 'workspace', dir: '/ws/.devmate/skills', count: 0 },
    ],
    scored: [
      {
        skillId: 'tdd-debug',
        confidence: 0.5,
        reason: 'trigger:debug',
        triggerFile: 'skills/tdd-debug/SKILL.md',
        refFiles: [],
        negativeTriggered: false,
        priority: 3,
      },
      {
        skillId: 'vetoed',
        confidence: 0,
        reason: "negative-trigger:'crash'",
        triggerFile: 'skills/vetoed/SKILL.md',
        refFiles: [],
        negativeTriggered: true,
        priority: 5,
      },
    ],
    selected: ['tdd-debug'],
    topN: 3,
    minConfidence: 0.25,
    lane: 'bug',
    gate: 'impl-started',
    intent: null,
    ...over,
  };
}

describe('decision-ledger', () => {
  it('appends a decision and creates the parent directory', async () => {
    const ledgerPath = await tempLedger();
    await recordSkillDecision(makeDecision(), { ledgerPath });

    const rows = await readSkillDecisions(ledgerPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query, 'debug the crash');
    assert.equal(typeof rows[0].timestamp, 'string');
  });

  it('records negatively-triggered candidates (no longer triple-blind)', async () => {
    const ledgerPath = await tempLedger();
    await recordSkillDecision(makeDecision(), { ledgerPath });

    const [row] = await readSkillDecisions(ledgerPath);
    const vetoed = row.scored.find((s) => s.skillId === 'vetoed');
    assert.ok(vetoed, 'the negatively-triggered candidate is present in the ledger');
    assert.equal(vetoed?.negativeTriggered, true);
  });

  it('carries the loader canary (manifestsLoaded + skillsDir)', async () => {
    const ledgerPath = await tempLedger();
    // Simulate the empty-catalog bug: the loader resolved a dir with no skills.
    await recordSkillDecision(
      makeDecision({ manifestsLoaded: 0, skillsDir: '/workspace/skills', scored: [], selected: [] }),
      { ledgerPath },
    );

    const [row] = await readSkillDecisions(ledgerPath);
    assert.equal(row.manifestsLoaded, 0, 'canary exposes the empty catalog');
    assert.equal(row.skillsDir, '/workspace/skills');
  });

  it('reads [] from a ledger that does not exist yet', async () => {
    const ledgerPath = await tempLedger();
    assert.deepEqual(await readSkillDecisions(ledgerPath), []);
  });

  it('concurrent appends do not interleave or drop entries', async () => {
    const ledgerPath = await tempLedger();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        recordSkillDecision(makeDecision({ query: `q-${i}` }), { ledgerPath }),
      ),
    );

    const rows = await readSkillDecisions(ledgerPath);
    assert.equal(rows.length, 8, 'every concurrent append landed');
    const queries = new Set(rows.map((r) => r.query));
    assert.equal(queries.size, 8, 'no entry was lost or duplicated');
  });
});
