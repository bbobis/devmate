// @ts-check
/**
 * E9-26: structural checks over docs/PATTERNS.md — every pattern block must
 * carry a Benefit line and an Enforcement line drawn from the allowed
 * vocabulary with a repo-relative `file:line` evidence pointer that actually
 * resolves. (E9-30 later adds the CI check that the *claimed status* matches
 * reality; this test guards the structure and pointer freshness.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'PATTERNS.md'), 'utf8');

const ENFORCEMENT_VOCAB = ['structural', 'ci-enforced', 'hook-runtime', 'prompt-only', 'aspirational'];

/**
 * Split the doc into `### <id> — <title>` pattern blocks.
 * @returns {Array<{ id: string, heading: string, body: string }>}
 */
function patternBlocks() {
  return DOC.split('\n### ')
    .slice(1)
    .map((segment) => {
      const newline = segment.indexOf('\n');
      const heading = segment.slice(0, newline).trim();
      // A block ends at the next section header ("## ..." or "---").
      const body = segment.slice(newline + 1).split(/\n(?:## |---)/)[0] ?? '';
      const id = heading.split(' ')[0] ?? '';
      return { id, heading, body };
    })
    .filter((b) => /^(TCM-\d+|P\d+)$/.test(b.id));
}

const BLOCKS = patternBlocks();

test('catalog names TCM-1…TCM-12 and P1…P12', () => {
  const ids = BLOCKS.map((b) => b.id);
  for (let i = 1; i <= 12; i++) {
    assert.ok(ids.includes(`TCM-${i}`), `TCM-${i} present`);
    assert.ok(ids.includes(`P${i}`), `P${i} present`);
  }
});

test('every pattern block has a Benefit line', () => {
  for (const block of BLOCKS) {
    assert.match(block.body, /^- \*\*Benefit:\*\* \S/m, `${block.id} has a Benefit line`);
  }
});

test('every pattern block has an Enforcement line with allowed vocabulary and a file:line pointer', () => {
  const line = /^- \*\*Enforcement:\*\* `([a-z-]+)` \(`([^`]+):(\d+)`\)/m;
  for (const block of BLOCKS) {
    const m = block.body.match(line);
    assert.ok(m, `${block.id} has an Enforcement line in the canonical shape`);
    assert.ok(
      ENFORCEMENT_VOCAB.includes(m[1] ?? ''),
      `${block.id}: "${m[1]}" is in the Enforcement vocabulary`
    );
  }
});

test('every Enforcement evidence pointer resolves to a real file and line', () => {
  const line = /^- \*\*Enforcement:\*\* `[a-z-]+` \(`([^`]+):(\d+)`\)/m;
  for (const block of BLOCKS) {
    const m = block.body.match(line);
    assert.ok(m && m[1] && m[2], `${block.id} pointer parsed`);
    const file = m[1];
    const lineNo = Number(m[2]);
    /** @type {string} */
    let content;
    // @bounded-alloc — reads one repo file per pointer in the checked-in patterns doc.
    try {
      content = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      assert.fail(`${block.id}: pointer file "${file}" does not exist`);
    }
    const lineCount = content.split('\n').length;
    assert.ok(
      lineNo >= 1 && lineNo <= lineCount,
      `${block.id}: ${file}:${lineNo} is within the file (${lineCount} lines)`
    );
  }
});

test('statuses are honest, not uniformly wired', () => {
  // The E9 assessment's core complaint was everything reading as built.
  // At least one pattern must admit to prompt-only/aspirational status.
  const weak = BLOCKS.filter((b) =>
    /^- \*\*Enforcement:\*\* `(prompt-only|aspirational)`/m.test(b.body)
  );
  assert.ok(weak.length >= 1, 'at least one pattern is prompt-only or aspirational');
});
