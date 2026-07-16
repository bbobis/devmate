// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { main as generateMain } from '../../scripts/generate-docs.mjs';
import { main as checkMain } from '../../scripts/check-generated-docs.mjs';

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
 * Create a temp root with registry + generated docs already written.
 * @returns {Promise<{ root: string, registryPath: string }>}
 */
async function makeUpToDateRoot() {
  const root = resolve(tmpdir(), `check-docs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  const registryPath = resolve(root, 'docs', 'capability-registry.json');
  writeFileSync(registryPath, JSON.stringify(makeRegistry()), 'utf8');
  // Generate docs into the temp root so they are up to date
  await generateMain([], { registryPath, rootOverride: root });
  return { root, registryPath };
}

test('check-generated-docs main() — returns 0 for an up-to-date fixture', async () => {
  const { root, registryPath } = await makeUpToDateRoot();
  try {
    const code = await checkMain([], { registryPath, rootOverride: root });
    assert.equal(code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('check-generated-docs main() — returns 1 and prints differing section name for a stale fixture', async () => {
  const { root, registryPath } = await makeUpToDateRoot();
  try {
    // Corrupt README generated block
    const readmePath = resolve(root, 'README.md');
    const { readFileSync } = await import('node:fs');
    const content = readFileSync(readmePath, 'utf8');
    // Replace a known generated row with stale text
    const stale = content.replace('hook-one', 'STALE-ID');
    writeFileSync(readmePath, stale, 'utf8');

    const messages = /** @type {string[]} */ ([]);
    const originalWrite = process.stderr.write.bind(process.stderr);
    // @ts-ignore
    process.stderr.write = (/** @type {string} */ msg) => { messages.push(msg); return true; };
    let code;
    try {
      code = await checkMain([], { registryPath, rootOverride: root });
    } finally {
      // @ts-ignore
      process.stderr.write = originalWrite;
    }
    assert.equal(code, 1);
    const combined = messages.join('');
    assert.ok(combined.includes('README.md') || combined.includes('capability-table'), 'differing section reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
