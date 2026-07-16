// @ts-check
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/complete-step.mjs';

/** @type {string} */
let traceDir;
/** @type {string} */
let tracePath;
/** @type {string} */
let prevEnv;

/**
 * Capture process.stdout / process.stderr writes during `fn`.
 * @param {() => Promise<number>} fn
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
async function capture(fn) {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = /** @type {any} */ (
    /** @param {string} s */ (s) => {
      out += s;
      return true;
    }
  );
  process.stderr.write = /** @type {any} */ (
    /** @param {string} s */ (s) => {
      err += s;
      return true;
    }
  );
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

beforeEach(async () => {
  traceDir = await fsp.mkdtemp(join(tmpdir(), 'complete-step-'));
  tracePath = join(traceDir, 'trace.jsonl');
  prevEnv = process.env.DEVMATE_TRACE_PATH ?? '';
  process.env.DEVMATE_TRACE_PATH = tracePath;
});

afterEach(async () => {
  if (prevEnv) process.env.DEVMATE_TRACE_PATH = prevEnv;
  else delete process.env.DEVMATE_TRACE_PATH;
  await fsp.rm(traceDir, { recursive: true, force: true });
});

describe('complete-step main()', () => {
  it('returns 0 and writes parseable JSON for valid args', async () => {
    const { code, out } = await capture(() =>
      main(['--step-id', 's1', '--label', 'Do thing', '--task-id', 't1', '--lane', 'feature']),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.entry.stepId, 's1');
    const content = await fsp.readFile(tracePath, 'utf8');
    assert.equal(content.trim().split('\n').length, 1);
  });

  it('returns 1 with actionable message when a required arg is missing', async () => {
    const { code, err } = await capture(() =>
      main(['--label', 'Do thing', '--task-id', 't1', '--lane', 'feature']),
    );
    assert.equal(code, 1);
    assert.match(err, /--step-id/);
  });

  it('returns 0 with already_complete on second identical call', async () => {
    const first = await capture(() =>
      main(['--step-id', 'dup', '--label', 'L', '--task-id', 't1', '--lane', 'feature']),
    );
    assert.equal(first.code, 0);
    const second = await capture(() =>
      main(['--step-id', 'dup', '--label', 'L', '--task-id', 't1', '--lane', 'feature']),
    );
    assert.equal(second.code, 0);
    const parsed = JSON.parse(second.out.trim());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'already_complete');
    const content = await fsp.readFile(tracePath, 'utf8');
    assert.equal(content.trim().split('\n').length, 1);
  });
});
