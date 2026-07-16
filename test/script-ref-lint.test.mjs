// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBareScriptRefs,
  formatScriptRefTable,
  PLUGIN_ROOT_PLACEHOLDER,
} from '../lib/script-ref-lint.mjs';

test('script-ref-lint › flags a bare node invocation', () => {
  const v = findBareScriptRefs('Run `node scripts/gatectl.mjs workflow set x`', 'a.md');
  assert.equal(v.length, 1);
  assert.equal(v[0].ref, 'scripts/gatectl.mjs');
  assert.equal(v[0].line, 1);
  assert.equal(v[0].file, 'a.md');
});

test('script-ref-lint › accepts the plugin-root token form', () => {
  const text = `node "${PLUGIN_ROOT_PLACEHOLDER}/scripts/gatectl.mjs" workflow set x`;
  assert.deepEqual(findBareScriptRefs(text, 'a.md'), []);
});

test('script-ref-lint › accepts an inline-backtick token form', () => {
  const text = '`node "${PLUGIN_ROOT}/scripts/orch-assert-floor.mjs" --gate g`';
  assert.deepEqual(findBareScriptRefs(text, 'a.md'), []);
});

test('script-ref-lint › does not match lib/ or nested paths', () => {
  const text = 'verify via `lib/loop/verify-step.mjs` or test/scripts/foo.mjs';
  assert.deepEqual(findBareScriptRefs(text, 'a.md'), []);
});

test('script-ref-lint › reports correct line numbers across a document', () => {
  const text = ['# Title', '', 'ok: ${PLUGIN_ROOT}/scripts/a.mjs', 'bad: scripts/b.mjs'].join(
    '\n'
  );
  const v = findBareScriptRefs(text, 'doc.md');
  assert.equal(v.length, 1);
  assert.equal(v[0].ref, 'scripts/b.mjs');
  assert.equal(v[0].line, 4);
});

test('script-ref-lint › table includes the suggested fix', () => {
  const table = formatScriptRefTable([{ file: 'a.md', line: 2, ref: 'scripts/x.mjs' }]);
  assert.match(table, /\$\{PLUGIN_ROOT\}\/scripts\/x\.mjs/);
});
