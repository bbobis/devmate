// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { verifyStep } from '../../lib/loop/verify-step.mjs';
import { readTraceFile } from '../../lib/loop/trace-schema.mjs';
import { main } from '../../scripts/verify-step.mjs';

/**
 * Initialise a git repo in `dir` with TWO commits so HEAD~1 is valid.
 * @param {string} dir
 */
function gitInit(dir) {
  spawnSync('git', ['init', dir], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' });
  spawnSync('git', ['-C', dir, 'commit', '--allow-empty', '-m', 'second'], { stdio: 'pipe' });
}

/**
 * Run main() and capture the single JSON line it writes to stdout.
 * Intercepts only string chunks that look like JSON objects, ignoring
 * any binary chunks the test runner itself may flush to stdout.
 * @param {string[]} args
 * @returns {Promise<Record<string, unknown>>}
 */
async function runMain(args) {
  /** @type {string[]} */
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);

  /** @param {unknown} chunk @returns {boolean} */
  // @ts-ignore — intentional override for capture
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string') chunks.push(chunk);
    // Don't forward to real stdout during test to keep output clean.
    return true;
  };

  try {
    await main(args);
  } finally {
    // @ts-ignore
    process.stdout.write = origWrite;
  }

  // Find the first chunk that parses as a JSON object (our LoopOutput line).
  const combined = chunks.join('');
  // Split on newlines and find the first valid JSON object line.
  for (const line of combined.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      return JSON.parse(trimmed);
    }
  }
  throw new Error(`No JSON object line found in stdout. Captured: ${JSON.stringify(combined)}`);
}

test('verifyStep happy path: node --version -> passed:true, exitCode:0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-test-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const result = await verifyStep({
      argv: ['node', '--version'],
      traceFile,
      taskId: 'task-1',
      attemptId: 'attempt-1',
      outputDir,
      repoRoot: dir,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.passed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyStep: output cap - outputCapped <= 4096 chars, fullOutputPath exists with full output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-cap-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');
    const bigOutput = "'" + 'x'.repeat(10000) + "'";
    const result = await verifyStep({
      argv: ['node', '-e', `process.stdout.write(${bigOutput})`],
      traceFile,
      taskId: 'task-cap',
      attemptId: 'attempt-cap',
      outputDir,
      repoRoot: dir,
    });

    assert.ok(result.outputCapped.length <= 4096, `capped length: ${result.outputCapped.length}`);
    assert.ok(existsSync(result.fullOutputPath), 'fullOutputPath must exist');
    const full = readFileSync(result.fullOutputPath, 'utf8');
    assert.ok(full.length > 4096, `full output should be > 4096 chars (got ${full.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyStep: trace entry - loop_attempt appended with correct attemptId and outputDigest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-trace-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const result = await verifyStep({
      argv: ['node', '-e', 'console.log("trace-test")'],
      traceFile,
      taskId: 'task-trace',
      attemptId: 'attempt-trace-1',
      outputDir,
      repoRoot: dir,
    });

    const { events } = readTraceFile(traceFile);
    const attempts = events.filter((e) => e.type === 'loop_attempt');
    assert.equal(attempts.length, 1);
    const attempt = attempts[0];
    assert.equal(attempt.attemptId, 'attempt-trace-1');
    assert.equal(attempt.outputDigest, result.outputDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyStep: metachar in argv[0] throws before spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-meta-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    await assert.rejects(
      async () => verifyStep({
        argv: ['node|bad', '-e', 'console.log(1)'],
        traceFile,
        taskId: 'task-meta',
        attemptId: 'attempt-meta',
        outputDir,
        repoRoot: dir,
      }),
      (/** @type {unknown} */ err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('shell metacharacters'));
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyStep: non-zero exit -> passed:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-fail-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const result = await verifyStep({
      argv: ['node', '-e', 'process.exit(1)'],
      traceFile,
      taskId: 'task-fail',
      attemptId: 'attempt-fail',
      outputDir,
      repoRoot: dir,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyStep: fullOutputPath file exists after call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-artifact-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const result = await verifyStep({
      argv: ['node', '-e', 'console.log("artifact")'],
      traceFile,
      taskId: 'task-artifact',
      attemptId: 'attempt-artifact',
      outputDir,
      repoRoot: dir,
    });

    assert.ok(existsSync(result.fullOutputPath), `fullOutputPath must exist: ${result.fullOutputPath}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// E2-7: scripts/verify-step.mjs main() boundary tests
// ---------------------------------------------------------------------------

test('main() — default JSON output: no output_full key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-main-default-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const parsed = await runMain([
      '--argv', JSON.stringify(['node', '--version']),
      '--trace-file', traceFile,
      '--task-id', 'task-main-1',
      '--attempt-id', 'attempt-main-1',
      '--output-dir', outputDir,
    ]);

    assert.ok(!('output_full' in parsed), 'output_full must NOT be present by default');
    assert.ok('output_capped' in parsed, 'output_capped must be present');
    assert.ok('output_digest' in parsed, 'output_digest must be present');
    assert.ok('full_output_path' in parsed, 'full_output_path must be present');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main() — --include-full-output flag: output_full present in JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-main-full-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const parsed = await runMain([
      '--argv', JSON.stringify(['node', '-e', 'console.log("full-output-test")']),
      '--trace-file', traceFile,
      '--task-id', 'task-main-2',
      '--attempt-id', 'attempt-main-2',
      '--output-dir', outputDir,
      '--include-full-output',
    ]);

    assert.ok('output_full' in parsed, 'output_full must be present when --include-full-output is set');
    assert.ok(typeof parsed.output_full === 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main() — JSON always has output_capped, output_digest, full_output_path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vs-main-shape-'));
  try {
    gitInit(dir);
    const traceFile = join(dir, 'trace.jsonl');
    const outputDir = join(dir, 'output');

    const parsed = await runMain([
      '--argv', JSON.stringify(['node', '-e', 'console.log("shape-test")']),
      '--trace-file', traceFile,
      '--task-id', 'task-shape',
      '--attempt-id', 'attempt-shape',
      '--output-dir', outputDir,
    ]);

    assert.ok('output_capped' in parsed);
    assert.ok('output_digest' in parsed);
    assert.ok('full_output_path' in parsed);
    assert.ok('passed' in parsed);
    assert.ok('exitCode' in parsed);
    assert.ok('durationMs' in parsed);
    assert.ok('attemptId' in parsed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
