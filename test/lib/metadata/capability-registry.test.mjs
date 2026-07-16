// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRegistry, validateRegistry, renderCapabilityTable } from '../../../lib/metadata/capability-registry.mjs';

/** @typedef {import('../../../lib/types.mjs').CapabilityRegistry} CapabilityRegistry */
/** @typedef {import('../../../lib/types.mjs').CapabilityEntry} CapabilityEntry */

/** @returns {CapabilityRegistry} */
function makeValidRegistry() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    capabilities: [
      {
        id: 'test-hook',
        type: 'hook',
        name: 'Test Hook',
        description: 'A test hook.',
        invocationPath: 'scripts/test-hook.mjs',
        invocation: 'auto-registered',
      },
      {
        id: 'test-script',
        type: 'script',
        name: 'Test Script',
        description: 'A test script.',
        invocationPath: 'scripts/test-script.mjs',
        invocation: 'agent-invoked',
      },
    ],
  };
}

/**
 * Create a temp dir with a registry JSON file.
 * @param {unknown} content
 * @returns {{ dir: string, filePath: string }}
 */
function makeTempRegistry(content) {
  const dir = resolve(tmpdir(), `cap-reg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, 'capability-registry.json');
  if (typeof content === 'string') {
    writeFileSync(filePath, content, 'utf8');
  } else {
    writeFileSync(filePath, JSON.stringify(content), 'utf8');
  }
  return { dir, filePath };
}

test('loadRegistry — parses a valid registry and returns correct entry count', () => {
  const registry = makeValidRegistry();
  const { filePath, dir } = makeTempRegistry(registry);
  try {
    const result = loadRegistry(filePath);
    assert.equal(result.capabilities.length, 2);
    assert.equal(result.schemaVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRegistry — throws on malformed JSON without overwriting the file', () => {
  const { filePath, dir } = makeTempRegistry('{ not valid json }');
  try {
    assert.throws(() => loadRegistry(filePath), /Malformed JSON/);
    // File must still exist and still be the original malformed content
    const content = readFileSync(filePath, 'utf8');
    assert.equal(content, '{ not valid json }');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateRegistry — valid registry returns {ok:true}', () => {
  const result = validateRegistry(makeValidRegistry());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateRegistry — rejects entry missing id', () => {
  const registry = makeValidRegistry();
  // @ts-ignore
  registry.capabilities[0].id = '';
  const result = validateRegistry(registry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('id')));
});

test('validateRegistry — rejects entry with unknown type', () => {
  const registry = makeValidRegistry();
  // @ts-ignore
  registry.capabilities[0].type = 'unknown-type';
  const result = validateRegistry(registry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('type')));
});

test('validateRegistry — rejects entry missing invocationPath', () => {
  const registry = makeValidRegistry();
  // @ts-ignore
  registry.capabilities[0].invocationPath = '';
  const result = validateRegistry(registry);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('invocationPath')));
});

test('renderCapabilityTable — produces markdown table with correct row count for unfiltered list', () => {
  const registry = makeValidRegistry();
  const table = renderCapabilityTable(registry.capabilities);
  assert.ok(table.includes('| ID | Type | Name | Description | Invocation |'));
  // 2 data rows
  const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.includes('ID | Type'));
  assert.equal(rows.length, 2);
});

test('renderCapabilityTable — filtered by type returns only matching entries', () => {
  const registry = makeValidRegistry();
  const table = renderCapabilityTable(registry.capabilities, 'hook');
  const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.includes('ID | Type'));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes('test-hook'));
});
