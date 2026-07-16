// @ts-check
/**
 * E9-27: budget-class doc honesty. Docs must use the canonical
 * tiny/standard/large names (`lib/types.mjs` BudgetClass) and must never
 * revive the invented `small`/`medium` classes, the fictional `budgetClasses`
 * config key, or the fictional 400000-token `large` cap that contradicted
 * `classifyBudget` (large = max_context_sources 999, reducer required).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '..', 'docs');

// Top level only, deliberately: docs/archive/** preserves history as-was.
const DOC_FILES = readdirSync(DOCS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
  .map((entry) => entry.name);

/** @param {string} name @returns {string} */
function read(name) {
  return readFileSync(join(DOCS_DIR, name), 'utf8');
}

test('docs directory scan finds the doc set', () => {
  assert.ok(DOC_FILES.includes('ARCHITECTURE.md'));
  assert.ok(DOC_FILES.includes('context-management.md'));
  assert.ok(DOC_FILES.length >= 10, `found ${DOC_FILES.length} docs`);
});

test('no doc uses small/medium budget-class names', () => {
  for (const file of DOC_FILES) {
    const text = read(file);
    assert.doesNotMatch(text, /["'`](small|medium)["'`]\s*:/, `${file}: quoted budget-class key`);
    assert.doesNotMatch(text, /\bsmall\s*\/\s*medium\b/i, `${file}: small/medium class triple`);
    assert.doesNotMatch(text, /budgetClasses/, `${file}: invented budgetClasses config key`);
  }
});

test('no doc revives the fictional large-class token cap', () => {
  for (const file of DOC_FILES) {
    assert.doesNotMatch(read(file), /400[,. ]?000/, `${file}: fictional 400000 cap`);
  }
});

test('large semantics stated consistently with the code', () => {
  const contextDoc = read('context-management.md');
  assert.match(contextDoc, /tiny/);
  assert.match(contextDoc, /standard/);
  assert.match(contextDoc, /unbounded/);
  assert.match(contextDoc, /ContextReducer/);
  const architecture = read('ARCHITECTURE.md');
  assert.match(architecture, /`tiny` \| `standard` \| `large`/);
  assert.match(architecture, /max_context_sources = 999/);
});
