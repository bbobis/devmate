// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand, validateArgv } from '../../../lib/loop/run-command.mjs';

test('happy path: node --version exits 0 and stdout matches /^v\\d+/', async () => {
  const result = await runCommand(['node', '--version']);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /^v\d+/);
  assert.equal(result.timedOut, false);
});

test('non-zero exit: process.exit(42) → exitCode 42', async () => {
  const result = await runCommand(['node', '-e', 'process.exit(42)']);
  assert.equal(result.exitCode, 42);
});

test('spaces in argument: "hello world" passes through unquoted', async () => {
  const result = await runCommand(['node', '-e', 'console.log("hello world")']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('hello world'), `stdout: ${result.stdout}`);
});

test('quotes in argument: single-quote passes through correctly', async () => {
  const result = await runCommand(['node', '-e', "console.log(\"it's ok\")"]);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("it's ok"), `stdout: ${result.stdout}`);
});

test('shell metacharacters in non-argv[0] position are fine', async () => {
  const result = await runCommand(['node', '-e', 'console.log(1+1)']);
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('2'), `stdout: ${result.stdout}`);
});

test('metachar in argv[0]: validateArgv throws before spawn', () => {
  assert.throws(
    () => validateArgv(['node|bad', '-e', 'console.log(1)']),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('shell metacharacters'));
      return true;
    }
  );
});

test('timeout: process that hangs is killed and timedOut:true returned', async () => {
  const result = await runCommand(
    ['node', '-e', 'setInterval(()=>{},1000)'],
    { timeoutMs: 200 }
  );
  assert.equal(result.timedOut, true);
});

test('stderr is captured separately', async () => {
  const result = await runCommand(['node', '-e', 'process.stderr.write("err-msg\\n")']);
  assert.ok(result.stderr.includes('err-msg'), `stderr: ${result.stderr}`);
});

test('durationMs is a non-negative number', async () => {
  const result = await runCommand(['node', '--version']);
  assert.ok(typeof result.durationMs === 'number');
  assert.ok(result.durationMs >= 0);
});

test('validateArgv: empty array throws INVALID_ARGV', () => {
  assert.throws(
    () => validateArgv([]),
    (/** @type {unknown} */ err) => {
      assert.ok(err instanceof Error);
      const e = /** @type {Error & { code?: string }} */ (err);
      assert.equal(e.code, 'INVALID_ARGV');
      return true;
    }
  );
});

test('runCommand: cwd option is respected (list files in tmp dir)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-cmd-test-'));
  try {
    const result = await runCommand(['node', '-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes(dir) || result.stdout.replace(/\\/g, '/').includes(dir.replace(/\\/g, '/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
