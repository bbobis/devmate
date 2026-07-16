// @ts-check
/**
 * #94 — `namedPaths`: the classification signal that decides whether a tool
 * devmate has never seen is touching a file the guard protects.
 *
 * The bug it exists to fix: every MCP/extension-contributed tool was denied on
 * first contact purely for being unfamiliar. The property under test is
 * therefore two-sided — it must find a path under ANY key (so a renamed edit tool
 * is still gated), and it must find NOTHING in a payload that only carries data
 * (so `session_store_sql` runs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { namedPaths, toolInputPaths, firstToolInputPath } from '../../../lib/hooks/tool-input.mjs';

test('namedPaths - finds the VS Code target keys', () => {
  assert.deepEqual(namedPaths({ filePath: 'lib/a.mjs' }), ['lib/a.mjs']);
  assert.deepEqual(namedPaths({ dirPath: 'lib/sub/b.ts' }), ['lib/sub/b.ts']);
});

test('namedPaths - finds keys VS Code never sends (the MCP surface)', () => {
  // `path` and `uri` are exactly the keys toolInputPaths does NOT read. An
  // unrecognized tool has no schema devmate knows, so classification must be
  // wider than target extraction.
  assert.deepEqual(namedPaths({ path: 'lib/a.mjs' }), ['lib/a.mjs']);
  assert.deepEqual(namedPaths({ uri: 'file:///c:/dev/lib/a.mjs' }), ['/c:/dev/lib/a.mjs']);
  assert.deepEqual(namedPaths({ target_file: 'src/app.jsx' }), ['src/app.jsx']);
});

test('namedPaths - strips a file:// scheme and its percent-encoding', () => {
  assert.deepEqual(namedPaths({ uri: 'file:///home/me/my%20proj/a.mjs' }), [
    '/home/me/my proj/a.mjs',
  ]);
});

test('namedPaths - walks nested objects and arrays', () => {
  assert.deepEqual(
    namedPaths({ edits: [{ target: { file: 'lib/deep.mjs' } }] }),
    ['lib/deep.mjs'],
  );
  assert.deepEqual(namedPaths({ files: ['lib/a.mjs', 'lib/b.ts'] }), ['lib/a.mjs', 'lib/b.ts']);
});

test('namedPaths - session artifacts count, whatever their extension (#93)', () => {
  // Protected by LOCATION, not extension: `.md` is not a source extension.
  assert.deepEqual(namedPaths({ doc: '.devmate/session/T1/spec.md' }), [
    '.devmate/session/T1/spec.md',
  ]);
});

test('namedPaths - a data payload names nothing (the session_store_sql case)', () => {
  assert.deepEqual(namedPaths({ query: 'SELECT * FROM sessions' }), []);
  assert.deepEqual(
    namedPaths({ prompt: 'Summarize the changes to the auth module', limit: 10 }),
    [],
  );
  assert.deepEqual(namedPaths({ url: 'https://example.com/docs' }), []);
  assert.deepEqual(namedPaths({}), []);
});

test('namedPaths - de-duplicates and tolerates non-objects', () => {
  assert.deepEqual(namedPaths({ a: 'lib/a.mjs', b: 'lib/a.mjs' }), ['lib/a.mjs']);
  assert.deepEqual(namedPaths(null), []);
  assert.deepEqual(namedPaths('lib/a.mjs'), ['lib/a.mjs']);
  assert.deepEqual(namedPaths(42), []);
});

test('namedPaths - respects the depth cap', () => {
  // depth 4 is reachable; depth 5 is past the cap and is not descended into.
  const atCap = { a: { b: { c: { d: 'lib/deep.mjs' } } } };
  assert.deepEqual(namedPaths(atCap), ['lib/deep.mjs']);
  const pastCap = { a: { b: { c: { d: { e: 'lib/too-deep.mjs' } } } } };
  assert.deepEqual(namedPaths(pastCap), []);
});

test('namedPaths - respects the node cap', () => {
  // 400 sibling strings, only the last of which is a path: past the 200-node
  // ceiling, so the walk stops rather than scanning an unbounded payload.
  /** @type {Record<string, unknown>} */
  const wide = {};
  for (let i = 0; i < 400; i++) wide[`k${i}`] = i === 399 ? 'lib/late.mjs' : 'not a path';
  assert.deepEqual(namedPaths(wide), []);
  // The same path early in the payload is found.
  assert.deepEqual(namedPaths({ first: 'lib/early.mjs', ...wide }), ['lib/early.mjs']);
});

test('namedPaths - ignores prose and source content, not just SQL', () => {
  // A multi-line blob is content, not a filename anyone typed.
  assert.deepEqual(namedPaths({ content: "import x from './a.mjs';\nexport const y = 1;\n" }), []);
});

// ---- toolInputPaths is UNCHANGED: it remains the authoritative target extractor.

test('toolInputPaths still reads only the VS Code target keys', () => {
  assert.deepEqual(toolInputPaths({ filePath: 'lib/a.mjs' }), ['lib/a.mjs']);
  // `path` / `uri` are NOT target keys — reading them here would let a decoy mask
  // a real multi-file edit target (the #74 lesson). namedPaths is the wider
  // signal; the target extractor stays narrow.
  assert.deepEqual(toolInputPaths({ path: 'lib/a.mjs' }), []);
  assert.deepEqual(toolInputPaths({ uri: 'file:///c:/dev/lib/a.mjs' }), []);
  assert.equal(firstToolInputPath({ files: ['lib/a.mjs', 'lib/b.mjs'] }), 'lib/a.mjs');
  assert.equal(firstToolInputPath({}), undefined);
});
