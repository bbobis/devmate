// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/reduce-context.mjs';

/** @type {string[]} */
let outWrites = [];
/** @type {typeof process.stdout.write} */
const realOut = process.stdout.write.bind(process.stdout);
/** @type {typeof process.stderr.write} */
const realErr = process.stderr.write.bind(process.stderr);

function silence() {
  outWrites = [];
  process.stdout.write =
    /** @type {typeof process.stdout.write} */ (
      (/** @type {string} */ chunk) => {
        outWrites.push(String(chunk));
        return true;
      }
    );
  process.stderr.write =
    /** @type {typeof process.stderr.write} */ (() => true);
}

function restore() {
  process.stdout.write = realOut;
  process.stderr.write = realErr;
}

/**
 * @param {Partial<import('../../lib/types.mjs').EvidencePointer>} over
 * @returns {import('../../lib/types.mjs').EvidencePointer}
 */
function ptr(over) {
  return {
    path: 'src/a.js',
    lineRange: null,
    reason: 'relevant',
    confidence: 0.5,
    freshness: '2026-06-24T00:00:00.000Z',
    kind: 'file',
    ...over,
  };
}

test('reduce-context main() / exits 0, writes reduced artifact', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-cli-'));
  /** @type {import('../../lib/types.mjs').EvidencePointer[]} */
  const pointers = [];
  // @bounded-alloc — writes 8 fixture files.
  for (let i = 0; i < 8; i += 1) {
    const fp = path.join(dir, `f${i}.txt`);
    await fsp.writeFile(fp, `Fact ${i}. Detail.`);
    pointers.push(ptr({ path: fp }));
  }
  const packPath = path.join(dir, 'pack.json');
  await fsp.writeFile(
    packPath,
    JSON.stringify({
      taskId: 't1',
      stage: 'discovery',
      pointers,
      maxSources: 3,
      created_at: '2026-06-24T00:00:00.000Z',
    }),
  );
  const outPath = path.join(dir, 'reduced.json');

  silence();
  let code;
  try {
    code = await main([packPath, outPath]);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  const written = JSON.parse(await fsp.readFile(outPath, 'utf8'));
  assert.equal(written.originalCount, 8);
  assert.ok(Array.isArray(written.chunks) && written.chunks.length > 0);
});

test('reduce-context main() / exits 1 on missing input file', async () => {
  silence();
  let code;
  try {
    code = await main(['/no/such/dir/pack.json']);
  } finally {
    restore();
  }
  assert.equal(code, 1);
});
