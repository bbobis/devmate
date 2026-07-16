// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { capOutput, redactSecrets, buildLoopOutput } from '../../../lib/loop/output-cap.mjs';

// ---------------------------------------------------------------------------
// capOutput
// ---------------------------------------------------------------------------

test('capOutput — under limit: 100-char input returned unchanged', () => {
  const input = 'a'.repeat(100);
  const result = capOutput(input, { maxBytes: 4096 });
  assert.equal(result, input);
  assert.ok(!result.includes('truncated'));
});

test('capOutput — exactly at limit: 4096-char input returned unchanged', () => {
  const input = 'b'.repeat(4096);
  const result = capOutput(input, { maxBytes: 4096 });
  assert.equal(result, input);
});

test('capOutput — over limit: 5000-char input truncated with notice', () => {
  const input = 'c'.repeat(5000);
  const result = capOutput(input, { maxBytes: 4096 });
  assert.ok(result.startsWith('c'.repeat(4096)));
  assert.ok(result.includes('truncated'));
  assert.ok(result.includes('full_output_path'));
  // Total length = cap + truncation notice length
  assert.ok(result.length > 4096);
});

test('capOutput — default maxBytes is 4096', () => {
  const input = 'd'.repeat(5000);
  const result = capOutput(input);
  assert.ok(result.startsWith('d'.repeat(4096)));
  assert.ok(result.includes('truncated'));
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test('redactSecrets — env assignment: SECRET=abc123 -> SECRET=[REDACTED]', () => {
  const input = 'SECRET=abc123';
  const result = redactSecrets(input);
  assert.ok(result.includes('[REDACTED]'), `expected [REDACTED] in: ${result}`);
  assert.ok(!result.includes('abc123'), `expected abc123 to be redacted: ${result}`);
});

test('redactSecrets — Bearer token: Authorization: Bearer eyJhbGc... -> [REDACTED]', () => {
  const bearerSample = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.payload.signature';
  const input = `Authorization: Bearer ${bearerSample}`;
  const result = redactSecrets(input);
  assert.ok(result.includes('[REDACTED]'), `expected [REDACTED] in: ${result}`);
  assert.ok(!result.includes(bearerSample), `expected bearer value to be redacted`);
});

test('redactSecrets — no secrets: plain text returned unchanged', () => {
  const input = 'Tests passed: 42 failures: 0';
  const result = redactSecrets(input);
  assert.equal(result, input);
});

test('redactSecrets — API_KEY pattern redacted', () => {
  const input = 'API_KEY=supersecretvalue123';
  const result = redactSecrets(input);
  assert.ok(result.includes('[REDACTED]'));
  assert.ok(!result.includes('supersecretvalue123'));
});

// ---------------------------------------------------------------------------
// buildLoopOutput
// ---------------------------------------------------------------------------

test('buildLoopOutput — default: no output_full key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-test-'));
  try {
    /** @type {import('../../../lib/loop/run-command.mjs').RunCommandResult} */
    const runResult = {
      exitCode: 0,
      stdout: 'hello world',
      stderr: '',
      timedOut: false,
      durationMs: 42,
    };
    const result = await buildLoopOutput(runResult, {
      attemptId: 'test-attempt-1',
      outputDir: join(dir, 'output'),
    });
    assert.ok(!('output_full' in result), 'output_full must NOT be present by default');
    assert.ok('output_capped' in result);
    assert.ok('output_digest' in result);
    assert.ok('full_output_path' in result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoopOutput — includeFullOutput: true adds output_full', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-full-'));
  try {
    /** @type {import('../../../lib/loop/run-command.mjs').RunCommandResult} */
    const runResult = {
      exitCode: 0,
      stdout: 'some output',
      stderr: 'some error',
      timedOut: false,
      durationMs: 10,
    };
    const result = await buildLoopOutput(runResult, {
      attemptId: 'test-attempt-2',
      outputDir: join(dir, 'output'),
      includeFullOutput: true,
    });
    assert.ok('output_full' in result, 'output_full must be present when includeFullOutput: true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoopOutput — artifact written: full_output_path file exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-artifact-'));
  try {
    /** @type {import('../../../lib/loop/run-command.mjs').RunCommandResult} */
    const runResult = {
      exitCode: 0,
      stdout: 'artifact content',
      stderr: '',
      timedOut: false,
      durationMs: 5,
    };
    const result = await buildLoopOutput(runResult, {
      attemptId: 'test-attempt-3',
      outputDir: join(dir, 'output'),
    });
    assert.ok(existsSync(result.full_output_path), `artifact must exist at ${result.full_output_path}`);
    const contents = readFileSync(result.full_output_path, 'utf8');
    assert.ok(contents.includes('artifact content'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoopOutput — large output capped: 10 KB stdout -> output_capped.length <= 4096 + 80', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-large-'));
  try {
    /** @type {import('../../../lib/loop/run-command.mjs').RunCommandResult} */
    const runResult = {
      exitCode: 0,
      stdout: 'x'.repeat(10240),
      stderr: '',
      timedOut: false,
      durationMs: 100,
    };
    const result = await buildLoopOutput(runResult, {
      attemptId: 'test-attempt-4',
      outputDir: join(dir, 'output'),
    });
    assert.ok(
      result.output_capped.length <= 4096 + 80,
      `output_capped length ${result.output_capped.length} must be <= ${4096 + 80}`
    );
    // Full artifact must have the untruncated content.
    const full = readFileSync(result.full_output_path, 'utf8');
    assert.ok(full.length > 4096);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildLoopOutput — output_full equals redacted combined output when includeFullOutput: true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-redact-'));
  try {
    /** @type {import('../../../lib/loop/run-command.mjs').RunCommandResult} */
    const runResult = {
      exitCode: 0,
      stdout: 'API_KEY=secret123',
      stderr: '',
      timedOut: false,
      durationMs: 5,
    };
    const result = await buildLoopOutput(runResult, {
      attemptId: 'test-attempt-5',
      outputDir: join(dir, 'output'),
      includeFullOutput: true,
    });
    assert.ok('output_full' in result);
    // @ts-ignore — narrowed by the test above
    assert.ok(result.output_full.includes('[REDACTED]'));
    // @ts-ignore
    assert.ok(!result.output_full.includes('secret123'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
