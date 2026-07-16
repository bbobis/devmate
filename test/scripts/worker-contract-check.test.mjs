// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { main } from '../../scripts/worker-contract-check.mjs';

const LOCAL_TMP_BASE = path.join(process.cwd(), '.tmp-test');

/** @param {string} prefix */
async function makeLocalTempDir(prefix) {
  await fsp.mkdir(LOCAL_TMP_BASE, { recursive: true });
  return fsp.mkdtemp(path.join(LOCAL_TMP_BASE, prefix));
}

/** @param {string} dir */
async function cleanupLocalTempDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** @type {string[]} */
let outWrites = [];
/** @type {typeof process.stdout.write} */
const realOut = process.stdout.write.bind(process.stdout);
/** @type {typeof process.stderr.write} */
const realErr = process.stderr.write.bind(process.stderr);

function capture() {
  outWrites = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        outWrites.push(String(chunk));
        return true;
      }
    );
  process.stderr.write = /** @type {typeof process.stderr.write} */ (() => true);
}

function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/** @returns {import('../../lib/types.mjs').WorkerReturn} */
function validReturn() {
  return {
    workerId: 'w-1',
    finding: 'ok',
    sourcePointer: { path: 'lib/x.mjs', lineRange: null, reason: 'r', confidence: 0.8, freshness: 'now', kind: 'file' },
    confidence: 0.9,
    artifactWritten: null,
    nextRecommendedStep: 'continue',
    tokenNotes: '~100 tokens',
    debugMode: false,
    rawTranscriptPath: null,
    returnedAt: 'now',
  };
}

test('worker-contract-check main() / exits 0 for valid artifact file', async (t) => {
  const dir = await makeLocalTempDir('wcc-ok-');
  t.after(async () => {
    await cleanupLocalTempDir(dir);
  });
  await fsp.writeFile(path.join(dir, 'a.worker-return.json'), JSON.stringify(validReturn()), 'utf8');
  capture();
  let code;
  try {
    code = await main([dir]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.match(outWrites.join(''), /PASS/);
});

test('worker-contract-check main() / exits 1 for invalid artifact file', async (t) => {
  const dir = await makeLocalTempDir('wcc-bad-');
  t.after(async () => {
    await cleanupLocalTempDir(dir);
  });
  const bad = validReturn();
  bad.confidence = 5; // out of range
  bad.rawTranscriptPath = 'tmp/x'; // forbidden when debugMode=false
  await fsp.writeFile(path.join(dir, 'b.worker-return.json'), JSON.stringify(bad), 'utf8');
  capture();
  let code;
  try {
    code = await main([dir]);
  } finally {
    restore();
  }
  assert.equal(code, 1);
  const blob = outWrites.join('');
  assert.match(blob, /FAIL/);
  assert.match(blob, /rawTranscriptPath must be null/);
});

test('worker-contract-check main() / exits 0 with message when no artifacts found', async (t) => {
  const dir = await makeLocalTempDir('wcc-empty-');
  t.after(async () => {
    await cleanupLocalTempDir(dir);
  });
  capture();
  let code;
  try {
    code = await main([dir]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.match(outWrites.join(''), /No worker-return artifacts found/);
});

test('worker-contract-check main() / descends into subdirectories', async (t) => {
  const dir = await makeLocalTempDir('wcc-nested-');
  t.after(async () => {
    await cleanupLocalTempDir(dir);
  });
  const sub = path.join(dir, 'nested', 'deep');
  await fsp.mkdir(sub, { recursive: true });
  await fsp.writeFile(path.join(sub, 'c.worker-return.json'), JSON.stringify(validReturn()), 'utf8');
  capture();
  let code;
  try {
    code = await main([dir]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.match(outWrites.join(''), /c\.worker-return\.json/);
});
