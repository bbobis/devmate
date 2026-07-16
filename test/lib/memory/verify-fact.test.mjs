// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyFactSource } from '../../../lib/memory/verify-fact.mjs';
import { queryMemory } from '../../../lib/memory/query.mjs';

/**
 * @param {string} source
 * @param {number} ts
 * @returns {Record<string, unknown>}
 */
function fact(source, ts) {
  return {
    event: 'fact',
    key: `${source}:${ts}`,
    source,
    tool: 'write_file',
    lane: 'feature',
    tags: [],
    summary: `edited ${source}`,
    confidence: 0.8,
    ts,
    stepId: '1',
    firstEdit: true,
  };
}

test('verifyFactSource resolves an existing source and rejects a missing one', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-fact-'));
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'a.mjs'), 'export const x = 1;', 'utf8');

    assert.equal(verifyFactSource({ source: 'lib/a.mjs' }, root).resolves, true);
    assert.equal(verifyFactSource({ source: 'lib/gone.mjs' }, root).resolves, false);
    assert.equal(verifyFactSource({ source: '' }, root).resolves, false);
    assert.equal(verifyFactSource({}, root).resolves, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('queryMemory with verifyRoot drops facts whose source no longer resolves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-query-'));
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    writeFileSync(join(root, 'lib', 'live.mjs'), 'export const x = 1;', 'utf8');
    // lib/gone.mjs is NOT created — its fact is drifted.
    const ledger = join(root, 'repo.jsonl');
    writeFileSync(
      ledger,
      `${JSON.stringify(fact('lib/live.mjs', 1))}\n${JSON.stringify(fact('lib/gone.mjs', 2))}\n`,
      'utf8',
    );

    const unverified = await queryMemory(ledger, {});
    assert.equal(unverified.matches.length, 2, 'without verify, both facts returned');

    const verified = await queryMemory(ledger, {}, { verifyRoot: root });
    assert.equal(verified.matches.length, 1, 'drifted fact dropped');
    assert.equal(verified.matches[0].source, 'lib/live.mjs');
    assert.equal(verified.driftedExcluded, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
