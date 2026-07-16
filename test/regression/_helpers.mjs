// @ts-check
/**
 * Shared helpers for the E7-1 script-level regression suites.
 * Keeps each *.test.mjs file <= 120 lines by extracting temp-dir setup,
 * JSONL writing, and fail-then-pass script generation.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlSync } from '../../lib/json-io.mjs';

/**
 * Create a fresh temp directory for a test case.
 * @param {string} [prefix]
 * @returns {string} Absolute path to the new directory.
 */
export function makeTmpDir(prefix = 'devmate-reg-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove a temp directory recursively (best-effort).
 * @param {string} dir
 * @returns {void}
 */
export function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Write an array of objects as JSONL to a file.
 * @param {string} filePath
 * @param {Array<Record<string, unknown>>} rows
 * @returns {void}
 */
export function writeJsonl(filePath, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(filePath, body, 'utf8');
}

/**
 * Write a JSONL file with valid rows interspersed with raw malformed lines.
 * @param {string} filePath
 * @param {string[]} rawLines  Pre-serialized lines (valid JSON or truncated junk).
 * @returns {void}
 */
export function writeRawLines(filePath, rawLines) {
  writeFileSync(filePath, rawLines.join('\n') + '\n', 'utf8');
}

/**
 * Read a JSONL file into parsed objects (skips blank lines).
 * @param {string} filePath
 * @returns {Array<Record<string, unknown>>}
 */
export function readJsonl(filePath) {
  return /** @type {Array<Record<string, unknown>>} */ (readJsonlSync(filePath));
}

/**
 * Generate a Node script that fails on its first invocation and passes after,
 * using a counter file to track state across runs. Used by flaky-rerun tests.
 * @param {string} counterFile  Absolute path to the counter file.
 * @returns {string} Script source.
 */
export function failThenPassScript(counterFile) {
  return [
    "import { readFileSync, writeFileSync, existsSync } from 'node:fs';",
    `const f = ${JSON.stringify(counterFile)};`,
    'const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;',
    'writeFileSync(f, String(n + 1), "utf8");',
    'if (n === 0) { console.error("first run fails"); process.exit(1); }',
    'console.log("second run passes"); process.exit(0);',
  ].join('\n');
}

/**
 * Generate a Node script that sleeps for the given milliseconds then exits 0.
 * Used by timeout tests (the timeout should kill it first).
 * @param {number} ms
 * @returns {string} Script source.
 */
export function sleepScript(ms) {
  return `await new Promise((r) => setTimeout(r, ${ms})); process.exit(0);`;
}
