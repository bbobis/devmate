// @ts-check
/**
 * DN-1: devmate-doctor.mjs domain warning checks — declared-but-missing
 * contextFile, dangling relatedDomains id, and the all-valid no-warnings case.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/devmate-doctor.mjs';

/** Silence stdio during a run, capturing everything written. */
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

/**
 * @param {string[]} args
 * @returns {Promise<{ code: number, out: string }>}
 */
async function run(args) {
  /** @type {string[]} */
  const chunks = [];
  const capture = /** @type {typeof process.stdout.write} */ ((c) => {
    chunks.push(String(c));
    return true;
  });
  process.stdout.write = capture;
  process.stderr.write = capture;
  let code;
  try {
    code = await main(args);
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, out: chunks.join('') };
}

/**
 * @param {unknown} configOverrides  Merged into a minimal valid config object.
 * @returns {Promise<string>}  The temp repo root.
 */
async function makeRepo(configOverrides) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'devmate-doctor-domains-'));
  await fsp.mkdir(join(root, '.devmate'), { recursive: true });
  const config = {
    schemaVersion: 1,
    personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
    ...(/** @type {Record<string, unknown>} */ (configOverrides)),
  };
  await fsp.writeFile(join(root, '.devmate', 'devmate.config.json'), JSON.stringify(config), 'utf8');
  return root;
}

test('devmate-doctor - declared-but-missing contextFile produces a warning containing the path', async () => {
  const root = await makeRepo({
    domains: [
      {
        domain: 'billing',
        keywords: ['invoice'],
        globs: ['packages/billing/**'],
        contextFile: '.devmate/contexts/billing.md',
      },
    ],
  });
  try {
    const { out } = await run(['--root', root]);
    assert.match(out, /domain 'billing' contextFile not found: \.devmate\/contexts\/billing\.md/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('devmate-doctor - dangling relatedDomains id produces a warning', async () => {
  const root = await makeRepo({
    domains: [
      { domain: 'billing', keywords: ['invoice'], globs: ['packages/billing/**'], relatedDomains: ['orders'] },
    ],
  });
  try {
    const { out } = await run(['--root', root]);
    assert.match(out, /domain 'billing' relatedDomains references unknown domain 'orders'/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('devmate-doctor - missing entryPoints path produces a warning', async () => {
  const root = await makeRepo({
    domains: [
      {
        domain: 'billing',
        keywords: ['invoice'],
        globs: ['packages/billing/**'],
        entryPoints: ['packages/billing/src/index.ts'],
      },
    ],
  });
  try {
    const { out } = await run(['--root', root]);
    assert.match(out, /domain 'billing' entryPoints path not found: packages\/billing\/src\/index\.ts/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('devmate-doctor - all-valid domains produce no domain warnings', async () => {
  const root = await makeRepo({});
  await fsp.mkdir(join(root, '.devmate', 'contexts'), { recursive: true });
  await fsp.writeFile(join(root, '.devmate', 'contexts', 'billing.md'), '# Billing', 'utf8');
  await fsp.mkdir(join(root, 'packages', 'billing', 'src'), { recursive: true });
  await fsp.writeFile(join(root, 'packages', 'billing', 'src', 'index.ts'), 'export {};', 'utf8');
  // Rewrite config with the fully-valid domain now that the files exist.
  await fsp.writeFile(
    join(root, '.devmate', 'devmate.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      personas: [{ persona: 'backend', editableGlobs: ['src/**'] }],
      domains: [
        {
          domain: 'billing',
          keywords: ['invoice'],
          globs: ['packages/billing/**'],
          contextFile: '.devmate/contexts/billing.md',
          entryPoints: ['packages/billing/src/index.ts'],
        },
      ],
    }),
    'utf8',
  );
  try {
    const { out } = await run(['--root', root]);
    assert.doesNotMatch(out, /devmate-doctor/);
    const summaryLine = out.split('\n').find((line) => line.startsWith('{'));
    assert.ok(summaryLine);
    const summary = JSON.parse(/** @type {string} */ (summaryLine));
    assert.deepEqual(summary.domainWarnings, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('devmate-doctor - missing devmate.config.json skips domain checks silently (no crash, no warnings)', async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), 'devmate-doctor-noconfig-'));
  try {
    const { out } = await run(['--root', root]);
    assert.doesNotMatch(out, /devmate-doctor/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('devmate-doctor - persisted result file includes domainWarnings alongside the memory diagnosis', async () => {
  const root = await makeRepo({
    domains: [
      { domain: 'billing', keywords: ['invoice'], globs: ['packages/billing/**'], relatedDomains: ['orders'] },
    ],
  });
  try {
    await run(['--root', root]);
    const resultPath = join(root, '.devmate', 'state', 'memory-doctor-result.json');
    const persisted = JSON.parse(await fsp.readFile(resultPath, 'utf8'));
    assert.ok(Array.isArray(persisted.domainWarnings));
    assert.match(persisted.domainWarnings[0], /domain 'billing' relatedDomains references unknown domain 'orders'/);
    // The memory diagnosis fields must still be present unchanged.
    assert.ok('ok' in persisted);
    assert.ok('firstBrokenStage' in persisted);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
