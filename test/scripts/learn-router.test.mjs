// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../../scripts/learn-router.mjs';
import { parseJson } from '../../lib/json-io.mjs';

/**
 * Capture stdout while running main with the given args.
 * @param {string[]} args
 * @returns {Promise<{ code: number, out: string }>}
 */
async function run(args) {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  /** @param {string | Uint8Array} chunk */
  const stub = (chunk) => {
    out += chunk;
    return true;
  };
  process.stdout.write = /** @type {typeof process.stdout.write} */ (stub);
  try {
    const code = await main(args);
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

test('learn-router main — "author pattern foo" → exits 0 with pattern-authoring', async () => {
  const { code, out } = await run(['--input', 'author pattern foo']);
  assert.equal(code, 0);
  assert.deepEqual(parseJson(out), { route: 'pattern-authoring' });
});

test('learn-router main — "how does verify-step work" → exits 0 with help', async () => {
  const { code, out } = await run(['--input', 'how does verify-step work']);
  assert.equal(code, 0);
  assert.deepEqual(parseJson(out), { route: 'help' });
});

test('learn-router main — no input → exits 0 with help', async () => {
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.deepEqual(parseJson(out), { route: 'help' });
});
