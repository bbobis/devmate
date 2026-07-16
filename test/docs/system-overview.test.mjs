// @ts-check
/**
 * E9-28: SYSTEM_OVERVIEW.md structure — the four contract sections exist, the
 * component graph is a mermaid fence, and README names the doc as the
 * canonical entry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '..', 'docs');
const OVERVIEW = readFileSync(join(DOCS_DIR, 'SYSTEM_OVERVIEW.md'), 'utf8');

test('the four contract sections exist in order', () => {
  const sections = [
    '## 1. The system at a glance (mermaid component graph)',
    '## 2. One request, end to end (continuous walkthrough)',
    '## 3. The closed loop: classify → budget → route → gate → eval',
    '## 4. Why it is shaped this way (rationale & benefits)',
  ];
  let cursor = -1;
  for (const heading of sections) {
    const idx = OVERVIEW.indexOf(heading);
    assert.ok(idx !== -1, `missing section: ${heading}`);
    assert.ok(idx > cursor, `out of order: ${heading}`);
    cursor = idx;
  }
});

test('a mermaid component graph fence is present', () => {
  assert.match(OVERVIEW, /```mermaid\nflowchart TD/);
  assert.match(OVERVIEW, /hooks\/hooks\.json/);
});

test('README names SYSTEM_OVERVIEW as the canonical entry', () => {
  const readme = readFileSync(join(DOCS_DIR, 'README.md'), 'utf8');
  assert.match(readme, /\[SYSTEM_OVERVIEW\.md\]\(\.\/SYSTEM_OVERVIEW\.md\)/);
  assert.match(readme, /canonical entry/);
});
