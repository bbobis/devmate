// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { countChangedFiles, assertBelowMaxFiles } from '../../../lib/loop/file-change-counter.mjs';
import { runLoopGuard } from '../../../lib/loop/loop-guard.mjs';
import { SCHEMA_VERSION } from '../../../lib/loop/trace-schema.mjs';

// ---- assertBelowMaxFiles tests ----

test('assertBelowMaxFiles — below: assertBelowMaxFiles(4, 5) does not throw', () => {
  assert.doesNotThrow(() => assertBelowMaxFiles(4, 5));
});

test('assertBelowMaxFiles — at limit: assertBelowMaxFiles(5, 5) throws with code MAX_FILES_CHANGED_WITHOUT_VERIFY', () => {
  assert.throws(
    () => assertBelowMaxFiles(5, 5),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(/** @type {any} */ (err).code, 'MAX_FILES_CHANGED_WITHOUT_VERIFY');
      assert.ok(err.message.includes('MAX_FILES_CHANGED_WITHOUT_VERIFY'));
      return true;
    }
  );
});

test('assertBelowMaxFiles — above limit: count=8, limit=5 throws with correct code/count/limit', () => {
  assert.throws(
    () => assertBelowMaxFiles(8, 5),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(/** @type {any} */ (err).code, 'MAX_FILES_CHANGED_WITHOUT_VERIFY');
      assert.equal(/** @type {any} */ (err).count, 8);
      assert.equal(/** @type {any} */ (err).limit, 5);
      return true;
    }
  );
});

// ---- countChangedFiles spawn injection test ----

test('countChangedFiles — no shell: spawn receives git as args[0] and no shell: true option', async () => {
  /** @type {string | undefined} */ let capturedCmd;
  /** @type {string[] | undefined} */ let capturedArgs;
  /** @type {object | undefined} */ let capturedOpts;

  /**
   * Stub spawn that captures arguments and fakes a git diff response of 3 files.
   * @param {string} cmd
   * @param {string[]} args
   * @param {object} spawnOpts
   * @returns {any}
   */
  const spawnStub = (cmd, args, spawnOpts) => {
    capturedCmd = cmd;
    capturedArgs = args;
    capturedOpts = spawnOpts;

    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    /** @type {any} */ (child).stdout = stdout;
    /** @type {any} */ (child).stderr = stderr;

    setImmediate(() => {
      stdout.emit('data', Buffer.from('src/a.mjs\nsrc/b.mjs\nsrc/c.mjs\n'));
      child.emit('close', 0);
    });

    return child;
  };

  const count = await countChangedFiles(
    { repoRoot: '/tmp', sinceRef: 'HEAD~1' },
    /** @type {any} */ (spawnStub)
  );

  assert.equal(capturedCmd, 'git', 'first arg to spawn must be "git"');
  assert.ok(Array.isArray(capturedArgs), 'spawn args must be an array');
  assert.ok(!(/** @type {any} */ (capturedOpts))?.shell, 'shell option must not be true');
  assert.equal(count, 3);
});

// ---- Git-based integration tests ----

/**
 * Create a minimal temporary git repo with N committed files after a base commit.
 * @param {number} fileCount
 * @returns {{ repoRoot: string, sinceRef: string, cleanup: () => void }}
 */
function makeTempGitRepo(fileCount) {
  const repoRoot = join(
    tmpdir(),
    `devmate-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(repoRoot, { recursive: true });
  execSync('git init', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.email "t@t.com"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git config user.name "T"', { cwd: repoRoot, stdio: 'ignore' });
  execSync('git commit --allow-empty -m "base"', { cwd: repoRoot, stdio: 'ignore' });
  const sinceRef = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();

  // @bounded-alloc — writes fileCount fixture files; callers pass small constants.
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(repoRoot, `file${i}.txt`), `content ${i}`);
  }
  if (fileCount > 0) {
    execSync('git add .', { cwd: repoRoot, stdio: 'ignore' });
    execSync('git commit -m "add files"', { cwd: repoRoot, stdio: 'ignore' });
  }

  return {
    repoRoot,
    sinceRef,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

test('runLoopGuard — below threshold: 2 files with limit 5 → allowed: true', async () => {
  const { repoRoot, sinceRef, cleanup } = makeTempGitRepo(2);
  const traceFile = join(tmpdir(), `trace-below-${Date.now()}.jsonl`);
  try {
    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      maxFiles: 5,
      repoRoot,
      sinceRef,
    });
    assert.equal(result.allowed, true);
    assert.ok(!existsSync(traceFile), 'no trace file written when allowed');
  } finally {
    cleanup();
    if (existsSync(traceFile)) rmSync(traceFile);
  }
});

test('runLoopGuard — at threshold: 5 files with limit 5 → allowed: false, haltReason set', async () => {
  const { repoRoot, sinceRef, cleanup } = makeTempGitRepo(5);
  const traceFile = join(tmpdir(), `trace-at-${Date.now()}.jsonl`);
  try {
    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-2',
      attemptId: 'attempt-2',
      maxFiles: 5,
      repoRoot,
      sinceRef,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.haltReason, 'MAX_FILES_CHANGED_WITHOUT_VERIFY');
  } finally {
    cleanup();
    if (existsSync(traceFile)) rmSync(traceFile);
  }
});

test('runLoopGuard — above threshold: 8 files with limit 5 → allowed: false, fileCount: 8', async () => {
  const { repoRoot, sinceRef, cleanup } = makeTempGitRepo(8);
  const traceFile = join(tmpdir(), `trace-above-${Date.now()}.jsonl`);
  try {
    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-3',
      attemptId: 'attempt-3',
      maxFiles: 5,
      repoRoot,
      sinceRef,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.fileCount, 8);
  } finally {
    cleanup();
    if (existsSync(traceFile)) rmSync(traceFile);
  }
});

test('runLoopGuard — trace event written: above-threshold run writes a valid loop_halt JSONL line', async () => {
  const { repoRoot, sinceRef, cleanup } = makeTempGitRepo(6);
  const traceFile = join(tmpdir(), `trace-event-${Date.now()}.jsonl`);
  try {
    const result = await runLoopGuard({
      traceFile,
      taskId: 'task-4',
      attemptId: 'attempt-4',
      maxFiles: 5,
      repoRoot,
      sinceRef,
    });
    assert.equal(result.allowed, false);
    assert.ok(existsSync(traceFile), 'trace file must exist');
    const lines = readFileSync(traceFile, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.type, 'loop_halt');
    assert.equal(event.reason, 'MAX_FILES_CHANGED_WITHOUT_VERIFY');
    assert.ok(
      event.lastError.includes('MAX_FILES_CHANGED_WITHOUT_VERIFY'),
      `lastError should include halt reason, got: ${event.lastError}`
    );
    assert.equal(event.schemaVersion, SCHEMA_VERSION);
  } finally {
    cleanup();
    if (existsSync(traceFile)) rmSync(traceFile);
  }
});
