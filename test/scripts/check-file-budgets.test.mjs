// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../scripts/check-file-budgets.mjs';

/** @type {string} */
let fixtureDir;

before(() => {
  fixtureDir = join(tmpdir(), `check-file-budgets-test-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

/**
 * Write a docs/file-budgets.json fixture and a set of content files.
 * @param {string} baseDir
 * @param {import('../../lib/types.mjs').FileBudget[]} budgets
 * @param {Record<string,string>} files  Map of repo-relative path to file content.
 * @returns {string} path to the budgets JSON file
 */
function buildFixture(baseDir, budgets, files) {
  mkdirSync(baseDir, { recursive: true });
  const budgetsPath = join(baseDir, 'file-budgets.json');
  writeFileSync(budgetsPath, JSON.stringify(budgets));
  // @bounded-alloc — writes the fixture files declared by this test case.
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(baseDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return budgetsPath;
}

describe('check-file-budgets main()', () => {
  it('returns 0 for a fixture directory where all files are within budget', async () => {
    const dir = join(fixtureDir, 'all-pass');
    const budgetsPath = buildFixture(
      dir,
      [{ path: 'docs/agent.md', maxLines: 10, maxTokensEstimate: 200 }],
      { 'docs/agent.md': 'line1\nline2\nline3\n' }
    );
    const code = await main([], budgetsPath, dir);
    assert.equal(code, 0);
  });

  it('returns 1 and prints a violation table when one file exceeds its limit', async () => {
    const dir = join(fixtureDir, 'one-fail');
    // Write a file with 6 lines but budget is 3
    const budgetsPath = buildFixture(
      dir,
      [{ path: 'docs/bloated.md', maxLines: 3 }],
      { 'docs/bloated.md': 'a\nb\nc\nd\ne\nf\n' }
    );
    const code = await main([], budgetsPath, dir);
    assert.equal(code, 1);
  });

  it('glob expansion correctly checks all matched files', async () => {
    const dir = join(fixtureDir, 'glob-expand');
    // Two agent files both under budget
    const budgetsPath = buildFixture(
      dir,
      [{ path: '.github/agents/*.md', maxLines: 10 }],
      {
        '.github/agents/orchestrator.md': 'role\nboundaries\n',
        '.github/agents/frontend.md': 'role\nboundaries\n',
      }
    );
    const code = await main([], budgetsPath, dir);
    assert.equal(code, 0);
  });

  it('glob expansion returns 1 when a matched file is over budget', async () => {
    const dir = join(fixtureDir, 'glob-fail');
    // One matched agent file exceeds the budget
    const budgetsPath = buildFixture(
      dir,
      [{ path: '.github/agents/*.md', maxLines: 2 }],
      {
        '.github/agents/orchestrator.md': 'a\nb\nc\nd\ne\n',
      }
    );
    const code = await main([], budgetsPath, dir);
    assert.equal(code, 1);
  });
});
