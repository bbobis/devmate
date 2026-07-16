// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBudgets, estimateTokens, checkFileBudget } from '../../lib/budgets.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `budgets-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('loadBudgets', () => {
  it('parses a valid file-budgets.json and returns the correct entry count', () => {
    const p = join(fixtureDir, 'valid-budgets.json');
    writeFileSync(p, JSON.stringify([
      { path: 'docs/foo.md', maxLines: 60 },
      { path: 'docs/bar.md', maxLines: 80, maxTokensEstimate: 800 },
    ]));
    const budgets = loadBudgets(p);
    assert.equal(budgets.length, 2);
    assert.equal(budgets[0].path, 'docs/foo.md');
    assert.equal(budgets[1].maxLines, 80);
  });

  it('throws on malformed JSON', () => {
    const p = join(fixtureDir, 'bad-budgets.json');
    writeFileSync(p, '{ not valid json ]]]');
    assert.throws(
      () => loadBudgets(p),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('malformed JSON'), `expected "malformed JSON" in: ${err.message}`);
        return true;
      }
    );
  });
});

describe('estimateTokens', () => {
  it('returns ceil(text.length / 4) for a known input', () => {
    // 12 chars / 4 = 3 exactly
    assert.equal(estimateTokens('abcdefghijkl'), 3);
    // 13 chars / 4 = 3.25 -> ceil = 4
    assert.equal(estimateTokens('abcdefghijklm'), 4);
    // empty string
    assert.equal(estimateTokens(''), 0);
  });
});

describe('checkFileBudget', () => {
  it('returns {passed: true} for a file under both limits', async () => {
    const p = join(fixtureDir, 'under-budget.md');
    writeFileSync(p, 'line1\nline2\nline3\n');
    const result = await checkFileBudget(p, {
      path: 'fixture/under-budget.md',
      maxLines: 10,
      maxTokensEstimate: 500,
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.violations, []);
  });

  it('returns {passed: false} with a violation message when line count exceeds maxLines', async () => {
    const p = join(fixtureDir, 'over-lines.md');
    writeFileSync(p, 'a\nb\nc\nd\ne\n');
    const result = await checkFileBudget(p, {
      path: 'fixture/over-lines.md',
      maxLines: 3,
    });
    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
    assert.ok(
      result.violations[0].includes('maxLines'),
      `expected "maxLines" in: ${result.violations[0]}`
    );
  });

  it('returns {passed: false} with a violation message when estimated tokens exceed maxTokensEstimate', async () => {
    const p = join(fixtureDir, 'over-tokens.md');
    // 40 chars = 10 tokens, budget is 5
    writeFileSync(p, '1234567890123456789012345678901234567890');
    const result = await checkFileBudget(p, {
      path: 'fixture/over-tokens.md',
      maxLines: 100,
      maxTokensEstimate: 5,
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.violations.some((v) => v.includes('maxTokensEstimate')),
      `expected "maxTokensEstimate" in violations: ${JSON.stringify(result.violations)}`
    );
  });
});
