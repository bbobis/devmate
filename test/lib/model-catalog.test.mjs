// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAgentFrontmatter } from '../../lib/agent-validator.mjs';
import { loadModelCatalog, checkModelRule, DEFAULT_CATALOG_PATH } from '../../lib/model-catalog.mjs';

/** A minimal catalog standing in for config/model-catalog.json. */
const CATALOG = /** @type {import('../../lib/model-catalog.mjs').ModelCatalog} */ ({
  schemaVersion: 1,
  verifiedAt: '2026-07-13',
  source: 'https://example.invalid/models',
  models: {
    'Claude Sonnet 5 (copilot)': { input: 2, output: 10, bestFor: 'general' },
    'Claude Opus 4.8 (copilot)': { input: 5, output: 25, bestFor: 'deep reasoning' },
  },
  inheritPicker: ['router'],
});

/**
 * @param {string} yaml  Frontmatter body (without the `---` fences).
 * @returns {import('../../lib/agent-validator.mjs').AgentFrontmatter}
 */
const fm = (yaml) => parseAgentFrontmatter(`---\n${yaml}\n---\n\nbody\n`);

describe('parseAgentFrontmatter — model field', () => {
  it('normalizes a scalar model to a one-element array', () => {
    assert.deepEqual(fm('name: a\nmodel: Claude Sonnet 5 (copilot)').model, [
      'Claude Sonnet 5 (copilot)',
    ]);
  });

  it('parses the inline array form (VS Code availability fallback)', () => {
    assert.deepEqual(
      fm("name: a\nmodel: ['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']").model,
      ['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']
    );
  });

  it('parses the block array form', () => {
    assert.deepEqual(
      fm('name: a\nmodel:\n  - Claude Opus 4.8 (copilot)\n  - Claude Sonnet 5 (copilot)').model,
      ['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']
    );
  });

  it('leaves model undefined when the key is absent', () => {
    assert.equal(fm('name: a\ntools: [read]').model, undefined);
  });

  it('ignores YAML comments, so a `# ...` line is not mistaken for a field', () => {
    const parsed = fm('name: a\n# No `model:` — inherits the picker (Auto).\ntools: [read]');
    assert.equal(parsed.model, undefined);
    assert.equal(parsed.name, 'a');
  });
});

describe('checkModelRule', () => {
  it('accepts a pinned model that is in the catalog', () => {
    const v = checkModelRule(fm('model: Claude Sonnet 5 (copilot)'), 'planner', CATALOG);
    assert.deepEqual(v, []);
  });

  it('accepts every entry of an availability-fallback array', () => {
    const v = checkModelRule(
      fm("model: ['Claude Opus 4.8 (copilot)', 'Claude Sonnet 5 (copilot)']"),
      'security',
      CATALOG
    );
    assert.deepEqual(v, []);
  });

  it('accepts an absent model when the agent is registered in inheritPicker', () => {
    const v = checkModelRule(fm('tools: [read]'), 'router', CATALOG);
    assert.deepEqual(v, []);
  });

  it('rejects a typo — the defect that used to ship green', () => {
    const v = checkModelRule(fm('model: Claude Sonet 5 (copilot)'), 'planner', CATALOG);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /not in config\/model-catalog\.json/);
  });

  it('rejects `Auto (copilot)`, which is not a documented frontmatter value', () => {
    const v = checkModelRule(fm('model: Auto (copilot)'), 'security', CATALOG);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /not a valid 'model:' value/);
    assert.match(v[0].message, /omit the 'model:' key entirely/);
  });

  it('rejects an unregistered agent that declares no model (silent picker fallback)', () => {
    const v = checkModelRule(fm('tools: [read]'), 'security', CATALOG);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /declares no 'model:'/);
  });

  it('rejects an inheritPicker agent that also pins a model', () => {
    const v = checkModelRule(fm('model: Claude Sonnet 5 (copilot)'), 'router', CATALOG);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /Pick one/);
  });
});

describe('loadModelCatalog', () => {
  it('loads the shipped catalog and exposes the models the roster pins', () => {
    const catalog = loadModelCatalog();
    assert.ok(catalog.models['Claude Opus 4.8 (copilot)']);
    assert.ok(catalog.models['Claude Sonnet 5 (copilot)']);
    assert.ok(catalog.models['GPT-5.3-Codex (copilot)']);
    assert.ok(catalog.verifiedAt);
    assert.ok(catalog.source.startsWith('https://'));
    assert.equal(DEFAULT_CATALOG_PATH.endsWith('model-catalog.json'), true);
  });

  it('rejects a catalog whose model names were never sourced', () => {
    const dir = join(tmpdir(), `model-catalog-test-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, 'no-source.json');
    writeFileSync(
      bad,
      JSON.stringify({
        schemaVersion: 1,
        verifiedAt: '2026-07-13',
        models: { 'X (copilot)': { input: 1, output: 2, bestFor: 'x' } },
        inheritPicker: [],
      })
    );
    try {
      assert.throws(() => loadModelCatalog({ catalogPath: bad }), /source must be a URL/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
