// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { main, applySentinel, buildBlock } from '../../scripts/generate-docs.mjs';

/** @returns {import('../../lib/types.mjs').CapabilityRegistry} */
function makeRegistry() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: [
      {
        id: 'hook-one',
        type: 'hook',
        name: 'Hook One',
        description: 'First hook.',
        invocationPath: 'scripts/hook-one.mjs',
        invocation: 'auto-registered',
      },
    ],
  };
}

/**
 * Set up a temp root with the minimal structure needed.
 * @returns {{ root: string, registryPath: string }}
 */
function makeTempRoot() {
  const root = resolve(tmpdir(), `gen-docs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  const registryPath = resolve(root, 'docs', 'capability-registry.json');
  writeFileSync(registryPath, JSON.stringify(makeRegistry()), 'utf8');
  return { root, registryPath };
}

test('generate-docs main() — writes generated block to output file, leaves manual content intact', async () => {
  const { root, registryPath } = makeTempRoot();
  try {
    // Seed README with manual content outside the sentinels
    const readmePath = resolve(root, 'README.md');
    writeFileSync(readmePath, '# Manual Header\n\nSome manual text.\n', 'utf8');

    const code = await main([], { registryPath, rootOverride: root });
    assert.equal(code, 0);

    const content = readFileSync(readmePath, 'utf8');
    assert.ok(content.includes('# Manual Header'), 'manual content preserved above sentinel');
    assert.ok(content.includes('<!-- generated:capability-table -->'), 'sentinel marker present');
    assert.ok(content.includes('hook-one'), 'registry entry rendered in table');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applySentinel — replaces existing block, preserves content outside markers', () => {
  const initial = '# Title\n\n<!-- generated:my-section -->\nold content\n<!-- /generated:my-section -->\n\n# After\n';
  const result = applySentinel(initial, 'my-section', 'new content\n');
  assert.ok(result.includes('new content'), 'new content present');
  assert.ok(!result.includes('old content'), 'old content removed');
  assert.ok(result.includes('# Title'), 'content before sentinel preserved');
  assert.ok(result.includes('# After'), 'content after sentinel preserved');
});

test('applySentinel — appends block when sentinel not present', () => {
  const initial = '# Title\n';
  const result = applySentinel(initial, 'new-section', 'inserted content\n');
  assert.ok(result.includes('<!-- generated:new-section -->'), 'open sentinel appended');
  assert.ok(result.includes('inserted content'), 'content appended');
});

test('buildBlock — wraps content in open and close sentinels', () => {
  const block = buildBlock('test-id', 'some content\n');
  assert.ok(block.startsWith('<!-- generated:test-id -->'));
  assert.ok(block.includes('some content'));
  assert.ok(block.includes('<!-- /generated:test-id -->'));
});
