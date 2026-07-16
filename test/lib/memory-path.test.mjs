// @ts-check
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MEMORY_PATH,
  OLD_MEMORY_PATHS,
  REPO_LEDGER_REL,
  TASK_LEDGER_DIR,
  TASK_ID_RE,
  memoryMdPath,
  repoLedgerPath,
  taskLedgerPath,
  validateTaskId,
  resolveMemoryPath,
  migrateMemoryPaths,
  findNonCanonicalRefs,
} from '../../lib/memory/paths.mjs';

/** @type {string} */
let baseDir;

before(() => {
  baseDir = join(tmpdir(), `memory-path-test-${Date.now()}`);
  mkdirSync(baseDir, { recursive: true });
});

after(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('resolveMemoryPath', () => {
  it('returns the correct absolute path for a given repo root', () => {
    const repoRoot = join(baseDir, 'resolve');
    const expected = join(repoRoot, MEMORY_PATH);
    assert.equal(resolveMemoryPath(repoRoot), expected);
    assert.ok(resolveMemoryPath(repoRoot).startsWith(repoRoot));
  });
});

describe('path helpers and taskId validation', () => {
  it('builds canonical paths for memory, repo ledger, and task ledger', () => {
    const repoRoot = join(baseDir, 'paths');
    mkdirSync(repoRoot, { recursive: true });

    assert.equal(memoryMdPath(repoRoot), join(repoRoot, MEMORY_PATH));
    assert.equal(repoLedgerPath(repoRoot), join(repoRoot, REPO_LEDGER_REL));
    assert.equal(
      taskLedgerPath(repoRoot, 'feat-auth-revamp'),
      join(repoRoot, TASK_LEDGER_DIR, 'feat-auth-revamp.jsonl'),
    );
  });

  it('accepts valid task ids and rejects invalid ones', () => {
    assert.doesNotThrow(() => validateTaskId('feat-auth-revamp'));
    assert.ok(TASK_ID_RE.test('feat-auth-revamp'));

    assert.throws(() => validateTaskId(''), TypeError);
    assert.throws(() => validateTaskId('../escape'), TypeError);
    assert.throws(() => validateTaskId('Feat Auth'), TypeError);
    assert.throws(() => validateTaskId('feat/nested'), TypeError);
  });
});

describe('migrateMemoryPaths', () => {
  it('dry-run returns a MigrationResult with moved entries for existing old-path files without writing any files', async () => {
    const repoRoot = join(baseDir, 'dry-run');
    mkdirSync(repoRoot, { recursive: true });
    const oldAbs = join(repoRoot, OLD_MEMORY_PATHS[0] ?? 'MEMORY.md');
    writeFileSync(oldAbs, 'old content\n');

    const result = await migrateMemoryPaths(repoRoot, { dryRun: true });

    assert.ok(result.moved.includes(OLD_MEMORY_PATHS[0] ?? 'MEMORY.md'));
    // Nothing written: canonical absent and old file unchanged.
    assert.equal(existsSync(resolveMemoryPath(repoRoot)), false);
    assert.equal(readFileSync(oldAbs, 'utf8'), 'old content\n');
  });

  it('live moves an old-path file to canonical location, writes a pointer stub, and does not truncate existing canonical content', async () => {
    const repoRoot = join(baseDir, 'live');
    mkdirSync(join(repoRoot, '.devmate'), { recursive: true });
    const oldAbs = join(repoRoot, OLD_MEMORY_PATHS[0] ?? 'MEMORY.md');
    writeFileSync(oldAbs, 'OLD_FACT\n');
    const canonicalAbs = resolveMemoryPath(repoRoot);
    writeFileSync(canonicalAbs, 'CANON_FACT\n');

    const result = await migrateMemoryPaths(repoRoot);

    assert.ok(result.moved.includes(OLD_MEMORY_PATHS[0] ?? 'MEMORY.md'));
    const merged = readFileSync(canonicalAbs, 'utf8');
    assert.match(merged, /CANON_FACT/);
    assert.match(merged, /OLD_FACT/);
    // Old path now holds a pointer stub referencing the canonical path.
    const stub = readFileSync(oldAbs, 'utf8');
    assert.match(stub, /\.devmate\/MEMORY\.md/);
    assert.doesNotMatch(stub, /OLD_FACT/);
  });

  it('skips migration when old-path file does not exist', async () => {
    const repoRoot = join(baseDir, 'absent');
    mkdirSync(repoRoot, { recursive: true });

    const result = await migrateMemoryPaths(repoRoot);

    assert.equal(result.moved.length, 0);
    assert.ok(result.skipped.length >= 1);
    assert.equal(existsSync(resolveMemoryPath(repoRoot)), false);
  });

  it('returns an error entry when a write fails (simulate with canonical path as directory)', async () => {
    const repoRoot = join(baseDir, 'readonly');
    mkdirSync(repoRoot, { recursive: true });
    const oldAbs = join(repoRoot, OLD_MEMORY_PATHS[0] ?? 'MEMORY.md');
    writeFileSync(oldAbs, 'data\n');
    // Create a directory at the canonical FILE path so read/write as file fails on all platforms.
    const canonicalAbs = resolveMemoryPath(repoRoot);
    mkdirSync(canonicalAbs, { recursive: true });

    const result = await migrateMemoryPaths(repoRoot);

    assert.equal(result.errors.length >= 1, true);
    assert.match(result.errors[0] ?? '', /MEMORY\.md/);
  });
});

describe('findNonCanonicalRefs', () => {
  it('returns violations for a fixture file containing an old path string', async () => {
    const repoRoot = join(baseDir, 'refs-violation');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'consumer.mjs'), "const p = 'MEMORY.md';\n");

    const violations = await findNonCanonicalRefs(repoRoot);

    assert.equal(violations.length >= 1, true);
    assert.equal(violations[0]?.file, 'consumer.mjs');
    assert.equal(violations[0]?.match, 'MEMORY.md');
  });

  it('returns an empty array for a fixture containing only the canonical path string', async () => {
    const repoRoot = join(baseDir, 'refs-clean');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(join(repoRoot, 'consumer.mjs'), `const p = '${MEMORY_PATH}';\n`);

    const violations = await findNonCanonicalRefs(repoRoot);

    assert.deepEqual(violations, []);
  });
});
