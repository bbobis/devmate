// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWithFlakeDetection } from '../../../lib/loop/flake-rerun.mjs';
import { readTraceFile } from '../../../lib/loop/trace-schema.mjs';

/** Build a minimal opts object with temp dirs.
 * @param {string} outputDir
 * @param {string} traceFile
 * @param {string[]} argv
 * @param {string} [firstAttemptId]
 * @returns {import('../../../lib/types.mjs').FlakeRunOpts}
 */
function makeOpts(outputDir, traceFile, argv, firstAttemptId = 'attempt-first-001') {
  return {
    argv,
    traceFile,
    taskId: 'task-test-001',
    firstAttemptId,
    outputDir,
    tier: 1,
  };
}

test('first run passes: verdict=passed, no rerun artifact, one trace entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  try {
    const opts = makeOpts(dir, traceFile, ['node', '--version']);
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.verdict, 'passed');
    assert.equal(result.rerunAttemptId, null);
    assert.equal(result.rerunFullOutputPath, null);
    assert.equal(result.timedOut, false);
    assert.ok(result.outputCapped.length <= 4096);
    assert.ok(result.fullOutputPath.endsWith('.txt'));

    // Exactly one trace entry
    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'loop_attempt');
    assert.equal(events[0].attemptId, 'attempt-first-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('flaky: first run fails, rerun passes => verdict=flaky, two trace entries, second has rerunOf', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  const counterFile = join(dir, 'counter.txt');
  const scriptFile = join(dir, 'script.mjs');
  // Script fails on first call (count===0), passes on second.
  const scriptContent = [
    'import { readFileSync, writeFileSync, existsSync } from \'node:fs\';',
    `const f = ${JSON.stringify(counterFile)};`,
    'const count = existsSync(f) ? parseInt(readFileSync(f, \'utf8\'), 10) : 0;',
    'writeFileSync(f, String(count + 1));',
    'if (count === 0) process.exit(1);',
  ].join('\n');
  writeFileSync(scriptFile, scriptContent);
  try {
    const opts = makeOpts(dir, traceFile, ['node', scriptFile]);
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.verdict, 'flaky');
    assert.ok(result.rerunAttemptId !== null);
    assert.ok(result.rerunFullOutputPath !== null);
    assert.equal(result.timedOut, false);

    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 2);
    const second = /** @type {import('../../../lib/types.mjs').LoopAttemptEvent} */ (events[1]);
    assert.equal(second.rerunOf, 'attempt-first-001');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stable_fail: both runs fail with same output => verdict=stable_fail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  try {
    // Exit 1 with empty output => identical digests both runs.
    const opts = makeOpts(dir, traceFile, ['node', '-e', 'process.exit(1)']);
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.verdict, 'stable_fail');
    assert.ok(result.rerunAttemptId !== null);

    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unstable fail: both runs fail with different outputs => verdict=failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  const counterFile = join(dir, 'counter2.txt');
  const scriptFile = join(dir, 'script2.mjs');
  // Each call prints a unique timestamp so digests differ.
  const scriptContent = [
    'import { readFileSync, writeFileSync, existsSync } from \'node:fs\';',
    `const f = ${JSON.stringify(counterFile)};`,
    'const count = existsSync(f) ? parseInt(readFileSync(f, \'utf8\'), 10) : 0;',
    'writeFileSync(f, String(count + 1));',
    `process.stdout.write('run-' + count + '-' + Date.now());`,
    'process.exit(1);',
  ].join('\n');
  writeFileSync(scriptFile, scriptContent);
  try {
    const opts = makeOpts(dir, traceFile, ['node', scriptFile]);
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.verdict, 'failed');
    assert.ok(result.rerunAttemptId !== null);

    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('output cap: large stdout is capped at 4096 chars in FlakeResult', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  // Produce exactly 10240 chars then exit 0
  const opts = makeOpts(dir, traceFile, ['node', '-e', "process.stdout.write('x'.repeat(10240))"]);
  try {
    const result = await runWithFlakeDetection(opts);
    assert.ok(
      result.outputCapped.length <= 4096,
      `outputCapped.length=${result.outputCapped.length} > 4096`
    );
    // Full output file must contain the full content
    const full = readFileSync(result.fullOutputPath, 'utf8');
    assert.ok(full.length >= 10240);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace linkage: second trace entry rerunOf equals first attemptId', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  const counterFile = join(dir, 'link-counter.txt');
  const scriptFile = join(dir, 'link-script.mjs');
  const scriptContent = [
    'import { readFileSync, writeFileSync, existsSync } from \'node:fs\';',
    `const f = ${JSON.stringify(counterFile)};`,
    'const count = existsSync(f) ? parseInt(readFileSync(f, \'utf8\'), 10) : 0;',
    'writeFileSync(f, String(count + 1));',
    'if (count === 0) process.exit(1);',
  ].join('\n');
  writeFileSync(scriptFile, scriptContent);
  try {
    const firstId = 'my-first-attempt-id';
    const opts = makeOpts(dir, traceFile, ['node', scriptFile], firstId);
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.firstAttemptId, firstId);
    assert.ok(result.rerunAttemptId !== null);

    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 2);
    const second = /** @type {import('../../../lib/types.mjs').LoopAttemptEvent} */ (events[1]);
    assert.equal(second.rerunOf, firstId, 'second trace entry rerunOf must equal first attemptId');
    assert.equal(second.attemptId, result.rerunAttemptId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('timeout on first run: verdict=failed, timedOut=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flake-test-'));
  const traceFile = join(dir, 'trace.jsonl');
  try {
    const opts = {
      ...makeOpts(dir, traceFile, ['node', '-e', 'setInterval(()=>{},1000)']),
      timeoutMs: 200,
    };
    const result = await runWithFlakeDetection(opts);

    assert.equal(result.verdict, 'failed');
    assert.equal(result.timedOut, true);
    assert.equal(result.rerunAttemptId, null);

    // One trace entry for the timed-out first run only
    const { events } = readTraceFile(traceFile);
    assert.equal(events.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
